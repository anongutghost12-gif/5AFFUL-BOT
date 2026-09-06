'use strict'

const WRAPPERS = new Set(['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'])
const CONTAINERS = new Set([...WRAPPERS, 'ephemeralMessage', 'deviceSentMessage', 'documentWithCaptionMessage'])
const MEDIA = new Set(['imageMessage', 'videoMessage', 'audioMessage'])

function detectViewOnce(raw) {
  const seen = new WeakSet()
  function visit(content, viewOnce = false) {
    if (!content || typeof content !== 'object' || seen.has(content)) return null
    seen.add(content)
    for (const [type, media] of Object.entries(content)) {
      if (MEDIA.has(type) && media && (viewOnce || media.viewOnce === true)) return { type, media }
      if (CONTAINERS.has(type) && media?.message) {
        const result = visit(media.message, viewOnce || WRAPPERS.has(type))
        if (result) return result
      }
    }
    return null
  }
  return visit(raw?.message || raw, raw?.key?.isViewOnce === true)
}

function attach(socket, onViewOnce, onUnavailable = () => {}) {
  if (!socket?.ev || socket.__saffulViewOnceDetectorAttached) return
  socket.__saffulViewOnceDetectorAttached = true
  const dispatch = raw => {
    const detected = detectViewOnce(raw)
    // Copy before the legacy serializer strips wrappers or mutates the message.
    if (detected) {
      const copy = structuredClone(raw)
      void Promise.resolve(onViewOnce(copy, detectViewOnce(copy))).catch(error => {
        process.stderr.write(`[antiviewonce] Detector error: ${error.message}\n`)
      })
    } else if (raw?.key?.isViewOnce) onUnavailable(raw)
  }
  const handle = (event, data) => {
    if (event === 'messages.upsert') for (const raw of data?.messages || []) dispatch(raw)
    if (event === 'messages.update') for (const { key, update } of data || []) {
      if (update?.message) dispatch({ ...update, key: { ...key, ...update.key } })
    }
  }
  if (typeof socket.ev.emit === 'function') {
    const emit = socket.ev.emit.bind(socket.ev)
    socket.ev.emit = (event, data) => {
      try { handle(event, data) } catch (error) { process.stderr.write(`[antiviewonce] Capture error: ${error.message}\n`) }
      return emit(event, data)
    }
  } else {
    socket.ev.on('messages.upsert', data => handle('messages.upsert', data))
    socket.ev.on('messages.update', data => handle('messages.update', data))
  }
  // Late media frequently arrives with the reconnect history sync rather than
  // a live upsert — sweep those batches too so the retry path can catch them.
  socket.ev.on('messaging-history.set', data => {
    const messages = Array.isArray(data?.messages) ? data.messages : []
    for (const raw of messages) {
      try { dispatch(raw) } catch {}
    }
  })
  // Baileys ACKs some unavailable fanouts without an upsert. Observe metadata:
  // these notices contain no media payload or encryption key to download.
  socket.ws?.on?.('CB:message', node => {
    const unavailable = Array.isArray(node.content) && node.content.find(child => child.tag === 'unavailable')
    if (!/^view_once(?:_unavailable_fanout)?$/.test(unavailable?.attrs?.type || '')) return
    onUnavailable({ key: {
      id: node.attrs?.id, remoteJid: node.attrs?.from, participant: node.attrs?.participant,
      participantAlt: node.attrs?.participant_pn, remoteJidAlt: node.attrs?.sender_pn,
      isViewOnce: true,
    } })
  })
}

module.exports = { attach, detectViewOnce }
