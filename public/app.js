// ===== DOM Elements =====
const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const downloadBtn = document.getElementById('downloadBtn');
const cancelBtn = document.getElementById('cancelBtn');
const retryBtn = document.getElementById('retryBtn');
const downloadAgainBtn = document.getElementById('downloadAgainBtn');
const openFileBtn = document.getElementById('openFileBtn');

const previewSection = document.getElementById('previewSection');
const progressSection = document.getElementById('progressSection');
const completeSection = document.getElementById('completeSection');
const errorSection = document.getElementById('errorSection');

const thumbnail = document.getElementById('thumbnail');
const durationBadge = document.getElementById('durationBadge');
const videoTitle = document.getElementById('videoTitle');
const uploader = document.getElementById('uploader');
const formatOptions = document.getElementById('formatOptions');
const progressPercent = document.getElementById('progressPercent');
const progressFill = document.getElementById('progressFill');
const progressSpeed = document.getElementById('progressSpeed');
const progressEta = document.getElementById('progressEta');
const completeFilename = document.getElementById('completeFilename');
const completeFilesize = document.getElementById('completeFilesize');
const errorMessage = document.getElementById('errorMessage');

// ===== State =====
let currentUrl = '';
let currentDownloadId = null;
let eventSource = null;
let isDownloading = false;

// ===== Utils =====
function showSection(section) {
  [previewSection, progressSection, completeSection, errorSection].forEach(s => {
    s.style.display = s === section ? '' : 'none';
  });
}

function setFetchBtnLoading(loading) {
  fetchBtn.disabled = loading;
  fetchBtn.innerHTML = loading
    ? '<span class="spinner"></span> 获取中...'
    : '<span class="btn-icon">🔍</span> 获取信息';
}

function setDownloadBtnLoading(loading) {
  downloadBtn.disabled = loading;
  downloadBtn.innerHTML = loading
    ? '<span class="spinner"></span> 下载中...'
    : '<span class="btn-icon">⬇️</span> 开始下载';
}

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

// ===== Format Selection =====
formatOptions.addEventListener('click', (e) => {
  const card = e.target.closest('.format-card');
  if (!card) return;
  formatOptions.querySelectorAll('.format-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
});

function getSelectedFormat() {
  return formatOptions.querySelector('.format-card.selected')?.dataset.format || 'mp4';
}

// ===== Fetch Video Info =====
fetchBtn.addEventListener('click', fetchVideoInfo);
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchVideoInfo();
});

async function fetchVideoInfo() {
  const url = urlInput.value.trim();
  if (!url) {
    shakeElement(urlInput);
    return;
  }

  // 自动修正 YouTube 链接
  currentUrl = normalizeUrl(url);
  setFetchBtnLoading(true);
  showSection(previewSection);

  try {
    const res = await fetch(`/api/info?url=${encodeURIComponent(currentUrl)}`);
    const data = await res.json();

    if (!res.ok) {
      throw new Error(data.error || data.detail || '无法获取视频信息');
    }

    // 展示预览
    thumbnail.src = data.thumbnail || '';
    durationBadge.textContent = data.durationString || '';
    videoTitle.textContent = data.title || '未知标题';
    uploader.textContent = data.uploader || '';

    // 小红书/抖音不显示格式选择（直接最佳质量下载）
    const formatSelector = document.querySelector('.format-selector');
    if (data.isXiaohongshu || data.isDouyin) {
      formatSelector.style.display = 'none';
      downloadBtn.innerHTML = '<span class="btn-icon">⬇️</span> 下载视频';
    } else {
      formatSelector.style.display = '';
      downloadBtn.innerHTML = '<span class="btn-icon">⬇️</span> 开始下载';
    }

    // 保存当前视频信息，用于下载
    window._currentVideoData = data;

    setFetchBtnLoading(false);
  } catch (err) {
    setFetchBtnLoading(false);
    showError(err.message);
  }
}

function normalizeUrl(url) {
  // 处理 youtube.com/shorts/xxx -> youtube.com/watch?v=xxx
  const shortsMatch = url.match(/(?:youtube\.com|youtu\.be)\/shorts\/([a-zA-Z0-9_-]+)/);
  if (shortsMatch) {
    return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
  }
  return url;
}

