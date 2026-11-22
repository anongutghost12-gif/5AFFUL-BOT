'use strict'

// Isolate the capture store so the real temp/kk-capture is never touched.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-kk-capture-'))
process.env.SAFFUL_KK_CAPTURE_DIR = root
process.env.SAFFUL_KK_LOG = path.join(root, 'kk.log')
// The phone budget is shared by every test in this file.
process.env.SAFFUL_KK_RESEND_PER_HOUR = '1000'

const capture = require('../lib/safful-kk-capture')

const chat = '120363000000000000@g.us'
const mediaKey = Buffer.alloc(32, 7)
const plaintext = Buffer.from('captured view-once bytes')

function viewOnce(id, extra = {}) {
  return {
    key: { id, remoteJid: chat, fromMe: false, isViewOnce: true },
    message: { viewOnceMessageV2: { message: {
      imageMessage: {
        viewOnce: true, directPath: '/v/t62/' + id, mediaKey,
        fileLength: plaintext.length, mimetype: 'image/jpeg', ...extra,
      },
    } } },
  }
}

async function waitFor(predicate, ms = 3000) {
  const started = Date.now()
  while (Date.now() - started < ms) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}

test.after(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

test('captures view-once bytes at arrival and reads them back', async () => {
  capture.ingest(null, viewOnce('capture-1'), 'upsert', { download: async () => ({ bytes: plaintext }) })
  assert.ok(await waitFor(async () => Boolean((await capture.read(chat, 'capture-1'))?.bytes)))
  const found = await capture.read(chat, 'capture-1')
  assert.deepEqual(found.bytes, plaintext)
  assert.equal(found.entry.captured, true)
  assert.equal(found.entry.kind, 'image')
  assert.equal(found.entry.media.mimetype, 'image/jpeg')
})

test('records a stripped view-once without inventing bytes', async () => {
  let downloads = 0
  capture.ingest(null, viewOnce('stub-1', { mediaKey: undefined }), 'upsert', {
    download: async () => { downloads += 1; throw Error('must not download') },
  })
  const found = await capture.read(chat, 'stub-1')
  assert.equal(found.bytes, null)
  assert.equal(found.entry.hasKey, false)
  assert.equal(found.reason, 'no-media-key')
  assert.equal(downloads, 0)
})

test('a later stub never overwrites captured bytes', async () => {
  capture.ingest(null, viewOnce('capture-2'), 'upsert', { download: async () => ({ bytes: plaintext }) })
  assert.ok(await waitFor(async () => Boolean((await capture.read(chat, 'capture-2'))?.bytes)))
  capture.ingest(null, viewOnce('capture-2', { mediaKey: undefined }), 'upsert')
  const found = await capture.read(chat, 'capture-2')
  assert.deepEqual(found.bytes, plaintext)
  assert.equal(found.entry.captured, true)
})

test('unavailable fanout is recorded with its real reason', async () => {
  capture.noteUnavailable({ id: 'stub-2', remoteJid: chat }, 'view_once_unavailable_fanout')
  const found = await capture.read(chat, 'stub-2')
  assert.equal(found.bytes, null)
  assert.equal(found.reason, 'unavailable:view_once_unavailable_fanout')
})

test('non view-once messages are ignored', () => {
  const before = capture.status().entries
  capture.ingest(null, { key: { id: 'plain-1', remoteJid: chat }, message: { conversation: 'hi' } }, 'upsert')
  assert.equal(capture.status().entries, before)
})

test('attach copies the message before the dispatcher can strip it', async () => {
  const { EventEmitter } = require('node:events')
  const ev = new EventEmitter()
  const socket = { ev, ws: new EventEmitter() }
  capture.attach(socket)
  // The legacy dispatcher mutates the message after receiving the event.
  ev.on('messages.upsert', data => { for (const message of data.messages) delete message.message })
  ev.emit('messages.upsert', { messages: [viewOnce('attach-1', { mediaKey: undefined })] })
  const found = await capture.read(chat, 'attach-1')
  assert.ok(found, 'entry was recorded before the dispatcher stripped the message')
  assert.equal(found.entry.hasKey, false)
  assert.equal(found.reason, 'no-media-key')
})

test('keeps the preview when the full file can no longer be fetched', async () => {
  const thumb = Buffer.from([0xff, 0xd8, 0xff, 0xd9])
  capture.ingest(null, viewOnce('thumb-1', { jpegThumbnail: thumb }), 'upsert', {
    download: async () => { throw Object.assign(Error('gone'), { code: 'KK_MISSING_URL' }) },
  })
  assert.ok(await waitFor(async () => Boolean((await capture.read(chat, 'thumb-1'))?.thumb)))
  const found = await capture.read(chat, 'thumb-1')
  assert.equal(found.bytes, null)
  assert.deepEqual(found.thumb, thumb)
  assert.equal(found.entry.thumb, thumb.length)
  assert.equal(found.reason, 'KK_MISSING_URL')
})

test('chases a view-once that arrived without its payload, once', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'request-id' } }
  const bare = {
    key: { id: 'chase-1', remoteJid: chat, fromMe: false, isViewOnce: true },
    message: { messageContextInfo: { deviceListMetadataVersion: 2 } },
  }
  capture.chase(socket, bare, 'upsert')
  assert.ok(await waitFor(() => requests === 1), 'the phone was asked')
  const found = await capture.read(chat, 'chase-1')
  assert.equal(found.bytes, null)
  assert.equal(found.reason, 'no-content')
  assert.ok(found.askedAt > 0)
  // The same message announced again must not spend a second request.
  capture.chase(socket, bare, 'upsert')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(requests, 1)
})

