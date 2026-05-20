FROM node:18-slim

# 安装ffmpeg和必要工具
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# 设置工作目录
WORKDIR /app

# 复制package.json和package-lock.json
COPY package.json package-lock.json ./

# 安装依赖
RUN npm ci --production --ignore-scripts 2>/dev/null || npm install --production --ignore-scripts

# 复制应用代码
COPY server.js ./
COPY public ./public/
COPY *.json ./

# 创建下载目录
RUN mkdir -p /app/downloads

# 暴露端口
EXPOSE 3000

# 设置环境变量
ENV NODE_ENV=production
ENV PORT=3000
ENV FFMPEG_PATH=/usr/bin/ffmpeg
ENV DOWNLOADS_DIR=/app/downloads
ENV DOWNLOAD_CONCURRENCY=10

# 启动应用
CMD ["node", "server.js"]
