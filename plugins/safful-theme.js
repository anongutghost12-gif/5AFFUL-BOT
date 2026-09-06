// ---------------------------------------------------------------------------
// Theme Switcher  —  .theme | .theme <name>
//
// The theme packs live in Themes/<NAME>.json and the obfuscated string loader
// (tlang/STRINGS) picks one ONCE at boot from process.env.THEME (uppercased).
// Because it is read at boot, a switch is persisted to .env and then applied
// by a controlled restart — exactly like the bot's own .restart flow, with the
// WhatsApp session snapshot first so the panel restart is never treated as a
// fresh login that would request a repair.
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const { cmd } = require('../lib/plugins')
const { isOwner } = require('../lib/safful-mode')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const THEMES_DIR = path.join(PROJECT_ROOT, 'Themes')
const ENV_FILE = path.join(PROJECT_ROOT, '.env')
const DEFAULT_THEME = 'SAFFUL'

function listThemes() {
  try {
    return fs
      .readdirSync(THEMES_DIR)
      .filter(f => /\.json$/i.test(f))
      .map(f => f.replace(/\.json$/i, '').toUpperCase())
      .sort()
  } catch (error) {
    return []
  }
}

function resolveThemeName(name) {
  const wanted = String(name || '').trim().toUpperCase().replace(/\.json$/i, '')
  if (!wanted) return ''
  return listThemes().includes(wanted) ? wanted : ''
}

function readEnvThemes() {
  let current = ''
  try {
    const text = fs.readFileSync(ENV_FILE, 'utf8')
    const match = text.match(/^THEME[ \t]*=[ \t]*([^\r\n]*)/m)
    if (match) current = String(match[1]).trim().toUpperCase()
  } catch (error) {
    // .env missing — default applies
  }
  return String(process.env.THEME || current || '').toUpperCase()
}

// Rewrites the THEME= line of .env, preserving every other line and the
// file's line endings. Returns { ok, theme } or { ok:false, reason }.
function setThemeInEnv(name) {
  const wanted = resolveThemeName(name)
  if (!wanted) return { ok: false, reason: 'no such theme' }
  try {
    let text = ''
    try {
      text = fs.readFileSync(ENV_FILE, 'utf8')
    } catch (error) {
      text = ''
    }
    const eol = /\r\n/.test(text) ? '\r\n' : '\n'
    const line = `THEME=${wanted}`
    if (/^THEME[ \t]*=/m.test(text)) {
      text = text.replace(/^THEME[ \t]*=.*$/m, line)
    } else {
      if (text.length && !text.endsWith('\n')) text += eol
      text += `${line}${eol}`
    }
    fs.writeFileSync(ENV_FILE, text)
    process.env.THEME = wanted
    return { ok: true, theme: wanted }
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : String(error) }
  }
}

function formatList(current) {
  const themes = listThemes()
  const lines = themes.map(t => (t === current ? `  ▶ *${t}*` : `  ${t}`))
  const chunks = []
  for (let i = 0; i < lines.length; i += 4) chunks.push(lines.slice(i, i + 4))
  return chunks.map(chunk => chunk.join('\n')).join('\n')
}

cmd(
  {
    pattern: 'theme',
    alias: ['settheme', 'skin', 'themes'],
    desc: 'Show or switch the bot theme. Usage: .theme | .theme <name>',
    category: 'owner',
    filename: __filename,
  },
  async (m, args, meta) => {
    try {
      if (!isOwner(m, meta)) return await m.reply('*Owner only*')
      const arg = String(args || '').trim().toUpperCase()
      const current = readEnvThemes()
      const wanted = resolveThemeName(arg)
      const themes = listThemes()

      if (!themes.length) {
        return await m.reply('*No theme packs found.* Expected a `Themes/` folder with `*.json` files.')
      }
      if (!wanted) {
        return await m.reply(
          `*Theme: ${current || DEFAULT_THEME}*\n\n` +
            `Available themes:\n${formatList(current || DEFAULT_THEME)}\n\n` +
            `Use \`.theme <name>\` to switch — e.g. \`.theme ${themes[0]}\``
        )
      }
      if (wanted === current) {
        return await m.reply(`Theme is already *${wanted}*.`)
      }

      const saved = setThemeInEnv(wanted)
      if (!saved.ok) {
        return await m.reply(`❌ Could not save theme: ${saved.reason}`)
      }

      // Controlled restart with a session snapshot (same path as .restart) so
      // the switch applies at boot where the string loader reads THEME.
      let backup
      try {
        const { protectSession } = require('./owner-tools')
        backup = await protectSession('theme-switch')
      } catch (error) {
        backup = { saved: false, reason: error && error.message ? error.message : String(error) }
      }
      if (!backup.saved) {
        return await m.reply(
          `✅ Theme saved to *${wanted}* — it will apply on the next restart.\n` +
            `(Auto-restart skipped: ${backup.reason})`
        )
      }
      await m.reply(`🎨 Theme set to *${wanted}*. Restarting to apply…`)
      try {
        const { scheduleControlledRestart } = require('./owner-tools')
        scheduleControlledRestart(2000)
      } catch (error) {
        setTimeout(() => process.exit(1), 2000).unref?.()
      }
      return null
    } catch (error) {
      console.log('[theme] error:', error)
      return m.reply('*ERROR* ' + (error && error.message ? error.message : error))
    }
  }
)

module.exports = { listThemes, resolveThemeName, readEnvThemes, setThemeInEnv, DEFAULT_THEME }
