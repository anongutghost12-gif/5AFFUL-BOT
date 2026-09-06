'use strict'

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
    if (!String(value || '').endsWith('@lid')) continue
    try {
      const mapping = socket?.signalRepository?.lidMapping
      const jid = phoneJid(await mapping?.getPNForLID(value))
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

module.exports = { phoneJid, resolvePhone, ownerJids, senderIds, isOperator }
