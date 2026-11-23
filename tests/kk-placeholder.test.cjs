'use strict'

// The placeholder gate is a module-level cache (TurboFex core/placeholder.js),
// so it gets its own file and its own log path.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-kk-placeholder-'))
process.env.SAFFUL_KK_LOG = path.join(root, 'kk.log')
process.env.SAFFUL_KK_RESEND_PER_HOUR = '2'

const gate = require('../lib/safful-kk-placeholder')

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

test('every id looks "already asked" until it is explicitly allowed', () => {
  gate.reset()
  assert.equal(gate.cache.get('unknown'), true, 'the library must not ask the phone on its own')
  gate.cache.set('unknown', { key: { id: 'unknown' } })
  assert.equal(gate.cache.get('unknown'), true, 'a blocked id cannot store metadata either')
})

test('allow() opens one window and lets the library store its metadata', () => {
  gate.reset()
  assert.equal(gate.allow('open-1'), true)
  assert.equal(gate.cache.get('open-1'), undefined, 'the deliberate request may pass')
  const metadata = { key: { id: 'open-1' }, messageTimestamp: 1 }
  gate.cache.set('open-1', metadata)
  assert.deepEqual(gate.cache.get('open-1'), metadata)
  gate.cache.del('open-1')
  assert.equal(gate.cache.get('open-1'), true, 'after the answer the gate is closed again')
})

test('allow() is free while the same id is still open', () => {
  gate.reset()
  assert.equal(gate.allow('same-1'), true)
  assert.equal(gate.allow('same-1'), true)
  assert.deepEqual(gate.spent(), { used: 1, limit: 2 })
})

test('a stale entry from an earlier request cannot block the next one', () => {
  gate.reset()
  assert.equal(gate.allow('stale-1'), true)
  gate.cache.set('stale-1', { key: { id: 'stale-1' } })
  // The hold window ends (or the library deletes the entry) and a new request
  // is allowed for the same id.
  gate.cache.del('stale-1')
  assert.equal(gate.allow('stale-1'), true)
  assert.equal(gate.cache.get('stale-1'), undefined, 'allow() cleared the stale metadata')
})

test('the hourly budget still applies to allowed ids', () => {
  gate.reset()
  assert.equal(gate.allow('budget-a'), true)
  assert.equal(gate.allow('budget-b'), true)
  assert.equal(gate.allow('budget-c'), false)
  assert.equal(gate.cache.get('budget-c'), true)
  gate.refund('budget-a')
  assert.equal(gate.allow('budget-c'), true)
})

test('installCache gates an existing library cache in place', () => {
  gate.reset()
  const backing = new Map()
  const socket = {
    placeholderResendCache: {
      get: id => backing.get(id),
      set: (id, value) => backing.set(id, value),
      del: id => backing.delete(id),
      close() {},
    },
  }
  gate.installCache(socket)
  assert.equal(socket.__saffulKkPlaceholderGate, true)
  assert.equal(socket.placeholderResendCache.get('auto-1'), true,
    'Baileys automatic requests are dropped')
  assert.equal(socket.placeholderResendCache.get('auto-1'), true)
  assert.equal(backing.has('auto-1'), false, 'nothing was stored for a blocked id')
  // The deliberate path opens the gate.
  assert.equal(gate.allow('auto-1'), true)
  assert.equal(socket.placeholderResendCache.get('auto-1'), undefined)
  socket.placeholderResendCache.set('auto-1', { key: { id: 'auto-1' } })
  assert.deepEqual(socket.placeholderResendCache.get('auto-1'), { key: { id: 'auto-1' } })
  assert.equal(typeof socket.placeholderResendCache.close, 'function', 'other cache methods survive')
})

test('installCache is idempotent and ignores sockets without a cache', () => {
  gate.reset()
  const socket = { placeholderResendCache: { get: () => false, set() {}, del() {} } }
  gate.installCache(socket)
  const get = socket.placeholderResendCache.get
  gate.installCache(socket)
  assert.equal(socket.placeholderResendCache.get, get)
  assert.doesNotThrow(() => gate.installCache({}))
})
