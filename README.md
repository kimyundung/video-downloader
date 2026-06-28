# YouTube Downloader

🍿 一个漂亮的 Web UI 工具，用于下载 YouTube 视频、Shorts 和音频。

## 功能

- 🎬 下载 YouTube 视频（最高 1080p）
- 🔥 最佳质量下载（原画质）
- 🎵 提取 MP3 音频（320kbps）
- 📱 支持 YouTube Shorts
- ⏱️ 实时下载进度显示
- 🖼️ 自动嵌入缩略图和元数据
- 🧹 自动清理过期文件（1小时）

## 安装

```bash
# 1. 安装 yt-dlp（如果还没有）
brew install yt-dlp

# 2. 安装 Node.js 依赖
cd yt-downloader
npm install

# 3. 启动
npm start
```

打开浏览器访问 `http://localhost:3000`

## 开发模式

```bash
npm run dev  # 自动重启
```

## 技术栈

- **前端:** 纯 HTML + CSS + JS（无框架）
- **后端:** Node.js + Express 5
- **下载引擎:** yt-dlp
- **媒体处理:** ffmpeg（由 yt-dlp 自动调用）
- **实时通信:** SSE (Server-Sent Events)

## 注意事项

- 下载的文件保存在 `downloads/` 目录
- 超过 1 小时的旧文件会自动清理
- 单文件最大 2GB
- 仅供个人学习使用
