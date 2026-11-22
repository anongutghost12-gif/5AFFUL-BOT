'use strict'

/**
 * Static "audio sticker" support: a 512x512 WebP sticker that carries a short
 * voice note inside `Message.StickerMessage.audioMessage` (proto field 26).
 *
 * Baileys 7.0.0-rc14 ships a WAProto build without that field, so we patch the
 * generated `StickerMessage.encode` at runtime and re-attach the prepared audio
 * after `generateWAMessageFromContent` (which would otherwise drop it).
 *
 * The video is turned into a still frame plus an OGG/Opus voice note using
 * ffmpeg/ffprobe. Set SAFFUL_FFMPEG_PATH / SAFFUL_FFPROBE_PATH when the
 * binaries are not on PATH.
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFile } = require('child_process')

const baileys = require('@whiskeysockets/baileys')
const { proto, prepareWAMessageMedia, generateWAMessageFromContent } = baileys
const sharp = require('sharp')

const DEFAULT_MAX_STICKER_BYTES = 100 * 1024
const DEFAULT_MAX_AUDIO_SECONDS = 10
const STICKER_SIZE = 512
const WAVEFORM_SAMPLES = 64

let protoPatched = false

/**
 * Teach the installed WAProto about `StickerMessage.audioMessage = 26`.
 * Safe to call repeatedly.
 */
function patchStickerAudioProto() {
  if (protoPatched) return true
  const StickerMessage = proto?.Message?.StickerMessage
  const AudioMessage = proto?.Message?.AudioMessage
  if (!StickerMessage || typeof StickerMessage.encode !== 'function') return false
  if (!AudioMessage || typeof AudioMessage.encode !== 'function') return false

  const original = StickerMessage.encode
  if (original.__saffulAudioStickerPatched) {
    protoPatched = true
    return true
  }

  const patchedEncode = function encodeStickerWithAudio(message, writer) {
    const audio = message && message.audioMessage
    if (!audio) return original.call(this, message, writer)

    // Encode the known StickerMessage fields first, then append field 26.
    const known = { ...message }
    delete known.audioMessage
    original.call(this, known, writer)

    writer.uint32((26 << 3) | 2).fork()
    AudioMessage.encode(audio, writer)
    writer.ldelim()
    return writer
  }
  patchedEncode.__saffulAudioStickerPatched = true

  StickerMessage.encode = patchedEncode
  protoPatched = true
  return true
}

patchStickerAudioProto()

function resolveTool(envNames, staticModule, fallback) {
  for (const name of envNames) {
    const value = process.env[name]
    if (value) return value
  }
  if (staticModule) {
    try {
      const resolved = require(staticModule)
      if (typeof resolved === 'string') return resolved
      if (typeof resolved?.path === 'string') return resolved.path
    } catch {}
  }
  return fallback
}

function ffmpegPath() {
  return resolveTool(['SAFFUL_FFMPEG_PATH', 'FFMPEG_PATH'], 'ffmpeg-static', 'ffmpeg')
}

function ffprobePath() {
  return resolveTool(['SAFFUL_FFPROBE_PATH', 'FFPROBE_PATH'], 'ffprobe-static', 'ffprobe')
}

function run(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      windowsHide: true,
      timeout: options.timeout || 120000,
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout, stderr })
        return
      }
      if (error.code === 'ENOENT') {
        error.code = 'FFMPEG_MISSING'
        error.message = `FFmpeg binary not found: ${binary}`
      }
      error.stderr = String(stderr || '')
      reject(error)
    })
  })
}

function parseProbeOutput(input) {
  const data = typeof input === 'string' ? JSON.parse(input) : input
  const streams = Array.isArray(data?.streams) ? data.streams : []
  const audio = streams.find(stream => stream?.codec_type === 'audio')
  const video = streams.find(stream => stream?.codec_type === 'video')
  const duration = Number(data?.format?.duration ?? video?.duration ?? audio?.duration ?? 0)
  return {
    hasAudio: Boolean(audio),
    hasVideo: Boolean(video),
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
  }
}

async function probeVideo(inputPath, options = {}) {
  const { stdout } = await run(options.ffprobe || ffprobePath(), [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    inputPath,
  ])
  return parseProbeOutput(stdout)
}

async function extractFrame(inputPath, outputPath, options = {}) {
  const seek = Number(options.duration) > 2 ? 1 : 0.1
  await run(options.ffmpeg || ffmpegPath(), [
    '-y', '-v', 'error',
    '-ss', String(seek),
    '-i', inputPath,
    '-frames:v', '1',
    '-vf', `scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=increase,crop=${STICKER_SIZE}:${STICKER_SIZE}`,
    '-f', 'image2',
    outputPath,
  ])
}

