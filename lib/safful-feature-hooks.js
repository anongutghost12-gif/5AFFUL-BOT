'use strict'

const Module = require('module')
const path = require('path')
const attached = new WeakSet()

function attach(socket) {
  if (!socket?.ev || attached.has(socket)) return socket
  attached.add(socket)
  global.__saffulLatestSocket = socket
  require('../plugins/safful-call-guard').attach(socket)
  require('../plugins/antiviewonce').attach(socket)
  // Push-notification guard (presence 'unavailable' + receipt wrapping) is
  // attached per socket, and the legacy core reconnects internally without
  // re-running index.js — so it must ride along on every replacement socket
  // too, or the phone stops receiving push notifications after a reconnect.
  // The module is idempotent per socket via its own flag.
  try { require('./safful-mobile-notifications')(socket) } catch (error) {
    process.stdout.write('[notifications] re-attach failed: ' + (error?.message || error) + '\n')
  }
  hardenPresenceGuard(socket)
  return socket
}

// WhatsApp suppresses push notifications on the phone while this linked
// session is marked globally 'available'. The notifications module sends one
// 'unavailable' on connect, but the session can be re-marked 'available'
// later (status autoview, receipts, library internals) — so map any global
// 'available' to 'unavailable' permanently and re-assert periodically.
// Chat-scoped presences ('composing', 'recording', per-jid) pass through.
function hardenPresenceGuard(socket) {
  if (!socket || typeof socket.sendPresenceUpdate !== 'function') return
  if (socket.__saffulPresenceGuard) return
  socket.__saffulPresenceGuard = true
  const inner = socket.sendPresenceUpdate.bind(socket)
  socket.sendPresenceUpdate = (status, jid, ...rest) => {
    if (!jid && status === 'available') return inner('unavailable', jid, ...rest)
    return inner(status, jid, ...rest)
  }
  const period = process.env.SAFFUL_PRESENCE_REASSERT_MS
    ? Math.max(100, Number(process.env.SAFFUL_PRESENCE_REASSERT_MS) || 0)
    : 10 * 60 * 1000
  const reassert = setInterval(() => {
    // Stop once a newer socket supersedes this one (no leaked timers/GC pins).
    if (global.__saffulLatestSocket !== socket) { clearInterval(reassert); return }
    try { void socket.sendPresenceUpdate('unavailable') } catch {}
  }, period)
  reassert.unref?.()
}

// The legacy core reconnects internally, without calling index.js again.
// Hook its socket factory so every replacement gets handlers before dispatch.
function install() {
  if (global.__saffulFeatureHooksInstalled) return
  global.__saffulFeatureHooksInstalled = true
  const previous = Module._load
  Module._load = function(request, parent, isMain) {
    const loaded = previous.call(this, request, parent, isMain)
    if (parent?.filename !== path.join(__dirname, 'smd.js')) return loaded
    if (request === './serialized.js') {
      return { ...loaded, smsg: async (socket, raw, ...args) => {
        const message = await loaded.smsg(socket, raw, ...args)
        if (message && await require('./safful-identities').isOperator(raw, {}, socket)) {
          // The legacy private-mode gate runs before plugins and knows only PN.
          message.isCreator = true
        }
        return message
      } }
    }
    if (request !== '@whiskeysockets/baileys') return loaded
    const factory = options => attach(loaded.default(options))
    return new Proxy(loaded, { get(target, property, receiver) {
      return property === 'default' ? factory : Reflect.get(target, property, receiver)
    } })
  }
}

module.exports = { install, attach }
