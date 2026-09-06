'use strict'
// .autoview — control the status auto-view engine (plugins/statusauto.smd).
//   .autoview            → status card
//   .autoview instant    → mark every status seen immediately (default)
//   .autoview <1-10>     → mark statuses seen after a delay of N minutes
//   .autoview off        → stop marking statuses seen

const { cmd } = require('../lib/plugins')
const autoview = require('./statusauto.smd')

function isOwner(message, extra) {
  if (extra?.ownerNumber || message?.isCreator) return true
  const ownerNumber = String(process.env.OWNER_NUMBER || global.owner || '').replace(/\D/g, '')
  const senders = [
    message?.sender,
    message?.senderNum,
    message?.key?.remoteJid,
    message?.key?.participant,
    message?.key?.participantAlt,
    message?.key?.remoteJidAlt,
    extra?.sender,
    extra?.mek?.key?.participant,
    extra?.mek?.key?.participantAlt,
  ]
  return Boolean(ownerNumber && senders.some(sender =>
    String(sender || '').replace(/\D/g, '') === ownerNumber))
}

cmd({
  pattern: 'autoview',
  alias: ['autoviewstatus', 'statusview'],
  desc: 'Auto-view statuses: instant, a 1-10 minute delay, or off',
  category: 'owner',
  use: 'instant | <1-10> | off | status',
  filename: __filename,
}, async (message, text, extra) => {
  autoview.attach(extra?.Void || message?.bot || global.__saffulLatestSocket)
  if (!isOwner(message, extra)) return message.reply('❌ This command is for the bot owner only.')

  const input = String(text || '').trim().toLowerCase()
  if (!input || input === 'status') {
    const mode = autoview.getMode()
    const state = mode === 'off'
      ? '*OFF* — statuses are not marked seen.'
      : mode === 'instant'
        ? '*INSTANT* — every status is marked seen immediately.'
        : `*DELAYED* — statuses are marked seen after *${mode} minute(s)*.`
    return message.reply('👁 *Auto-view*\nMode: ' + state +
      '\n\n`.autoview instant` — view immediately\n`.autoview <1-10>` — delay in minutes\n`.autoview off` — stop viewing')
  }

  try {
    const mode = autoview.setMode(input)
    if (mode === 'off') return message.reply('👁 Auto-view is now *OFF*. Pending statuses were cleared and nothing will be marked seen.')
    if (mode === 'instant') return message.reply('👁 Auto-view is now *INSTANT*. Every status is marked seen as it arrives.')
    return message.reply(`👁 Auto-view is now *DELAYED*. Statuses are marked seen after *${mode} minute(s)*.`)
  } catch {
    return message.reply('Usage: `.autoview instant`, `.autoview <1-10>`, or `.autoview off`.')
  }
})

module.exports = { isOwner }
