'use strict'

const { downloadContentFromMessage, downloadMediaMessage, generateMessageIDV2, proto } = require('@whiskeysockets/baileys')
const { detectViewOnce } = require('./safful-viewonce-detector')
const { bufferFrom } = require('./safful-status-media')
const { logLine, debugLog, LOG_FILE } = require('./safful-kk-log')
const phone = require('./safful-kk-phone')

// How long a single resend request may wait for the phone's answer, and how
// many requests `.kk` may send for one message. TurboFex uses 10s/2 attempts.
const RESEND_TIMEOUT = Math.max(1000, Number(process.env.SAFFUL_KK_RESEND_MS) || 10000)
const RESEND_ATTEMPTS = Math.max(1, Number(process.env.SAFFUL_KK_RESEND_ATTEMPTS) || 2)
const SILENT = { level: 'silent', info() {}, error() {}, warn() {}, debug() {}, trace() {}, fatal() {},
  child() { return SILENT } }

function delay(ms) {
  return new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })
}

function mediaKey(value) {
  if (Buffer.isBuffer(value)) return value
  if (ArrayBuffer.isView(value) || Array.isArray(value)) return Buffer.from(value)
  if (value?.type === 'Buffer') return mediaKey(value.data)
  if (typeof value === 'string') return Buffer.from(value.replace(/^data:;base64,/, ''), 'base64')
  return null
}
function hasMediaKey(media) {
  const key = mediaKey(media?.mediaKey)
  return Boolean(key && key.length === 32)
}
function statusCode(error) {
  return Number(error?.status || error?.response?.status || error?.output?.statusCode) || 0
}
function deadline(task, ms, onTimeout = () => {}) {
  let timer
  return Promise.race([task, new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(Object.assign(Error('Media operation timed out'), { code: 'KK_TIMEOUT' }))
    }, ms)
  })]).finally(() => clearTimeout(timer))
}
function asRaw(candidate, key) {
  if (!candidate || typeof candidate !== 'object') return null
  if (candidate.message) return { ...candidate, key: { ...key, ...candidate.key } }
  if (candidate.mtype && candidate.msg) return { key: { ...key, ...candidate.key }, message: { [candidate.mtype]: candidate.msg } }
  return { key, message: candidate }
}

// WhatsApp may now send a full https url without a directPath, while Baileys
// only trusts a "host/path" url and otherwise rebuilds the CDN address from
// directPath. Normalise both shapes so the download never fails on metadata.
function normalizeMedia(media) {
  const url = typeof media?.url === 'string' ? media.url.trim() : ''
  let directPath = typeof media?.directPath === 'string' ? media.directPath : ''
  if (!directPath && url) {
    try {
      const parsed = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url)
      directPath = parsed.pathname + parsed.search
    } catch {}
  }
  let normalizedUrl = url.replace(/^https?:\/\//i, '')
  if (!normalizedUrl.startsWith('mmg.whatsapp.net/')) normalizedUrl = ''
  return { ...media, directPath, url: normalizedUrl || undefined }
}

// Baileys keeps recently decrypted message content for retry receipts; it is
// the cheapest source of an original media key when the quote was stripped.
function recentOriginal(socket, chat, id) {
  try {
    const recent = socket?.messageRetryManager?.getRecentMessage?.(chat, id)
    if (recent?.message) return { key: { remoteJid: chat, id }, message: recent.message }
  } catch {}
  return null
}

// New WhatsApp clients no longer fan view-once ciphertext out to linked
// devices (the companion only sees an "unavailable" stub) and strip media
// fields from a quote. Ask the primary phone to resend the original stanza,
// then use the full message it returns.
function pdoKey(key) {
  return {
    remoteJid: key.remoteJid, fromMe: Boolean(key.fromMe), id: key.id,
    participant: key.participant || undefined,
  }
}

// Baileys deduplicates resend requests through its placeholder cache: a second
// request for the same id returns immediately and sends nothing at all. That
// made .kk silently skip the phone whenever Baileys had already queued a
// request for the same unavailable stub. Always clear the entry first.
async function clearResendCache(socket, id) {
  const cache = socket?.placeholderResendCache
  if (!id || !cache || typeof cache.del !== 'function') return
  try { await Promise.resolve(cache.del(id)) } catch {}
}

