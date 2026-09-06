'use strict'

// ---------------------------------------------------------------------------
// SAFFUL-MD command menu — terminal / anonymous style canvas renderer.
// Green-on-black terminal look: window chrome, typed prompt lines, mono
// readouts, faint Kali-dragon watermark. Readable replacement of the old
// obfuscated Suhail menu; draws with portable canvas APIs only.
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const { createCanvas, loadImage } = require('canvas')
const { cmd, commands } = require('../lib/plugins')
const Config = require('../config')

const WIDTH = 1440
const COLUMNS = 3
const COL_GAP = 26
const COL_MARGIN = 56
const COL_WIDTH = Math.floor((WIDTH - COL_MARGIN * 2 - COL_GAP * (COLUMNS - 1)) / COLUMNS)
const TITLE_BAR = 54
const HEADER_ZONE = 300
const FOOTER = 64
const MIN_HEIGHT = 1080
const BOTNAME = String(Config.botname || 'SAFFUL BOT')
let VERSION = '1.0.1'
try { VERSION = require('../package.json').version || VERSION } catch {}

// Red + blue terminal palette (green-free)
const RED = '#ff3b52'
const RED_SOFT = '#ff5a6a'
const RED_DIM = '#8f2a38'
const BLUE = '#3d9bff'
const BLUE2 = '#5fb0ff'
const BLUE_DIM = '#2c6fbe'
const TEXT = '#cfdbff'          // command names / light blue-white text
const SOFT = '#aab8e8'
const DIM = '#5a6f9e'           // dim slate
const FAINT = '#26365c'         // very dim
const BG = '#070b16'
const CHROME = '#111a30'

// Legacy Suhail-era commands hidden from the menu (still respond if typed).
const HIDDEN_MENU_COMMANDS = new Set([
  'play', 'tts', 'tgs', 'tiktokold', 'wikimedia', 'ytdoc', 'ytmp3',
])

// Kali Linux neofetch dragon (plain ASCII only).
const KALI_DRAGON = [
  '            _,met$$$$$gg.',
  '         ,g$$$$$$$$$$$$$$$P.',
  '      ,g$$P"     """Y$$.".',
  '     ,$$P\'              `$$$.',
  '   \',$$P       ,ggs.     `$$b:',
  '   `d$$\'     ,$P"\'   .    $$$',
  '    $$P      d$\'     ,    $$P',
  '    $$:      $$.   -     ,d$$\'',
  '    $$\\;      Y$b._   _,d$P\'',
  '    Y$$.    `.`"Y$$$$P"\'',
  '    `$$b      "-.__',
  '     `Y$$',
  '      `Y$$.',
  '        `$$b.',
  '          `Y$$b.',
  '            `"Y$b._',
  '                `"""',
]

const MONO = '"DejaVu Sans Mono", "Courier New", monospace'

function roundedRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

function displayName(category) {
  return String(category || 'MISC').replace(/_+/g, ' ')
}

function formatRuntime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60
  if (hours) return `${hours}h ${minutes}m`
  if (minutes) return `${minutes}m ${secs}s`
  return `${secs}s`
}

function namesOf(command) {
  return [command && (command.pattern || command.cmdname), command && command.cat]
    .concat(Array.isArray(command && command.alias) ? command.alias : [])
    .filter(Boolean)
    .map(name => String(name).toLowerCase().trim())
}

function socketFor(message) {
  return message && (message.bot || message.client) || global.__saffulLatestSocket
}

// Group commands by category, balanced into columns by estimated height.
function orderedCommandGroups(commandList) {
  const groups = []
  for (const command of commandList) {
    const category = String(command.category || command.cat || 'MISC').toUpperCase()
    let group = groups.find(item => item.category === category)
    if (!group) {
      group = { category, items: [] }
      groups.push(group)
    }
    const name = String(command.pattern || command.cmdname || command.cmd || '').trim()
    if (name && !HIDDEN_MENU_COMMANDS.has(name.toLowerCase())) group.items.push(name)
  }
  for (const group of groups) group.items = [...new Set(group.items)].sort()
  const populated = groups.filter(group => group.items.length > 0)
  const order = {
    GENERAL: 0, DOWNLOADER: 1, CONVERTER: 2, STICKER: 3, AUTOMOD: 4, SPORTS: 5, PDF: 6,
    FUN: 7, GROUP: 8, PROTECTION: 9, SETTINGS: 10, OWNER: 11, CHATBOT: 12, STATUS: 13,
  }
  populated.sort((a, b) =>
    (order[a.category] === undefined ? 99 : order[a.category]) -
    (order[b.category] === undefined ? 99 : order[b.category]) ||
    a.category.localeCompare(b.category))
  return populated
}

