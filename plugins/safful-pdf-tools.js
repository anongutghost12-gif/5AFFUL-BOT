'use strict'

// ---------------------------------------------------------------------------
// SAFFUL PDF tools — fully keyless PDF utility commands.
// Structure/editing via pdf-lib (merge, split, rotate, watermark, protect,
// image→PDF). Text extraction + page rasterization via pdfjs-dist (legacy,
// runs on plain Node — no browser, no worker, no API key, no quota).
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { cmd } = require('../lib/plugins')
const { PDFDocument, degrees, rgb, StandardFonts } = require('pdf-lib')

let pdfjs = null
try { pdfjs = require('pdfjs-dist/legacy/build/pdf.js') } catch {}

const TEMP_ROOT = path.join(__dirname, '..', 'temp')
const MERGE_DIR = () => path.join(TEMP_ROOT, 'pdf-merge')
const MAX_INPUT_MB = 25
const MAX_MERGE_FILES = 12
const MAX_SPLIT_SENDS = 12
const MAX_PAGES_RASTER = 25

// ── helpers ───────────────────────────────────────────────────────────────
function socketFor(message) {
  return message && (message.bot || message.client) || global.__saffulLatestSocket
}

function repliedMessage(message) {
  return message?.quoted || message?.reply_message || message?.replyMessage || message
}

async function send(message, content, options = {}) {
  const socket = socketFor(message)
  if (typeof socket?.sendMessage !== 'function') throw new Error('WhatsApp socket is unavailable')
  return socket.sendMessage(message.chat, content, { quoted: message, ...options })
}

function chatKey(jid) {
  return String(jid || '').split('@')[0].replace(/[^0-9]/g, '').slice(-12) || 'default'
}

function mediaType(message) {
  const quoted = repliedMessage(message)
  return String(quoted?.mtype || quoted?.type || quoted?.mimetype || message?.mtype || '').toLowerCase()
}

async function mediaBuffer(message) {
  const candidates = [repliedMessage(message), message]
  for (const candidate of candidates) {
    if (!candidate) continue
    if (Buffer.isBuffer(candidate)) return candidate
    if (Buffer.isBuffer(candidate?.buffer)) return candidate.buffer
    for (const method of ['download', 'downloadMedia', 'downloadMediaMessage']) {
      if (typeof candidate?.[method] !== 'function') continue
      try {
        const result = await candidate[method]()
        if (Buffer.isBuffer(result)) return result
        if (typeof result === 'string' && fs.existsSync(result)) return fs.readFileSync(result)
      } catch {}
    }
  }
  throw new Error('Reply to a media message first.')
}

async function pdfBuffer(message) {
  const type = mediaType(message)
  if (!type.includes('pdf')) throw new Error('Reply to a *PDF document* first.')
  const buffer = await mediaBuffer(message)
  if (buffer.length > MAX_INPUT_MB * 1024 * 1024) {
    throw new Error(`That PDF is larger than ${MAX_INPUT_MB} MB — too big for this server.`)
  }
  return buffer
}

function humanBytes(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB'
  return Math.max(1, Math.round(bytes / 1024)) + ' KB'
}

function safeName(original, fallback) {
  const base = String(original || '').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9-_ ]+/gi, '').trim()
  return (base || fallback).slice(0, 60)
}

async function loadDoc(buffer) {
  return PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false })
}

// ── core operations (exported for tests) ──────────────────────────────────
async function mergeBuffers(buffers) {
  const out = await PDFDocument.create()
  for (const buffer of buffers) {
    const doc = await loadDoc(buffer)
    if (doc.isEncrypted) throw new Error('One of the PDFs is password-protected.')
    const pages = await out.copyPages(doc, doc.getPageIndices())
    pages.forEach(page => out.addPage(page))
  }
  return out.save()
}

