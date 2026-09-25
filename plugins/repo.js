'use strict'

const fs = require('fs')
const path = require('path')
const { cmd } = require('../lib/plugins')

const IMAGE_PATH = path.join(__dirname, '..', 'assets', 'repo', 'safful-repo.jpeg')
const DEFAULT_REPO = 'https://github.com/godfada-sa/5AFFUL-BOT'

function repoUrl() {
  const configured = String(process.env.GIT_REPO_URL || '').trim().replace(/\.git\/?$/, '')
  return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/i.test(configured) ? configured : DEFAULT_REPO
}

function repoCaption(url = repoUrl()) {
  return [
    '╭─〔 *SAFFUL // SOURCE ACCESS* 〕',
    '│  >_ system: online',
    '│  >_ module: public repository',
    '│  >_ access: granted',
    '╰────────────────────',
    '',
    '⚡ *Clone it. Explore it. Build on it.*',
    '',
    `🔗 ${url}`,
    '',
    '_Tap the raw link above to open the repository._',
  ].join('\n')
}

async function repo(message, _text, meta = {}) {
  const socket = meta.Void || message.bot
  const chat = message.chat || message.jid || message.key?.remoteJid
  const caption = repoCaption()
  if (!socket?.sendMessage || !chat) return message.reply(caption)
  try {
    await socket.sendMessage(chat, { image: fs.readFileSync(IMAGE_PATH), caption }, { quoted: message })
  } catch (error) {
    console.error('[repo] image send failed; sending text instead:', error)
    return socket.sendMessage(chat, { text: caption }, { quoted: message })
  }
}

cmd({ pattern: 'repo', alias: ['repository', 'sourcecode'], desc: 'Show the clickable source repository', category: 'general', filename: __filename }, repo)
module.exports = { IMAGE_PATH, DEFAULT_REPO, repoUrl, repoCaption, repo }