// Consumed vertical space of one group (chip → rows → gap to next chip).
// The draw loop advances the row cursor once per item (including the last),
// so a group with n items consumes: first-row baseline offset + n * ROW_STEP
// + the trailing gap to the next chip. The estimator MUST match that exactly
// or columns drift downward and the last chips run into the footer.
const ROW_STEP = 36
const FIRST_ROW_BASELINE = 76
const AFTER_GROUP = 24
function estimateGroupHeight(group) {
  return FIRST_ROW_BASELINE + group.items.length * ROW_STEP + AFTER_GROUP
}

async function renderMenuImage(commandList) {
  const groups = orderedCommandGroups(commandList)
  const totalCommands = commandList.filter(command => command.pattern || command.cmdname || command.cmd).length

  const columns = Array.from({ length: COLUMNS }, () => ({ groups: [], height: 0 }))
  for (const group of groups) {
    const column = columns.reduce((a, b) => (b.height < a.height ? b : a))
    column.groups.push(group)
    column.height += estimateGroupHeight(group)
  }
  const contentHeight = Math.max(...columns.map(column => column.height))
  // Keep a generous band of dark air below the tallest column so the last
  // command rows can never crowd or touch the footer bar.
  const BOTTOM_AIR = 100
  const height = Math.max(MIN_HEIGHT, TITLE_BAR + HEADER_ZONE + contentHeight + FOOTER + BOTTOM_AIR)

  const canvas = createCanvas(WIDTH, height)
  const ctx = canvas.getContext('2d')

  // ── background ──────────────────────────────────────────────────────────
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, WIDTH, height)

  // ── Kali dragon watermark (right side, very faint) ─────────────────────
  const dragonX = WIDTH - 360
  const dragonTop = Math.max(340, TITLE_BAR + 180)
  ctx.font = `400 22px ${MONO}`
  ctx.fillStyle = 'rgba(61,155,255,0.05)'
  KALI_DRAGON.forEach((line, index) => {
    ctx.fillText(line, dragonX, dragonTop + index * 23)
  })

  // ── window title bar ───────────────────────────────────────────────────
  ctx.fillStyle = CHROME
  ctx.fillRect(0, 0, WIDTH, TITLE_BAR)
  const barGradient = ctx.createLinearGradient(0, 0, WIDTH, 0)
  barGradient.addColorStop(0, RED)
  barGradient.addColorStop(1, BLUE)
  ctx.fillStyle = barGradient
  ctx.fillRect(0, TITLE_BAR - 3, WIDTH, 3)
  const dots = ['#ff4d5d', '#ffb02e', '#4d9fff']
  dots.forEach((color, index) => {
    ctx.beginPath()
    ctx.arc(28 + index * 26, TITLE_BAR / 2, 8, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
  })
  ctx.font = `500 18px ${MONO}`
  ctx.textAlign = 'center'
  ctx.fillStyle = SOFT
  ctx.fillText('root@safful: ~/safful-md  —  anonymous', WIDTH / 2, TITLE_BAR / 2 + 6)
  ctx.textAlign = 'right'
  ctx.fillStyle = BLUE2
  ctx.fillText('[ SYSTEM ONLINE ]', WIDTH - 24, TITLE_BAR / 2 + 6)
  ctx.textAlign = 'left'

  // ── header: typed prompt lines ─────────────────────────────────────────
  const lineHeight = 30
  let y = TITLE_BAR + 42
  ctx.font = `500 21px ${MONO}`
  const segments = (x, parts) => {
    let cursor = x
    for (const [text, color] of parts) {
      ctx.fillStyle = color
      ctx.fillText(text, cursor, y)
      cursor += ctx.measureText(text).width
    }
    return cursor
  }
  // ── avatar (brand logo, frameless and large like the original menu) ────
  const avatarSize = 132
  const avatarX = 190 - avatarSize - 34
  const avatarY = TITLE_BAR + 46
  const logoPath = path.join(__dirname, '..', 'lib', 'assets', 'safful-menu.jpg')
  let logo = null
  if (fs.existsSync(logoPath)) {
    try { logo = await loadImage(logoPath) } catch {}
  }
  if (logo) ctx.drawImage(logo, avatarX, avatarY, avatarSize, avatarSize)

  const leftX = 190
  const type = [
    [['#', RED_SOFT], ['  whoami', TEXT]],
    [['anonymous', TEXT], ['   uid=0(root)  @  kali:safful', FAINT]],
    [['#', RED_SOFT], ['  ./menu --modules', BLUE2]],
    [['>', RED_SOFT], ['  scanning registry...  ', BLUE2], [String(totalCommands), TEXT], ['  decrypted', BLUE2], ['   [OK]', BLUE]],
  ]
  for (const parts of type) {
    y += lineHeight
    const end = segments(leftX, parts)
    if (parts === type[type.length - 1]) {
      // terminal cursor block
      ctx.fillStyle = 'rgba(61,155,255,0.85)'
      ctx.fillRect(end + 8, y - 18, 11, 21)
    }
  }

  // ── header: readout block (right side, aligned colons) ─────────────────
  const now = new Date()
  const reads = [
    ['commands', String(totalCommands), RED_SOFT],
    ['uptime', formatRuntime(process.uptime()), BLUE2],
    ['memory', `${Math.round(process.memoryUsage().rss / 1024 / 1024)} MB`, TEXT],
    ['date', now.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }), SOFT],
    ['time', now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }), BLUE2],
  ]
  ctx.font = `500 21px ${MONO}`
  reads.forEach(([label, value, color], index) => {
    const rowY = TITLE_BAR + 60 + index * 32
    ctx.fillStyle = DIM
    ctx.fillText(String(label).padEnd(10) + ' :', WIDTH - 430, rowY)
    ctx.fillStyle = RED_DIM
    ctx.fillText(':', WIDTH - 430 + ctx.measureText(String(label).padEnd(10) + ' ').width, rowY)
    ctx.fillStyle = color
    ctx.fillText(value, WIDTH - 430 + ctx.measureText(String(label).padEnd(10) + ' : ').width, rowY)
  })
  ctx.fillStyle = FAINT
  ctx.fillText('--[ root access granted ]--', WIDTH - 430, TITLE_BAR + 60 + reads.length * 32 + 6)

  // ── content columns ─────────────────────────────────────────────────────
  const startY = HEADER_ZONE + 46
  columns.forEach((column, columnIndex) => {
    let colY = startY
    const x = COL_MARGIN + columnIndex * (COL_WIDTH + COL_GAP)
    for (const group of column.groups) {
      // section header: red strip + "# NAME" with count on the right
      roundedRect(ctx, x, colY, COL_WIDTH, 44, 7)
      ctx.fillStyle = 'rgba(61,155,255,0.06)'
      ctx.fill()
      ctx.strokeStyle = 'rgba(77,163,255,0.25)'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.fillStyle = RED
      ctx.fillRect(x, colY + 6, 4, 28)

      ctx.font = `700 22px ${MONO}`
      ctx.fillStyle = TEXT
      ctx.fillText(displayName(group.category), x + 18, colY + 29)
      ctx.font = `500 20px ${MONO}`
      ctx.fillStyle = BLUE2
      const countText = `[${group.items.length}]`
      ctx.fillText(countText, x + COL_WIDTH - 18 - ctx.measureText(countText).width, colY + 29)

      let rowY = colY + FIRST_ROW_BASELINE
      ctx.font = `500 22px ${MONO}`
      for (const item of group.items) {
        ctx.fillStyle = RED_DIM
        ctx.fillText('$', x + 14, rowY)
        ctx.fillStyle = BLUE
        ctx.fillText('.', x + 30, rowY)
        ctx.fillStyle = TEXT
        ctx.fillText(item, x + 40, rowY)
        rowY += ROW_STEP
      }
      colY = rowY + AFTER_GROUP
    }
  })

  // subtle CRT scanlines over the content area
  ctx.fillStyle = 'rgba(0,0,0,0.045)'
  for (let scanY = TITLE_BAR; scanY < height - FOOTER; scanY += 4) {
    ctx.fillRect(0, scanY, WIDTH, 1)
  }

  // ── footer ──────────────────────────────────────────────────────────────
  ctx.fillStyle = CHROME
  ctx.fillRect(0, height - FOOTER, WIDTH, FOOTER)
  ctx.fillStyle = barGradient
  ctx.fillRect(0, height - FOOTER, WIDTH, 3)
  ctx.font = `500 19px ${MONO}`
  ctx.fillStyle = DIM
  ctx.fillText('tip: .menu <command>  for usage details', COL_MARGIN, height - FOOTER / 2 + 6)
  ctx.fillStyle = RED_SOFT
  ctx.fillText('root@safful:~#', WIDTH - 560, height - FOOTER / 2 + 6)
  ctx.fillStyle = TEXT
  ctx.fillText(' exit', WIDTH - 560 + ctx.measureText('root@safful:~#').width, height - FOOTER / 2 + 6)
  ctx.fillStyle = FAINT
  ctx.textAlign = 'right'
  ctx.fillText('kali dragon edition', WIDTH - 200, height - FOOTER / 2 + 6)
  ctx.fillStyle = RED_SOFT
  ctx.fillText(`v${VERSION}`, WIDTH - 24, height - FOOTER / 2 + 6)
  ctx.textAlign = 'left'

  return canvas.toBuffer('image/png')
}

