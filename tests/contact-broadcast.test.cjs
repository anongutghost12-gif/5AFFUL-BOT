'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const root = path.resolve(__dirname, '..')

function load(file) {
  const filename = path.join(root, file)
  const module = { exports: {} }
  const native = createRequire(filename)
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), __filename: filename,
    require: key => key === '../lib/plugins' ? { cmd() {} } : native(key),
    Buffer, console, process, global, setTimeout,
  }, { filename })
  return module.exports
}

test('all-contacts export combines saved contacts and all group rosters, deduplicates LIDs, and sends CSV to sudo', async () => {
  const vcf = load('plugins/vcf.js')
  const sent = []
  const socket = {
    user: { id: '233240000001@s.whatsapp.net' },
    contacts: [{ id: '233240000002@s.whatsapp.net', name: 'Ama' }],
    groupFetchAllParticipating: async () => ({
      'a@g.us': { participants: [{ id: '900002@lid' }, { id: '233240000003@s.whatsapp.net', name: 'Kojo' }] },
      'b@g.us': { participants: [{ id: '900004@lid' }] },
    }),
    signalRepository: { lidMapping: { getPNForLID: async lid => lid === '900002@lid' ? '233240000002@s.whatsapp.net' : null } },
    sendMessage: async (...args) => sent.push(args),
  }
  await vcf.exportContacts({ chat: '233240000005@s.whatsapp.net', bot: socket }, 'all csv')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][0], socket.user.id)
  assert.equal(sent[0][1].fileName, 'all-known-contacts.csv')
  const csv = sent[0][1].document.toString('utf8')
  assert.match(csv, /Ama/)
  assert.match(csv, /Kojo/)
  assert.equal((csv.match(/233240000002/g) || []).length, 1)
  assert.doesNotMatch(csv, /900004/)
})

test('broadcast targets all known contacts and participating groups, excluding owner and duplicate aliases', async () => {
  const broadcast = load('plugins/broadcast.js')
  const socket = {
    user: { id: '233240000001@s.whatsapp.net' },
    contacts: [{ id: '233240000002@s.whatsapp.net' }, { id: '900003@lid', phoneNumber: '233240000003@s.whatsapp.net' }],
    signalRepository: { lidMapping: { getPNForLID: async () => null } },
  }
  const groups = { 'a@g.us': { participants: [{ id: '900003@lid' }, { id: '233240000004@s.whatsapp.net' }] }, 'b@g.us': { participants: [] } }
  const store = { messages: { '233240000002@s.whatsapp.net': [], '233240000001@s.whatsapp.net': [] } }
  const targets = await broadcast.broadcastTargets(socket, store, groups)
  assert.deepEqual([...targets.groups], ['a@g.us', 'b@g.us'])
  assert.deepEqual([...targets.contacts].sort(), [
    '233240000002@s.whatsapp.net', '233240000003@s.whatsapp.net', '233240000004@s.whatsapp.net',
  ])
})

test('vcf group exports only the current group, not the full contact cache', async () => {
  const vcf = load('plugins/vcf.js')
  const sent = []
  const socket = {
    user: { id: '233240000001@s.whatsapp.net' },
    contacts: [{ id: '233240000099@s.whatsapp.net', name: 'Unrelated' }],
    groupMetadata: async () => ({ subject: 'Team', participants: [{ id: '233240000002@s.whatsapp.net', name: 'Member' }] }),
    sendMessage: async (...args) => sent.push(args),
  }
  await vcf.exportContacts({ chat: 'team@g.us', bot: socket }, 'group csv')
  assert.equal(sent.length, 1)
  assert.equal(sent[0][1].fileName, 'Team.csv')
  const csv = sent[0][1].document.toString('utf8')
  assert.match(csv, /233240000002/)
  assert.doesNotMatch(csv, /233240000099/)
})
