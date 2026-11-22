'use strict'

const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')
const sharp = require('sharp')

const audioSticker = require('../lib/safful-audio-sticker')
const { proto } = require('@whiskeysockets/baileys')

function readVarint(buffer, position) {
  let result = 0
  let shift = 0
  let byte
  do {
    byte = buffer[position]
    position += 1
    result += (byte & 0x7f) * Math.pow(2, shift)
    shift += 7
  } while (byte & 0x80)
  return [result, position]
}

function fields(buffer) {
  const output = []
  let position = 0
  while (position < buffer.length) {
    const [tag, afterTag] = readVarint(buffer, position)
    const field = Math.floor(tag / 8)
    const wire = tag & 7
    position = afterTag
    if (wire === 2) {
      const [length, afterLength] = readVarint(buffer, position)
      output.push({ field, wire, value: buffer.subarray(afterLength, afterLength + length) })
      position = afterLength + length
    } else if (wire === 0) {
      const [value, after] = readVarint(buffer, position)
      output.push({ field, wire, value })
      position = after
    } else {
      throw new Error(`Unsupported wire type ${wire}`)
    }
  }
  return output
}

function wireAudio(message) {
  const bytes = proto.Message.encode(message).finish()
  const top = fields(bytes)
  const wrapped = top.find(item => item.field === 134)
  let innerBytes = bytes
  if (wrapped) {
    const futureProof = fields(wrapped.value)
    const inner = futureProof.find(item => item.field === 1)
    assert.ok(inner, 'audioStickerMessage.message is present')
    innerBytes = inner.value
  }
  const sticker = fields(innerBytes).find(item => item.field === 26)
  assert.ok(sticker, 'stickerMessage field is present')
  const audio = fields(sticker.value).find(item => item.field === 26)
  assert.ok(audio, 'stickerMessage.audioMessage field 26 is present')
  return proto.Message.AudioMessage.decode(audio.value)
}

async function frameBuffer(width = 320, height = 180) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 30, g: 140, b: 90 } },
  }).png().toBuffer()
}

function pcmBuffer() {
  const buffer = Buffer.alloc(16000 * 2)
  for (let index = 0; index < 16000; index += 1) {
    buffer.writeInt16LE(Math.round(Math.sin(index / 25) * 9000), index * 2)
  }
  return buffer
}

test('the installed proto learns both sound-sticker fields once', () => {
  assert.equal(audioSticker.patchStickerAudioProto(), true)
  const patched = proto.Message.StickerMessage.encode
  assert.equal(patched.__saffulAudioStickerPatched, true)
  assert.equal(proto.Message.encode.__saffulAudioStickerPatched, true)
  assert.equal(audioSticker.patchStickerAudioProto(), true)
  assert.equal(proto.Message.StickerMessage.encode, patched, 'patch is idempotent')
  assert.equal(proto.Message.encode.__saffulAudioStickerPatched, true)
})

test('wrapAudioSticker nests the sticker in field 134 without duplicating it', () => {
  const inner = proto.Message.create({
    stickerMessage: {
      url: 'https://mmg.whatsapp.net/sticker',
      mimetype: 'image/webp',
      isAnimated: true,
      width: 512,
      height: 512,
    },
  })
  inner.stickerMessage.audioMessage = proto.Message.AudioMessage.create({
    url: 'https://mmg.whatsapp.net/voice',
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
  })

  const wrapped = audioSticker.wrapAudioSticker(inner)
  assert.equal(wrapped.audioStickerMessage.message, inner)
  assert.equal(wrapped.stickerMessage, inner.stickerMessage, 'relay can still see the media type')
  assert.equal(
    Object.prototype.hasOwnProperty.call(wrapped, 'stickerMessage'),
    false,
    'the sticker is not duplicated as an own field',
  )

  const top = fields(proto.Message.encode(wrapped).finish())
  assert.equal(top.some(item => item.field === 26), false)
  assert.ok(top.some(item => item.field === 134), 'audioStickerMessage field 134 is present')
  assert.equal(wireAudio(wrapped).url, 'https://mmg.whatsapp.net/voice')
})

test('an audio sticker survives the wire format with field 26', () => {
  const message = proto.Message.create({
    stickerMessage: {
      url: 'https://mmg.whatsapp.net/sticker',
      mimetype: 'image/webp',
      isAnimated: false,
      width: 512,
      height: 512,
    },
  })
  message.stickerMessage.audioMessage = proto.Message.AudioMessage.create({
    url: 'https://mmg.whatsapp.net/voice',
    mimetype: 'audio/ogg; codecs=opus',
    ptt: true,
    seconds: 7,
  })

  const decoded = wireAudio(message)
  assert.equal(decoded.url, 'https://mmg.whatsapp.net/voice')
  assert.equal(decoded.ptt, true)
  assert.equal(decoded.seconds, 7)
  assert.equal(decoded.mimetype, 'audio/ogg; codecs=opus')
})

