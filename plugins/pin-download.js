const { cmd } = require('../lib/plugins');
const path = require('path');
const fs = require('fs');
const nodeFetch = require('node-fetch');

const RAPIDAPI_KEYS = [
  '88a90fa926msh71c13439cf464b0p12b878jsnfc6e87cd5cc1',
  '61f008b6bcmsh2ce3a8ab7b478b5p1ba598jsnb96b7846a076',
  '838a49c740msh66f2cc2a92d1ddcp1e3662jsne682454bc725',
];

function log(msg) {
  process.stderr.write('[safful-pin] ' + msg + '\n');
}

async function fetchBuffer(url) {
  const res = await nodeFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://www.pinterest.com/',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.buffer();
}

async function tryRapidAPI(url) {
  for (const key of RAPIDAPI_KEYS) {
    try {
      const res = await nodeFetch('https://social-download-all-in-one.p.rapidapi.com/v1/social/autolink', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': 'social-download-all-in-one.p.rapidapi.com',
        },
        body: JSON.stringify({ url }),
      });

      if (res.ok) {
        const data = await res.json();
        if (data.medias && data.medias.length > 0) {
          const video = data.medias.find(m => m.type === 'video');
          const image = data.medias.find(m => m.type === 'image');
          const media = video || image;

          if (media && media.url) {
            log('RapidAPI found: ' + media.type + ' ' + (media.quality || '') + ' ' + (media.extension || ''));
            const buf = await fetchBuffer(media.url);
            if (buf.length > 1000) {
              return {
                buffer: buf,
                type: media.type,
                title: data.title || '',
                url: media.url,
              };
            }
          }
        }
      }
    } catch (e) {
      log('RapidAPI key failed: ' + e.message);
    }
  }
  return null;
}

async function tryScrape(url) {
  const res = await nodeFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });

  const html = await res.text();

  const videoMatch = html.match(/<meta[^>]*property="og:video"[^>]*content="([^"]+)"/i)
    || html.match(/content="([^"]+)"[^>]*property="og:video"/i);

  const imageMatch = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i)
    || html.match(/content="([^"]+)"[^>]*property="og:image"/i);

  if (videoMatch) {
    const buf = await fetchBuffer(videoMatch[1]);
    if (buf.length > 1000) {
      return { buffer: buf, type: 'video', title: '', url: videoMatch[1] };
    }
  }

  if (imageMatch) {
    let imgUrl = imageMatch[1].replace(/\/\d+x\//, '/originals/').replace(/\/\d+x\d+\//, '/originals/');
    const buf = await fetchBuffer(imgUrl);
    if (buf.length > 1000) {
      return { buffer: buf, type: 'image', title: '', url: imgUrl };
    }
  }

  return null;
}

cmd({
  pattern: 'pin',
  alias: ['pinterest', 'pindl', 'pindownload'],
  desc: 'Download Pinterest video or image',
  category: 'downloader',
  use: '.pin <Pinterest URL>',
}, async (mek, text, extra) => {
  const Void = extra?.Void;
  log('.pin called');

  const query = String(text || '').trim();
  if (!query) {
    return mek.reply(
      '*Pinterest Downloader* 📌\n\n' +
      '*Usage:* `.pin <Pinterest URL>`\n\n' +
      '*Supported:* pin.it shortlinks, pinterest.com/pin/... URLs\n\n' +
      '*Example:* `.pin https://pin.it/46xA5K7VY`'
    );
  }

  const urlMatch = query.match(/https?:\/\/[^\s]*(?:pinterest\.(?:com|ca|co\.\w+)|pin\.it)[^\s]*/i);
  if (!urlMatch) {
    return mek.reply('*Provide a valid Pinterest URL.*\n\nExample: `.pin https://pin.it/abc123`');
  }

  const url = urlMatch[0];
  log('URL: ' + url);

  try {
    log('Trying RapidAPI...');
    let result = await tryRapidAPI(url);

    if (!result) {
      log('RapidAPI failed, trying scrape...');
      result = await tryScrape(url);
    }

    if (!result) {
      log('Scrape failed, trying loader.to...');
      try {
        const { downloadMedia, removeDownloadedAudio } = require('../lib/safful-loader-dl');
        const loaderResult = await downloadMedia(url, 'video');
        if (loaderResult && loaderResult.filePath) {
          await Void.sendMessage(mek.chat, {
            video: { url: loaderResult.filePath },
            mimetype: loaderResult.mimeType || 'video/mp4',
            caption: '*Pinterest Download* 📌\n' + (loaderResult.title || ''),
          }, { quoted: { key: mek.key, message: {} } });
          removeDownloadedAudio(loaderResult.filePath);
          log('SUCCESS via loader.to');
          return;
        }
      } catch (loaderErr) {
        log('loader.to failed: ' + loaderErr.message);
      }
    }

    if (!result) {
      return mek.reply('*Could not download from this Pinterest link.*\n\nThe link may be private, expired, or unsupported.');
    }

    const isVideo = result.type === 'video';
    const caption = result.title
      ? '*Pinterest Download* 📌\n' + result.title.slice(0, 200)
      : '*Pinterest Download* 📌';

    await Void.sendMessage(mek.chat, {
      [isVideo ? 'video' : 'image']: result.buffer,
      caption,
    }, { quoted: { key: mek.key, message: {} } });

    log('SUCCESS: Sent ' + result.type + ' (' + (result.buffer.length / 1024).toFixed(1) + ' KB)');

  } catch (err) {
    log('Error: ' + (err.message || err));
    return mek.reply('*Download failed:* ' + String(err.message || err).slice(0, 200));
  }
});

module.exports = {};
