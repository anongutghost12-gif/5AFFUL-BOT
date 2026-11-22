'use strict'

// Always-on view-once capture.
//
// A view-once message is only decryptable while the original stanza (with its
// 32-byte mediaKey) is available and the CDN object has not been deleted after
// viewing. Waiting for `.kk` to run is therefore a race that is usually lost:
// the reply quote is stripped of mediaKey/directPath, the store may have been
// trimmed, and WhatsApp removes the media once it is opened.
//
// This module copies every view-once message at arrival and downloads the
// bytes immediately, before anything can consume or expire them. `.kk` then
// only has to send the stored bytes; no network, no phone round-trip.
//
// Storage: temp/kk-capture/<message-id>.json + <message-id>.bin
// Disable with SAFFUL_KK_CAPTURE=0. Tune with SAFFUL_KK_CAPTURE_MAX_MB,
// SAFFUL_KK_CAPTURE_MAX and SAFFUL_KK_CAPTURE_TTL_HOURS.

const fs = require('fs')
const path = require('path')
const { detectViewOnce } = require('./safful-viewonce-detector')
const { retrieve, hasMediaKey, statusCode, logLine, sendResendRequest, thumbnailOf } = require('./safful-kk-media')

const ENABLED = !/^(0|false|no|off)$/i.test(String(process.env.SAFFUL_KK_CAPTURE || '1'))
const ROOT = process.env.SAFFUL_KK_CAPTURE_DIR
  ? path.resolve(process.env.SAFFUL_KK_CAPTURE_DIR)
  : path.join(__dirname, '..', 'temp', 'kk-capture')
const MAX_BYTES = Math.max(1, Number(process.env.SAFFUL_KK_CAPTURE_MAX_MB) || 64) * 1024 * 1024
const MAX_ENTRIES = Math.max(20, Number(process.env.SAFFUL_KK_CAPTURE_MAX) || 300)
const TTL_MS = Math.max(1, Number(process.env.SAFFUL_KK_CAPTURE_TTL_HOURS) || 72) * 60 * 60 * 1000
const MAX_JSON = 512 * 1024
const CONCURRENCY = 2
// How long to wait for the phone's answer before allowing another request for
// the same message. Matches TurboFex's answerWait.
const ANSWER_MS = Math.max(2000, Number(process.env.SAFFUL_KK_ANSWER_MS) || 20000)

const memory = new Map()
const inflight = new Set()
const queue = []
let active = 0
let prunedAt = 0

function log(...parts) {
  logLine('[capture]', ...parts)
}

function normalize(jid) {
  return String(jid || '').replace(/:\d+@/, '@').trim()
}

function sameChat(a, b) {
  return Boolean(a && b) && normalize(a) === normalize(b)
}

function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 96)
}

function jsonPath(id) {
  return path.join(ROOT, safeId(id) + '.json')
}

function binPath(id) {
  return path.join(ROOT, safeId(id) + '.bin')
}

// WhatsApp attaches a tiny jpeg preview even when it withholds the file. Kept
// in its own small file so a failed capture still has something to show.
function thumbPath(id) {
  return path.join(ROOT, safeId(id) + '.thumb')
}

function ensureRoot() {
  try { fs.mkdirSync(ROOT, { recursive: true }) } catch {}
}

function pickMedia(media) {
  const copy = {}
  for (const key of ['mimetype', 'caption', 'ptt', 'fileName', 'fileLength',
    'seconds', 'pageCount', 'width', 'height', 'isAnimated']) {
    if (media?.[key] !== undefined) copy[key] = media[key]
  }
  return copy
}

function serializable(raw) {
  try {
    const text = JSON.stringify(raw, (_key, value) => {
      if (Buffer.isBuffer(value)) return { type: 'Buffer', data: [...value] }
      return value
    })
    if (!text || text.length > MAX_JSON) return null
    return JSON.parse(text)
  } catch {
    return null
  }
}

function saveEntry(entry) {
  if (!entry?.id) return
  ensureRoot()
  const target = jsonPath(entry.id)
  const temporary = target + '.tmp'
  try {
    fs.writeFileSync(temporary, JSON.stringify(entry), 'utf8')
    fs.renameSync(temporary, target)
  } catch (error) {
    log('write-failed', entry.id, error?.message || String(error))
  }
}

function loadEntry(id) {
  if (!id) return null
  if (memory.has(id)) return memory.get(id)
  try {
    const entry = JSON.parse(fs.readFileSync(jsonPath(id), 'utf8'))
    if (entry?.id === id) {
      memory.set(id, entry)
      return entry
    }
  } catch {}
  return null
}

