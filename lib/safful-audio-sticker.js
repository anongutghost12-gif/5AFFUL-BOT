'use strict'

/**
 * Sound sticker support: a 512x512 animated WebP sticker that carries a short
 * voice note inside `Message.StickerMessage.audioMessage` (proto field 26), sent
 * inside `Message.audioStickerMessage` (proto field 134) exactly like WhatsApp
 * Web.
 *
 * Baileys 7.0.0-rc14 ships a WAProto build without either field, so we patch the
 * generated `StickerMessage.encode` and `Message.encode` at runtime, then wrap
 * the built message before `relayMessage`.
 *
 * The video is turned into an animated WebP plus an OGG/Opus voice note using
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
// WhatsApp allows up to 500 KB for an animated (video) sticker. Sound stickers
// are animated stickers that also carry an audio track, so the still-frame cap
// does not apply to them.
const DEFAULT_MAX_ANIMATED_BYTES = 500 * 1024
const DEFAULT_MAX_AUDIO_SECONDS = 10
const ANIMATED_MAX_SECONDS = 6
const ANIMATED_FPS = 12
const STICKER_SIZE = 512
const WAVEFORM_SAMPLES = 64

const STICKER_LOG = process.env.SAFFUL_STICKER_LOG || path.join(__dirname, '..', 'temp', 'sticker.log')

/**
 * Append a line to `temp/sticker.log`. The bot usually runs behind a panel, so
 * the console is not visible; a small on-disk trace is the only reliable way to
 * see which stage of the sound-sticker pipeline failed.
 */
function logSticker(...parts) {
  try {
    const line = new Date().toISOString() + ' ' + parts.map(part => {
      if (typeof part === 'string') return part
      if (part instanceof Error) return part.message
      try { return JSON.stringify(part) } catch { return String(part) }
    }).join(' ') + '\n'
    fs.mkdirSync(path.dirname(STICKER_LOG), { recursive: true })
    fs.appendFileSync(STICKER_LOG, line)
  } catch {}
}

let protoPatched = false

/**
 * Teach the installed WAProto about the two fields WhatsApp uses for sound
 * stickers:
 *
 *   StickerMessage.audioMessage = 26  (AudioMessage)
 *   Message.audioStickerMessage = 134 (FutureProofMessage)
 *
 * Safe to call repeatedly.
 */
function patchStickerAudioProto() {
  if (protoPatched) return true
  const Message = proto?.Message
  const StickerMessage = Message?.StickerMessage
  const AudioMessage = Message?.AudioMessage
  const FutureProofMessage = Message?.FutureProofMessage
  if (!Message || typeof Message.encode !== 'function') return false
  if (!StickerMessage || typeof StickerMessage.encode !== 'function') return false
  if (!AudioMessage || typeof AudioMessage.encode !== 'function') return false
  if (!FutureProofMessage || typeof FutureProofMessage.encode !== 'function') return false

  const originalStickerEncode = StickerMessage.encode
  if (!originalStickerEncode.__saffulAudioStickerPatched) {
    const patchedStickerEncode = function encodeStickerWithAudio(message, writer) {
      const audio = message && message.audioMessage
      if (!audio) return originalStickerEncode.call(this, message, writer)

      // Encode the known StickerMessage fields first, then append field 26.
      const known = { ...message }
      delete known.audioMessage
      if (writer) originalStickerEncode.call(this, known, writer)
      else writer = originalStickerEncode.call(this, known)

      writer.uint32((26 << 3) | 2).fork()
      AudioMessage.encode(audio, writer)
      writer.ldelim()
      return writer
    }
    patchedStickerEncode.__saffulAudioStickerPatched = true
    StickerMessage.encode = patchedStickerEncode
  }

  const originalMessageEncode = Message.encode
  if (!originalMessageEncode.__saffulAudioStickerPatched) {
    const patchedMessageEncode = function encodeMessageWithAudioSticker(message, writer) {
      const audioSticker = message && message.audioStickerMessage
      if (!audioSticker) return originalMessageEncode.call(this, message, writer)

      // Copy only the own enumerable fields (never the prototype getter used by
      // the relay code to report `mediatype=sticker`), then append field 134.
      const known = {}
      for (const key of Object.keys(message)) {
        if (key !== 'audioStickerMessage') known[key] = message[key]
      }
      if (writer) originalMessageEncode.call(this, known, writer)
      else writer = originalMessageEncode.call(this, known)

      writer.uint32((134 << 3) | 2).fork()
      FutureProofMessage.encode(audioSticker, writer)
      writer.ldelim()
      return writer
    }
    patchedMessageEncode.__saffulAudioStickerPatched = true
    Message.encode = patchedMessageEncode
  }

  protoPatched = true
  return true
}

