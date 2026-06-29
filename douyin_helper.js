/**
 * Douyin video info extractor using Puppeteer.
 * Opens the douyin video page in headless Chrome and extracts video URL.
 */

const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

// Chrome paths (try different locations)
const CHROME_PATHS = [
  process.env.CHROME_PATH || '',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',  // macOS
  '/usr/bin/chromium-browser',   // Linux
  '/usr/bin/chromium',            // Linux (alt)
  '/usr/bin/google-chrome',      // Linux (Chrome)
  '/usr/bin/google-chrome-stable', // Linux
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  // Fallback: try puppeteer's bundled chrome if available
  try {
    return require('puppeteer').executablePath();
  } catch (_) {}
  return CHROME_PATHS[0]; // Default to first
}

const CHROME_PATH = findChrome();

/**
 * Extract douyin video info using Puppeteer (headless Chrome).
 * @param {string} videoUrl - Full douyin video URL
 * @returns {Promise<{title, uploader, thumbnail, duration, videoUrl, allUrls}>}
 */
async function extractDouyinVideo(videoUrl) {
  // Prevent launching headless Chrome if yt-dlp can handle it (YouTube)
  if (!videoUrl.includes('douyin.com')) {
    throw new Error('Not a douyin URL');
  }

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-networking',
        '--disable-sync',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // Listen for the video detail API response
    const videoData = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout waiting for video data')), 40000);
      
      page.on('response', async (response) => {
        const url = response.url();
        if (url.includes('/aweme/v1/web/aweme/detail/') && url.includes('aweme_id=')) {
          try {
            const data = await response.json();
            if (data && data.aweme_detail) {
              clearTimeout(timeout);
              resolve(data);
            }
          } catch (_) {}
        }
      });

      // Also capture video elements directly from the page after render
      setTimeout(async () => {
        try {
          const videos = await page.evaluate(() => {
            const v = document.querySelectorAll('video source');
            return Array.from(v).map(s => s.src).filter(Boolean);
          });
          if (videos.length > 0) {
            clearTimeout(timeout);
            resolve({ aweme_detail: { desc: '', video: { play_addr: { url_list: videos } } } });
          }
        } catch (_) {}
      }, 15000);

      page.goto(videoUrl, { waitUntil: 'networkidle2', timeout: 40000 }).catch(reject);
    });

    const detail = videoData.aweme_detail;
    const video = detail.video || {};
    const playAddr = video.play_addr || {};
    const urls = playAddr.url_list || [];
    const downloadAddr = video.download_addr || {};

    return {
      title: (detail.desc || '').trim(),
      uploader: detail.author?.nickname || '',
      uploader_id: detail.author?.unique_id || '',
      thumbnail: (video.cover?.url_list || [null])[0] || '',
      duration: detail.duration || 0,
      videoUrl: urls[0] || '',
      allUrls: urls,
      downloadUrls: downloadAddr.url_list || [],
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

module.exports = { extractDouyinVideo };