test('probe output is parsed into duration and audio presence', () => {
  const withAudio = audioSticker.parseProbeOutput(JSON.stringify({
    streams: [
      { codec_type: 'video', width: 720, height: 1280 },
      { codec_type: 'audio' },
    ],
    format: { duration: '7.4' },
  }))
  assert.deepEqual(withAudio, { hasAudio: true, hasVideo: true, duration: 7.4, width: 720, height: 1280 })

  const silent = audioSticker.parseProbeOutput({ streams: [{ codec_type: 'video' }], format: {} })
  assert.equal(silent.hasAudio, false)
  assert.equal(silent.duration, 0)
})

test('voice notes are capped at ten whole seconds', () => {
  assert.equal(audioSticker.audioSeconds(7.4), 7)
  assert.equal(audioSticker.audioSeconds(0.2), 1)
  assert.equal(audioSticker.audioSeconds(25), 10)
  assert.equal(audioSticker.audioSeconds(0), 10)
  assert.equal(audioSticker.audioSeconds(10), 10)
})

test('waveform is 64 normalised bytes', () => {
  const waveform = audioSticker.buildWaveform(pcmBuffer())
  assert.equal(waveform.length, 64)
  assert.ok(waveform.every(value => value >= 0 && value <= 100))
  assert.equal(Math.max(...waveform), 100)
  assert.equal(audioSticker.buildWaveform(Buffer.alloc(8)), undefined)
})

test('a busy frame still fits the 100 KB static sticker cap', async () => {
  const width = 1024
  const height = 1024
  const raw = Buffer.alloc(width * height * 3)
  let seed = 123456789
  for (let index = 0; index < raw.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    raw[index] = seed & 0xff
  }
  const noisy = await sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer()

  const webp = await audioSticker.makeStaticWebp(noisy)
  assert.ok(webp.length <= 100 * 1024, `sticker is ${webp.length} bytes`)
  const metadata = await sharp(webp).metadata()
  assert.equal(metadata.format, 'webp')
  assert.equal(metadata.width, 512)
  assert.equal(metadata.height, 512)
})

test('asset extraction caps the duration and cleans its temp folder', async () => {
  const frame = await frameBuffer()
  let workDirectory

  const assets = await audioSticker.extractVideoAssets(Buffer.from('fake video'), {
    probe: async inputPath => {
      workDirectory = path.dirname(inputPath)
      return { hasAudio: true, duration: 25 }
    },
    extractFrame: async (_input, outputPath) => { fs.writeFileSync(outputPath, frame) },
    extractAnimated: async (_input, outputPath) => {
      fs.writeFileSync(outputPath, Buffer.from('animated-webp'))
      return fs.readFileSync(outputPath)
    },
    extractAudio: async (_input, outputPath) => { fs.writeFileSync(outputPath, Buffer.from('fake-ogg')) },
    extractPcm: async (_input, outputPath) => { fs.writeFileSync(outputPath, pcmBuffer()) },
  })

  assert.equal(assets.hasAudio, true)
  assert.equal(assets.seconds, 6, 'audio is capped to the six-second animation')
  assert.equal(assets.waveform.length, 64)
  assert.ok(Buffer.isBuffer(assets.frameBuffer))
  assert.deepEqual(assets.animatedBuffer, Buffer.from('animated-webp'))
  assert.equal(fs.existsSync(workDirectory), false, 'temp folder removed')
})

test('asset extraction survives an animated encode failure', async () => {
  const frame = await frameBuffer()
  const assets = await audioSticker.extractVideoAssets(Buffer.from('fake video'), {
    probe: async () => ({ hasAudio: true, duration: 4 }),
    extractFrame: async (_input, outputPath) => { fs.writeFileSync(outputPath, frame) },
    extractAnimated: async () => { throw Object.assign(new Error('too large'), { code: 'STICKER_TOO_LARGE' }) },
    extractAudio: async (_input, outputPath) => { fs.writeFileSync(outputPath, Buffer.from('fake-ogg')) },
    extractPcm: async (_input, outputPath) => { fs.writeFileSync(outputPath, pcmBuffer()) },
  })
  assert.equal(assets.hasAudio, true)
  assert.equal(assets.animatedBuffer, undefined, 'falls back to a still sticker')
})

test('a video without an audio stream reports no-audio', async () => {
  const assets = await audioSticker.extractVideoAssets(Buffer.from('fake video'), {
    probe: async () => ({ hasAudio: false, duration: 4 }),
  })
  assert.deepEqual(assets, { hasAudio: false })
})

