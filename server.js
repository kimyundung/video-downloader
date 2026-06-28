const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const crypto = require('crypto');

// ---- 检测 yt-dlp 路径 ----
function findYtDlp() {
  const candidates = [
    '/opt/homebrew/Caskroom/miniforge/base/bin/yt-dlp',
    '/opt/homebrew/bin/yt-dlp',
    '/usr/local/bin/yt-dlp',
    '/Users/kim-yundung/Library/Python/3.9/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp'
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
    // try via which
  }
  return 'yt-dlp';
}

const YT_DLP = findYtDlp();
console.log(`🔧 Using yt-dlp: ${YT_DLP}`);

// ---- Cookie 文件 ----
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
const zlib = require('zlib');

function writeCookies() {
  // 尝试环境变量（gzip base64）
  const b64 = process.env.YT_COOKIES_B64;
  if (b64) {
    try {
      const compressed = Buffer.from(b64, 'base64');
      const decoded = zlib.gunzipSync(compressed);
      fs.writeFileSync(COOKIES_FILE, decoded);
      console.log('🍪 Cookies written from env (gzipped)');
      return true;
    } catch (e) {
      // 可能是非压缩的 base64
      try {
        const decoded = Buffer.from(b64, 'base64');
        fs.writeFileSync(COOKIES_FILE, decoded);
        console.log('🍪 Cookies written from env (raw)');
        return true;
      } catch (e2) {
        console.log('⚠️  Failed to write cookies:', e2.message);
      }
    }
  }
  return false;
}

const HAS_COOKIES = writeCookies();

const app = express();
const PORT = process.env.PORT || 3000;

// ---- 配置 ----
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2GB
const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour
const FILE_TTL = 60 * 60 * 1000; // 1 hour

if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// ---- 中间件 ----
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---- 活跃下载 ----
const downloads = new Map(); // id -> { sseClients: Set, process: ChildProcess, format, filename }

// ---- 工具函数 ----
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 200);
}

function sendSSE(clients, data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try {
      client.write(msg);
    } catch (_) {
      clients.delete(client);
    }
  }
}

// ---- 获取视频信息 ----
app.get('/api/info', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Missing url parameter' });

  const isYouTube = /youtube\.com|youtu\.be/.test(url);

  // 多个播放客户端策略，优先用不指定客户端的默认方式（自动选择最佳画质）
  const playerClients = [
    '',
    'youtube:player_client=android',
    'youtube:player_client=web',
  ];

  let lastError = '';

  tryRun(playerClients, 0);

  function tryRun(clients, idx) {
    if (idx >= clients.length) {
      return res.status(400).json({
        error: 'Failed to fetch video info',
        detail: lastError.slice(0, 500)
      });
    }

    const args = [
      '--dump-json',
      '--no-playlist',
      '--remote-components', 'ejs:github',
      ...(HAS_COOKIES ? ['--cookies', COOKIES_FILE] : []),
    ];
    // 如果客户端不是空字符串，加上 extractor-args
    if (clients[idx]) {
      args.push('--extractor-args', clients[idx]);
    }
    args.push(url);

    const proc = spawn(YT_DLP, args);
    let pStdout = '';
    let pStderr = '';

    proc.stdout.on('data', (d) => { pStdout += d.toString(); });
    proc.stderr.on('data', (d) => { pStderr += d.toString(); });

    proc.on('close', (code) => {
      if (code !== 0 || !pStdout) {
        lastError = pStderr.slice(0, 800);
        console.log(`[info] player_client=${clients[idx]} failed, trying next...`);
        tryRun(clients, idx + 1);
        return;
      }
      try {
        const info = JSON.parse(pStdout.split('\n')[0]);
        res.json({
          title: info.title || info.display_id || '未知标题',
          duration: info.duration,
          thumbnail: info.thumbnail,
          uploader: info.uploader || info.channel || info.creator || '',
          durationString: formatDuration(info.duration),
          formats: (info.formats || [])
            .filter(f => f.filesize || f.filesize_approx)
            .map(f => ({
              format_id: f.format_id,
              ext: f.ext,
              resolution: f.resolution || f.format_note || '',
              filesize: f.filesize || f.filesize_approx,
              filesizeString: f.filesize ? formatBytes(f.filesize) : '~' + formatBytes(f.filesize_approx)
            })),
          isXiaohongshu: !info.duration && info.extractor === 'XiaoHongShu'
        });
      } catch (e) {
        res.status(500).json({ error: 'Failed to parse video info' });
      }
    });
  }
});