function readBin(entry) {
  if (!entry?.captured) return null
  try {
    const file = binPath(entry.id)
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_BYTES) return null
    return fs.readFileSync(file)
  } catch {
    return null
  }
}

function readThumb(entry) {
  if (!entry?.thumb) return null
  try { return fs.readFileSync(thumbPath(entry.id)) } catch { return null }
}

function saveThumb(entry, detected) {
  const thumb = thumbnailOf(detected)
  if (!thumb) return
  try {
    ensureRoot()
    fs.writeFileSync(thumbPath(entry.id), thumb)
    entry.thumb = thumb.length
  } catch (error) {
    log('thumb-write-failed', entry.id, error?.message || String(error))
  }
}

function prune(force = false) {
  const now = Date.now()
  if (!force && now - prunedAt < 60 * 1000) return
  prunedAt = now
  let names
  try { names = fs.readdirSync(ROOT) } catch { return }
  const entries = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
    const id = name.slice(0, -5)
    let entry
    try { entry = JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8')) } catch { continue }
    if (!entry?.id) continue
    if (now - Number(entry.receivedAt || 0) > TTL_MS) {
      removeEntry(entry.id)
      continue
    }
    entries.push(entry)
  }
  if (entries.length <= MAX_ENTRIES) return
  entries.sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0))
  for (const entry of entries.slice(0, entries.length - MAX_ENTRIES)) removeEntry(entry.id)
}

function removeEntry(id) {
  memory.delete(id)
  for (const file of [jsonPath(id), binPath(id), thumbPath(id), jsonPath(id) + '.tmp']) {
    try { fs.unlinkSync(file) } catch {}
  }
}

function enqueue(socket, entry, options) {
  queue.push({ socket, entry, options })
  pump()
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()
    active += 1
    void download(job.socket, job.entry, job.options)
      .catch(error => log('download-crash', job.entry?.id, error?.message || String(error)))
      .finally(() => { active -= 1; pump() })
  }
}

async function download(socket, entry, options = {}) {
  if (!entry?.id || inflight.has(entry.id)) return
  inflight.add(entry.id)
  let detected
  try {
    // Use the live copy for the download; the serialized copy may have been
    // dropped when a message exceeded the JSON size limit.
    const raw = options.raw || entry.raw
    // The phone's answer is ordinary media, so the forced view-once detection
    // used by `ingest` must be repeated here or the bytes are never fetched.
    detected = detectViewOnce(raw) ||
      (options.assume ? detectViewOnce({ ...raw, key: { ...(raw?.key || {}), isViewOnce: true } }) : null)
    if (!detected) return
    const result = options.download
      ? await options.download(raw, detected)
      : await retrieve(socket, raw, detected)
    const bytes = Buffer.isBuffer(result) ? result : result?.bytes
    if (!bytes?.length) throw Object.assign(Error('Empty capture'), { code: 'KK_EMPTY' })
    if (bytes.length > MAX_BYTES) throw Object.assign(Error('Capture too large'), { code: 'KK_TOO_LARGE' })
    ensureRoot()
    fs.writeFileSync(binPath(entry.id), bytes)
    entry.captured = true
    entry.bytes = bytes.length
    entry.reason = ''
    entry.media = { ...entry.media, ...pickMedia(detected.media) }
    memory.set(entry.id, entry)
    saveEntry(entry)
    log('captured', entry.id, entry.kind || '', bytes.length + 'B', 'source=' + (entry.source || 'unknown'))
  } catch (error) {
    entry.reason = error?.code || (statusCode(error) ? 'http-' + statusCode(error) : '') ||
      String(error?.message || error).slice(0, 120)
    entry.captured = false
    // Keep the preview WhatsApp always sends: TurboFex falls back to it when
    // the real file can no longer be fetched.
    if (detected) saveThumb(entry, detected)
    memory.set(entry.id, entry)
    saveEntry(entry)
    log('capture-failed', entry.id, entry.reason, entry.thumb ? 'thumb=' + entry.thumb + 'B' : 'no-thumb')
  } finally {
    inflight.delete(entry.id)
  }
}

