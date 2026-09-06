/**
 * keepvid-api.js — Node.js embedded version of the keepvid API
 * 
 * Provides two core functions:
 *   1. search(query)     — Search YouTube via keepv.id's backend (no CAPTCHA)
 *   2. getLinks(url)     — Get all download URLs via yt-dlp (direct CDN links)
 * 
 * This replaces the Python FastAPI server so it runs inside the bot
 * without needing a separate process.
 */

const { execFile } = require('child_process');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const SECRETS_DIR = path.join(ROOT, '.safful-secrets');
const KEEPVID_BASE = 'https://keepv.id';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ── Session management for keepv.id ────────────────────────────────────────

let _sessionId = null;
let _sessionExpiry = 0;

/**
 * Get a fresh session ID from keepv.id's homepage.
 * The SID is embedded in: <script>sid='dpie40fcko9kiha4ili4jcrbfv';</script>
 */
async function getSessionId() {
  if (_sessionId && Date.now() < _sessionExpiry) return _sessionId;

  const res = await fetch(KEEPVID_BASE, {
    timeout: 10000,
    headers: { 'User-Agent': UA },
  });
  const html = await res.text();
  const match = html.match(/sid\s*=\s*'([^']+)'/);
  if (match) {
    _sessionId = match[1];
    _sessionExpiry = Date.now() + 30 * 60 * 1000; // 30 min cache
    return _sessionId;
  }
  throw new Error('Could not extract session ID from keepv.id');
}

// ── Search ─────────────────────────────────────────────────────────────────

/**
 * Search YouTube via keepv.id's backend.
 * Returns up to 20 results with videoId, title.
 * No CAPTCHA required — simple HTTP POST.
 */
async function search(query) {
  const sid = await getSessionId();
  const params = new URLSearchParams({ search: query, sid });

  const res = await fetch(KEEPVID_BASE, {
    method: 'POST',
    body: params,
    timeout: 15000,
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': KEEPVID_BASE,
    },
  });
  const results = await res.json();
  return results.map(function(item) {
    return {
      videoId: item.videoId,
      title: item.title,
      youtubeUrl: 'https://youtu.be/' + item.videoId,
      thumbnailUrl: 'https://i.ytimg.com/vi/' + item.videoId + '/mqdefault.jpg',
    };
  });
}

// ── Get download links via yt-dlp ──────────────────────────────────────────

/**
 * Find the yt-dlp binary (same logic as safful-ytdlp.js).
 */
function findYtdlp() {
  var ext = process.platform === 'win32' ? '.exe' : '';
  var candidates = [
    path.join(SECRETS_DIR, 'yt-dlp' + ext),
    path.join(ROOT, 'yt-dlp' + ext),
  ];

  var env = String(process.env.SAFFUL_YTDLP_PATH || '').trim();
  if (env && fs.existsSync(env)) candidates.unshift(env);

  try {
    var cmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
    var result = require('child_process').execSync(cmd + ' 2>/dev/null', { encoding: 'utf8', timeout: 5000 }).trim().split(/\r?\n/)[0];
    if (result && fs.existsSync(result)) candidates.unshift(result);
  } catch {}

  for (var i = 0; i < candidates.length; i++) {
    try { if (fs.existsSync(candidates[i])) return candidates[i]; } catch {}
  }
  return null;
}

/**
 * Run yt-dlp with args and return stdout.
 */
function runYtdlp(args, timeout) {
  timeout = timeout || 30000;
  var bin = findYtdlp();
  if (!bin) return Promise.reject(new Error('yt-dlp not found'));
  return new Promise(function(resolve, reject) {
    execFile(bin, args, { timeout: timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      function(err, stdout, stderr) {
        if (err) return reject(new Error(String(stderr || err.message || 'yt-dlp error').trim().slice(0, 500)));
        resolve(String(stdout || ''));
      });
  });
}

/**
 * Get all download links for a YouTube video via yt-dlp -j (JSON metadata).
 * Returns structured data with all available formats and direct CDN URLs.
 */
async function getLinks(videoUrl) {
  var args = [
    '-j', '--no-warnings', '--no-check-certificates', '--geo-bypass',
    '--no-playlist', '--socket-timeout', '15', '--retries', '1',
    '--user-agent', UA,
    videoUrl,
  ];

  // Add cookies if available
  var cookiesFile = path.join(SECRETS_DIR, 'youtube-cookies.txt');
  try { if (fs.existsSync(cookiesFile)) args.push('--cookies', cookiesFile); } catch {}

  var stdout = await runYtdlp(args, 30000);
  var info = JSON.parse(stdout);

  var result = {
    videoUrl: videoUrl,
    title: info.title || '',
    thumbnail: info.thumbnail || '',
    duration: info.duration || 0,
    uploader: info.uploader || '',
    totalLinks: 0,
    links: [],
  };

  var formats = info.formats || [];
  for (var i = 0; i < formats.length; i++) {
    var f = formats[i];
    var url = f.url || '';
    if (!url) continue; // Skip formats needing signature decryption

    var ext = f.ext || '';
    var qualityLabel = f.quality_label || f.resolution || '';
    var vcodec = f.vcodec || 'none';
    var acodec = f.acodec || 'none';
    var filesize = f.filesize || f.filesize_approx || 0;

    // Determine format category
    var fmtType;
    if (ext === 'mp3') {
      fmtType = 'mp3';
    } else if (ext === 'm4a' || ext === 'opus' || ext === 'ogg') {
      fmtType = 'mp3';
      qualityLabel = f.audio_quality || 'audio';
    } else if (vcodec !== 'none' && acodec !== 'none') {
      fmtType = 'mp4';
    } else if (vcodec !== 'none') {
      fmtType = 'mp4';
      qualityLabel = qualityLabel + ' (video only)';
    } else {
      fmtType = 'mp3';
      qualityLabel = f.audio_quality || 'audio';
    }

    result.links.push({
      format: fmtType,
      quality: qualityLabel || ext,
      url: url,
      label: ext + ' ' + qualityLabel,
      filesize: filesize,
      filesizeMb: filesize ? Math.round(filesize / (1024 * 1024) * 10) / 10 : 0,
      ext: ext,
    });
  }

  result.totalLinks = result.links.length;
  return result;
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = { search, getLinks, findYtdlp, runYtdlp, getSessionId };