async function extractAudio(inputPath, outputPath, options = {}) {
  const binary = options.ffmpeg || ffmpegPath()
  const maxSeconds = options.maxSeconds || DEFAULT_MAX_AUDIO_SECONDS
  const encode = codec => run(binary, [
    '-y', '-v', 'error',
    '-i', inputPath,
    '-vn',
    '-t', String(maxSeconds),
    '-ac', '1',
    '-ar', '48000',
    '-c:a', codec,
    '-b:a', '64k',
    '-f', 'ogg',
    outputPath,
  ])
  try {
    await encode('libopus')
  } catch (error) {
    if (error?.code === 'FFMPEG_MISSING') throw error
    await encode('opus')
  }
}

async function extractPcm(audioPath, outputPath, options = {}) {
  await run(options.ffmpeg || ffmpegPath(), [
    '-y', '-v', 'error',
    '-i', audioPath,
    '-f', 's16le',
    '-ac', '1',
    '-ar', '16000',
    outputPath,
  ])
}

/** Build the 64-byte waveform WhatsApp shows for a voice note. */
function buildWaveform(pcmBuffer) {
  if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length < WAVEFORM_SAMPLES * 2) return undefined
  const totalSamples = Math.floor(pcmBuffer.length / 2)
  const blockSize = Math.floor(totalSamples / WAVEFORM_SAMPLES)
  if (blockSize <= 0) return undefined

  const values = []
  for (let block = 0; block < WAVEFORM_SAMPLES; block += 1) {
    const start = block * blockSize
    let sum = 0
    for (let index = 0; index < blockSize; index += 1) {
      const sample = pcmBuffer.readInt16LE((start + index) * 2)
      sum += Math.abs(sample) / 32768
    }
    values.push(sum / blockSize)
  }

  const peak = Math.max(...values)
  if (!(peak > 0)) return Buffer.alloc(WAVEFORM_SAMPLES)
  return Buffer.from(values.map(value => Math.max(0, Math.min(100, Math.floor((value / peak) * 100)))))
}

/** Round the probed duration into WhatsApp's whole-second field, capped. */
function audioSeconds(duration, maxSeconds = DEFAULT_MAX_AUDIO_SECONDS) {
  if (!(Number(duration) > 0)) return maxSeconds
  return Math.min(maxSeconds, Math.max(1, Math.round(Number(duration))))
}

async function extractVideoAssets(videoBuffer, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'safful-audio-sticker-'))
  const inputPath = path.join(directory, 'input.bin')
  const framePath = path.join(directory, 'frame.png')
  const audioPath = path.join(directory, 'audio.ogg')
  const pcmPath = path.join(directory, 'audio.pcm')

  const probe = options.probe || probeVideo
  const frame = options.extractFrame || extractFrame
  const audioOut = options.extractAudio || extractAudio
  const pcm = options.extractPcm || extractPcm

  try {
    fs.writeFileSync(inputPath, videoBuffer)
    const info = await probe(inputPath, options)
    if (!info.hasAudio) return { hasAudio: false }

    await frame(inputPath, framePath, { ...options, duration: info.duration })
    await audioOut(inputPath, audioPath, options)

    const audioBuffer = fs.readFileSync(audioPath)
    if (!audioBuffer.length) return { hasAudio: false }

    let waveform
    try {
      await pcm(audioPath, pcmPath, options)
      waveform = buildWaveform(fs.readFileSync(pcmPath))
    } catch {}

    const maxSeconds = options.maxSeconds || DEFAULT_MAX_AUDIO_SECONDS

    return {
      hasAudio: true,
      frameBuffer: fs.readFileSync(framePath),
      audioBuffer,
      seconds: audioSeconds(info.duration, maxSeconds),
      waveform,
    }
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true }) } catch {}
  }
}

/** Resize a frame into a square WebP that fits WhatsApp's static sticker cap. */
async function makeStaticWebp(frameBuffer, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_STICKER_BYTES
  const image = () => sharp(frameBuffer, { animated: false })
    .resize(STICKER_SIZE, STICKER_SIZE, { fit: 'cover' })

  for (let quality = 90; quality >= 20; quality -= 10) {
    const output = await image().webp({ quality, effort: 4 }).toBuffer()
    if (output.length <= maxBytes) return output
  }

  const fallback = await image().webp({ quality: 10, effort: 6 }).toBuffer()
  if (fallback.length > maxBytes) {
    throw new Error('Could not fit the sticker under 100 KB.')
  }
  return fallback
}

async function applyStickerMetadata(webpBuffer, metadata, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_MAX_STICKER_BYTES
  let exif = options.exif
  if (exif === undefined) {
    try { exif = require('./exif') } catch { exif = null }
  }
  if (!exif || typeof exif.writeExifWebp !== 'function') return webpBuffer

  try {
    const result = await exif.writeExifWebp(webpBuffer, metadata)
    let output = null
    if (Buffer.isBuffer(result)) {
      output = result
    } else if (typeof result === 'string' && fs.existsSync(result)) {
      output = fs.readFileSync(result)
      try { fs.unlinkSync(result) } catch {}
    }
    if (output && output.length <= maxBytes) return output
  } catch {}
  return webpBuffer
}