// Fire-and-forget variant for the capture pipeline: the phone's answer arrives
// as a normal messages.upsert, which the view-once detector already handles.
// Requests are budgeted (TurboFex core/placeholder.js): the phone shows a
// "Finished syncing" notice for every one of them.
async function sendResendRequest(socket, key) {
  if (!socket || !key?.id || !key?.remoteJid) return false
  const messageKey = pdoKey(key)
  if (!phone.allow(messageKey.id)) return false
  let charged = true
  await clearResendCache(socket, messageKey.id)
  if (typeof socket.requestPlaceholderResend === 'function') {
    try {
      const result = await deadline(Promise.resolve(socket.requestPlaceholderResend(messageKey)), 12000)
      // `undefined` means Baileys thinks a request is already in flight. Keep
      // waiting for that answer instead of sending a duplicate request.
      logLine('resend-helper', messageKey.id, 'result=' + String(result))
      return true
    } catch (error) {
      logLine('resend-helper-failed', messageKey.id, error?.message || String(error))
    }
  }
  if (typeof socket.sendPeerDataOperationMessage === 'function') {
    try {
      const result = await deadline(Promise.resolve(socket.sendPeerDataOperationMessage({
        placeholderMessageResendRequest: [{ messageKey }],
        peerDataOperationRequestType: proto.Message.PeerDataOperationRequestType.PLACEHOLDER_MESSAGE_RESEND,
      })), 12000)
      logLine('resend-raw-pdo', messageKey.id, 'result=' + String(result))
      return true
    } catch (error) {
      logLine('resend-raw-pdo-failed', messageKey.id, error?.message || String(error))
    }
  }
  if (charged) { phone.refund(messageKey.id); charged = false }
  return false
}

// The phone answers a placeholder-resend as an ordinary upsert (Baileys tags
// the response with requestId). Watch every channel it can arrive on so `.kk`
// can use the complete message instead of only hoping the capture store saw it.
function watchAnswers(socket, onAnswer) {
  if (!socket?.ev?.on) return () => {}
  const upsert = data => { for (const raw of data?.messages || []) onAnswer(raw, data?.requestId) }
  const update = data => {
    for (const item of data || []) {
      if (!item?.update?.message) continue
      onAnswer({ ...item.update, key: { ...item.key, ...(item.update.key || {}) } }, item?.requestId)
    }
  }
  const history = data => { for (const raw of data?.messages || []) onAnswer(raw, data?.requestId) }
  try {
    socket.ev.on('messages.upsert', upsert)
    socket.ev.on('messages.update', update)
    socket.ev.on('messaging-history.set', history)
  } catch { return () => {} }
  return () => {
    for (const [event, handler] of [['messages.upsert', upsert],
      ['messages.update', update], ['messaging-history.set', history]]) {
      try { socket.ev.off?.(event, handler) } catch {}
    }
  }
}

// Ask the primary phone for the original message and collect its answer.
// Newer WhatsApp builds give linked devices no view-once ciphertext at all and
// strip the media key from the quote, so the phone is the only remaining
// source. TurboFex does exactly this at arrival (askPhoneAgain) and again from
// `.vv`; the returned state says what really happened:
//   resent    - the phone returned the original (with a media key)
//   stub      - the phone answered, but without decryptable media
//   no-answer - the request went out and nothing came back in time
//   no-budget - the hourly phone allowance is spent
//   no-api    - this socket cannot request a resend at all
async function requestOriginal(socket, key, options = {}) {
  if (!socket || !key?.id || !key?.remoteJid) return { state: 'no-key', raw: null }
  const messageKey = pdoKey(key)
  const timeout = Math.max(1000, Number(options.timeout) || RESEND_TIMEOUT)
  const attempts = Math.max(1, Number(options.attempts) || RESEND_ATTEMPTS)
  const answers = []
  const stop = watchAnswers(socket, (raw, requestId) => {
    if (!raw || typeof raw !== 'object') return
    const ours = raw.key?.id === messageKey.id
    // A tagged answer during our wait is ours even when the phone restamped the
    // key; only untagged messages have to match the id exactly.
    if (!ours && !requestId) return
    const candidate = ours ? raw : { ...raw, key: { ...(raw.key || {}), ...messageKey } }
    const detected = detectViewOnce({ ...candidate, key: { ...candidate.key, isViewOnce: true } })
    answers.push({ raw: candidate, hasKey: hasMediaKey(detected?.media) })
    debugLog('resend-answer', messageKey.id, 'tag=' + (requestId || 'none'),
      'media=' + Boolean(detected), 'key=' + hasMediaKey(detected?.media))
  })
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const sent = await sendResendRequest(socket, messageKey)
      if (!sent) {
        const { used, limit } = phone.spent()
        return { state: used >= limit ? 'no-budget' : 'no-api', raw: null }
      }
      const started = Date.now()
      while (Date.now() - started < timeout) {
        const withKey = answers.find(answer => answer.hasKey)
        if (withKey) return { state: 'resent', raw: withKey.raw }
        await delay(200)
      }
      logLine('resend-attempt', messageKey.id, attempt + '/' + attempts, 'without media')
    }
  } finally {
    stop()
  }
  const withKey = answers.find(answer => answer.hasKey)
  if (withKey) return { state: 'resent', raw: withKey.raw }
  if (answers.length) return { state: 'stub', raw: answers[answers.length - 1].raw }
  return { state: 'no-answer', raw: null }
}

