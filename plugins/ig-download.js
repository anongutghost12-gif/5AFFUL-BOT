const { cmd } = require('../lib/plugins');
let fetch;
try { fetch = require('node-fetch'); } catch { fetch = globalThis.fetch; }

// Startup + per-call traces are silenced by default; set SAFFUL_SOCIAL_DEBUG=1
// if you want download diagnostics in the panel console.
function log(msg) {
  if (process.env.SAFFUL_SOCIAL_DEBUG) process.stderr.write('[safful-social] ' + msg + '\n');
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// ─── Instagram ─────────────────────────────────────────────────────────────

async function downloadInstagram(url) {
  let cleanUrl = url.split('?')[0];
  if (cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);
  log('IG fetch: ' + cleanUrl);

  const shortcode = cleanUrl.match(/\/(?:reel|p|tv)\/([A-Za-z0-9_-]+)/)?.[1];
  if (shortcode) {
    log('IG shortcode: ' + shortcode);
    // Method 1: embed scraping
    try {
      const embedRes = await fetch('https://www.instagram.com/p/' + shortcode + '/embed/', {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
      });
      const html = await embedRes.text();
      const videoMatch = html.match(/"video_url"\s*:\s*"([^"]+)"/)
        || html.match(/"url"\s*:\s*"(https?:\/\/[^"]*\.mp4[^"]*)"/)
        || html.match(/src="(https?:\/\/[^"]*\.mp4[^"]*)"/);
      if (videoMatch) return { videoUrl: videoMatch[1].replace(/\\u0026/g, '&'), type: 'video' };

      const imageMatch = html.match(/"image_url"\s*:\s*"([^"]+)"/)
        || html.match(/"(?:display_url|image_src)"\s*:\s*"([^"]+)"/);
      if (imageMatch) return { imageUrl: imageMatch[1].replace(/\\u0026/g, '&'), type: 'image' };
    } catch (e) { log('IG embed failed: ' + e.message); }

    // Method 2: oEmbed
    try {
      const oembedRes = await fetch('https://api.instagram.com/oembed/?url=' + encodeURIComponent(cleanUrl), {
        headers: { 'User-Agent': UA },
      });
      if (oembedRes.ok) {
        const oembed = await oembedRes.json();
        if (oembed.thumbnail_url) return { imageUrl: oembed.thumbnail_url, type: 'image', title: oembed.title };
      }
    } catch (e) { log('IG oembed failed: ' + e.message); }
  }
  return null;
}

// ─── Facebook ──────────────────────────────────────────────────────────────

async function downloadFacebook(url) {
  log('FB fetch: ' + url);

  // Method 1: the installed extractor. The old scraping sites below now
  // intermittently fail with DNS errors/403 responses.
  try {
    const getFacebookInfo = require('@xaviabot/fb-downloader');
    const info = await getFacebookInfo(url);
    const directUrl = info?.hd || info?.sd;
    if (directUrl) {
      return {
        videoUrl: directUrl,
        type: 'video',
        quality: info.hd ? 'HD' : 'SD',
        title: info.title || '',
      };
    }
  } catch (e) { log('FB installed extractor failed: ' + e.message); }

  // Method 2: fbdown API (free, no auth)
  try {
    const apiRes = await fetch('https://fbdown.net/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'url=' + encodeURIComponent(url),
    });
    if (apiRes.ok) {
      const html = await apiRes.text();
      const sdMatch = html.match(/data-quality="sd"[^>]*data-url="([^"]+)"/);
      if (sdMatch) return { videoUrl: sdMatch[1].replace(/&amp;/g, '&'), type: 'video', quality: 'SD' };
      const hdMatch = html.match(/data-quality="hd"[^>]*data-url="([^"]+)"/);
      if (hdMatch) return { videoUrl: hdMatch[1].replace(/&amp;/g, '&'), type: 'video', quality: 'HD' };
    }
  } catch (e) { log('FB api failed: ' + e.message); }

  // Method 3: fdown API
  try {
    const apiRes = await fetch('https://www.fdown.net/download.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: 'URLz=' + encodeURIComponent(url),
    });
    if (apiRes.ok) {
      const html = await apiRes.text();
      const sdMatch = html.match(/id="sdlink"[^>]*href="([^"]+)"/);
      if (sdMatch) return { videoUrl: sdMatch[1].replace(/&amp;/g, '&'), type: 'video', quality: 'SD' };
      const hdMatch = html.match(/id="hdlink"[^>]*href="([^"]+)"/);
      if (hdMatch) return { videoUrl: hdMatch[1].replace(/&amp;/g, '&'), type: 'video', quality: 'HD' };
    }
  } catch (e) { log('FB fdown failed: ' + e.message); }

  return null;
}

// ─── Download buffer (native fetch compatible) ─────────────────────────────

async function downloadToBuffer(url, referer) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...(referer ? { 'Referer': referer } : {}) },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('Download failed: HTTP ' + res.status);
  // Support both node-fetch (.buffer) and native fetch (.arrayBuffer)
  if (typeof res.buffer === 'function') return await res.buffer();
  return Buffer.from(await res.arrayBuffer());
}

// ─── Instagram Command ─────────────────────────────────────────────────────