function commandDetail(message, query) {
  const needle = String(query || '').toLowerCase().trim()
  const match = commands.find(command => namesOf(command).includes(needle))
  if (!match) {
    return `*${needle}* was not found in the command list.\nSend *${Config.HANDLERS || '.'}menu* to see all commands.`
  }
  const prefix = String(Config.HANDLERS || '.')[0] || '.'
  const aliases = (Array.isArray(match.alias) && match.alias.length)
    ? match.alias.map(alias => `${prefix}${alias}`).join(', ')
    : 'none'
  const use = match.use || match.usage
  return [
    `*${BOTNAME} — Command info*`,
    '',
    `Command: *${prefix}${String(match.pattern || match.cmdname)}*`,
    `Description: ${match.desc || match.description || 'No description provided.'}`,
    `Category: ${displayName(match.category || match.cat || 'MISC')}`,
    `Aliases: ${aliases}`,
    use ? `Usage: ${prefix}${String(match.pattern || match.cmdname)} ${use}` : '',
  ].filter(Boolean).join('\n')
}

cmd({
  pattern: 'menu',
  alias: ['help', 'commands', 'menu2', 'allmenu'],
  desc: 'Show the full command menu (image) — or .menu <command> for details',
  category: 'general',
  filename: __filename,
}, async (message, text) => {
  const query = String(text || '').trim()
  if (query) return message.reply(commandDetail(message, query))

  const socket = socketFor(message)
  if (!socket || typeof socket.sendMessage !== 'function') {
    const groups = orderedCommandGroups(commands)
    const lines = [`*${BOTNAME} — Command Menu*`, '']
    for (const group of groups) {
      lines.push(`*${displayName(group.category)}*`)
      lines.push(group.items.map(item => `${String(Config.HANDLERS || '.')[0] || '.'}${item}`).join('  '))
      lines.push('')
    }
    return message.reply(lines.join('\n'))
  }

  let image
  try {
    image = await renderMenuImage(commands)
  } catch (error) {
    console.error('[menu] render failed:', error)
    return message.reply('Could not render the menu image. Try `.menu <command>` for details instead.')
  }
  const caption = `*${BOTNAME} Command Menu*\n📌 Send *${String(Config.HANDLERS || '.')[0] || '.'}menu <command>* for usage of a single command.`
  try {
    return await socket.sendMessage(message.chat, { image, caption }, { quoted: message })
  } catch (error) {
    console.error('[menu] send failed:', error)
    return message.reply('Could not send the menu image. Try `.menu <command>` for details instead.')
  }
})

module.exports = {
  orderedCommandGroups,
  renderMenuImage,
  displayName,
}