// TurboFex downloads through Baileys' own helper, which retries once and then
// asks the phone for a fresh link on HTTP 410/404 (reuploadRequest). Our manual
// `retrieve` builds the message itself; this path is worth trying when that
// fails because it uses the exact stanza Baileys expects.
async function downloadOriginal(socket, raw, detected) {
  if (!detected?.type || !detected?.media || !raw?.key) {
    throw Object.assign(Error('No stored message'), { code: 'KK_MISSING_KEY' })
  }
  const type = detected.type === 'ptvMessage' ? 'videoMessage' : detected.type
  const media = { ...detected.media }
  media.mediaKey = mediaKey(media.mediaKey)
  if (!media.mediaKey || media.mediaKey.length !== 32) {
    throw Object.assign(Error('Missing original media key'), { code: 'KK_MISSING_KEY' })
  }
  // Baileys' downloadMediaMessage only treats a message as media when it has
  // `url` (or `thumbnailDirectPath`); WhatsApp often sends only directPath.
  if (!media.url && typeof media.directPath === 'string' && media.directPath) {
    media.url = 'https://mmg.whatsapp.net' + media.directPath
  } else if (typeof media.url === 'string' && media.url && !/^https?:\/\//i.test(media.url)) {
    media.url = 'https://' + media.url.replace(/^\/+/, '')
  }
  const source = { key: { ...raw.key }, message: { [type]: media } }
  const ctx = typeof socket?.updateMediaMessage === 'function'
    ? { logger: SILENT, reuploadRequest: message => socket.updateMediaMessage(message) }
    : undefined
  const buffer = await deadline(Promise.resolve(downloadMediaMessage(source, 'buffer', {}, ctx)), 25000)
  if (!buffer?.length) throw Object.assign(Error('Empty download'), { code: 'KK_EMPTY' })
  const kind = detected.type === 'ptvMessage' ? 'video' : detected.type.replace('Message', '')
  return { found: { ...detected, kind, media: detected.media }, bytes: buffer }
}

// Re-send the stored original as an ordinary message instead of downloading it.
// The relay carries the mediaKey/url/directPath that are already in the stored
// stanza, so no key handling and no local download are involved: the recipient
// fetches the ciphertext straight from the CDN. This is how other Baileys bots
// (levanter's .vv plugin, via forwardOrBroadCast(..., { viewOnce: false }))
// deliver view-once media, and it is the only path that survives a stripped
// quote, because it never asks this device to decrypt anything.
function relayContent(detected) {
  const type = detected.type === 'ptvMessage' ? 'videoMessage' : detected.type
  const media = { ...detected.media }
  delete media.viewOnce
  delete media.ptv
  media.mediaKey = mediaKey(media.mediaKey)
  return { [type]: media }
}

