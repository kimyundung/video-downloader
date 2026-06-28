FROM node:20-slim

# 安装 Python 和 yt-dlp
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install yt-dlp --break-system-packages

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