/**
 * Wrap a built message exactly like WhatsApp Web does for sound stickers:
 * `{ audioStickerMessage: { message: <inner> } }` (proto field 134).
 *
 * `relayMessage` reads `message.stickerMessage` to pick `mediatype=sticker`, so
 * the wrapper exposes it through a prototype getter. protobufjs only encodes
 * own enumerable fields, so the inner sticker is not duplicated on the wire.
 */
function wrapAudioSticker(message) {
  if (!message || typeof message !== 'object') return message
  if (message.audioStickerMessage) return message

  const wrapper = Object.create({
    get stickerMessage() {
      return message.stickerMessage
    },
  })
  for (const key of Object.keys(message)) {
    if (key !== 'stickerMessage') wrapper[key] = message[key]
  }
  wrapper.audioStickerMessage = { message }
  return wrapper
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

/**
 * Like `run`, but resolves even when the process exits non-zero. `ffmpeg -i`
 * always exits 1 because no output file is given, yet its stderr contains the
 * duration and stream list we need.
 */
function runAllowingFailure(binary, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      windowsHide: true,
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error && error.code === 'ENOENT') {
        error.code = 'FFMPEG_MISSING'
        error.message = `FFmpeg binary not found: ${binary}`
        reject(error)
        return
      }
      resolve({ stdout, stderr, code: error?.code || 0 })
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
  try {
    const { stdout } = await run(options.ffprobe || ffprobePath(), [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ], { timeout: options.probeTimeout })
    return parseProbeOutput(stdout)
  } catch (error) {
    // ffprobe is optional. Many minimal hosts ship ffmpeg but not ffprobe, and
    // the same container can be inspected from ffmpeg's banner. Only give up
    // when ffmpeg itself is missing.
    logSticker('probe-fallback', error?.code || error?.message || error)
    return probeVideoWithFfmpeg(inputPath, options)
  }
}

function parseFfmpegProbe(stderr) {
  const text = String(stderr || '')
  const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
  const hasAudio = /Stream #\d+:\d+[^:]*:\s*Audio:/.test(text)
  const hasVideo = /Stream #\d+:\d+[^:]*:\s*Video:/.test(text)
  if (!durationMatch && !hasAudio && !hasVideo) return null

  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0
  const dimensions = text.match(/Video:.*?(\d{2,5})x(\d{2,5})/)

  return {
    hasAudio,
    hasVideo,
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: dimensions ? Number(dimensions[1]) : 0,
    height: dimensions ? Number(dimensions[2]) : 0,
  }
}