async function relayStored(socket, destination, detected) {
  if (!detected?.type || !detected?.media) {
    throw Object.assign(Error('No stored original media'), { code: 'KK_MISSING_KEY' })
  }
  const key = mediaKey(detected.media.mediaKey)
  if (!key || key.length !== 32) throw Object.assign(Error('Missing original media key'), { code: 'KK_MISSING_KEY' })
  if (!detected.media.directPath && !detected.media.url) {
    throw Object.assign(Error('No original download location'), { code: 'KK_MISSING_URL' })
  }
  if (typeof socket?.relayMessage !== 'function') {
    throw Object.assign(Error('This socket cannot relay a stored message'), { code: 'KK_NO_RELAY' })
  }
  const content = relayContent(detected)
  const messageId = typeof socket.generateMessageIDV2 === 'function'
    ? socket.generateMessageIDV2() : generateMessageIDV2()
  await deadline(Promise.resolve(socket.relayMessage(destination, content, { messageId })), 20000)
  logLine('relayed', destination, Object.keys(content)[0])
  return Object.keys(content)[0]
}

async function retrieve(socket, raw, detected) {
  const kind = detected.type === 'ptvMessage' ? 'video' : detected.type.replace('Message', '')
  const key = mediaKey(detected.media.mediaKey)
  if (!key || key.length !== 32) throw Object.assign(Error('Missing original media key'), { code: 'KK_MISSING_KEY' })
  const found = { ...detected, kind, media: { ...normalizeMedia(detected.media), mediaKey: key } }
  async function fetch(media) {
    let stream, expired = false
    const task = (async () => {
      stream = await downloadContentFromMessage(media, kind)
      if (expired) { stream.destroy?.(); throw Error('Download expired') }
      return bufferFrom(stream)
    })()
    return deadline(task, 20000, () => { expired = true; stream?.destroy?.() })
  }
  let failure
  if (found.media.directPath || found.media.url) {
    try { return { found, bytes: await fetch(found.media) } } catch (error) { failure = error }
    if (![400, 403, 404, 410].includes(statusCode(failure))) throw failure
  }
  if (!raw.key?.id || !raw.key?.remoteJid || typeof socket.updateMediaMessage !== 'function') {
    throw failure || Object.assign(Error('No original download location'), { code: 'KK_MISSING_URL' })
  }
  // The refresh API accepts unwrapped media and unwraps view-once wrappers
  // itself. Its assertion does not accept ptvMessage, so video notes use
  // videoMessage while retaining the original key.
  const type = detected.type === 'ptvMessage' ? 'videoMessage' : detected.type
  const request = { key: { ...raw.key }, message: { [type]: { ...found.media } } }
  const updated = await deadline(Promise.resolve(socket.updateMediaMessage(request)), 15000)
  const refreshed = detectViewOnce({ ...(updated || request), key: { ...(updated || request).key, isViewOnce: true } })
  if (!refreshed) throw Object.assign(Error('No refreshed media'), { code: 'KK_MISSING_URL' })
  found.media = { ...normalizeMedia(refreshed.media), mediaKey: mediaKey(refreshed.media.mediaKey) || key }
  return { found, bytes: await fetch(found.media) }
}

// WhatsApp always includes a tiny jpeg preview of a picture, even when it
// withholds the file itself. TurboFex sends that preview when the real download
// fails; it is the difference between "nothing" and "this is what it looked
// like". Returns null when the message carries no preview.
function thumbnailOf(detected) {
  const thumb = detected?.media?.jpegThumbnail
  if (Buffer.isBuffer(thumb)) return thumb.length ? thumb : null
  if (ArrayBuffer.isView(thumb) || Array.isArray(thumb)) {
    const bytes = Buffer.from(thumb)
    return bytes.length ? bytes : null
  }
  if (thumb?.type === 'Buffer' && Array.isArray(thumb.data)) {
    const bytes = Buffer.from(thumb.data)
    return bytes.length ? bytes : null
  }
  return null
}

// Compact description used by the log file, never sent to a chat.
function describe(raw) {
  const detected = detectViewOnce(raw)
  if (!detected) return { viewOnce: false }
  const media = detected.media || {}
  return {
    viewOnce: true,
    type: detected.type,
    key: hasMediaKey(media),
    directPath: typeof media.directPath === 'string' && media.directPath.length > 0,
    url: typeof media.url === 'string' && media.url.length > 0,
    caption: Boolean(media.caption),
  }
}

module.exports = { asRaw, retrieve, relayStored, relayContent, statusCode, deadline, debugLog, logLine, describe,
  thumbnailOf, hasMediaKey, mediaKey, normalizeMedia, recentOriginal, sendResendRequest, requestOriginal,
  downloadOriginal, RESEND_TIMEOUT }