// Copy and record a view-once message. Returns the stored entry (or null when
// the message is not view-once). `options.download` is a test seam.
function ingest(socket, raw, source = 'upsert', options = {}) {
  if (!ENABLED || !raw || typeof raw !== 'object') return null
  const id = raw.key?.id
  if (!id) return null
  let copy
  try { copy = structuredClone(raw) } catch { copy = raw }
  // The phone answers a resend request with an ordinary media message that no
  // longer carries the view-once flag or wrapper. `assume` is only set for an
  // id we asked about, so a normal picture sent later is never captured.
  const detected = detectViewOnce(copy) ||
    (options.assume ? detectViewOnce({ ...copy, key: { ...(copy.key || {}), isViewOnce: true } }) : null)
  if (!detected) return null
  const keyed = hasMediaKey(detected.media)
  const previous = loadEntry(id)
  // Never let a late stub overwrite bytes we already captured.
  if (previous?.captured && !keyed) return previous
  const entry = {
    version: 1,
    id,
    chat: raw.key?.remoteJid || '',
    chatAlt: raw.key?.remoteJidAlt || '',
    participant: raw.key?.participant || '',
    participantAlt: raw.key?.participantAlt || '',
    fromMe: Boolean(raw.key?.fromMe),
    receivedAt: previous?.captured ? previous.receivedAt : Date.now(),
    source,
    type: detected.type,
    kind: detected.type === 'ptvMessage' ? 'video' : detected.type.replace('Message', ''),
    hasKey: keyed,
    reason: keyed ? '' : (previous?.reason === 'phone-budget' ? 'phone-budget'
      : (previous?.reason === 'phone-stub' ? 'phone-stub' : 'no-media-key')),
    media: pickMedia(detected.media),
    raw: serializable(copy),
    captured: Boolean(previous?.captured),
    bytes: previous?.bytes || 0,
    // A late stub must not make us ask the phone again while its first answer
    // is still on the way.
    askedAt: previous?.askedAt || 0,
  }
  memory.set(id, entry)
  saveEntry(entry)
  log('seen', id, entry.kind, 'key=' + keyed, 'source=' + source, options.assume ? 'assume=1' : '')
  if (keyed && !entry.captured) enqueue(socket, entry, { ...options, raw: copy })
  prune()
  return entry
}

// True while the phone's answer to our request can still arrive.
function answerWindow(entry) {
  const at = Number(entry?.askedAt || 0)
  return at > 0 && Date.now() - at <= ANSWER_MS
}

// The phone answered, but with another empty stub instead of media. Remember
// that so `.kk` reports "phone sent no media" instead of asking again.
function markAnswerStub(id, entry) {
  if (!entry) return entry
  entry.reason = 'phone-stub'
  entry.captured = false
  memory.set(id, entry)
  saveEntry(entry)
  log('answer-stub', id, 'source=' + (entry.source || 'unknown'))
  return entry
}

// An unavailable fanout carries no payload at all. Remember it so `.kk` can
// explain the real reason instead of pretending a key was lost locally.
function noteUnavailable(key, type = 'view_once', socket = null) {
  if (!ENABLED || !key?.id) return null
  const previous = loadEntry(key.id)
  if (previous?.captured) return previous
  // A second notice for an id we already asked about is the phone's answer.
  // Ignore duplicates that arrive within the first 1.5 s (two attached
  // sockets report the same stanza milliseconds apart).
  const answered = answerWindow(previous) && Date.now() - Number(previous.askedAt) > 1500
  const entry = {
    version: 1,
    id: key.id,
    chat: key.remoteJid || '',
    chatAlt: key.remoteJidAlt || '',
    participant: key.participant || '',
    participantAlt: key.participantAlt || '',
    fromMe: Boolean(key.fromMe),
    receivedAt: Date.now(),
    source: 'unavailable',
    type: '',
    kind: '',
    hasKey: false,
    reason: answered ? 'phone-stub' : (previous?.reason === 'phone-stub' ? 'phone-stub'
      : 'unavailable:' + String(type || 'view_once')),
    media: {},
    raw: null,
    captured: false,
    bytes: 0,
    // A re-announcement must not spend a second phone request.
    askedAt: previous?.askedAt || 0,
  }
  memory.set(key.id, entry)
  saveEntry(entry)
  log(answered ? 'answer-stub' : 'unavailable', key.id, entry.reason)
  // The WS notice can arrive without an upsert. Ask the phone here as well so
  // a withheld view-once is not lost just because Baileys only ACKed it.
  if (socket && !key.fromMe && !entry.askedAt) askPhone(socket, { key }, entry, 'unavailable')
  return entry
}

// WhatsApp announces some view-once messages without any content at all on a
// linked device (no payload, or only messageContextInfo). TurboFex calls this
// "chasing": ask the phone once, then let the answer arrive as a normal message
// with the same id. A bare stub is only chased when something proves it is a
// view-once; otherwise ordinary undecryptable traffic would spend the budget.
const CHASE_EMPTY = /^(1|true|yes|on)$/i.test(String(process.env.SAFFUL_KK_CHASE_EMPTY || ''))

function hiddenStub(type) {
  if (type === 2 || type === 'CIPHERTEXT') return true
  return type == null && CHASE_EMPTY
}

