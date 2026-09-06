'use strict'

const contactCaches = new WeakMap()

function normalizedJid(value) {
  const text = String(value || '').trim()
  return phoneJid(text) || (/^\d+(?::\d+)?@lid$/.test(text) ? text.replace(/:\d+@/, '@') : '')
}

function contactValues(contacts) {
  if (contacts instanceof Map) return [...contacts.values()]
  return Array.isArray(contacts) ? contacts : Object.values(contacts || {})
}

function indexContacts(...sources) {
  const index = new Map()
  for (const source of sources) for (const contact of contactValues(source)) {
    if (!contact || typeof contact !== 'object') continue
    const ids = [contact.id, contact.lid, contact.phoneNumber, contact.jid, contact.pn].map(normalizedJid).filter(Boolean)
    const prior = ids.map(id => index.get(id)).filter(Boolean)
    const merged = Object.assign({}, ...prior, contact)
    const pn = [contact.phoneNumber, contact.pn, contact.id, contact.jid, ...prior.map(c => c.phoneNumber)].map(phoneJid).find(Boolean)
    if (pn) merged.phoneNumber = pn
    for (const id of ids) index.set(id, merged)
  }
  return index
}

function knownContacts(socket) { return contactCaches.get(socket) || new Map() }

function attachContactCache(socket) {
  if (!socket?.ev?.on || contactCaches.has(socket)) return
  const contacts = new Map()
  contactCaches.set(socket, contacts)
  const remember = entries => {
    const batch = indexContacts(entries)
    const pairs = []
    for (const [id, entry] of batch) {
      contacts.set(id, { ...contacts.get(id), ...entry })
      if (id.endsWith('@lid') && entry.phoneNumber) pairs.push({ lid: id, pn: entry.phoneNumber })
    }
    while (contacts.size > 20000) contacts.delete(contacts.keys().next().value)
    // Save observed mappings in Baileys' existing auth store for future restarts.
    if (pairs.length) {
      try { void Promise.resolve(socket.signalRepository?.lidMapping?.storeLIDPNMappings?.(pairs)).catch(() => {}) } catch {}
    }
  }
  socket.ev.on('contacts.upsert', remember)
  socket.ev.on('contacts.update', remember)
  socket.ev.on('lid-mapping.update', entry => remember([entry]))
  socket.ev.on('messaging-history.set', data => {
    remember(data.contacts)
    remember(data.lidPnMappings)
  })
  socket.ev.on('messages.upsert', data => {
    for (const message of data.messages || []) {
      const key = message.key || {}
      if (key.fromMe) continue
      const group = String(key.remoteJid).endsWith('@g.us')
      const id = group ? key.participant : key.remoteJid
      const alt = group ? key.participantAlt : key.remoteJidAlt
      const ids = [id, alt].map(normalizedJid).filter(Boolean)
      const pn = ids.find(value => phoneJid(value))
      const lid = ids.find(value => value.endsWith('@lid'))
      if (pn && lid) remember([{ id: lid, lid, phoneNumber: pn, notify: message.pushName }])
    }
  })
}

function phoneJid(value) {
  const text = String(value || '').trim()
  if (text.includes('@') && !/@(?:s\.whatsapp\.net|c\.us)$/.test(text)) return ''
  const number = text.split('@')[0].split(':')[0].replace(/[+\s()-]/g, '')
  return /^\d{7,15}$/.test(number) ? `${number}@s.whatsapp.net` : ''
}

async function resolvePhone(socket, ...values) {
  for (const value of values) {
    const jid = phoneJid(value)
    if (jid) return jid
  }
  for (const value of values) {
    const lid = normalizedJid(value)
    if (!lid.endsWith('@lid')) continue
    const cached = phoneJid(knownContacts(socket).get(lid)?.phoneNumber)
    if (cached) return cached
    try {
      const mapping = socket?.signalRepository?.lidMapping
      const jid = phoneJid(await mapping?.getPNForLID(lid))
      if (jid) return jid
    } catch {}
  }
  return ''
}

function ownerJids(socket) {
  for (const value of [process.env.SUDO, global.sudo, process.env.OWNER_NUMBER, global.owner]) {
    const jids = String(value || '').split(/[,;\s]+/).map(phoneJid).filter(Boolean)
    if (jids.length) return [...new Set(jids)]
  }
  const self = phoneJid(socket?.user?.id)
  return self ? [self] : []
}

function senderIds(message) {
  const key = message?.key || message?.fakeObj?.key || {}
  // A group's remoteJidAlt describes the chat, not the sender.
  return key.participant || message?.isGroup || String(key.remoteJid || message?.chat).endsWith('@g.us')
    ? [key.participantAlt, message?.senderNum, message?.sender, key.participant, message?.participant]
    : [key.remoteJidAlt, message?.senderNum, message?.sender, key.remoteJid]
}

async function isOperator(message, meta, socket) {
  const { isOwner } = require('./safful-mode')
  if (isOwner(message, meta)) return true
  const sender = await resolvePhone(socket, ...senderIds(message))
  return Boolean(sender && ownerJids(socket).includes(sender))
}

module.exports = { phoneJid, resolvePhone, ownerJids, senderIds, isOperator,
  normalizedJid, indexContacts, knownContacts, attachContactCache }
