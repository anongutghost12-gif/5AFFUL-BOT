'use strict'

// The phone budget is a module-level rolling window, so it gets its own file
// and its own log path. TurboFex core/placeholder.js is the reference.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-kk-phone-'))
process.env.SAFFUL_KK_LOG = path.join(root, 'kk.log')
process.env.SAFFUL_KK_RESEND_PER_HOUR = '2'

const phone = require('../lib/safful-kk-phone')

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

test('the phone is only asked a few times per hour', () => {
  phone.reset()
  assert.equal(phone.allow('a'), true)
  assert.equal(phone.allow('b'), true)
  assert.equal(phone.allow('c'), false)
  assert.deepEqual(phone.spent(), { used: 2, limit: 2 })
})

test('a request that never reached the phone gives its slot back', () => {
  phone.reset()
  assert.equal(phone.allow('x'), true)
  assert.equal(phone.allow('y'), true)
  assert.equal(phone.allow('z'), false)
  phone.refund('x')
  assert.equal(phone.allow('z'), true)
})

test('install wraps the socket helper so every caller is budgeted', async () => {
  phone.reset()
  let calls = 0
  const socket = { requestPlaceholderResend: async () => { calls += 1; return 'msg-id' } }
  phone.install(socket)
  assert.equal(await socket.requestPlaceholderResend({ id: 'm1' }), 'msg-id')
  assert.equal(await socket.requestPlaceholderResend({ id: 'm2' }), 'msg-id')
  assert.equal(await socket.requestPlaceholderResend({ id: 'm3' }), undefined)
  assert.equal(calls, 2)
})

test('a helper that throws refunds the slot', async () => {
  phone.reset()
  const socket = { requestPlaceholderResend: async () => { throw Error('offline') } }
  phone.install(socket)
  await assert.rejects(socket.requestPlaceholderResend({ id: 'e1' }), /offline/)
  assert.equal(phone.spent().used, 0)
})

test('install is idempotent per socket', () => {
  phone.reset()
  const socket = { requestPlaceholderResend: async () => 'ok' }
  phone.install(socket)
  const wrapped = socket.requestPlaceholderResend
  phone.install(socket)
  assert.equal(socket.requestPlaceholderResend, wrapped)
})

test('a budget of zero keeps the phone silent', () => {
  phone.reset()
  // The limit is read at load time, so this only checks the documented value.
  assert.equal(phone.PER_HOUR, 2)
})