function bareContent(content) {
  return Object.keys(content || {}).every(key =>
    key === 'messageContextInfo' || key === 'senderKeyDistributionMessage')
}

// Proof that a content-less stub is a view-once, not a group event or a message
// this device simply cannot decrypt. WhatsApp sets key.isViewOnce on the
// unavailable fanout; a stored entry means we saw the notice earlier.
function viewOnceEvidence(raw, previous) {
  if (raw.key?.isViewOnce === true) return true
  const params = Array.isArray(raw.messageStubParameters) ? raw.messageStubParameters : []
  if (params.some(value => /view.?once/i.test(String(value)))) return true
  if (previous && (/^unavailable:/.test(previous.reason || '') || previous.type)) return true
  return false
}

function chase(socket, raw, source) {
  if (!ENABLED || !raw?.key?.id) return null
  const id = raw.key.id
  const previous = loadEntry(id)
  if (previous?.captured) return previous
  // Replaying old history must not spend the phone budget on every stale stub.
  if (source === 'messaging-history.set') return previous
  if (answerWindow(previous)) {
    // This is the phone's answer and it is still empty.
    if (Date.now() - Number(previous.askedAt) > 1500) return markAnswerStub(id, previous)
    return previous
  }
  const bare = Boolean(raw.message) && bareContent(raw.message)
  if (!viewOnceEvidence(raw, previous) && !(CHASE_EMPTY && (bare || hiddenStub(raw.messageStubType)))) {
    return previous
  }
  const entry = previous || {
    version: 1,
    id,
    chat: raw.key?.remoteJid || '',
    chatAlt: raw.key?.remoteJidAlt || '',
    participant: raw.key?.participant || '',
    participantAlt: raw.key?.participantAlt || '',
    fromMe: Boolean(raw.key?.fromMe),
    receivedAt: Date.now(),
    source,
    type: '',
    kind: '',
    hasKey: false,
    media: {},
    raw: null,
    captured: false,
    bytes: 0,
  }
  if (!/^(unavailable|phone-)/.test(entry.reason || '')) entry.reason = 'no-content'
  return askPhone(socket, raw, entry, source)
}

// One budgeted request to the primary phone. Shared by "announced without any
// content" and "view-once wrapper without a media key": both mean the linked
// device never received the ciphertext, so only the phone can supply it.
// TurboFex does this at arrival (askPhoneAgain) instead of waiting for `.vv`.
function askPhone(socket, raw, entry, source) {
  const id = raw?.key?.id
  if (!id || entry?.captured) return entry
  // The phone already answered this id with an empty stub. Asking again only
  // spends another slot and shows another notice on the phone; a deliberate
  // retry from `.kk` goes through requestOriginal instead.
  if (entry?.reason === 'phone-stub') return entry
  // Already asked: wait for the phone's answer instead of spending another slot.
  if (entry?.askedAt && Date.now() - entry.askedAt < ANSWER_MS) return entry
  const current = entry
  current.askedAt = Date.now()
  memory.set(id, current)
  saveEntry(current)
  log('ask-phone', id, 'reason=' + (current.reason || ''), 'source=' + source)
  void sendResendRequest(socket, raw.key).then(asked => {
    if (asked) return
    const latest = loadEntry(id) || current
    latest.askedAt = 0
    latest.reason = 'phone-budget'
    memory.set(id, latest)
    saveEntry(latest)
    log('ask-phone-budget', id)
  }).catch(error => log('ask-phone-failed', id, error?.message || String(error)))
  return current
}

// Record a message, and chase it when WhatsApp announced it without content.
function consider(socket, raw, source, options = {}) {
  if (!ENABLED || !raw || typeof raw !== 'object') return null
  const id = raw.key?.id
  const previous = id ? loadEntry(id) : null
  const answering = answerWindow(previous)
  // Only an id we asked about (or one already known as an unavailable
  // view-once) may be read as view-once without the flag. This is how the
  // phone's plain media answer is captured.
  const assume = answering || /^(unavailable:|no-content)/.test(previous?.reason || '')
  const stored = ingest(socket, raw, source, { ...options, assume })
  if (stored) {
    // WhatsApp now delivers a view-once to linked devices as a wrapper whose
    // media node has no mediaKey/url/directPath (TurboFex's `empty`). The bytes
    // are held on the phone and never fan out, so ask for them right now while
    // the phone can still answer. The complete copy arrives later with the same
    // id and `ingest` downloads it.
    if (!stored.captured && !stored.hasKey && !raw.key?.fromMe && source !== 'messaging-history.set') {
      if (answering && Date.now() - Number(previous.askedAt) > 1500) markAnswerStub(id, stored)
      else askPhone(socket, raw, stored, source)
    }
    return stored
  }
  if (!raw.key?.id || raw.key.fromMe) return null
  if (!raw.message || bareContent(raw.message)) return chase(socket, raw, source)
  return null
}

