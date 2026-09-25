'use strict'

const { cmd } = require('../lib/plugins')
const { resolvePhone, phoneJid, ownerJids, normalizedJid, indexContacts, knownContacts } = require('../lib/safful-identities')

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

async function collectContacts(socket, metadata, store, extraContacts = []) {
  const rows = [], seen = new Set()
  // Non-admin rosters often contain only LIDs. Contact records may be keyed
  // by PN with a lid field, so direct dictionary lookup alone misses them.
  const contacts = indexContacts(knownContacts(socket), store?.contacts, socket.contacts, extraContacts, metadata.participants)
  let unresolved = 0
  for (const participant of metadata.participants || []) {
    const record = typeof participant === 'string' ? { id: participant } : participant
    const aliases = [record.id, record.lid, record.phoneNumber, record.jid].map(normalizedJid).filter(Boolean)
    const matches = aliases.map(id => contacts.get(id)).filter(Boolean)
    const jid = await resolvePhone(socket, record.phoneNumber, record.jid, record.id, record.lid,
      ...matches.map(contact => contact.phoneNumber))
    if (!jid) { unresolved++; continue }
    if (seen.has(jid)) continue
    seen.add(jid)
    const contact = contacts.get(jid) || matches[0] || {}
    const number = jid.split('@')[0]
    const name = String(contact.name || contact.notify || contact.verifiedName || record.name || record.notify || `${metadata.subject || 'Group'} ${rows.length + 1}`).trim()
    rows.push({ name, number, role: record.admin || 'member' })
  }
  return { rows, unresolved }
}

function contactSources(socket, store) {
  return [knownContacts(socket), store?.contacts, socket?.contacts]
}

function contactRecords(source) {
  if (source instanceof Map) return [...source.values()]
  if (Array.isArray(source)) return source
  return Object.values(source || {})
}

async function collectAllContacts(socket, store, groups = {}) {
  const sources = contactSources(socket, store)
  const roster = Object.values(groups || {}).flatMap(group => group?.participants || [])
  const contacts = indexContacts(...sources, roster)
  const rows = [], seen = new Set()
  let unresolved = 0
  for (const source of [...sources, roster]) for (const item of contactRecords(source)) {
    const record = typeof item === 'string' ? { id: item } : item
    const aliases = [record?.id, record?.lid, record?.phoneNumber, record?.jid, record?.pn]
      .map(normalizedJid).filter(Boolean)
    if (!aliases.length) continue
    const matches = aliases.map(id => contacts.get(id)).filter(Boolean)
    const jid = await resolvePhone(socket, ...aliases, ...matches.map(match => match.phoneNumber))
    if (!jid) { unresolved++; continue }
    if (seen.has(jid)) continue
    seen.add(jid)
    const contact = contacts.get(jid) || matches[0] || record
    const number = jid.split('@')[0]
    const name = String(contact.name || contact.notify || contact.verifiedName || record.name || record.notify || number).trim()
    rows.push({ name, number, role: 'contact' })
  }
  return { rows, unresolved }
}

// Anyone in a group may run .vcf. It is fully silent: nothing is echoed back
// to the chat — the VCF/CSV is pushed straight to the owner's (sudo) chat.
// Failures are logged to the console only.
async function exportContacts(message, text, meta = {}) {
  const socket = meta.Void || message.bot || global.__saffulLatestSocket
  const chat = message.chat || message.jid || message.key?.remoteJid
  const args = String(text || '').trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (args.some(arg => !['vcf', 'csv', 'excel', 'sudo', 'personal', 'me', 'all'].includes(arg))) return
  const all = args.includes('all')
  if (!all && !String(chat).endsWith('@g.us')) return
  const csv = args.includes('csv') || args.includes('excel')
  const destination = ownerJids(socket)[0] || phoneJid(socket.user?.id) || socket.user?.id
  if (!destination || !/@(?:s\.whatsapp\.net|lid)$/.test(destination)) {
    process.stderr.write('[vcf] no SUDO/personal destination configured — export skipped\n')
    return
  }
  try {
    if (all) {
      let groups = {}
      if (typeof socket.groupFetchAllParticipating === 'function') {
        try { groups = await socket.groupFetchAllParticipating() || {} }
        catch (error) { process.stderr.write('[vcf] Group roster lookup failed: ' + error.message + '\n') }
      }
      const { rows, unresolved } = await collectAllContacts(socket, meta.store, groups)
      if (!rows.length) {
        process.stderr.write('[vcf] no exportable contact numbers available (' + unresolved + ' unresolved)\n')
        return
      }
      await socket.sendMessage(destination, {
        document: csv ? makeCsv(rows) : makeVcf(rows),
        mimetype: csv ? 'text/csv' : 'text/vcard',
        fileName: `all-known-contacts.${csv ? 'csv' : 'vcf'}`,
        caption: `${rows.length} known contacts${unresolved ? ` (${unresolved} entries without a supplied phone mapping skipped)` : ''}`,
      })
      return
    }
    let metadata = await socket.groupMetadata(chat)
    let result = await collectContacts(socket, metadata, meta.store)
    if ((result.unresolved || Number(metadata.size) > (metadata.participants || []).length) && typeof socket.groupFetchAllParticipating === 'function') {
      try {
        const groups = await socket.groupFetchAllParticipating()
        const fresh = groups[chat]
        if (fresh?.participants?.length) {
          // Both sources are fresh server rosters. Use the more complete one,
          // with phone mappings from the other, never an unrelated group.
          const original = metadata
          if (fresh.participants.length > (metadata.participants || []).length) metadata = { ...metadata, ...fresh }
          const retry = await collectContacts(socket, metadata, meta.store, [...original.participants || [], ...fresh.participants])
          if (retry.rows.length >= result.rows.length) result = retry
        }
      } catch (error) { process.stderr.write('[vcf] Full roster lookup failed: ' + error.message + '\n') }
    }
    const { rows, unresolved } = result
    if (!rows.length) {
      process.stderr.write('[vcf] no phone numbers available for ' + chat + ' (' + unresolved + ' unresolved)\n')
      return
    }
    const filename = String(metadata.subject || 'group-contacts').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0,80)
    await socket.sendMessage(destination, {
      document: csv ? makeCsv(rows) : makeVcf(rows),
      mimetype: csv ? 'text/csv' : 'text/vcard', fileName: `${filename}.${csv ? 'csv' : 'vcf'}`,
      caption: `${rows.length} contacts from ${metadata.subject || 'group'}${unresolved ? ` (${unresolved} unresolved: WhatsApp has not supplied a phone number or mapping; admin status is not required by this command)` : ''}`,
    })
  } catch (error) {
    process.stderr.write('[vcf] export failed: ' + (error?.message || error) + '\n')
  }
}

cmd({ pattern: 'vcf', alias: ['groupcontacts', 'exportcontacts'], category: 'group', desc: 'Export group or all known contacts to sudo as VCF or Excel-compatible CSV (silent)', filename: __filename }, exportContacts)
module.exports = { collectContacts, collectAllContacts, makeVcf, makeCsv, exportContacts }