async function extractPages(buffer, indices) {
  const doc = await loadDoc(buffer)
  if (doc.isEncrypted) throw new Error('That PDF is password-protected.')
  const out = await PDFDocument.create()
  const pages = await out.copyPages(doc, indices)
  pages.forEach(page => out.addPage(page))
  return out.save()
}

function parsePageSelection(text, pageCount) {
  const input = String(text || '').trim().toLowerCase()
  if (!input || input === 'all' || input === 'every') return { mode: 'all' }
  const range = input.match(/^(\d+)\s*-\s*(\d+)$/)
  if (range) {
    let a = Number(range[1])
    let b = Number(range[2])
    if (a < 1 || b > pageCount || a > b) throw new Error(`Pages must be 1-${pageCount}.`)
    return { mode: 'range', indices: Array.from({ length: b - a + 1 }, (_, i) => a + i - 1) }
  }
  const list = input.split(/[,\s]+/).map(n => Number(n))
  if (!list.length || list.some(n => !Number.isInteger(n) || n < 1 || n > pageCount)) {
    throw new Error(`Page numbers must be between 1 and ${pageCount}.`)
  }
  return { mode: 'list', indices: [...new Set(list)].map(n => n - 1) }
}

async function rotatePdf(buffer, angle) {
  const doc = await loadDoc(buffer)
  if (doc.isEncrypted) throw new Error('That PDF is password-protected.')
  const degreesAngle = degrees((angle % 360 + 360) % 360)
  doc.getPages().forEach(page => page.setRotation(degreesAngle))
  return doc.save()
}

async function watermarkPdf(buffer, text) {
  const doc = await loadDoc(buffer)
  if (doc.isEncrypted) throw new Error('That PDF is password-protected.')
  const font = await doc.embedFont(StandardFonts.HelveticaBold)
  const pages = doc.getPages()
  for (const page of pages) {
    const { width, height } = page.getSize()
    const fontSize = Math.min(Math.max(Math.floor(width / 14), 16), 44)
    const step = Math.floor(fontSize * 3.1)
    for (let y = -height; y < height * 2; y += step) {
      for (let x = -width / 2; x < width * 1.5; x += step * 1.9) {
        page.drawText(text, {
          x, y, size: fontSize, font,
          color: rgb(0.75, 0.78, 0.85),
          opacity: 0.13,
          rotate: degrees(-32),
        })
      }
    }
  }
  return doc.save()
}

// ── PDF Standard Security (RC4 40-bit, revision 2) ─────────────────────────
// pdf-lib cannot WRITE encryption, so we do it here: encrypt every stream in
// place (RC4 is length-preserving, so nothing shifts) and append a standard
// incremental update that adds a fresh /Encrypt object + trailer entry. The
// result is a valid encrypted PDF (verified against the pdf.js reader).
const PDF_PAD = Buffer.from('28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a', 'hex')

function padPassword(password) {
  const bytes = Buffer.from(String(password || ''), 'utf8').slice(0, 32)
  return Buffer.concat([bytes, PDF_PAD]).slice(0, 32)
}

function rc4(key, data) {
  const s = Buffer.alloc(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 0xff
    const t = s[i]; s[i] = s[j]; s[j] = t
  }
  const out = Buffer.alloc(data.length)
  let a = 0; let b = 0
  for (let i = 0; i < data.length; i++) {
    a = (a + 1) & 0xff
    b = (b + s[a]) & 0xff
    const t = s[a]; s[a] = s[b]; s[b] = t
    out[i] = data[i] ^ s[(s[a] + s[b]) & 0xff]
  }
  return out
}

