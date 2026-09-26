'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const filename = path.resolve(__dirname, '..', 'plugins', 'owner-tools.js')
const moduleStub = { exports: {} }
const native = createRequire(filename)
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
  module: moduleStub, exports: moduleStub.exports, __dirname: path.dirname(filename), __filename: filename,
  process, global, console, setTimeout, clearTimeout,
  require: key => {
    if (key === '../lib/plugins') return { cmd() {} }
    if (key === '../lib/safful-mode') return { isOwner: () => true }
    if (key === '../lib/safful-session-guard') return { backupSession: async () => {} }
    if (key === '../lib/safful-update-session') return { snapshot: () => ({ saved: true }), restoreLatestIfNeeded: () => ({ current: true }) }
    return native(key)
  },
}, { filename })
const { moveUntrackedCollisions, restoreUntrackedCollisions, resolveUpdateBranch } = moduleStub.exports

test('master checkouts select published main when origin/master does not exist', async () => {
  const calls = []
  const branch = await resolveUpdateBranch('master', async (_command, args) => {
    calls.push(args.at(-1))
    return { ok: args.at(-1) === 'refs/remotes/origin/main' }
  })
  assert.equal(branch, 'main')
  assert.equal(calls.includes('refs/remotes/origin/master'), false)
})

test('update preserves only the exact colliding untracked file and can restore on pull failure', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-update-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tests = path.join(root, 'tests')
  fs.mkdirSync(tests)
  const collision = path.join(tests, 'save.test.cjs')
  const unrelated = path.join(tests, 'keep.test.cjs')
  fs.writeFileSync(collision, 'local custom test')
  fs.writeFileSync(unrelated, 'keep me')
  const backup = moveUntrackedCollisions(root, ['tests/save.test.cjs'])
  assert.equal(backup.moved.length, 1)
  assert.equal(fs.existsSync(collision), false)
  assert.equal(fs.readFileSync(backup.moved[0].destination, 'utf8'), 'local custom test')
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep me')
  restoreUntrackedCollisions(backup)
  assert.equal(fs.readFileSync(collision, 'utf8'), 'local custom test')
})

test('update refuses traversal paths without moving other files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-update-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.throws(() => moveUntrackedCollisions(root, ['../outside.txt']), /Unsafe untracked collision/)
})