test('sendAudioSticker relays a sticker with the voice note attached', async () => {
  const frame = await frameBuffer()
  const waveform = audioSticker.buildWaveform(pcmBuffer())
  const quoted = { key: { id: 'QUOTED', remoteJid: '222@s.whatsapp.net' }, message: { conversation: '.sticker' } }
  const prepareCalls = []
  const relayCalls = []

  const socket = {
    waUploadToServer: async () => ({ mediaUrl: 'uploaded' }),
    authState: { creds: { me: { id: '111@s.whatsapp.net' } } },
  }

  const result = await audioSticker.sendAudioSticker(socket, '222@s.whatsapp.net', Buffer.from('video'), {
    quoted,
    exif: null,
    extract: async () => ({
      hasAudio: true,
      frameBuffer: frame,
      animatedBuffer: Buffer.from('animated-webp'),
      audioBuffer: Buffer.from('ogg'),
      seconds: 7,
      waveform,
    }),
    prepare: async (content) => {
      prepareCalls.push(content)
      if (content.sticker) return { stickerMessage: { url: 'sticker-url', mimetype: 'image/webp' } }
      return { audioMessage: { url: 'audio-url', mimetype: content.mimetype, ptt: content.ptt } }
    },
    generate: (jid, content, options) => {
      assert.equal(jid, '222@s.whatsapp.net')
      assert.equal(content.stickerMessage.url, 'sticker-url')
      assert.equal(options.quoted, quoted)
      assert.equal(options.userJid, '111@s.whatsapp.net')
      return {
        key: { id: 'MSGID', remoteJid: jid, fromMe: true },
        message: { stickerMessage: { url: 'sticker-url', mimetype: 'image/webp' } },
      }
    },
    relay: async (_socket, jid, message, options) => {
      relayCalls.push({ jid, message, options })
    },
  })

  assert.equal(result.ok, true)
  assert.equal(prepareCalls.length, 2)
  assert.deepEqual(prepareCalls[0].sticker, Buffer.from('animated-webp'))
  assert.ok(Buffer.isBuffer(prepareCalls[1].audio))
  assert.equal(prepareCalls[1].ptt, true)
  assert.equal(prepareCalls[1].mimetype, 'audio/ogg; codecs=opus')
  assert.equal(prepareCalls[1].seconds, 7)
  assert.equal(prepareCalls[1].waveform, waveform)

  assert.equal(relayCalls.length, 1)
  assert.equal(relayCalls[0].jid, '222@s.whatsapp.net')
  assert.deepEqual(relayCalls[0].options, { messageId: 'MSGID' })
  const relayed = relayCalls[0].message
  assert.equal(relayed.stickerMessage.audioMessage.url, 'audio-url')
  assert.equal(relayed.stickerMessage.isAnimated, true, 'sound sticker is a video sticker')
  assert.equal(relayed.stickerMessage.width, 512)
  assert.equal(relayed.stickerMessage.height, 512)
  assert.equal(typeof relayed.stickerMessage.stickerSentTs, 'number')

  const decoded = wireAudio(relayed)
  assert.equal(decoded.url, 'audio-url')
  assert.equal(decoded.ptt, true)
})

test('sendAudioSticker falls back to a still sticker when no animation is available', async () => {
  const frame = await frameBuffer()
  let relayed
  const result = await audioSticker.sendAudioSticker(
    { waUploadToServer: async () => ({}), authState: { creds: { me: { id: '111@s.whatsapp.net' } } } },
    '222@s.whatsapp.net',
    Buffer.from('video'),
    {
      exif: null,
      extract: async () => ({
        hasAudio: true,
        frameBuffer: frame,
        audioBuffer: Buffer.from('ogg'),
        seconds: 5,
      }),
      prepare: async content => content.sticker
        ? { stickerMessage: { url: 'sticker-url', mimetype: 'image/webp' } }
        : { audioMessage: { url: 'audio-url' } },
      generate: (jid, content) => ({
        key: { id: 'MSGID', remoteJid: jid, fromMe: true },
        message: { stickerMessage: { url: 'sticker-url', mimetype: 'image/webp' } },
      }),
      relay: async (_socket, _jid, message) => { relayed = message },
    },
  )
  assert.equal(result.ok, true)
  assert.equal(relayed.stickerMessage.isAnimated, false)
})

test('sendAudioSticker reports no-audio without relaying', async () => {
  let relayed = false
  const result = await audioSticker.sendAudioSticker(
    { waUploadToServer: async () => ({}), relayMessage: async () => { relayed = true } },
    '222@s.whatsapp.net',
    Buffer.from('video'),
    { exif: null, extract: async () => ({ hasAudio: false }) },
  )
  assert.deepEqual(result, { ok: false, reason: 'no-audio' })
  assert.equal(relayed, false)
})

test('sendAudioSticker reports a missing ffmpeg instead of throwing', async () => {
  const error = Object.assign(new Error('not found'), { code: 'FFMPEG_MISSING' })
  const result = await audioSticker.sendAudioSticker(
    { waUploadToServer: async () => ({}), relayMessage: async () => {} },
    '222@s.whatsapp.net',
    Buffer.from('video'),
    { exif: null, extract: async () => { throw error } },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'ffmpeg-missing')
})

test('sendAudioSticker needs the socket uploader', async () => {
  const result = await audioSticker.sendAudioSticker(
    { relayMessage: async () => {} },
    '222@s.whatsapp.net',
    Buffer.from('video'),
    {
      exif: null,
      extract: async () => ({
        hasAudio: true,
        frameBuffer: await frameBuffer(),
        audioBuffer: Buffer.from('ogg'),
        seconds: 5,
      }),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'upload-unavailable')
})
