'use strict'

// `.kk` / `.vv` phone budget.
//
// Every placeholder-resend request makes the primary phone show
// "Finished syncing with WhatsApp on Chrome". On a busy account that notice
// fires again and again, so asking the phone has to be rare and deliberate:
// the view-once path gets a small hourly allowance and nothing else is added
// here. The normal retry-receipt repair (the sender re-encrypts for this
// device) is untouched, because that never asks the phone.
//
// The budget and the placeholder gate live together in
// safful-kk-placeholder.js (a port of TurboFex core/placeholder.js). This
// module keeps the historical API used by the capture store and the tests.
//
// SAFFUL_KK_RESEND_PER_HOUR = 4 by default; 0 disables phone requests.

const { logLine } = require('./safful-kk-log')
const gate = require('./safful-kk-placeholder')

const PER_HOUR = gate.PER_HOUR
const WINDOW_MS = gate.WINDOW_MS

// Wrap the socket helper so any caller (not only `.kk`) respects the budget.
// Baileys' own automatic retries live inside the socket and never reach this
// wrapper, so decryption recovery keeps working exactly as before. The gate is
// installed first so those automatic requests are dropped instead of racing
// the deliberate one for the same message id.
function install(socket) {
  if (!socket) return socket
  gate.installCache(socket)
  if (socket.__saffulKkPhoneBudget || typeof socket.requestPlaceholderResend !== 'function') return socket
  const original = socket.requestPlaceholderResend.bind(socket)
  socket.requestPlaceholderResend = async (messageKey, msgData) => {
    const id = messageKey?.id
    if (!gate.charged(id) && !gate.allow(id)) return undefined
    try {
      const result = await original(messageKey, msgData)
      logLine('phone-request', id, 'result=' + String(result))
      return result
    } catch (error) {
      gate.refund(id)
      logLine('phone-request-failed', id, error?.message || String(error))
      throw error
    } finally {
      gate.settle(id)
    }
  }
  socket.__saffulKkPhoneBudget = true
  return socket
}

module.exports = { allow: gate.allow, refund: gate.refund, charged: gate.charged,
  settle: gate.settle, spent: gate.spent, reset: gate.reset, install,
  PER_HOUR, WINDOW_MS }
