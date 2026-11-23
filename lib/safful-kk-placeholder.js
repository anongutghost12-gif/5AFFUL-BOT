'use strict'

// Port of TurboFex's core/placeholder.js, adapted to `.kk` / `.vv`.
//
// Every placeholder-resend request makes the primary phone show
// "Finished syncing with WhatsApp on Chrome". Baileys sends those requests on
// its own whenever a message arrives it could not decrypt, and it keeps a
// cache of ids it already asked about so it never asks twice.
//
// TurboFex turns that cache into a gate: it answers "already asked" for every
// id, so the library's automatic requests never reach the phone. Only
// allow(id) opens a short window for the one deliberate request the view-once
// path needs. That is the key end-to-end difference from our earlier build:
// without the gate the phone could receive two resend requests for the same
// message (Baileys' automatic one and ours), and only one of them is tied to
// the request id we watch. The phone's answer then arrived under an id we did
// not map and was dropped.
//
// The normal repair (a retry receipt sent to the sender, who re-encrypts for
// this device) is not touched: it never goes through this cache.

const { logLine } = require('./safful-kk-log')

const WINDOW_MS = 60 * 60 * 1000
const configured = Number(process.env.SAFFUL_KK_RESEND_PER_HOUR)
const PER_HOUR = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 4
// How long one allowed id keeps the gate open. The library deletes the entry
// itself after 8 s; this is the outer bound for a slow phone.
const HOLD_MS = Math.max(5000, Number(process.env.SAFFUL_KK_PLACEHOLDER_MS) || 60000)
const ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.SAFFUL_KK_PLACEHOLDER_GATE || '1'))

const real = new Map() // ids we really asked for -> metadata (or true)
const allowed = new Set() // ids allowed to pass the gate right now
const asks = [] // { id, at } inside the rolling hour
const holds = new Map() // id -> timer that closes the gate

function prune(now) {
  while (asks.length && now - asks[0].at > WINDOW_MS) asks.shift()
}

function get(id) {
  return allowed.has(id) ? real.get(id) : true
}

function set(id, value) {
  if (allowed.has(id)) real.set(id, value === undefined ? true : value)
}

function del(id) {
  real.delete(id)
  allowed.delete(id)
  const timer = holds.get(id)
  if (timer) {
    clearTimeout(timer)
    holds.delete(id)
  }
}

const cache = {
  get,
  set,
  del,
  flushAll() {
    for (const timer of holds.values()) clearTimeout(timer)
    holds.clear()
    real.clear()
    allowed.clear()
  },
}

// Reserve one request for this message id. False means: do not ask now.
// Calling it again for an id that is still open is free, so the capture
// watcher and `.kk` cannot charge the phone twice for one message.
function allow(id) {
  if (!id) return false
  if (allowed.has(id)) {
    // The same id may be asked again deliberately (`.kk` retry) while the hold
    // window is still open. Clear the old metadata so the library does not
    // mistake it for an answer to the previous request.
    real.delete(id)
    return true
  }
  if (PER_HOUR === 0) {
    logLine('phone-budget', id, 'disabled')
    return false
  }
  const now = Date.now()
  prune(now)
  if (asks.length >= PER_HOUR) {
    logLine('phone-budget', id, 'exhausted', asks.length + '/' + PER_HOUR)
    return false
  }
  asks.push({ id, at: now })
  allowed.add(id)
  // A stale entry from an earlier request must never block our own request.
  real.delete(id)
  const timer = setTimeout(() => del(id), HOLD_MS)
  timer.unref?.()
  holds.set(id, timer)
  return true
}

// A request that never reached the phone should not cost a slot.
function refund(id) {
  if (!id) return
  allowed.delete(id)
  real.delete(id)
  const timer = holds.get(id)
  if (timer) {
    clearTimeout(timer)
    holds.delete(id)
  }
  for (let i = asks.length - 1; i >= 0; i--) {
    if (asks[i].id === id) { asks.splice(i, 1); return }
  }
}

// True when this id was already charged by allow().
function charged(id) {
  return Boolean(id) && allowed.has(id)
}

// Kept for callers that used to close the budget slot right after the request.
// With the gate the window has to stay open while the phone's answer travels,
// so the hold timer (not the caller) closes it.
function settle() {}

function spent() {
  prune(Date.now())
  return { used: asks.length, limit: PER_HOUR }
}

function reset() {
  cache.flushAll()
  asks.length = 0
}

// Replace the socket's placeholder cache with the gate, in place. Baileys
// destructures that object once when it builds the receive socket, so mutating
// its methods is what actually changes `requestPlaceholderResend`; assigning a
// new cache on the socket later would have no effect.
function installCache(socket) {
  if (!ENABLED || !socket || socket.__saffulKkPlaceholderGate) return socket
  const target = socket.placeholderResendCache
  if (!target || typeof target.get !== 'function') return socket
  target.get = id => get(id)
  target.set = (id, value) => set(id, value)
  target.del = id => del(id)
  target.flushAll = () => cache.flushAll()
  socket.__saffulKkPlaceholderGate = true
  return socket
}

module.exports = { cache, allow, refund, charged, settle, spent, reset, installCache,
  PER_HOUR, WINDOW_MS, HOLD_MS, ENABLED }
