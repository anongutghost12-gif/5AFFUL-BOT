'use strict'

// ---------------------------------------------------------------------------
// Silent tag family — replaces the obfuscated group-bundle .tag / .hidetag,
// .tagadmin, .tagnotadmin and .all commands.
//
// The originals echoed whatever text you typed (or the quoted message's text)
// back into the group as the mention body — so a tag "reprinted" content, and
// replying to a media message produced an empty reprint. These replacements
// NEVER echo anything: every member/subset is pinged through hidden mentions
// with an empty body, i.e. a silent tag.
//   .tag / .all        → mention every group member
//   .tagadmin          → mention only the group admins
//   .tagnotadmin       → mention everyone except the admins
// No admin requirement — usable by any group member, like the old commands.
// ---------------------------------------------------------------------------
const { cmd, commands } = require('../lib/plugins')

const TAG_NAMES = new Set(['tag', 'hidetag', 'tagadmin', 'tagnotadmin', 'tagmembers', 'tagallmembers', 'all'])

function namesOf(command) {
  return [command && command.pattern, command && command.cmdname]
    .concat(Array.isArray(command && command.alias) ? command.alias : [])
    .filter(Boolean)
    .map(name => String(name).toLowerCase().trim())
}

// Drop every legacy tag-family registration (the group bundle loads before
// this file alphabetically). Never drop our own registrations, and sweep
// again next tick so stragglers registered later are caught too.
function removeLegacyTagCommands() {
  for (let index = commands.length - 1; index >= 0; index--) {
    const command = commands[index]
    if (command && command.filename !== __filename && namesOf(command).some(name => TAG_NAMES.has(name))) {
      commands.splice(index, 1)
    }
  }
}
removeLegacyTagCommands()
setImmediate(removeLegacyTagCommands)

function socketFor(message) {
  return (message && (message.bot || message.sock || message.client || message.sck)) || global.__saffulLatestSocket
}

async function groupParticipants(sock, chat) {
  try {
    const metadata = typeof sock.groupMetadata === 'function' ? await sock.groupMetadata(chat) : null
    return (metadata && metadata.participants) || []
  } catch {
    return []
  }
}

async function silentTag(message, filter) {
  if (!message || !message.isGroup) {
    if (message && typeof message.reply === 'function') return message.reply('*This command can only be used in a group.*')
    return undefined
  }
  const sock = socketFor(message)
  if (!sock || typeof sock.sendMessage !== 'function') {
    return message.reply('*Could not reach the WhatsApp connection.*')
  }
  const participants = await groupParticipants(sock, message.chat)
  const jids = [...new Set(participants
    .filter(filter || (() => true))
    .map(p => p && p.id)
    .filter(id => id && String(id).includes('@')))]
  if (!jids.length) {
    return message.reply('*Could not load the group members.*')
  }
  try {
    // Empty body + hidden mentions = a silent tag. Nothing is echoed.
    await sock.sendMessage(message.chat, { text: '', mentions: jids })
  } catch (emptyBodyError) {
    // Some WhatsApp servers refuse a fully empty body — fall back to an
    // invisible character so the tag still goes out silently.
    try {
      await sock.sendMessage(message.chat, { text: '\u200b', mentions: jids })
    } catch (fallbackError) {
      return message.reply('*Silent tag failed:* ' + String((fallbackError && fallbackError.message) || fallbackError).slice(0, 120))
    }
  }
  return undefined
}

cmd({
  pattern: 'tag',
  alias: ['hidetag'],
  desc: 'Silently mention everyone in the group — no text is echoed back',
  category: 'group',
  filename: __filename,
}, async (message) => silentTag(message))

cmd({
  pattern: 'all',
  desc: 'Silently mention everyone in the group — no text is echoed back',
  category: 'group',
  filename: __filename,
}, async (message) => silentTag(message))

cmd({
  pattern: 'tagadmin',
  desc: 'Silently mention only the group admins — no text is echoed back',
  category: 'group',
  filename: __filename,
}, async (message) => silentTag(message, p => p && p.admin))

cmd({
  pattern: 'tagnotadmin',
  alias: ['tagmembers', 'tagallmembers'],
  desc: 'Silently mention every member except the admins — no text is echoed back',
  category: 'group',
  filename: __filename,
}, async (message) => silentTag(message, p => p && !p.admin))
