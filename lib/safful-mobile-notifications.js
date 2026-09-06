'use strict'

const Module = require('module')
const path = require('path')

function isDirectChat(jid) {
  return /@(?:s\.whatsapp\.net|c\.us|lid)$/.test(String(jid || ''))
}
function enabled() { return process.env.SAFFUL_PRESERVE_DM_NOTIFICATIONS !== 'false' }
function isRead(type) { return ['read', 'read-self', 'played'].includes(type) }
function keepKey(key) {
  return !isDirectChat(key?.remoteJid)
}

function preserveMobileNotifications(socket) {
  if (!socket || socket.__saffulMobileNotificationsGuard || !enabled()) return
  socket.__saffulMobileNotificationsGuard = true
  if (typeof socket.readMessages === 'function') {
    const read = socket.readMessages.bind(socket)
    socket.readMessages = (keys = []) => {
      const allowed = keys.filter(keepKey)
      return allowed.length ? read(allowed) : Promise.resolve()
    }
  }
  // sendReceipts closes over Baileys' original sendReceipt, so wrap both APIs.
  if (typeof socket.sendReceipts === 'function') {
    const receipts = socket.sendReceipts.bind(socket)
    socket.sendReceipts = (keys = [], type) => {
      const allowed = isRead(type) ? keys.filter(keepKey) : keys
      return allowed.length ? receipts(allowed, type) : Promise.resolve()
    }
  }
  if (typeof socket.sendReceipt === 'function') {
    const receipt = socket.sendReceipt.bind(socket)
    socket.sendReceipt = (jid, participant, ids, type) => {
      // Status auto-view addresses the sender with status@broadcast as participant.
      if (isDirectChat(jid) && participant !== 'status@broadcast' && isRead(type)) return Promise.resolve()
      return receipt(jid, participant, ids, type)
    }
  }
  if (typeof socket.sendPresenceUpdate !== 'function' || !socket.ev?.on) return
  const presence = socket.sendPresenceUpdate.bind(socket)
  socket.sendPresenceUpdate = (type, jid, ...rest) => {
    // Baileys ignores jid for available/unavailable: both are GLOBAL presence.
    return type === 'available' ? presence('unavailable') : presence(type, jid, ...rest)
  }
  let timer, open = false, sending = false
  const offline = async () => {
    if (!open || sending) return
    sending = true
    try { await presence('unavailable') }
    catch (error) { process.stderr.write('[notifications] Offline presence failed: ' + error.message + '\n') }
    finally { sending = false }
  }
  const period = Math.max(30000, Number(process.env.SAFFUL_PRESENCE_REASSERT_MS) || 60000)
  socket.ev.on('connection.update', update => {
    if (update.connection === 'close') {
      open = false
      clearInterval(timer)
      timer = undefined
      return
    }
    if (update.connection === 'open') {
      open = true
      if (!timer) {
        timer = setInterval(() => { void offline() }, period)
        timer.unref?.()
      }
    }
    if (update.connection === 'open' || update.receivedPendingNotifications || update.isOnline === true) void offline()
  })
  // On first linking the profile name may arrive after open. Baileys otherwise
  // silently ignores presence updates until the name is available.
  socket.ev.on('creds.update', update => { if (update.me?.name) void offline() })
}

function installMobileNotificationGuard() {
  if (global.__saffulMobileNotificationHookInstalled) return
  global.__saffulMobileNotificationHookInstalled = true
  const previous = Module._load
  Module._load = function(request, parent, isMain) {
    const loaded = previous.call(this, request, parent, isMain)
    if (request !== '@whiskeysockets/baileys' || parent?.filename !== path.join(__dirname, 'smd.js')) return loaded
    const factory = (options = {}) => {
      const socket = loaded.default(enabled() ? { ...options, markOnlineOnConnect: false } : options)
      preserveMobileNotifications(socket)
      return socket
    }
    return new Proxy(loaded, { get(target, property, receiver) {
      return property === 'default' ? factory : Reflect.get(target, property, receiver)
    } })
  }
}

module.exports = preserveMobileNotifications
module.exports.installMobileNotificationGuard = installMobileNotificationGuard
module.exports.isDirectChat = isDirectChat
