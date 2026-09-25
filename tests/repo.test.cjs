'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')

const filename = path.resolve(__dirname, '..', 'plugins', 'repo.js')
function load() {
  const module = { exports: {} }
  const registered = []
  const native = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    require: key => key === '../lib/plugins' ? { cmd: (options, handler) => registered.push({ options, handler }) } : native(key),
    process, console, Buffer,
  }, { filename })
  return { ...module.exports, registered }
}

test('repo command sends supplied image with an unformatted clickable HTTPS URL', async () => {
  const plugin = load()
  const sent = []
  const message = { chat: 'team@g.us', bot: { sendMessage: async (...args) => sent.push(args) } }
  await plugin.repo(message)
  assert.equal(plugin.registered[0].options.pattern, 'repo')
  assert.equal(sent.length, 1)
  assert.ok(Buffer.isBuffer(sent[0][1].image))
  assert.equal(sent[0][1].image.subarray(0, 2).toString('hex'), 'ffd8')
  assert.match(sent[0][1].caption, /https:\/\/github\.com\/godfada-sa\/5AFFUL-BOT(?:\s|$)/)
  assert.doesNotMatch(sent[0][1].caption, /\]\(https:\/\//)
})

test('repo falls back to text with the same URL if image delivery fails', async () => {
  const { repo } = load()
  const sent = []
  const message = { chat: 'team@g.us', bot: { sendMessage: async (_chat, payload) => {
    sent.push(payload)
    if (payload.image) throw new Error('media unavailable')
  } } }
  await repo(message)
  assert.equal(sent.length, 2)
  assert.match(sent[1].text, /https:\/\/github\.com\/godfada-sa\/5AFFUL-BOT/)
})
