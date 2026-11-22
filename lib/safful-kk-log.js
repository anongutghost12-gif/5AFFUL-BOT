'use strict'

// Shared `.kk` trace.
//
// The bot is normally started by a panel, so asking the user to relaunch with
// an env var loses the evidence. A small on-disk file is the only reliable way
// to see what WhatsApp and the phone actually answered.
//
// Kept in its own module so the capture store, the phone budget and the media
// helper can all log without requiring each other.

const fs = require('fs')
const path = require('path')

const LOG_FILE = process.env.SAFFUL_KK_LOG || path.join(__dirname, '..', 'temp', 'kk.log')
const MAX_LOG_BYTES = 2 * 1024 * 1024

function render(part) {
  if (typeof part === 'string') return part
  try {
    return JSON.stringify(part, (_key, value) => (Buffer.isBuffer(value) ? '<' + value.length + 'B>' : value))
  } catch {
    return String(part)
  }
}

function logLine(...parts) {
  try {
    const line = new Date().toISOString() + ' ' + parts.map(render).join(' ') + '\n'
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    try { if (fs.statSync(LOG_FILE).size > MAX_LOG_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.1') } catch {}
    fs.appendFileSync(LOG_FILE, line)
  } catch {}
}

// Set SAFFUL_KK_DEBUG=1 to keep the console noisy as well.
function debugLog(...parts) {
  if (!/^(1|true|yes|on)$/i.test(String(process.env.SAFFUL_KK_DEBUG || ''))) return
  logLine(...parts)
  try { process.stderr.write('[kk] ' + parts.map(render).join(' ') + '\n') } catch {}
}

module.exports = { logLine, debugLog, LOG_FILE }
