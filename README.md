# 视频下载器

一个基于Node.js的视频下载工具，支持搜索、下载、播放和投屏功能。

## 功能特性

- 🔍 搜索多个视频源
- 📥 下载视频（自动转换为MP4格式）
- 🎬 在线播放已下载视频
- 📺 DLNA投屏到电视
- ⏭ 自动连播功能
- 🔄 跳过已下载剧集
- ⚡ 多线程并发下载
- 📊 下载任务管理

## 快速开始

### Docker部署（推荐）

1. 创建目录结构：
```bash
mkdir -p vdown/downloads
cd vdown
```

2. 创建 `docker-compose.yml`：
```yaml
version: '3.8'

services:
  vdown:
    image: ghcr.io/your-username/vdown:latest
    container_name: vdown
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - ./downloads:/app/downloads
      - ./db.json:/app/db.json
    environment:
      - NODE_ENV=production
      - PORT=3000
      - FFMPEG_PATH=/usr/bin/ffmpeg
      - DOWNLOADS_DIR=/app/downloads
      - DOWNLOAD_CONCURRENCY=10
```

3. 启动服务：
```bash
docker-compose up -d
```

4. 访问 http://localhost:3000

### 本地部署

1. 安装依赖：
```bash
npm install
```

2. 安装 ffmpeg：
   - Windows: 下载 https://www.gyan.dev/ffmpeg/builds/ 并解压
   - Linux: `sudo apt install ffmpeg`
   - macOS: `brew install ffmpeg`

3. 配置 ffmpeg 路径（可选）：
```bash
# 设置环境变量
export FFMPEG_PATH=/path/to/ffmpeg

# 或直接修改 server.js 中的 FFMPEG_PATH
```

4. 启动服务：
```bash
npm start
```

## 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| PORT | 3000 | 服务端口 |
| FFMPEG_PATH | (自动检测) | ffmpeg可执行文件路径 |
| DOWNLOADS_DIR | ./downloads | 下载目录路径 |
| DOWNLOAD_CONCURRENCY | 10 | 下载并发线程数 |

## 目录挂载

Docker部署时，建议挂载以下目录：

- `/app/downloads` - 下载的视频文件
- `/app/db.json` - 下载任务记录

```bash
docker run -d \
  -p 3000:3000 \
  -v $(pwd)/downloads:/app/downloads \
  -v $(pwd)/db.json:/app/db.json \
  -e DOWNLOAD_CONCURRENCY=15 \
  ghcr.io/your-username/vdown:latest
```

## API接口

| 接口 | 方法 | 说明 |
|------|------|------|
| `/api/config` | GET | 获取配置信息 |
| `/api/download` | POST | 创建下载任务 |
| `/api/download/tasks` | GET | 获取所有任务 |
| `/api/download/status/:id` | GET | 获取任务状态 |
| `/api/download/pause/:id` | POST | 暂停任务 |
| `/api/download/resume/:id` | POST | 恢复任务 |
| `/api/download/:id` | DELETE | 删除任务 |
| `/api/download/history` | GET | 获取下载历史 |
| `/api/downloads` | GET | 获取已下载文件 |

## GitHub Actions

本项目配置了GitHub Actions自动构建Docker镜像：

- 推送到 `main` 或 `master` 分支时自动构建
- 创建版本标签（如 `v1.0.0`）时自动发布

## 许可证

MIT
