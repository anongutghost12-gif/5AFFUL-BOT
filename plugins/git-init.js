'use strict'

const fs = require('fs')
const path = require('path')
const { cmd } = require('../lib/plugins')
const { isOwner } = require('../lib/safful-mode')
const { PROJECT_ROOT, runProcess, runUpdate, shortResult } = require('./owner-tools')

const REPO_URL = String(process.env.GIT_REPO_URL || 'https://github.com/godfada-sa/5AFFUL-BOT.git').trim()

async function gitInit(message) {
  if (!isOwner(message)) return message.reply('❌ Owner only.')
  if (fs.existsSync(path.join(PROJECT_ROOT, '.git'))) {
    return runUpdate(message, { restart: false })
  }
  const version = await runProcess('git', ['--version'], 30000)
  if (!version.ok) return message.reply(`❌ Git is unavailable: ${shortResult(version)}`)
  // Initializing metadata does not overwrite the unpacked application or its session.
  const init = await runProcess('git', ['init'], 30000)
  if (!init.ok) return message.reply(`❌ Git initialization failed: ${shortResult(init)}`)
  const remote = await runProcess('git', ['remote', 'add', 'origin', REPO_URL], 30000)
  if (!remote.ok) return message.reply(`❌ Could not configure origin: ${shortResult(remote)}`)
  const fetch = await runProcess('git', ['fetch', 'origin', 'main'], 4 * 60 * 1000)
  if (!fetch.ok) return message.reply(`❌ Git fetch failed: ${shortResult(fetch)}`)
  // Do not force-checkout over ZIP files or touch the WhatsApp session.
  const checkout = await runProcess('git', ['checkout', '-b', 'main', '--track', 'origin/main'], 60000)
  if (!checkout.ok) return message.reply(`❌ Git fetched the repository but could not safely check it out over existing files: ${shortResult(checkout)}. No files were removed.`)
  return message.reply('✅ Repository initialized and pulled. Session untouched. Use `.update` to deploy/restart.')
}

cmd({ pattern: 'gitinit', alias: ['gitsetup', 'gitfix'], desc: 'Fetch GitHub repository without restarting or deleting session', category: 'owner', filename: __filename }, gitInit)
module.exports = { REPO_URL, gitInit }
