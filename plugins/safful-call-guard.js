// ---------------------------------------------------------------------------
// Call Guard — .rejectcall / .blockcall / .calldnd
//
// WhatsApp routes incoming calls through your linked phone, but Baileys also
// delivers a `call` event to the bot session while it rings. This plugin hooks
// that event and, depending on the configured rules, either:
//   • hangs up silently so the caller hears it declined (.rejectcall list),
//   • hangs up AND applies a real WhatsApp block so the number can no longer
//     call or message the bot at all (.blockcall list),
//   • rejects every incoming call while .calldnd on (do-not-disturb).
//
// The rules persist to .safful-data/callguard.json and survive restarts. Like
// the other raw hooks, everything goes quiet while `.chatbot off` is active.
// The socket-level API this uses is verified against the Baileys release this
// bot ships (7.0.0-rc14): ev.on('call', [..]) and rejectCall(callId, callFrom)
// — note the argument order, id first, then the caller jid.
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const { cmd } = require('../lib/plugins')
const { resolvePhone, phoneJid, isOperator } = require('../lib/safful-identities')
const stats = { offers: 0, rejected: 0, failed: 0, lastError: '' }

const SETTINGS_FILE = path.resolve(
  process.env.SAFFUL_CALLGUARD_FILE || path.join(__dirname, '..', '.safful-data', 'callguard.json')
)
const attachedSockets = new WeakSet()

function log(message) {
  process.stderr.write(`[callguard] ${message}\n`)
}

function defaults() {
  return { dnd: false, reject: [], block: [] }
}