function shakeElement(el) {
  el.style.animation = 'none';
  el.offsetHeight;
  el.style.animation = 'shake 0.3s ease';
  setTimeout(() => el.style.animation = '', 300);
}

// ===== Start Download =====
downloadBtn.addEventListener('click', startDownload);

async function startDownload() {
  if (isDownloading) return;
  if (!currentUrl) {
    showError('请先粘贴视频链接');
    return;
  }

  const format = getSelectedFormat();
  const videoData = window._currentVideoData || {};
  const isDouyin = videoData.isDouyin;

  isDownloading = true;
  setDownloadBtnLoading(true);
  showSection(progressSection);
  resetProgress();

  try {
    const body = { url: currentUrl, format };
    // 抖音传直链，服务端直接下载
    if (isDouyin && videoData.allUrls && videoData.allUrls.length > 0) {
      body.directUrl = videoData.allUrls[0];
    }

    const res = await fetch('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to start download');

    currentDownloadId = data.downloadId;
    connectSSE(currentDownloadId);
  } catch (err) {
    isDownloading = false;
    setDownloadBtnLoading(false);
    showError(err.message);
  }
}

// ===== SSE Progress =====
function connectSSE(downloadId) {
  if (eventSource) {
    eventSource.close();
  }

  eventSource = new EventSource(`/api/progress/${downloadId}`);

  eventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      handleSSEMessage(data);
    } catch (_) {}
  };

  eventSource.onerror = () => {
    // SSE connection lost — wait a bit then check if download finished
    setTimeout(() => {
      if (isDownloading) {
        showError('连接中断，请重试');
        cleanupDownload();
      }
    }, 3000);
  };
}

function handleSSEMessage(data) {
  switch (data.type) {
    case 'progress':
      const pct = Math.round(data.percent);
      progressPercent.textContent = `${pct}%`;
      progressFill.style.width = `${pct}%`;
      progressSpeed.textContent = data.speed || '-';
      progressEta.textContent = data.eta ? `ETA: ${data.eta}` : 'ETA: --';
      break;

    case 'complete':
      completeFilename.textContent = data.filename;
      completeFilesize.textContent = data.filesize;
      openFileBtn.href = data.downloadPath;
      showSection(completeSection);
      cleanupDownload();
      break;

    case 'cancelled':
      showError('下载已取消');
      cleanupDownload();
      break;

    case 'error':
      showError(data.message || '下载失败');
      cleanupDownload();
      break;
  }
}

function cleanupDownload() {
  isDownloading = false;
  setDownloadBtnLoading(false);
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  currentDownloadId = null;
}

// ===== Cancel =====
cancelBtn.addEventListener('click', async () => {
  if (!currentDownloadId) return;
  try {
    await fetch(`/api/cancel/${currentDownloadId}`, { method: 'POST' });
  } catch (_) {}
  showError('下载已取消');
  cleanupDownload();
});

// ===== Retry & Download Again =====
retryBtn.addEventListener('click', () => {
  showSection(previewSection);
});

downloadAgainBtn.addEventListener('click', () => {
  showSection(previewSection);
  urlInput.focus();
});

// ===== Error =====
function showError(msg) {
  cleanupDownload();
  errorMessage.textContent = msg || '发生未知错误';
  showSection(errorSection);
}

function resetProgress() {
  progressPercent.textContent = '0%';
  progressFill.style.width = '0%';
  progressSpeed.textContent = '-';
  progressEta.textContent = 'ETA: --';
}

// ===== Keyboard shortcut =====
document.addEventListener('keydown', (e) => {
  // Ctrl+Enter to download from preview
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && previewSection.style.display !== 'none') {
    startDownload();
  }
});

// ===== Inject shake animation =====
const style = document.createElement('style');
style.textContent = `
@keyframes shake {
  0%, 100% { transform: translateX(0); }
  25% { transform: translateX(-6px); border-color: #ef4444; }
  75% { transform: translateX(6px); border-color: #ef4444; }
}
`;
document.head.appendChild(style);
