'use strict'

const fs = require('fs')
const path = require('path')
const { cmd } = require('../lib/plugins')
const { isOperator, phoneJid, ownerJids, indexContacts, knownContacts, resolvePhone } = require('../lib/safful-identities')

const PROJECT_ROOT = path.join(__dirname, '..')
const STORE_FILE = path.join(PROJECT_ROOT, 'lib', 'store.json')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

function storedMessages(store) { return store?.messages || {} }
function legacyStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) } catch { return {} }
}
function recentPrivateChats(store = legacyStore()) {
  return Object.keys(storedMessages(store)).filter(jid => jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'))
}
function records(source) {
  return source instanceof Map ? [...source.values()] : Array.isArray(source) ? source : Object.values(source || {})
}

async function broadcastTargets(socket, store, groups = {}) {
  const groupIds = Object.keys(groups).filter(jid => jid.endsWith('@g.us'))
  const sources = [knownContacts(socket), store?.contacts, socket.contacts, legacyStore().contacts]
  const participants = Object.values(groups).flatMap(group => group?.participants || [])
  const index = indexContacts(...sources, participants)
  const candidates = [...sources.flatMap(records), ...participants, ...recentPrivateChats(store), ...recentPrivateChats()]
  const contacts = new Set()
  const excluded = new Set([...ownerJids(socket), phoneJid(socket.user?.id)].filter(Boolean))
  let unresolved = 0
  for (const item of candidates) {
    const record = typeof item === 'string' ? { id: item } : item
    const aliases = [record?.id, record?.jid, record?.lid, record?.phoneNumber, record?.pn].filter(Boolean)
    const matches = aliases.map(id => index.get(id)).filter(Boolean)
    const jid = await resolvePhone(socket, ...aliases, ...matches.map(match => match.phoneNumber))
    if (!jid) { if (aliases.length) unresolved++; continue }
    if (!excluded.has(jid)) contacts.add(jid)
  }
  return { groups: groupIds, contacts: [...contacts], unresolved }
}

async function broadcast(message, text, meta = {}) {
  const socket = meta.Void || message.bot
  if (!await isOperator(message, meta, socket)) return message.reply('Owner only.')
  const input = String(text || '').trim()
  const match = /^(groups|contacts)\s+([\s\S]+)$/i.exec(input)
  const scope = match?.[1]?.toLowerCase() || 'all'
  const body = (match?.[2] || input).trim()
  if (!body) return message.reply('Use: .broadcast <message> (or .broadcast groups <message> / .broadcast contacts <message>)')
  if (!socket?.sendMessage) return message.reply('The bot connection is unavailable.')
  let groups = {}
  try { groups = await socket.groupFetchAllParticipating?.() || {} }
  catch (error) { console.error('[broadcast] group lookup failed:', error) }
  const targets = await broadcastTargets(socket, meta.store, groups)
  const recipients = [...(scope === 'contacts' ? [] : targets.groups), ...(scope === 'groups' ? [] : targets.contacts)]
  if (!recipients.length) return message.reply('No known recipients found. WhatsApp has not supplied a complete phonebook.')
  await message.reply(`📢 Sending to ${recipients.length} known chats (${scope}).`)
  let accepted = 0, failed = 0
  const errors = []
  for (const jid of recipients) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await socket.sendMessage(jid, { text: body }); accepted++; break }
      catch (error) {
        if (attempt === 3) {
          failed++
          if (errors.length < 5) errors.push(`${jid}: ${String(error?.message || error).slice(0, 80)}`)
        } else await wait(attempt * 1000)
      }
    }
    if ((accepted + failed) % 10 === 0) await wait(75)
  }
  return message.reply(`Broadcast attempted: ${recipients.length}\nAccepted by sendMessage: ${accepted}\nFailed: ${failed}` +
    (targets.unresolved ? `\nUnmapped contact entries skipped: ${targets.unresolved}` : '') +
    (errors.length ? `\n${errors.join('\n')}` : '') +
    '\nAcceptance is not proof of delivery or reading.')
}

cmd({ pattern: 'broadcast', alias: ['bc', 'bcast', 'broadcastall', 'bcall'], desc: 'Send to all known contacts and participating groups', category: 'owner', use: '<message>' }, broadcast)
module.exports = { PROJECT_ROOT, STORE_FILE, recentPrivateChats, broadcastTargets, broadcast }