test('does not chase an ordinary undecryptable stub without view-once evidence', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'id' } }
  capture.chase(socket, {
    key: { id: 'cipher-1', remoteJid: chat },
    message: undefined,
    messageStubType: 2,
  }, 'upsert')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(requests, 0, 'a plain CIPHERTEXT stub must not spend the phone budget')
})

test('does not chase ordinary messages or group events', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'id' } }
  capture.chase(socket, {
    key: { id: 'plain-2', remoteJid: chat },
    message: { conversation: 'hello' },
  }, 'upsert')
  // A group event: no message, and a stub type that is not "could not read".
  capture.chase(socket, {
    key: { id: 'group-1', remoteJid: chat },
    message: null,
    messageStubType: 1,
  }, 'upsert')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(requests, 0)
})

test('chases a view-once announced with no content and no stub type', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'request-id' } }
  capture.consider(socket, {
    key: { id: 'hidden-1', remoteJid: chat, fromMe: false, isViewOnce: true },
    message: undefined,
  }, 'upsert')
  assert.ok(await waitFor(() => requests === 1), 'key.isViewOnce is enough to ask the phone')
  const found = await capture.read(chat, 'hidden-1')
  assert.ok(found.askedAt > 0)
})

test('asks the phone for an unavailable view-once fanout', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'request-id' } }
  capture.noteUnavailable({ id: 'fanout-1', remoteJid: chat }, 'view_once_unavailable_fanout', socket)
  assert.ok(await waitFor(() => requests === 1), 'the WS notice alone can trigger the ask')
  const found = await capture.read(chat, 'fanout-1')
  assert.equal(found.reason, 'unavailable:view_once_unavailable_fanout')
  assert.ok(found.askedAt > 0)
})

test('asks the phone when a view-once arrives without a media key, once', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'request-id' } }
  capture.consider(socket, viewOnce('keyless-1', { mediaKey: undefined }), 'upsert')
  assert.ok(await waitFor(() => requests === 1), 'the phone was asked at arrival')
  const found = await capture.read(chat, 'keyless-1')
  assert.equal(found.bytes, null)
  assert.equal(found.entry.hasKey, false)
  assert.equal(found.reason, 'no-media-key')
  assert.ok(found.askedAt > 0)
  // The same placeholder announced again must not spend a second request.
  capture.consider(socket, viewOnce('keyless-1', { mediaKey: undefined }), 'upsert')
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(requests, 1)
})

test('captures the complete message the phone sends after a keyless ask', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'request-id' } }
  capture.consider(socket, viewOnce('keyless-2', { mediaKey: undefined }), 'upsert')
  assert.ok(await waitFor(() => requests === 1))
  // The phone answers with the same id and a usable media key.
  capture.ingest(null, viewOnce('keyless-2'), 'upsert', { download: async () => ({ bytes: plaintext }) })
  assert.ok(await waitFor(async () => Boolean((await capture.read(chat, 'keyless-2'))?.bytes)))
  const found = await capture.read(chat, 'keyless-2')
  assert.deepEqual(found.bytes, plaintext)
  assert.equal(found.entry.hasKey, true)
})

test('captures a plain-media answer from the phone after an ask', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'request-id' } }
  capture.consider(socket, viewOnce('answer-plain-1', { mediaKey: undefined }), 'upsert')
  assert.ok(await waitFor(() => requests === 1), 'the phone was asked')
  // The phone answers with ordinary media: no view-once wrapper and no flag.
  // Only the id we asked about may be read this way.
  capture.consider(socket, {
    key: { id: 'answer-plain-1', remoteJid: chat, fromMe: false },
    message: { imageMessage: {
      directPath: '/v/t62/answer-plain-1', mediaKey,
      fileLength: plaintext.length, mimetype: 'image/jpeg', caption: 'from phone',
    } },
  }, 'upsert', { download: async () => ({ bytes: plaintext }) })
  assert.ok(await waitFor(async () => Boolean((await capture.read(chat, 'answer-plain-1'))?.bytes)))
  const found = await capture.read(chat, 'answer-plain-1')
  assert.deepEqual(found.bytes, plaintext)
  assert.equal(found.entry.type, 'imageMessage')
  assert.equal(found.entry.media.caption, 'from phone')
  assert.equal(requests, 1)
})

test('marks a second empty stub as the phone answer instead of asking again', async () => {
  let requests = 0
  const socket = { requestPlaceholderResend: async () => { requests += 1; return 'request-id' } }
  capture.consider(socket, viewOnce('answer-stub-1', { mediaKey: undefined }), 'upsert')
  assert.ok(await waitFor(() => requests === 1), 'the phone was asked')
  // Ignore a duplicate notice milliseconds later; the real answer needs the
  // 1.5 s guard so two attached sockets cannot be mistaken for an answer.
  await new Promise(resolve => setTimeout(resolve, 1600))
  capture.noteUnavailable({ id: 'answer-stub-1', remoteJid: chat }, 'view_once', socket)
  const found = await capture.read(chat, 'answer-stub-1')
  assert.equal(found.reason, 'phone-stub')
  assert.equal(found.bytes, null)
  assert.equal(requests, 1, 'an empty answer must not spend another request')
})

test('does not treat ordinary media as a phone answer without a request', () => {
  const before = capture.status().entries
  capture.consider(null, {
    key: { id: 'plain-media-1', remoteJid: chat, fromMe: false },
    message: { imageMessage: { directPath: '/v/t62/plain-media-1', mediaKey, mimetype: 'image/jpeg' } },
  }, 'upsert')
  assert.equal(capture.status().entries, before, 'no request means no assumed view-once')
})