// ---- 发起下载 ----
app.post('/api/download', (req, res) => {
  const { url, format } = req.body;
  if (!url) return res.status(400).json({ error: 'Missing url' });

  const id = crypto.randomUUID();

  // 构建 yt-dlp 参数
  const outputTemplate = path.join(DOWNLOADS_DIR, `%(title).100s_%(id)s.%(ext)s`);
  const args = ['--newline', '--no-playlist', '--embed-thumbnail', '--embed-metadata', '--remote-components', 'ejs:github'];

  // 如果有 cookie 文件，加上
  if (HAS_COOKIES) {
    args.push('--cookies', COOKIES_FILE);
  }

  // 检测平台并添加对应参数
  const isXiaohongshu = /xiaohongshu\.com|xhslink/.test(url);
  const isYouTube = /youtube\.com|youtu\.be/.test(url);

  if (isYouTube) {
    // YouTube: 让 yt-dlp 自动选客户端（不指定 extractor-args，兼容性最好）
    // 不强制客户端，yt-dlp 会自动用 web + android 混合获取最高画质
  }

  if (isXiaohongshu) {
    // 小红书: 下载最佳视频，无格式限制
    args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
  } else if (format === 'mp3') {
    args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  } else if (format === 'mp4') {
    // 标准 mp4: 用 best，不限制分辨率（android 客户端可能只有 360p 可用，不限制就能拿 web/ios 的更高画质）
    args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
  } else if (format === 'hd720') {
    args.push('-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]', '--merge-output-format', 'mp4');
  } else if (format === 'hd1080') {
    args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]', '--merge-output-format', 'mp4');
  } else {
    // best - 不限制，自动选最佳
    args.push('-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4');
  }

  args.push('-o', outputTemplate, url);

  // 创建 SSE 客户端集合
  const clients = new Set();
  downloads.set(id, { clients, process: null, format, filename: null, cancelled: false });

  // 返回下载 ID
  res.json({ downloadId: id });

  // 启动 yt-dlp
  const proc = spawn(YT_DLP, args);
  downloads.get(id).process = proc;

  let outputFile = '';

  // 解析 yt-dlp 的 --newline 输出
  proc.stdout.on('data', (data) => {
    const line = data.toString().trim();
    if (!line) return;

    // yt-dlp 可能会输出 "Destination: /path/file.mp4" 或 "  Merging formats..."等
    if (line.startsWith('Destination: ')) {
      outputFile = line.slice('Destination: '.length).trim();
    }

    // 进度行: [download]  45.2% of ~  5.3MiB at  2.3MiB/s ETA 00:02
    const progressMatch = line.match(/(\d+\.?\d*)%/);
    if (progressMatch) {
      const percent = parseFloat(progressMatch[1]);
      const speedMatch = line.match(/at\s+([\d.]+[KMG]?i?B\/s)/);
      const etaMatch = line.match(/ETA\s+(\S+)/);
      sendSSE(clients, {
        type: 'progress',
        percent: Math.min(percent, 100),
        speed: speedMatch ? speedMatch[1] : '',
        eta: etaMatch ? etaMatch[1] : ''
      });
    }
  });

  proc.stderr.on('data', (data) => {
    const text = data.toString();
    // yt-dlp 可能在 stderr 输出进度
    const progressMatch = text.match(/(\d+\.?\d*)%/);
    if (progressMatch) {
      const percent = parseFloat(progressMatch[1]);
      sendSSE(clients, {
        type: 'progress',
        percent: Math.min(percent, 100)
      });
    }
  });

  proc.on('close', (code) => {
    if (downloads.get(id)?.cancelled) {
      sendSSE(clients, { type: 'cancelled' });
      cleanupDownload(id);
      return;
    }

    if (code !== 0) {
      sendSSE(clients, { type: 'error', message: `yt-dlp exited with code ${code}` });
      cleanupDownload(id);
      return;
    }

    // 找到下载的文件
    const files = fs.readdirSync(DOWNLOADS_DIR)
      .filter(f => !f.startsWith('.'));
    const latest = files
      .map(f => ({ name: f, mtime: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)[0];

    if (latest) {
      const filePath = path.join(DOWNLOADS_DIR, latest.name);
      const stats = fs.statSync(filePath);

      if (stats.size > MAX_FILE_SIZE) {
        fs.unlinkSync(filePath);
        sendSSE(clients, { type: 'error', message: 'File exceeds 2GB limit' });
        cleanupDownload(id);
        return;
      }

      sendSSE(clients, {
        type: 'complete',
        filename: latest.name,
        filesize: formatBytes(stats.size),
        downloadPath: `/downloads/${encodeURIComponent(latest.name)}`
      });
    } else {
      sendSSE(clients, { type: 'error', message: 'Could not locate downloaded file' });
    }

    // 延迟清理，确保 SSE 客户端收到消息
    setTimeout(() => cleanupDownload(id), 5000);
  });

  proc.on('error', (err) => {
    sendSSE(clients, { type: 'error', message: err.message });
    cleanupDownload(id);
  });
});

// ---- SSE 进度 ----
app.get('/api/progress/:id', (req, res) => {
  const { id } = req.params;
  const dl = downloads.get(id);

  if (!dl) {
    return res.status(404).json({ error: 'Download not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  res.write('\n');
  dl.clients.add(res);

  req.on('close', () => {
    dl.clients.delete(res);
  });
});

// ---- 取消下载 ----
app.post('/api/cancel/:id', (req, res) => {
  const { id } = req.params;
  const dl = downloads.get(id);

  if (!dl) {
    return res.status(404).json({ error: 'Download not found' });
  }

  dl.cancelled = true;
  if (dl.process) {
    dl.process.kill('SIGTERM');
  }

  res.json({ success: true });
});

// ---- 文件下载 ----
app.get('/downloads/:filename', (req, res) => {
  const filePath = path.join(DOWNLOADS_DIR, req.params.filename);
  
  // 安全校验：防止目录穿越
  if (!filePath.startsWith(DOWNLOADS_DIR)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.download(filePath);
});

// ---- 辅助函数 ----
function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '--:--';
  if (seconds === 0) return '直播/未知';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(1)} ${units[i]}`;
}

function cleanupDownload(id) {
  const dl = downloads.get(id);
  if (dl) {
    for (const client of dl.clients) {
      try { client.end(); } catch (_) {}
    }
    downloads.delete(id);
  }
}

// ---- 定时清理过期文件 ----
setInterval(() => {
  const now = Date.now();
  const files = fs.readdirSync(DOWNLOADS_DIR);
  for (const file of files) {
    const filePath = path.join(DOWNLOADS_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > FILE_TTL) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up: ${file}`);
      }
    } catch (_) {}
  }
}, CLEANUP_INTERVAL);

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`🎬 Video Downloader running at http://localhost:${PORT}`);
  console.log(`📁 Downloads saved to: ${DOWNLOADS_DIR}`);
});