function defaultRelay(socket, jid, message, options) {
  return socket.relayMessage(jid, message, options)
}

/**
 * Build and send a static sticker carrying a voice note.
 *
 * Returns `{ ok: true, message }` on success, or `{ ok: false, reason }` when
 * the caller should fall back to a normal sticker. Relay/encryption failures
 * throw so the caller can report them instead of silently sending twice.
 */
async function sendAudioSticker(socket, jid, videoBuffer, options = {}) {
  if (!Buffer.isBuffer(videoBuffer) || videoBuffer.length === 0) {
    throw new Error('No video data to convert.')
  }
  if (!jid) throw new Error('No chat to send the sticker to.')
  if (!options.relay && typeof socket?.relayMessage !== 'function') {
    throw new Error('WhatsApp socket is unavailable')
  }

  patchStickerAudioProto()

  const extract = options.extract || extractVideoAssets
  let assets
  try {
    assets = await extract(videoBuffer, options)
  } catch (error) {
    return {
      ok: false,
      reason: error?.code === 'FFMPEG_MISSING' ? 'ffmpeg-missing' : 'extract-failed',
      error,
    }
  }
  if (!assets?.hasAudio || !assets.audioBuffer) return { ok: false, reason: 'no-audio' }

  const maxBytes = options.maxStickerBytes || DEFAULT_MAX_STICKER_BYTES
  let stickerBuffer
  try {
    stickerBuffer = await makeStaticWebp(assets.frameBuffer, { maxBytes })
  } catch (error) {
    return { ok: false, reason: 'sticker-failed', error }
  }

  stickerBuffer = await applyStickerMetadata(stickerBuffer, {
    packname: options.packname || process.env.STICKER_PACK || 'SAFFUL-MD',
    author: options.author || process.env.STICKER_AUTHOR || 'Safful Tech',
  }, { maxBytes, exif: options.exif })

  const prepare = options.prepare || prepareWAMessageMedia
  const generate = options.generate || generateWAMessageFromContent
  const relay = options.relay || defaultRelay
  const upload = options.upload || socket.waUploadToServer
  if (typeof upload !== 'function') return { ok: false, reason: 'upload-unavailable' }

  const mediaOptions = {
    upload,
    jid,
    logger: options.logger,
    mediaCache: options.mediaCache,
    options: options.httpOptions,
  }

  let stickerPrepared
  let audioPrepared
  try {
    stickerPrepared = await prepare({ sticker: stickerBuffer }, mediaOptions)
    audioPrepared = await prepare({
      audio: assets.audioBuffer,
      ptt: true,
      mimetype: 'audio/ogg; codecs=opus',
      seconds: assets.seconds,
      ...(assets.waveform ? { waveform: assets.waveform } : {}),
    }, mediaOptions)
  } catch (error) {
    return { ok: false, reason: 'upload-failed', error }
  }

  const stickerMessage = stickerPrepared?.stickerMessage
  const audioMessage = audioPrepared?.audioMessage
  if (!stickerMessage || !audioMessage) return { ok: false, reason: 'prepare-failed' }

  stickerMessage.isAnimated = false
  stickerMessage.width = STICKER_SIZE
  stickerMessage.height = STICKER_SIZE
  stickerMessage.stickerSentTs = Date.now()
  audioMessage.ptt = true
  audioMessage.mimetype = 'audio/ogg; codecs=opus'
  stickerMessage.audioMessage = audioMessage

  const userJid = options.userJid || socket?.authState?.creds?.me?.id || socket?.user?.id
  const wa = await generate(jid, { stickerMessage }, {
    quoted: options.quoted,
    userJid,
    messageId: options.messageId,
    timestamp: options.timestamp,
  })
  if (!wa?.message?.stickerMessage) throw new Error('Could not build the audio sticker message.')

  // `generateWAMessageFromContent` runs the content through WAProto.Message.create,
  // which does not know field 26. Re-attach the prepared audio before relaying.
  const finalSticker = wa.message.stickerMessage
  finalSticker.audioMessage = audioMessage
  finalSticker.isAnimated = false
  finalSticker.width = STICKER_SIZE
  finalSticker.height = STICKER_SIZE
  finalSticker.mimetype = finalSticker.mimetype || 'image/webp'
  if (!finalSticker.stickerSentTs) finalSticker.stickerSentTs = stickerMessage.stickerSentTs

  await relay(socket, jid, wa.message, { messageId: wa.key.id })
  return { ok: true, message: wa }
}

module.exports = {
  patchStickerAudioProto,
  parseProbeOutput,
  buildWaveform,
  audioSeconds,
  makeStaticWebp,
  applyStickerMetadata,
  extractVideoAssets,
  sendAudioSticker,
  ffmpegPath,
  ffprobePath,
  STICKER_SIZE,
  DEFAULT_MAX_STICKER_BYTES,
  DEFAULT_MAX_AUDIO_SECONDS,
}