function md5(...parts) {
  const hash = crypto.createHash('md5')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

async function protectPdf(buffer, password) {
  const doc = await loadDoc(buffer)
  if (doc.isEncrypted) throw new Error('That PDF is already password-protected.')
  const plain = Buffer.from(await doc.save({ useObjectStreams: false, addDefaultPage: false }))
  const latin = plain.toString('latin1')

  const paddedUser = padPassword(password)
  const ownerKey = md5(padPassword(password)).slice(0, 5) // owner == user password
  const oEntry = rc4(ownerKey, paddedUser)

  const id0 = crypto.randomBytes(16)
  const permissions = Buffer.from('fcffffff', 'hex') // -4 -> open permission flags
  const fileKey = md5(paddedUser, oEntry, permissions, id0).slice(0, 5)
  // U entry (rev 2) = RC4(fileKey, 32-byte constant padding) — NOT the padded password
  const uEntry = rc4(fileKey, PDF_PAD)

  // encrypt every object stream in place (40-bit RC4 per-object keys)
  const out = Buffer.from(plain)
  const regex = /(\d+) 0 obj\n<<(?:[^>]|>(?!>))*?>>\nstream\n/g
  let match
  while ((match = regex.exec(latin))) {
    const objectNumber = Number(match[1])
    const dict = match[0]
    const lengthMatch = dict.match(/\/Length (\d+)/)
    if (!lengthMatch) continue
    const length = Number(lengthMatch[1])
    const contentStart = match.index + match[0].length
    if (contentStart + length > out.length) continue

    // object key = MD5(fileKey(5) || objectNo(3 LE) || gen(2 LE))[0..10]  (n+5 per spec)
    const key = md5(fileKey, Buffer.from([
      objectNumber & 0xff, (objectNumber >> 8) & 0xff, (objectNumber >> 16) & 0xff, 0, 0,
    ])).slice(0, 10)
    rc4(key, out.slice(contentStart, contentStart + length)).copy(out, contentStart)
  }

  // incremental update: append a NEW /Encrypt object + xref + trailer
  const maxObject = Math.max(1, ...Array.from(latin.matchAll(/(\d+) 0 obj\n/g), m => Number(m[1])))
  const encryptNumber = maxObject + 1
  const encryptObject = Buffer.from(
    encryptNumber + ' 0 obj\n<< /Filter /Standard /V 1 /R 2 /Length 40 /O <' + oEntry.toString('hex') +
    '> /U <' + uEntry.toString('hex') + '> /P -4 >>\nendobj\n',
    'latin1',
  )
  const oldStartXref = Number((latin.match(/startxref\s+(\d+)/) || [])[1] || 0)
  const trailerRoot = latin.match(/\/Root\s+(\d+ 0 R)/)?.[1] || '2 0 R'
  const xrefOffset = out.length + encryptObject.length
  const update = Buffer.from(
    'xref\n0 1\n0000000000 65535 f \n' +
    encryptNumber + ' 1\n' + String(out.length).padStart(10, '0') + ' 00000 n \n' +
    'trailer\n<< /Size ' + (encryptNumber + 1) + ' /Root ' + trailerRoot + ' /Encrypt ' + encryptNumber +
    ' 0 R /ID [<' + id0.toString('hex') + '> <' + id0.toString('hex') + '>] /Prev ' + oldStartXref + ' >>\n' +
    'startxref\n' + xrefOffset + '\n%%EOF\n',
    'latin1',
  )
  return Buffer.concat([out, encryptObject, update])
}

async function imageToPdf(buffer, originalName) {
  const type = mediaTypeOfBuffer(buffer, originalName)
  const out = await PDFDocument.create()
  const reencoded = await ensureEmbeddableImage(buffer, type)
  const image = type === 'png' ? await out.embedPng(reencoded) : await out.embedJpg(reencoded)
  const page = out.addPage([image.width, image.height])
  page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  return out.save()
}

function mediaTypeOfBuffer(buffer, originalName) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpg'
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png'
  return String(originalName || '').toLowerCase().includes('png') ? 'png' : 'jpg'
}

async function ensureEmbeddableImage(buffer, type) {
  if (type === 'png' || type === 'jpg') return buffer
  // webp/gif/bmp — re-encode through canvas into a png buffer
  const { createCanvas, loadImage } = require('canvas')
  const image = await loadImage(buffer)
  const canvas = createCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')
  ctx.drawImage(image, 0, 0)
  return canvas.toBuffer('image/png')
}