// Read a capture. Message ids are unique, so the id is the primary key; the
// chat is only used to prefer the right entry and to reject obvious mismatches.
async function read(chat, id) {
  if (!id) return null
  const entry = loadEntry(id)
  if (!entry) return null
  if (chat && entry.chat && !sameChat(entry.chat, chat) && !sameChat(entry.chatAlt, chat)) {
    log('chat-mismatch', id, 'stored=' + entry.chat, 'asked=' + chat)
  }
  const bytes = readBin(entry)
  return {
    entry,
    raw: entry.raw,
    reason: entry.reason || '',
    askedAt: Number(entry.askedAt || 0),
    bytes: bytes || null,
    thumb: readThumb(entry),
  }
}

// Poll the store for the bytes the phone was asked to send. `.kk` uses this so
// a reply that arrives while the answer is still travelling does not fail with
// KK_MISSING_KEY before the media lands.
async function waitForBytes(chat, id, timeoutMs = ANSWER_MS) {
  const until = Date.now() + Math.max(0, Number(timeoutMs) || 0)
  for (;;) {
    const result = await read(chat, id)
    if (result?.bytes?.length) return result
    if (!result) return null
    // No request outstanding, or the phone already answered with a stub.
    if (!result.askedAt || result.reason === 'phone-stub') return result
    if (Date.now() >= until) return result
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 400)
      timer.unref?.()
    })
  }
}

function status() {
  prune(true)
  let entries = 0
  let captured = 0
  let asked = 0
  let bytes = 0
  try {
    for (const name of fs.readdirSync(ROOT)) {
      if (!name.endsWith('.json') || name.endsWith('.tmp')) continue
      entries += 1
      try {
        const entry = JSON.parse(fs.readFileSync(path.join(ROOT, name), 'utf8'))
        if (entry?.captured) { captured += 1; bytes += Number(entry.bytes || 0) }
        if (entry?.askedAt) asked += 1
      } catch {}
    }
  } catch {}
  return { enabled: ENABLED, directory: ROOT, entries, captured, asked, bytes, pending: inflight.size, queued: queue.length }
}

function attach(socket) {
  if (!socket || socket.__saffulKkCaptureAttached) return socket
  socket.__saffulKkCaptureAttached = true
  if (!ENABLED) return socket
  ensureRoot()
  prune(true)

  const handle = (event, data) => {
    if (event === 'messages.upsert' || event === 'messaging-history.set') {
      for (const raw of data?.messages || []) consider(socket, raw, event)
      return
    }
    if (event === 'messages.update') {
      for (const item of data || []) {
        if (!item?.update?.message) continue
        consider(socket, { ...item.update, key: { ...item.key, ...(item.update.key || {}) } }, event)
      }
    }
  }

  // Run before the legacy dispatcher so the copy is taken while the wrapper and
  // the media key are still intact. The detector wraps emit the same way; the
  // wrappers chain, and each one only reads its own copy.
  if (typeof socket.ev?.emit === 'function') {
    const emit = socket.ev.emit.bind(socket.ev)
    socket.ev.emit = (event, data) => {
      try { handle(event, data) } catch (error) { log('emit-error', error?.message || String(error)) }
      return emit(event, data)
    }
  } else if (typeof socket.ev?.on === 'function') {
    socket.ev.on('messages.upsert', data => handle('messages.upsert', data))
    socket.ev.on('messages.update', data => handle('messages.update', data))
  }

  // Baileys ACKs some unavailable view-once fanouts without an upsert.
  try {
    socket.ws?.on?.('CB:message', node => {
      const unavailable = Array.isArray(node?.content) && node.content.find(child => child.tag === 'unavailable')
      const type = unavailable?.attrs?.type || ''
      if (!/^view_once(?:_unavailable_fanout)?$/.test(type)) return
      noteUnavailable({
        id: node.attrs?.id,
        remoteJid: node.attrs?.from,
        participant: node.attrs?.participant,
        participantAlt: node.attrs?.participant_pn,
        remoteJidAlt: node.attrs?.sender_pn,
      }, type, socket)
    })
  } catch {}

  log('attached', 'dir=' + ROOT)
  return socket
}

module.exports = { attach, ingest, consider, chase, read, waitForBytes, noteUnavailable, status, prune,
  ENABLED, ROOT, ANSWER_MS }