async function probeVideoWithFfmpeg(inputPath, options = {}) {
  const { stderr } = await runAllowingFailure(options.ffmpeg || ffmpegPath(), [
    '-hide_banner', '-i', inputPath,
  ], { timeout: options.probeTimeout || 30000 })
  const parsed = parseFfmpegProbe(stderr)
  if (!parsed) {
    throw Object.assign(new Error('ffmpeg could not read the video'), { code: 'PROBE_FAILED' })
  }
  return parsed
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

// Build an animated WebP (WhatsApp's video sticker) from the source clip.
// ffmpeg's libwebp_anim writes every frame into one file; the encoder has no
// target-size option, so quality and frame rate are lowered until the result
// fits the animated sticker cap.
async function extractAnimatedWebp(inputPath, outputPath, options = {}) {
  try {
    return await encodeAnimatedWebp(inputPath, outputPath, options)
  } catch (error) {
    if (error?.code === 'FFMPEG_MISSING') throw error
    // Some ffmpeg builds ship libwebp but not libwebp_anim. Render a GIF with
    // ffmpeg and let sharp turn its frames into an animated WebP instead.
    logSticker('animated-primary-failed', error?.message || error)
    try {
      return await encodeAnimatedWebpViaGif(inputPath, outputPath, options)
    } catch (fallbackError) {
      logSticker('animated-gif-failed', fallbackError?.message || fallbackError)
      throw error
    }
  }
}

async function encodeAnimatedWebp(inputPath, outputPath, options = {}) {
  const binary = options.ffmpeg || ffmpegPath()
  const maxBytes = options.maxAnimatedBytes || DEFAULT_MAX_ANIMATED_BYTES
  const duration = Math.min(
    ANIMATED_MAX_SECONDS,
    Math.max(1, Number(options.duration) || ANIMATED_MAX_SECONDS),
  )
  const attempts = [
    { fps: ANIMATED_FPS, quality: 60 },
    { fps: 10, quality: 45 },
    { fps: 8, quality: 30 },
  ]

  let smallest = 0
  for (const attempt of attempts) {
    await run(binary, [
      '-y', '-v', 'error',
      '-t', String(duration),
      '-i', inputPath,
      '-an',
      '-vf', `fps=${attempt.fps},scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=increase,crop=${STICKER_SIZE}:${STICKER_SIZE}`,
      '-c:v', 'libwebp_anim',
      '-lossless', '0',
      '-quality', String(attempt.quality),
      '-compression_level', '4',
      '-loop', '0',
      '-f', 'webp',
      outputPath,
    ], { timeout: options.timeout || 120000 })
    const size = fs.statSync(outputPath).size
    smallest = size
    if (size <= maxBytes) return fs.readFileSync(outputPath)
  }

  throw Object.assign(
    Error(`Animated sticker is ${smallest} bytes, over the ${maxBytes} byte cap`),
    { code: 'STICKER_TOO_LARGE' },
  )
}

// Fallback animated encoder: ffmpeg writes a GIF, sharp rewrites it as WebP.
// Slower and slightly softer than libwebp_anim, but it works on builds that do
// not include libwebp_anim at all.
async function encodeAnimatedWebpViaGif(inputPath, outputPath, options = {}) {
  const binary = options.ffmpeg || ffmpegPath()
  const maxBytes = options.maxAnimatedBytes || DEFAULT_MAX_ANIMATED_BYTES
  const duration = Math.min(
    ANIMATED_MAX_SECONDS,
    Math.max(1, Number(options.duration) || ANIMATED_MAX_SECONDS),
  )
  const gifPath = outputPath.replace(/\.webp$/i, '') + '.gif'
  const attempts = [
    { fps: ANIMATED_FPS, quality: 60 },
    { fps: 10, quality: 45 },
    { fps: 8, quality: 30 },
  ]

  let smallest = 0
  for (const attempt of attempts) {
    await run(binary, [
      '-y', '-v', 'error',
      '-t', String(duration),
      '-i', inputPath,
      '-an',
      '-vf', `fps=${attempt.fps},scale=${STICKER_SIZE}:${STICKER_SIZE}:force_original_aspect_ratio=increase,crop=${STICKER_SIZE}:${STICKER_SIZE},split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer`,
      '-loop', '0',
      '-f', 'gif',
      gifPath,
    ], { timeout: options.timeout || 120000 })
    const gif = fs.readFileSync(gifPath)
    const webp = await sharp(gif, { animated: true })
      .webp({ quality: attempt.quality, effort: 4, loop: 0 })
      .toBuffer()
    smallest = webp.length
    if (webp.length <= maxBytes) return webp
  }

  throw Object.assign(
    Error(`Animated sticker is ${smallest} bytes, over the ${maxBytes} byte cap`),
    { code: 'STICKER_TOO_LARGE' },
  )
}

async function extractAudio(inputPath, outputPath, options = {}) {
  const binary = options.ffmpeg || ffmpegPath()
  const exec = options.run || run
  const maxSeconds = options.maxSeconds || DEFAULT_MAX_AUDIO_SECONDS
  const base = outputPath.replace(/\.ogg$/i, '')
  // WhatsApp accepts Opus in OGG and AAC in MP4. Try the exact Web codec first,
  // then the alias some builds use, then the MP4 fallback.
  const attempts = [
    { codec: 'libopus', format: 'ogg', path: base + '.ogg', mimetype: 'audio/ogg; codecs=opus', extra: [] },
    { codec: 'opus', format: 'ogg', path: base + '.ogg', mimetype: 'audio/ogg; codecs=opus', extra: [] },
    { codec: 'aac', format: 'mp4', path: base + '.m4a', mimetype: 'audio/mp4', extra: ['-movflags', '+faststart'] },
  ]

  let lastError
  for (const attempt of attempts) {
    try {
      await exec(binary, [
        '-y', '-v', 'error',
        '-i', inputPath,
        '-vn',
        '-t', String(maxSeconds),
        '-ac', '1',
        '-ar', '48000',
        '-c:a', attempt.codec,
        '-b:a', '64k',
        ...attempt.extra,
        '-f', attempt.format,
        attempt.path,
      ], { timeout: options.timeout || 120000 })
      const buffer = fs.readFileSync(attempt.path)
      if (!buffer.length) throw new Error(`Empty ${attempt.codec} output`)
      return { path: attempt.path, buffer, mimetype: attempt.mimetype, codec: attempt.codec }
    } catch (error) {
      if (error?.code === 'FFMPEG_MISSING') throw error
      lastError = error
      logSticker('audio-encode-failed', attempt.codec, error?.stderr || error?.message || error)
      try { fs.rmSync(attempt.path, { force: true }) } catch {}
    }
  }
  throw lastError || new Error('Could not encode the audio track')
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
  const animatedPath = path.join(directory, 'animated.webp')
  const audioPath = path.join(directory, 'audio.ogg')
  const pcmPath = path.join(directory, 'audio.pcm')

  const probe = options.probe || probeVideo
  const frame = options.extractFrame || extractFrame
  const animated = options.extractAnimated || extractAnimatedWebp
  const audioOut = options.extractAudio || extractAudio
  const pcm = options.extractPcm || extractPcm

  try {
    fs.writeFileSync(inputPath, videoBuffer)
    const info = await probe(inputPath, options)
    if (!info.hasAudio) return { hasAudio: false }

    await frame(inputPath, framePath, { ...options, duration: info.duration })

    // A sound sticker has to be animated to show WhatsApp's mute button. If the
    // animated encode fails, the caller falls back to a still sticker.
    let animatedBuffer
    try {
      animatedBuffer = await animated(inputPath, animatedPath, { ...options, duration: info.duration })
      if (animatedBuffer && !Buffer.isBuffer(animatedBuffer)) animatedBuffer = fs.readFileSync(animatedPath)
    } catch (error) {
      if (error?.code === 'FFMPEG_MISSING') throw error
      animatedBuffer = undefined
    }

    // Keep the voice note in sync with the animation, which is capped at six
    // seconds. A still fallback may keep the full voice-note length.
    const maxSeconds = options.maxSeconds || DEFAULT_MAX_AUDIO_SECONDS
    const audioMaxSeconds = animatedBuffer?.length
      ? Math.min(maxSeconds, ANIMATED_MAX_SECONDS)
      : maxSeconds

    const audioResult = await audioOut(inputPath, audioPath, { ...options, maxSeconds: audioMaxSeconds })

    let audioBuffer
    let audioMimetype = options.audioMimetype || 'audio/ogg; codecs=opus'
    let audioSourcePath = audioPath
    if (Buffer.isBuffer(audioResult)) {
      audioBuffer = audioResult
    } else if (audioResult && Buffer.isBuffer(audioResult.buffer)) {
      audioBuffer = audioResult.buffer
      if (audioResult.mimetype) audioMimetype = audioResult.mimetype
      if (typeof audioResult.path === 'string' && fs.existsSync(audioResult.path)) audioSourcePath = audioResult.path
    } else {
      audioBuffer = fs.readFileSync(audioPath)
    }
    if (!audioBuffer.length) return { hasAudio: false }

    let waveform
    try {
      await pcm(audioSourcePath, pcmPath, options)
      waveform = buildWaveform(fs.readFileSync(pcmPath))
    } catch {}

    return {
      hasAudio: true,
      frameBuffer: fs.readFileSync(framePath),
      animatedBuffer,
      audioBuffer,
      audioMimetype,
      seconds: audioSeconds(info.duration, audioMaxSeconds),
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

/** protobuf.js returns int64/uint64 fields as Long objects; the descriptor uses numbers. */
function toNumber(value) {
  if (value == null) return value
  if (typeof value === 'number') return value
  if (typeof value.toNumber === 'function') return value.toNumber()
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : value
}

/**
 * Match WhatsApp Web's audio descriptor exactly: no `ptt`, no `waveform`, and
 * numeric timestamps/lengths. Extra voice-note fields can make a client treat
 * the audio as an ordinary voice note instead of the sticker's soundtrack.
 */
function normalizeAudioDescriptor(audioMessage) {
  if (!audioMessage) return audioMessage
  if (audioMessage.fileLength != null) audioMessage.fileLength = toNumber(audioMessage.fileLength)
  if (audioMessage.mediaKeyTimestamp != null) audioMessage.mediaKeyTimestamp = toNumber(audioMessage.mediaKeyTimestamp)
  delete audioMessage.ptt
  delete audioMessage.waveform
  return audioMessage
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
    logSticker('extract-failed', error?.code || error?.message || error)
    return {
      ok: false,
      reason: error?.code === 'FFMPEG_MISSING' ? 'ffmpeg-missing' : 'extract-failed',
      error,
    }
  }
  if (!assets?.hasAudio || !assets.audioBuffer) {
    logSticker('no-audio')
    return { ok: false, reason: 'no-audio' }
  }

  const maxBytes = options.maxStickerBytes || DEFAULT_MAX_STICKER_BYTES
  const animated = Boolean(assets.animatedBuffer?.length)
  const audioMimetype = assets.audioMimetype || 'audio/ogg; codecs=opus'
  let stickerBuffer
  try {
    stickerBuffer = animated
      ? assets.animatedBuffer
      : await makeStaticWebp(assets.frameBuffer, { maxBytes })
  } catch (error) {
    logSticker('sticker-failed', error?.message || error)
    return { ok: false, reason: 'sticker-failed', error }
  }

  stickerBuffer = await applyStickerMetadata(stickerBuffer, {
    packname: options.packname || process.env.STICKER_PACK || 'SAFFUL-MD',
    author: options.author || process.env.STICKER_AUTHOR || 'Safful Tech',
  }, {
    maxBytes: animated ? (options.maxAnimatedBytes || DEFAULT_MAX_ANIMATED_BYTES) : maxBytes,
    exif: options.exif,
  })

  const prepare = options.prepare || prepareWAMessageMedia
  const generate = options.generate || generateWAMessageFromContent
  const relay = options.relay || defaultRelay
  const upload = options.upload || socket.waUploadToServer
  if (typeof upload !== 'function') {
    logSticker('upload-unavailable')
    return { ok: false, reason: 'upload-unavailable' }
  }

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
    // WhatsApp Web's sound-sticker audio descriptor carries only the media
    // fields, the mimetype, and the duration. It deliberately omits `ptt` and
    // `waveform`.
    audioPrepared = await prepare({
      audio: assets.audioBuffer,
      mimetype: audioMimetype,
      seconds: assets.seconds,
    }, mediaOptions)
  } catch (error) {
    logSticker('upload-failed', error?.message || error)
    return { ok: false, reason: 'upload-failed', error }
  }

  const stickerMessage = stickerPrepared?.stickerMessage
  const audioMessage = audioPrepared?.audioMessage
  if (!stickerMessage || !audioMessage) {
    logSticker('prepare-failed', JSON.stringify({
      sticker: Boolean(stickerMessage),
      audio: Boolean(audioMessage),
    }))
    return { ok: false, reason: 'prepare-failed' }
  }

  stickerMessage.isAnimated = animated
  stickerMessage.width = STICKER_SIZE
  stickerMessage.height = STICKER_SIZE
  stickerMessage.stickerSentTs = Date.now()
  normalizeAudioDescriptor(audioMessage)
  audioMessage.mimetype = audioMimetype
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
  finalSticker.isAnimated = animated
  finalSticker.width = STICKER_SIZE
  finalSticker.height = STICKER_SIZE
  finalSticker.mimetype = finalSticker.mimetype || 'image/webp'
  if (!finalSticker.stickerSentTs) finalSticker.stickerSentTs = stickerMessage.stickerSentTs

  // WhatsApp Web wraps sound stickers in `Message.audioStickerMessage` (field
  // 134). A bare `stickerMessage` with field 26 is ignored by recipients.
  await relay(socket, jid, wrapAudioSticker(wa.message), { messageId: wa.key.id })
  logSticker('sent', 'animated=' + animated, 'audio=' + audioMimetype, 'seconds=' + assets.seconds)
  return { ok: true, message: wa }
}

module.exports = {
  patchStickerAudioProto,
  wrapAudioSticker,
  parseProbeOutput,
  parseFfmpegProbe,
  normalizeAudioDescriptor,
  toNumber,
  buildWaveform,
  audioSeconds,
  makeStaticWebp,
  applyStickerMetadata,
  extractFrame,
  extractAnimatedWebp,
  extractAnimatedWebpViaGif: encodeAnimatedWebpViaGif,
  extractAudio,
  extractVideoAssets,
  sendAudioSticker,
  ffmpegPath,
  ffprobePath,
  STICKER_SIZE,
  DEFAULT_MAX_STICKER_BYTES,
  DEFAULT_MAX_ANIMATED_BYTES,
  DEFAULT_MAX_AUDIO_SECONDS,
}