function readSettings(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8') || '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function loadSettings() {
  const stored = readSettings(SETTINGS_FILE)
  const merged = defaults()
  if (stored) {
    merged.dnd = stored.dnd === true
    merged.reject = Array.isArray(stored.reject) ? stored.reject.map(String).filter(Boolean) : []
    merged.block = Array.isArray(stored.block) ? stored.block.map(String).filter(Boolean) : []
  }
  return merged
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  const temporary = `${SETTINGS_FILE}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(settings, null, 2), 'utf8')
  if (fs.existsSync(SETTINGS_FILE)) fs.copyFileSync(SETTINGS_FILE, `${SETTINGS_FILE}.bak`)
  fs.renameSync(temporary, SETTINGS_FILE)
}

// "2348031234567@s.whatsapp.net" / "…@lid" / "…:123@s.whatsapp.net" -> "2348031234567"
function digitsOf(value) {
  return String(value || '').split('@')[0].split(':')[0].replace(/\D/g, '')
}

function isValidNumber(number) {
  return /^\d{7,15}$/.test(String(number || ''))
}

function normalizeInputNumber(input) {
  return phoneJid(input).split('@')[0]
}

function listHas(list, value) {
  const digits = digitsOf(value)
  if (!digits) return false
  return (Array.isArray(list) ? list : []).some(entry => digitsOf(entry) === digits)
}

function addNumber(list, value) {
  const digits = normalizeInputNumber(value)
  if (!digits) return ''
  const next = (Array.isArray(list) ? list : []).filter(entry => digitsOf(entry) !== digits)
  next.push(digits)
  return { digits, list: next }
}

function removeNumber(list, value) {
  const digits = digitsOf(value)
  if (!digits) return null
  return (Array.isArray(list) ? list : []).filter(entry => digitsOf(entry) !== digits)
}

function formatNumberList(list) {
  const entries = Array.isArray(list) ? list : []
  if (!entries.length) return '_none_'
  const shown = entries.slice(0, 30).map(entry => `  • ${digitsOf(entry)}`).join('\n')
  const extra = entries.length > 30 ? `\n  …and ${entries.length - 30} more` : ''
  return shown + extra
}

// Never convert a LID into a phone number; resolve it through Baileys first.
function toWaJid(value) { return phoneJid(value) }

function liveSocket() {
  const socket = global.__saffulLatestSocket
  return socket && typeof socket?.rejectCall === 'function' ? socket : null
}

// ── Incoming-call handling ────────────────────────────────────────────────
function attach(socket) {
  if (!socket?.ev?.on || attachedSockets.has(socket)) return
  attachedSockets.add(socket)
  const handled = new Set(), pending = new Set()
  async function handle(call) {
    if (global.saffulChatbotPaused === true || !call || call.offline || !['offer', 'ringing'].includes(call.status)) return
    const from = call.from || call.chatId
    if (!from || !call.id) return
    const key = from + ':' + call.id
    if (handled.has(key) || pending.has(key)) return
    // Reserve before asynchronous LID resolution: raw + buffered events overlap.
    pending.add(key)
    try {
      stats.offers++
      const settings = loadSettings()
      const jid = await resolvePhone(socket, call.callerPn, from)
      if (from === socket.user?.lid || (jid && jid === phoneJid(socket.user?.id))) return
      const number = jid.split('@')[0]
      const block = Boolean(jid && listHas(settings.block, number))
      if (!settings.dnd && !block && !(jid && listHas(settings.reject, number))) return
      // Reject before any network block operation so a slow block cannot let
      // the call keep ringing. Keep the original creator JID for signaling.
      let rejected = false
      try {
        await socket.rejectCall(call.id, from)
        rejected = true
        stats.rejected++
      } catch (error) {
        stats.failed++
        stats.lastError = String(error.message || error).slice(0, 250)
        log('Reject failed: ' + stats.lastError)
      }
      if (block) {
        try { await socket.updateBlockStatus(jid, 'block') }
        catch (error) { stats.lastError = 'Block failed: ' + error.message; log(stats.lastError) }
      }
      if (rejected) {
        handled.add(key)
        if (handled.size > 1000) handled.delete(handled.values().next().value)
      }
    } catch (error) { stats.lastError = String(error.message || error); log(stats.lastError) }
    finally { pending.delete(key) }
  }
  socket.ev.on('call', async calls => {
    await Promise.all((Array.isArray(calls) ? calls : [calls]).map(handle))
  })
  // Baileys' public event may be delayed by event buffering while reconnecting.
  // The same handler deduplicates immediate raw offers and later public events.
  socket.ws?.on?.('CB:call', node => {
    // offer_notice nodes carry the same attrs as offer (Baileys maps both to 'offer').
    const info = Array.isArray(node.content) && node.content.find(child => ['offer', 'offer_notice', 'ringing'].includes(child.tag))
    if (!info) return
    void handle({ status: info.tag === 'offer_notice' ? 'offer' : info.tag, id: info.attrs?.['call-id'],
      from: info.attrs?.from || info.attrs?.['call-creator'], chatId: node.attrs?.from,
      callerPn: info.attrs?.caller_pn, offline: Boolean(node.attrs?.offline) })
  })
}

// ── Commands ──────────────────────────────────────────────────────────────
function ownerOnly(m, meta) {
  return isOperator(m, meta, meta?.Void || m.bot || liveSocket())
}

function usageReply(m, settings) {
  return m.reply(
    `*📵 Call Guard*\n\n` +
      `*Reject list* (auto hang-up, no block):\n${formatNumberList(settings.reject)}\n\n` +
      `*Block list* (real WhatsApp block):\n${formatNumberList(settings.block)}\n\n` +
      `*Do-not-disturb*: ${settings.dnd ? '🟢 ON — all calls rejected' : '⚪ OFF'}\n\n` +
      `Usage:\n` +
      `  .rejectcall <number>  — add to reject list\n` +
      `  .rejectcall del <number>  /  .rejectcall clear\n` +
      `  .blockcall <number>  — add to block list (blocks + rejects)\n` +
      `  .blockcall del <number>  /  .blockcall clear\n` +
      `  .calldnd on|off  — reject every incoming call\n\n` +
      `Since restart: ${stats.offers} offers/rings, ${stats.rejected} rejected, ${stats.failed} reject failures. ${stats.lastError}\n\n` +
      `Owner only. Add with country code, e.g. .rejectcall 2348012345678`
  )
}

async function mutateListCommand(m, args, meta, key, label) {
  try {
    if (!await ownerOnly(m, meta)) return m.reply('*Owner only*')
    const settings = loadSettings()
    const arg = String(args || '').trim()
    const lower = arg.toLowerCase()

    if (!arg || lower === 'list' || lower === 'show') {
      return m.reply(
        `*${label} list* (${settings[key].length})\n\n${formatNumberList(settings[key])}\n\n` +
          `Add: .${label.toLowerCase()}call <number> · Remove: .${label.toLowerCase()}call del <number> · Empty: .${label.toLowerCase()}call clear`
      )
    }
    if (lower === 'clear') {
      if (key === 'block') {
        const socket = meta?.Void || m.bot || liveSocket()
        for (const number of [...settings.block]) {
          await socket.updateBlockStatus(toWaJid(number), 'unblock')
          settings.block = removeNumber(settings.block, number)
          saveSettings(settings)
        }
      }
      settings[key] = []
      saveSettings(settings)
      return m.reply(`🗑️ ${label} list cleared.`)
    }
    const delMatch = arg.match(/^(?:del|delete|remove|rm)\s+(.+)$/i)
    if (delMatch) {
      const digits = normalizeInputNumber(delMatch[1])
      if (!digits) return m.reply('❌ That does not look like a phone number.')
      if (!listHas(settings[key], digits)) return m.reply(`ℹ️ ${digits} is not on the ${label.toLowerCase()} list.`)
      if (key === 'block') {
        const socket = meta?.Void || m.bot || liveSocket()
        await socket.updateBlockStatus(toWaJid(digits), 'unblock')
      }
      settings[key] = removeNumber(settings[key], digits)
      saveSettings(settings)
      return m.reply(`✅ Removed *${digits}* from the ${label.toLowerCase()} list.`)
    }

    const added = addNumber(settings[key], arg)
    if (!added) return m.reply('❌ Invalid number. Use the full number with country code, e.g. `2348012345678`.')
    settings[key] = added.list
    saveSettings(settings)
    if (key === 'block') {
      const jid = toWaJid(added.digits)
      const socket = meta?.Void || m.bot || liveSocket()
      if (socket?.updateBlockStatus && jid) {
        try {
          await socket.updateBlockStatus(jid, 'block')
          return m.reply(`🚫 Added *${added.digits}* to the block list — blocked on WhatsApp and calls will be auto-rejected.`)
        } catch (error) {
          return m.reply(
            `🚫 Added *${added.digits}* to the block list (WhatsApp rejected the instant block — ${error?.message || error}).\n` +
              `The number will still be auto-blocked the moment it calls.`
          )
        }
      }
      return m.reply(`🚫 Added *${added.digits}* to the block list. It will be blocked the next time it calls.`)
    }
    return m.reply(`🔇 Added *${added.digits}* to the reject list — its calls will be auto-rejected.`)
  } catch (error) {
    return m.reply('*ERROR* ' + (error && error.message ? error.message : error))
  }
}

cmd(
  {
    pattern: 'rejectcall',
    alias: ['rejcall', 'rejectcalls'],
    desc: 'Auto-reject calls from a number. Usage: .rejectcall <num> | del <num> | clear',
    category: 'call',
    filename: __filename,
  },
  async (m, args, meta) => {
    if (!await ownerOnly(m, meta)) return m.reply('*Owner only*')
    if (!String(args || '').trim() || /^(list|show)$/i.test(String(args).trim())) {
      const settings = loadSettings()
      return usageReply(m, settings)
    }
    return mutateListCommand(m, args, meta, 'reject', 'Reject')
  }
)

cmd(
  {
    pattern: 'blockcall',
    alias: ['callblock', 'blockcalls'],
    desc: 'WhatsApp-block a number and auto-reject its calls. Usage: .blockcall <num> | del <num> | clear',
    category: 'call',
    filename: __filename,
  },
  async (m, args, meta) => {
    if (!await ownerOnly(m, meta)) return m.reply('*Owner only*')
    if (!String(args || '').trim() || /^(list|show)$/i.test(String(args).trim())) {
      const settings = loadSettings()
      return usageReply(m, settings)
    }
    return mutateListCommand(m, args, meta, 'block', 'Block')
  }
)

cmd(
  {
    pattern: 'calldnd',
    alias: ['dndcall', 'calldndstatus'],
    desc: 'Reject every incoming call. Usage: .calldnd on | off',
    category: 'call',
    filename: __filename,
  },
  async (m, args, meta) => {
    try {
      if (!await ownerOnly(m, meta)) return m.reply('*Owner only*')
      const settings = loadSettings()
      const arg = String(args || '').trim().toLowerCase()
      if (arg === 'on' || arg === 'true' || arg === '1' || arg === 'yes' || arg === 'enable') {
        settings.dnd = true
        saveSettings(settings)
        return m.reply('🟢 *Do-not-disturb ON* — every incoming call will be rejected.')
      }
      if (arg === 'off' || arg === 'false' || arg === '0' || arg === 'no' || arg === 'disable') {
        settings.dnd = false
        saveSettings(settings)
        return m.reply('⚪ *Do-not-disturb OFF* — only listed numbers are handled.')
      }
      return m.reply(
        `*📵 Do-not-disturb*: ${settings.dnd ? '🟢 ON' : '⚪ OFF'}\nOffers/rings: ${stats.offers}; rejected: ${stats.rejected}; failures: ${stats.failed}. ${stats.lastError}\n\n` +
          `Use \`.calldnd on\` to reject every call, or \`.calldnd off\` to disable.`
      )
    } catch (error) {
      return m.reply('*ERROR* ' + (error && error.message ? error.message : error))
    }
  }
)

module.exports = {
  SETTINGS_FILE,
  stats,
  attach,
  digitsOf,
  isValidNumber,
  listHas,
  loadSettings,
  saveSettings,
  toWaJid,
}
