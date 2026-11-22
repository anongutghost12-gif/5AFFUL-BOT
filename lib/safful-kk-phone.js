'use strict'

// Port of TurboFex's core/placeholder.js budget, adapted to `.kk`.
//
// Every placeholder-resend request makes the primary phone show
// "Finished syncing with WhatsApp on Chrome". On a busy account that notice
// fires again and again, so asking the phone has to be rare and deliberate:
// the view-once path gets a small hourly allowance and nothing else is added
// here. The normal retry-receipt repair (the sender re-encrypts for this
// device) is untouched, because that never asks the phone.
//
// SAFFUL_KK_RESEND_PER_HOUR = 4 by default; 0 disables phone requests.

const { logLine } = require('./safful-kk-log')

const WINDOW_MS = 60 * 60 * 1000
const configured = Number(process.env.SAFFUL_KK_RESEND_PER_HOUR)
const PER_HOUR = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : 4

const asks = [] // { id, at } inside the rolling hour
const allowed = new Set() // ids already charged, so a wrapper does not charge twice

function prune(now) {
  while (asks.length && now - asks[0].at > WINDOW_MS) asks.shift()
}

// Reserve one request for this message id. False means: do not ask now.
function allow(id) {
  if (!id) return false
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
  return true
}

// A request that never reached the phone should not cost a slot.
function refund(id) {
  if (!id) return
  allowed.delete(id)
  for (let i = asks.length - 1; i >= 0; i--) {
    if (asks[i].id === id) { asks.splice(i, 1); return }
  }
}

// True when this id was already charged by allow().
function charged(id) {
  return Boolean(id) && allowed.has(id)
}

function settle(id) {
  allowed.delete(id)
}

function spent() {
  prune(Date.now())
  return { used: asks.length, limit: PER_HOUR }
}

function reset() {
  asks.length = 0
  allowed.clear()
}

// Wrap the socket helper so any caller (not only `.kk`) respects the budget.
// Baileys' own automatic retries live inside the socket and never reach this
// wrapper, so decryption recovery keeps working exactly as before.
function install(socket) {
  if (!socket || socket.__saffulKkPhoneBudget || typeof socket.requestPlaceholderResend !== 'function') return socket
  const original = socket.requestPlaceholderResend.bind(socket)
  socket.requestPlaceholderResend = async (messageKey, msgData) => {
    const id = messageKey?.id
    if (!charged(id) && !allow(id)) return undefined
    try {
      const result = await original(messageKey, msgData)
      logLine('phone-request', id, 'result=' + String(result))
      return result
    } catch (error) {
      refund(id)
      logLine('phone-request-failed', id, error?.message || String(error))
      throw error
    } finally {
      settle(id)
    }
  }
  socket.__saffulKkPhoneBudget = true
  return socket
}

module.exports = { allow, refund, charged, settle, spent, reset, install, PER_HOUR, WINDOW_MS }
