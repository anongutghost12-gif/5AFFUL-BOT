'use strict'

const { cmd } = require('../lib/plugins')
const { resolvePhone, phoneJid, ownerJids } = require('../lib/safful-identities')

function escapeVcard(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,')
}

// vCard lines are folded at 75 UTF-8 octets, without splitting a character.
function foldLine(line) {
  let result = '', current = ''
  for (const character of line) {
    if (Buffer.byteLength(current + character) > 75) { result += current + '\r\n'; current = ' ' }
    current += character
  }
  return result + current
}

function makeVcf(rows) {
  return Buffer.from(rows.map(row => [
    'BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeVcard(row.name)}`,
    `N:${escapeVcard(row.name)};;;;`, `TEL;TYPE=CELL:+${row.number}`, 'END:VCARD',
  ].map(foldLine).join('\r\n')).join('\r\n') + '\r\n', 'utf8')
}

function makeCsv(rows) {
  const cell = value => {
    let text = String(value || '')
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text
    return '"' + text.replace(/"/g, '""') + '"'
  }
  return Buffer.from('\uFEFF' + [['Name', 'Phone', 'Role'], ...rows.map(row => [row.name, '+' + row.number, row.role])]
    .map(row => row.map(cell).join(',')).join('\r\n') + '\r\n', 'utf8')
}

async function collectContacts(socket, metadata, store) {
  const rows = [], seen = new Set()
  let unresolved = 0
  for (const participant of metadata.participants || []) {
    const jid = await resolvePhone(socket, participant.phoneNumber, participant.jid, participant.id, participant.lid)
    if (!jid) { unresolved++; continue }
    if (seen.has(jid)) continue
    seen.add(jid)
    const contact = store?.contacts?.[jid] || store?.contacts?.[participant.id] || socket.contacts?.[jid] || {}
    const number = jid.split('@')[0]
    const name = String(contact.name || contact.notify || contact.verifiedName || participant.name || participant.notify || `${metadata.subject || 'Group'} ${rows.length + 1}`).trim()
    rows.push({ name, number, role: participant.admin || 'member' })
  }
  return { rows, unresolved }
}

// Anyone in a group may run .vcf. It is fully silent: nothing is echoed back
// to the chat — the VCF/CSV is pushed straight to the owner's (sudo) chat.
// Failures are logged to the console only.
async function exportContacts(message, text, meta = {}) {
  const socket = meta.Void || message.bot || global.__saffulLatestSocket
  const chat = message.chat || message.jid || message.key?.remoteJid
  if (!String(chat).endsWith('@g.us')) return
  const args = String(text || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (args.some(arg => !['vcf', 'csv', 'excel', 'sudo', 'personal', 'me'].includes(arg))) return
  const csv = args.includes('csv') || args.includes('excel')
  const destination = ownerJids(socket)[0] || phoneJid(socket.user?.id) || socket.user?.id
  if (!destination || !/@(?:s\.whatsapp\.net|lid)$/.test(destination)) {
    process.stderr.write('[vcf] no SUDO/personal destination configured — export skipped\n')
    return
  }
  try {
    const metadata = await socket.groupMetadata(chat)
    const { rows, unresolved } = await collectContacts(socket, metadata, meta.store)
    if (!rows.length) {
      process.stderr.write('[vcf] no phone numbers available for ' + chat + ' (' + unresolved + ' unresolved)\n')
      return
    }
    const filename = String(metadata.subject || 'group-contacts').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0,80)
    await socket.sendMessage(destination, {
      document: csv ? makeCsv(rows) : makeVcf(rows),
      mimetype: csv ? 'text/csv' : 'text/vcard', fileName: `${filename}.${csv ? 'csv' : 'vcf'}`,
      caption: `${rows.length} contacts from ${metadata.subject || 'group'}${unresolved ? ` (${unresolved} skipped — no number exposed)` : ''}`,
    })
  } catch (error) {
    process.stderr.write('[vcf] export failed: ' + (error?.message || error) + '\n')
  }
}

cmd({ pattern: 'vcf', alias: ['groupcontacts', 'exportcontacts'], category: 'group', desc: 'Export this group\'s contacts to the owner as VCF or Excel-compatible CSV (silent)', filename: __filename }, exportContacts)
module.exports = { collectContacts, makeVcf, makeCsv, exportContacts }