async function pdfjsDocument(buffer) {
  if (!pdfjs) throw new Error('The PDF reader engine is not available on this server.')
  return pdfjs.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useSystemFonts: true }).promise
}

async function pdfToText(buffer, maxChars = 6000) {
  const doc = await pdfjsDocument(buffer)
  let collected = ''
  for (let pageNo = 1; pageNo <= doc.numPages; pageNo += 1) {
    const page = await doc.getPage(pageNo)
    const content = await page.getTextContent()
    const text = content.items
      .map(item => (item.str !== undefined ? item.str : ''))
      .join(' ')
      .replace(/\s+/g, ' ')
    collected += text + '\n'
    if (collected.length > maxChars) break
  }
  await doc.destroy().catch(() => {})
  return collected.trim()
}

function renderCanvas(canvasLike) {
  // canvas-like from @napi-rs/canvas (package.json aliases canvas -> @napi-rs/canvas)
  return canvasLike
}

async function renderPages(buffer, { scale = 1.6, jpeg = false, quality = 60, maxPages = MAX_PAGES_RASTER } = {}) {
  if (!pdfjs) throw new Error('The PDF reader engine is not available on this server.')
  const { createCanvas } = require('canvas')
  const doc = await pdfjsDocument(buffer)
  const pageCount = Math.min(doc.numPages, maxPages)
  if (doc.numPages > maxPages) throw new Error(`This PDF has ${doc.numPages} pages — limit is ${maxPages} for this operation.`)
  const outputs = []
  for (let pageNo = 1; pageNo <= pageCount; pageNo += 1) {
    const page = await doc.getPage(pageNo)
    const base = page.getViewport({ scale: 1 })
    const scaleX = scale
    const viewport = page.getViewport({ scale: scaleX })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const context = canvas.getContext('2d')
    const canvasFactory = {
      create: (w, h) => {
        const c = createCanvas(Math.ceil(w), Math.ceil(h))
        return { canvas: c, context: c.getContext('2d') }
      },
    }
    await page.render({
      canvasContext: context,
      viewport,
      canvasFactory,
      background: '#ffffff',
    }).promise
    outputs.push({
      page: pageNo,
      width: base.width,
      height: base.height,
      buffer: jpeg ? canvas.toBuffer('image/jpeg', { quality }) : canvas.toBuffer('image/png'),
    })
  }
  await doc.destroy().catch(() => {})
  return outputs
}

async function compressPdf(buffer, quality = 60) {
  const pages = await renderPages(buffer, { jpeg: true, quality, scale: 1.4 })
  const out = await PDFDocument.create()
  for (const page of pages) {
    const image = await out.embedJpg(page.buffer)
    const pdfPage = out.addPage([image.width, image.height])
    pdfPage.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height })
  }
  return out.save()
}

