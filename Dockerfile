FROM node:20-slim

# 安装 Python, yt-dlp, deno (YouTube JS runtime)
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    unzip \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install yt-dlp --break-system-packages

# 安装 deno (yt-dlp 需要 JS runtime 解析 YouTube)
RUN curl -fsSL https://deno.land/install.sh | sh -s -- -y
ENV DENO_INSTALL="/root/.deno"
ENV PATH="${DENO_INSTALL}/bin:${PATH}"

# 配置 yt-dlp 允许远程 JS challenge 组件
RUN yt-dlp --remote-components ejs:github 2>/dev/null || true

# 创建 app 目录
WORKDIR /app

# 安装 Node 依赖
COPY package*.json ./
RUN npm install --production

# 复制源码
COPY . .

# 创建下载目录
RUN mkdir -p downloads

EXPOSE 3000

CMD ["node", "server.js"]
