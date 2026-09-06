'use strict'
// ---------------------------------------------------------------------------
// Downloader bundle cleanup — runs AFTER every other plugin (zzzzz sorts last)
// so it sees the final registry, then prunes the downloader category down to
// the owner-approved set: ig · pin · fb · video · spotify · save · yt · tiktok
// · x · song · snap.
//
// The obfuscated downloader.smd re-registers a pile of legacy extras (.apk,
// .apks, .tgs, .gitclone, .tts, .downmp4, .video2, .play, .sound,
// .tiktokold, .ringtone, .pint, .mediafire, .playlist, .ytmp4, .ytmp3,
// .ytdoc) — those are removed from the registry so they neither appear in the
// menu nor dispatch. Duplicate primaries (.video, .song) resolve to the last
// (readable) registration by keeping the highest-index entry.
// ---------------------------------------------------------------------------
const { commands } = require('../lib/plugins')

const KEEP_PRIMARY = new Set([
  'ig', 'fb', 'pin', 'video', 'spotify', 'save',
  'yts', 'tiktok', 'x', 'song', 'snap',
])

function cleanupDownloaderCategory() {
  const seen = new Set()
  let removed = 0
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index]
    if (String(command?.category || '').toLowerCase() !== 'downloader') continue
    const primary = String(command?.pattern || command?.cmdname || '').toLowerCase().trim()
    if (!primary || !KEEP_PRIMARY.has(primary) || seen.has(primary)) {
      commands.splice(index, 1)
      removed += 1
      continue
    }
    seen.add(primary)
  }
  return removed
}

cleanupDownloaderCategory()

module.exports = { cleanupDownloaderCategory, KEEP_PRIMARY }