// ── merge queue ───────────────────────────────────────────────────────────
function mergeQueueDir(message) {
  const dir = path.join(MERGE_DIR(), chatKey(message.chat))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function mergeQueueFiles(message) {
  const dir = mergeQueueDir(message)
  return fs.readdirSync(dir).filter(name => name.endsWith('.pdf')).sort().map(name => path.join(dir, name))
}

// ── commands ──────────────────────────────────────────────────────────────
cmd({
  pattern: 'pdfinfo',
  desc: 'Inspect a PDF (pages, size, protection, version)',
  category: 'pdf',
  use: '<reply to a PDF>',
}, async (message) => {
  try {
    const buffer = await pdfBuffer(message)
    const doc = await loadDoc(buffer)
    const info = [
      '📄 *PDF Info*',
      `• Pages: *${doc.getPageCount()}*`,
      `• Size: ${humanBytes(buffer.length)}`,
      `• Version: PDF ${doc.getVersion()}`,
      `• Encrypted: ${doc.isEncrypted ? 'yes 🔒' : 'no'}`,
    ]
    const names = Object.entries(doc.getTitle?.() ? { Title: doc.getTitle() } : {}).filter(([, v]) => v)
    if (names.length) info.push(`• Title: ${names[0][1]}`)
    return message.reply(info.join('\n'))
  } catch (error) {
    return message.reply(error?.message || 'Could not read that PDF.')
  }
})

cmd({
  pattern: 'mergepdf',
  alias: ['pdfmerge', 'joinpdf'],
  desc: 'Merge PDFs — reply a PDF to add it, then .mergepdf now',
  category: 'pdf',
  use: '<reply PDF> | now | clear | list',
}, async (message, text) => {
  const input = String(text || '').trim().toLowerCase()
  try {
    if (input === 'now' || input === 'go' || input === 'merge') {
      const files = mergeQueueFiles(message)
      if (!files.length) return message.reply('Your merge queue is empty — reply to PDFs with `.mergepdf` to add them.')
      if (files.length === 1) {
        fs.rmSync(mergeQueueDir(message), { recursive: true, force: true })
        return message.reply('Only one PDF in the queue — reply to at least two PDFs with `.mergepdf` first.')
      }
      await message.reply(`🔀 Merging ${files.length} PDFs…`)
      const buffers = files.map(file => fs.readFileSync(file))
      const output = await mergeBuffers(buffers)
      fs.rmSync(mergeQueueDir(message), { recursive: true, force: true })
      return send(message, {
        document: Buffer.from(output),
        fileName: 'merged.pdf',
        mimetype: 'application/pdf',
        caption: `🔀 *Merged ${files.length} PDFs* — ${humanBytes(output.length)}`,
      })
    }
    if (input === 'clear' || input === 'reset') {
      fs.rmSync(mergeQueueDir(message), { recursive: true, force: true })
      return message.reply('🗑️ Merge queue cleared.')
    }
    if (input === 'list' || input === 'status' || input === 'count') {
      const files = mergeQueueFiles(message)
      return message.reply(`📚 Merge queue: *${files.length}* PDF(s).\nReply to more PDFs with \`.mergepdf\`, then send \`.mergepdf now\`.`)
    }
    // add a PDF to the queue
    const buffer = await pdfBuffer(message)
    const files = mergeQueueFiles(message)
    if (files.length >= MAX_MERGE_FILES) return message.reply(`The queue is full (${MAX_MERGE_FILES} max) — send \`.mergepdf now\` to merge.`)
    const number = files.length + 1
    fs.writeFileSync(path.join(mergeQueueDir(message), `${String(number).padStart(2, '0')}.pdf`), buffer)
    return message.reply(`✅ Added PDF #${number} to the merge queue.\n\nReply to more PDFs with \`.mergepdf\`, then send \`.mergepdf now\` to merge all.`)
  } catch (error) {
    return message.reply(error?.message || 'Merge failed.')
  }
})

cmd({
  pattern: 'splitpdf',
  alias: ['pdfsplit', 'extractpdf'],
  desc: 'Split a PDF — all pages, a range (2-5), or pages (1,3,7)',
  category: 'pdf',
  use: '<reply PDF> [all | 2-5 | 1,3,7]',
}, async (message, text) => {
  try {
    const buffer = await pdfBuffer(message)
    const doc = await loadDoc(buffer)
    const pageCount = doc.getPageCount()
    const selection = parsePageSelection(text, pageCount)
    if (selection.mode === 'all') {
      if (pageCount > MAX_SPLIT_SENDS) {
        return message.reply(`That PDF has *${pageCount} pages* — sending each page would flood the chat.\nUse a range: \`.splitpdf 1-${MAX_SPLIT_SENDS}\`, or pick pages like \`.splitpdf 1,3,7\`.`)
      }
      await message.reply(`📄 Splitting ${pageCount} page(s)…`)
      for (let index = 0; index < pageCount; index += 1) {
        const output = await extractPages(buffer, [index])
        await send(message, {
          document: Buffer.from(output),
          fileName: `page-${index + 1}.pdf`,
          mimetype: 'application/pdf',
          caption: `📄 Page ${index + 1} of ${pageCount}`,
        })
      }
      return
    }
    await message.reply(`📄 Extracting ${selection.indices.length} page(s)…`)
    const output = await extractPages(buffer, selection.indices)
    return send(message, {
      document: Buffer.from(output),
      fileName: 'extracted-pages.pdf',
      mimetype: 'application/pdf',
      caption: `📄 Extracted page(s): ${selection.indices.map(i => i + 1).join(', ')}`,
    })
  } catch (error) {
    return message.reply(error?.message || 'Split failed.')
  }
})

cmd({
  pattern: 'rotatepdf',
  desc: 'Rotate every page of a PDF (90/180/270)',
  category: 'pdf',
  use: '<reply PDF> [90|180|270]',
}, async (message, text) => {
  try {
    const buffer = await pdfBuffer(message)
    let angle = Number(String(text || '').trim()) || 90
    if (![90, 180, 270].includes(((angle % 360) + 360) % 360)) angle = 90
    const output = await rotatePdf(buffer, angle)
    return send(message, {
      document: Buffer.from(output),
      fileName: 'rotated.pdf',
      mimetype: 'application/pdf',
      caption: `🔄 PDF rotated ${((angle % 360) + 360) % 360}°`,
    })
  } catch (error) {
    return message.reply(error?.message || 'Rotation failed.')
  }
})

cmd({
  pattern: 'watermark',
  alias: ['pdfwatermark'],
  desc: 'Stamp a diagonal text watermark on every page',
  category: 'pdf',
  use: '<reply PDF> <text>',
}, async (message, text) => {
  const input = String(text || '').trim()
  if (!input) return message.reply('Usage: `.watermark <text>` while replying to a PDF.\nExample: `.watermark CONFIDENTIAL`')
  try {
    const buffer = await pdfBuffer(message)
    await message.reply('💧 Adding watermark…')
    const output = await watermarkPdf(buffer, input.slice(0, 80))
    return send(message, {
      document: Buffer.from(output),
      fileName: 'watermarked.pdf',
      mimetype: 'application/pdf',
      caption: `💧 Watermarked: ${input.slice(0, 60)}`,
    })
  } catch (error) {
    return message.reply(error?.message || 'Watermark failed.')
  }
})

cmd({
  pattern: 'protectpdf',
  alias: ['pdfprotect', 'lockpdf'],
  desc: 'Password-protect a PDF',
  category: 'pdf',
  use: '<reply PDF> <password>',
}, async (message, text) => {
  const password = String(text || '').trim()
  if (password.length < 4) return message.reply('Usage: `.protectpdf <password>` (min 4 chars) while replying to a PDF.')
  try {
    const buffer = await pdfBuffer(message)
    const output = await protectPdf(buffer, password)
    return send(message, {
      document: Buffer.from(output),
      fileName: 'protected.pdf',
      mimetype: 'application/pdf',
      caption: `🔒 PDF protected. Password: ${password}`,
    })
  } catch (error) {
    return message.reply(error?.message || 'Protection failed.')
  }
})

cmd({
  pattern: 'img2pdf',
  alias: ['imagetopdf', 'jpg2pdf', 'png2pdf'],
  desc: 'Turn a replied image into a PDF',
  category: 'pdf',
  use: '<reply to an image>',
}, async (message) => {
  try {
    const type = mediaType(message)
    const isImage = /image|jpe?g|png|webp|gif/.test(type)
    if (!isImage) return message.reply('Reply to an *image* (jpg, png, webp) to turn it into a PDF.')
    const buffer = await mediaBuffer(message)
    const output = await imageToPdf(buffer, String(repliedMessage(message)?.msg?.fileName || ''))
    return send(message, {
      document: Buffer.from(output),
      fileName: 'image.pdf',
      mimetype: 'application/pdf',
      caption: '📄 Image converted to PDF.',
    })
  } catch (error) {
    return message.reply(error?.message || 'Image conversion failed.')
  }
})

cmd({
  pattern: 'pdf2text',
  alias: ['pdftotext', 'readpdf'],
  desc: 'Extract text from a PDF',
  category: 'pdf',
  use: '<reply PDF>',
}, async (message) => {
  try {
    const buffer = await pdfBuffer(message)
    await message.reply('📖 Reading…')
    const doc = await pdfjsDocument(buffer)
    const pageCount = doc.numPages
    await doc.destroy().catch(() => {})
    const text = await pdfToText(buffer)
    if (!text) return message.reply(`The PDF has ${pageCount} pages but no extractable text (it may be a scanned document — try \`.pdf2img\`).`)
    const preview = text.length > 3800 ? text.slice(0, 3800) + '\n\n…(truncated)' : text
    return message.reply(`📖 *Text from PDF (${pageCount} page${pageCount === 1 ? '' : 's'})*\n\n${preview}`)
  } catch (error) {
    return message.reply(error?.message || 'Text extraction failed.')
  }
})

cmd({
  pattern: 'pdf2img',
  alias: ['pdftoimg', 'pdf2image'],
  desc: 'Render PDF pages as images',
  category: 'pdf',
  use: '<reply PDF> [page]',
}, async (message, text) => {
  try {
    const buffer = await pdfBuffer(message)
    const pageArg = Number(String(text || '').trim())
    const pages = await renderPages(buffer, { scale: 1.6 })
    if (!pages.length) return message.reply('Could not render any pages.')
    const selected = pageArg && pageArg >= 1 && pageArg <= pages.length
      ? [pages[pageArg - 1]]
      : pages
    await message.reply(`🖼️ Rendering ${selected.length} page(s)…`)
    for (const page of selected) {
      await send(message, { image: page.buffer, caption: `📄 Page ${page.page} rendered as image.` })
    }
    if (!pageArg && pages.length > 1) {
      await message.reply(`Rendered ${pages.length} pages.\nFor one page use \`.pdf2img ${1}\` (etc).`)
    }
  } catch (error) {
    return message.reply(error?.message || 'Page rendering failed.')
  }
})

cmd({
  pattern: 'pdfcompress',
  alias: ['compresspdf'],
  desc: 'Shrink a PDF by re-rendering pages (lossy)',
  category: 'pdf',
  use: '<reply PDF> [quality 10-90, default 60]',
}, async (message, text) => {
  try {
    const buffer = await pdfBuffer(message)
    if (buffer.length < 400 * 1024) return message.reply('That PDF is already small — compression would not help.')
    let quality = Number(String(text || '').trim()) || 60
    quality = Math.min(90, Math.max(10, Math.round(quality)))
    await message.reply(`🗜️ Compressing (quality ${quality})… this can take a minute.`)
    const output = await compressPdf(buffer, quality)
    const saved = Math.max(0, Math.round((1 - output.length / buffer.length) * 100))
    return send(message, {
      document: Buffer.from(output),
      fileName: 'compressed.pdf',
      mimetype: 'application/pdf',
      caption: `🗜️ Compressed: ${humanBytes(buffer.length)} → ${humanBytes(output.length)} (${saved}% smaller, lossy)`,
    })
  } catch (error) {
    return message.reply(error?.message || 'Compression failed.')
  }
})

module.exports = {
  mergeBuffers,
  extractPages,
  parsePageSelection,
  rotatePdf,
  watermarkPdf,
  protectPdf,
  imageToPdf,
  pdfToText,
  renderPages,
  compressPdf,
  pdfBuffer,
  humanBytes,
}
