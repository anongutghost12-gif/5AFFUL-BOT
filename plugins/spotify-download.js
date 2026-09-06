const { cmd } = require('../lib/plugins');
const { downloadAudio, removeDownloadedAudio } = require('../lib/safful-loader-dl');
const fetch = require('node-fetch');
const path = require('path');

function log(msg) {
  process.stderr.write('[safful-spotify] ' + msg + '\n');
}

/**
 * Get Spotify track info from oEmbed (no auth needed)
 * Returns: { title, author_name, thumbnail_url }
 */
async function getSpotifyInfo(url) {
  const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
  const res = await fetch(oembedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10000,
  });
  if (!res.ok) throw new Error('Failed to fetch Spotify info: ' + res.status);
  const text = await res.text();
  try {
    const data = JSON.parse(text);
    // Extract title from iframe HTML if not in JSON
    if (!data.title && data.html) {
      const titleMatch = data.html.match(/title="Spotify Embed:\s*([^"]+)"/i);
      if (titleMatch) data.title = titleMatch[1].trim();
    }
    return data;
  } catch {
    // Try extracting from HTML response
    const titleMatch = text.match(/title="Spotify Embed:\s*([^"]+)"/i);
    if (titleMatch) return { title: titleMatch[1].trim() };
    throw new Error('Could not parse Spotify info');
  }
}

/**
 * Extract Spotify track/album/playlist URL from text
 */
function extractSpotifyUrl(text) {
  const match = text.match(/https?:\/\/[^\s]*(?:open\.spotify\.com|spotify\.link)[^\s]*/i);
  return match ? match[0] : null;
}

/**
 * Detect Spotify content type from URL
 */
function getSpotifyType(url) {
  if (/\/track\//.test(url)) return 'track';
  if (/\/album\//.test(url)) return 'album';
  if (/\/playlist\//.test(url)) return 'playlist';
  return 'track';
}

cmd({
  pattern: 'spotify',
  alias: ['spdl', 'spotifydl', 'sp'],
  desc: 'Download music from Spotify as MP3',
  category: 'downloader',
  use: '.spotify <Spotify URL or song name>',
}, async (mek, text, extra) => {
  log('=== .spotify CALLED ===');
  const Void = extra?.Void;
  const query = String(text || '').trim();

  if (!query) {
    return mek.reply(
      '*Spotify Downloader*\n\n' +
      '*Usage:*\n' +
      '• `.spotify <Spotify URL>` — download a track\n' +
      '• `.spotify <song name>` — search and download\n\n' +
      '*Examples:*\n' +
      '• `.spotify https://open.spotify.com/track/...`\n' +
      '• `.spotify Shatta Wale On God`'
    );
  }

  try {
    let songUrl = null;
    let songTitle = query;
    let songAuthor = '';

    // Check if input is a Spotify URL
    const spotifyUrl = extractSpotifyUrl(query);
    if (spotifyUrl) {
      const contentType = getSpotifyType(spotifyUrl);
      log('Spotify URL detected, type: ' + contentType);

      if (contentType !== 'track') {
        return mek.reply('*Only single tracks are supported.*\nPlease provide a track URL or search by name.');
      }

      await mek.reply('🔍 *Fetching Spotify info...*');
      const info = await getSpotifyInfo(spotifyUrl);
      songTitle = info.title || query;
      songAuthor = info.author_name || '';
      log('Track: ' + songTitle + ' by ' + songAuthor);
    }

    // Search YouTube for the song
    await mek.reply('🔍 *Searching for: ' + songTitle + (songAuthor ? ' - ' + songAuthor : '') + '*');

    let youtubeUrl;
    try {
      const { search } = require('../lib/keepvid-api');
      const searchTerm = songAuthor ? songAuthor + ' ' + songTitle : songTitle;
      const results = await search(searchTerm);
      if (!results || results.length === 0) throw new Error('No results');
      youtubeUrl = results[0].youtubeUrl || 'https://youtu.be/' + results[0].videoId;
      log('YouTube match: ' + (results[0].title || 'unknown'));
    } catch (e) {
      log('keepvid search failed: ' + e.message);
      return mek.reply('*Search failed.* Try providing a YouTube link directly with `.song`.');
    }

    // Download as audio via loader.to
    await mek.reply('🎵 *Downloading: ' + songTitle + '*');
    const result = await downloadAudio(youtubeUrl);

    if (!result || !result.filePath) {
      return mek.reply('*Download failed.*');
    }

    // Send audio
    const caption = songAuthor ? songAuthor + ' - ' + songTitle : songTitle;
    await Void.sendMessage(mek.chat, {
      audio: { url: result.filePath },
      mimetype: result.mimeType || 'audio/mpeg',
      fileName: caption.replace(/[\\/:*?"<>|]/g, '') + '.mp3',
      ptt: false,
    }, { quoted: { key: mek.key, message: {} } });

    log('SUCCESS: Sent audio for ' + songTitle);

  } catch (err) {
    log('Error: ' + (err.message || err));
    await mek.reply('*Download failed:* ' + String(err.message || err).slice(0, 200));
  }
});