cmd({
  pattern: 'ig',
  // `instagram` and `insta` are legacy-disabled names in the command-prune
  // plugin. If either is present, that plugin removes this entire command.
  alias: ['igdl'],
  desc: 'Download Instagram reel/post/video/image',
  category: 'downloader',
  use: '.ig <Instagram URL>',
}, async (mek, text, extra) => {
  log('.ig called');
  const Void = extra?.Void || mek.bot;
  const query = String(text || '').trim();
  if (!query) return mek.reply('*Provide an Instagram URL.*\n\nExample: `.ig https://www.instagram.com/reel/XYZ/`');

  const urlMatch = query.match(/https?:\/\/[^\s]*(?:instagram\.com|instagr\.am)[^\s]*/i);
  if (!urlMatch) return mek.reply('*Provide a valid Instagram URL.*');

  try {
    await mek.reply('⏳ *Downloading from Instagram...*');
    const result = await downloadInstagram(urlMatch[0]);

    if (result?.videoUrl) {
      log('IG: downloading video');
      const buffer = await downloadToBuffer(result.videoUrl, 'https://www.instagram.com/');
      await Void.sendMessage(mek.chat, {
        video: buffer,
        mimetype: 'video/mp4',
        caption: '*Instagram Download* 📸',
      }, { quoted: { key: mek.key, message: {} } });
    } else if (result?.imageUrl) {
      log('IG: downloading image');
      const buffer = await downloadToBuffer(result.imageUrl, 'https://www.instagram.com/');
      await Void.sendMessage(mek.chat, {
        image: buffer,
        caption: '*Instagram Download* 📸',
      }, { quoted: { key: mek.key, message: {} } });
    } else {
      log('IG: no direct URL found, trying loader.to fallback');
      try {
        const { downloadMedia } = require('../lib/safful-loader-dl');
        const fallback = await downloadMedia(urlMatch[0], 'video');
        if (fallback?.filePath) {
          const { readFileSync } = require('fs');
          const buffer = readFileSync(fallback.filePath);
          await Void.sendMessage(mek.chat, {
            video: buffer,
            mimetype: 'video/mp4',
            caption: '*Instagram Download* 📸',
          }, { quoted: { key: mek.key, message: {} } });
          try { require('fs').unlinkSync(fallback.filePath); } catch {}
        } else {
          return mek.reply('*Download failed.* Try downloading manually.');
        }
      } catch (loaderErr) {
        log('IG loader fallback failed: ' + loaderErr.message);
        return mek.reply('*Download failed.* Try downloading manually.');
      }
    }
    log('IG: success');
  } catch (err) {
    log('IG error: ' + err.message);
    await mek.reply('*Download failed:* ' + String(err.message).slice(0, 200));
  }
});

// ─── Facebook Command ──────────────────────────────────────────────────────

cmd({
  pattern: 'fb',
  // `facebook` and `fbdl` are legacy-disabled names in the command-prune
  // plugin. Keep only the non-conflicting alias so `.fb` remains registered.
  alias: ['fbd'],
  desc: 'Download Facebook video/reel',
  category: 'downloader',
  use: '.fb <Facebook URL>',
}, async (mek, text, extra) => {
  log('.fb called');
  const Void = extra?.Void || mek.bot;
  const query = String(text || '').trim();
  if (!query) return mek.reply('*Provide a Facebook URL.*\n\nExample: `.fb https://www.facebook.com/watch/?v=123`');

  const urlMatch = query.match(/https?:\/\/[^\s]*(?:facebook\.com|fb\.watch|fb\.com|m\.facebook\.com)[^\s]*/i);
  if (!urlMatch) return mek.reply('*Provide a valid Facebook URL.*');

  try {
    await mek.reply('⏳ *Downloading from Facebook...*');
    const result = await downloadFacebook(urlMatch[0]);

    if (result?.videoUrl) {
      log('FB: downloading video (' + (result.quality || 'default') + ')');
      const buffer = await downloadToBuffer(result.videoUrl);
      await Void.sendMessage(mek.chat, {
        video: buffer,
        mimetype: 'video/mp4',
        caption: '*Facebook Download* 📘',
      }, { quoted: { key: mek.key, message: {} } });
    } else {
      log('FB: no direct URL found, trying loader.to fallback');
      try {
        const { downloadMedia } = require('../lib/safful-loader-dl');
        const fallback = await downloadMedia(urlMatch[0], 'video');
        if (fallback?.filePath) {
          const { readFileSync } = require('fs');
          const buffer = readFileSync(fallback.filePath);
          await Void.sendMessage(mek.chat, {
            video: buffer,
            mimetype: 'video/mp4',
            caption: '*Facebook Download* 📘',
          }, { quoted: { key: mek.key, message: {} } });
          try { require('fs').unlinkSync(fallback.filePath); } catch {}
        } else {
          return mek.reply('*Download failed.* Try downloading manually.');
        }
      } catch (loaderErr) {
        log('FB loader fallback failed: ' + loaderErr.message);
        return mek.reply('*Download failed.* Try downloading manually.');
      }
    }
    log('FB: success');
  } catch (err) {
    log('FB error: ' + err.message);
    await mek.reply('*Download failed:* ' + String(err.message).slice(0, 200));
  }
});
