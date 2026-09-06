// ---------------------------------------------------------------------------
// Chatbot Off / On  —  .chatbot off | .chatbot on | .chatbot
//
// "chatbot off" temporarily pauses the bot: every incoming chat message is
// ignored (commands, auto handlers and replies). Only the owner / the bot's
// own number may still type `.chatbot on` to bring it back.
//
// The pause flag is `global.saffulChatbotPaused`, which the message dispatcher
// in lib/smd.js checks before processing any message.
//
// The state is persisted to .safful-data/chatbot-state.json so a restart or
// redeploy does NOT silently turn the bot back on.
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const { cmd } = require('../lib/plugins')

const STATE_DIR = path.join(__dirname, '..', '.safful-data')
const STATE_FILE = path.join(STATE_DIR, 'chatbot-state.json')

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed.paused === 'boolean' ? parsed.paused : false
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      console.log('[chatbot] could not read state file:', error.message || error)
    }
    return false
  }
}

function saveState(paused) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify({ paused, updatedAt: new Date().toISOString() }, null, 2))
  } catch (error) {
    console.log('[chatbot] could not save state file:', error.message || error)
  }
}

// Restore the persisted state as early as possible so every guard in
// lib/smd.js / statusauto / status-save starts with the correct value.
global.saffulChatbotPaused = loadState()
// Tracks which owner-DM chats already got the "Bot is OFF" notice during the
// current pause session (reset on every .chatbot off / .chatbot on).
if (!(global.saffulChatbotPausedDmNotified instanceof Set)) global.saffulChatbotPausedDmNotified = new Set()
// Restore confirmation is intentionally silent — the pause state is visible
// to the owner via `.chatbot` and would otherwise add a boot-time line that
// duplicates the command output.

function isBotOwner(m, meta) {
  const fromMeta = meta && (meta.isCreator === true || meta.isSuhail === true)
  const fromMsg = m && (m.isCreator === true || m.isSuhail === true)
  return fromMeta || fromMsg
}

function chatbotState() {
  return global.saffulChatbotPaused === true
}

cmd(
  {
    pattern: 'chatbot',
    alias: [],
    desc: 'Pause or resume the bot. Usage: .chatbot off | .chatbot on | .chatbot',
    category: 'CHATBOT',
    filename: __filename,
  },
  async (m, args, meta) => {
    try {
      if (!isBotOwner(m, meta)) {
        return await m.reply('*Owner only*')
      }
      const arg = String(args || '').trim().toLowerCase()
      const paused = chatbotState()
      if (/^(off|disable|stop|pause|halt|shut|false|0)\b/.test(arg)) {
        if (paused) return await m.reply('Chatbot is already *OFF* — this survives restarts. Send `.chatbot on` to resume.')
        global.saffulChatbotPaused = true
        global.saffulChatbotPausedDmNotified = new Set()
        saveState(true)
        return await m.reply('Chatbot is now *OFF* — all commands are paused (also after a restart). Send `.chatbot on` to resume.')
      }
      if (/^(on|enable|start|resume|true|1)\b/.test(arg)) {
        if (!paused) return await m.reply('Chatbot is already *ON*.')
        global.saffulChatbotPaused = false
        if (global.saffulChatbotPausedDmNotified instanceof Set) global.saffulChatbotPausedDmNotified.clear()
        saveState(false)
        return await m.reply('Chatbot is now *ON* — the bot is fully back online.')
      }
      return await m.reply(
        paused
          ? 'Chatbot is currently *OFF* — all commands are paused (state survives restarts).\nSend `.chatbot on` to resume.'
          : 'Chatbot is currently *ON*.\nSend `.chatbot off` to pause everything.'
      )
    } catch (error) {
      console.log('[chatbot] error:', error)
      return m.reply('*ERROR* ' + (error && error.message ? error.message : error))
    }
  }
)
