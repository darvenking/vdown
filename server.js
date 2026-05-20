const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const cors = require('cors');
const iconv = require('iconv-lite');
const { mkdirp } = require('mkdirp');
const mime = require('mime-types');
const dlnacasts = require('dlnacasts');
const { execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

// ffmpeg路径 - 支持环境变量配置
const FFMPEG_PATH = process.env.FFMPEG_PATH || 'E:\\sdk\\ffmpeg\\bin\\ffmpeg.exe';

// 下载目录 - 支持环境变量配置
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, 'downloads');

// DLNA投屏相关
let castClient = null;
let currentDevice = null;
let devices = [];

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// TS转MP4函数
function convertTsToMp4(tsFile, mp4File) {
  return new Promise((resolve, reject) => {
    console.log(`转换 ${tsFile} -> ${mp4File}`);
    
    execFile(FFMPEG_PATH, [
      '-i', tsFile,
      '-c', 'copy',
      '-movflags', '+faststart',
      '-y',
      mp4File
    ], { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        console.error('ffmpeg错误:', error.message);
        reject(error);
      } else {
        console.log('转换完成:', mp4File);
        resolve(mp4File);
      }
    });
  });
}

// 初始化DLNA发现
function initDLNA() {
  castClient = dlnacasts();
  
  castClient.on('update', (player) => {
    console.log('发现设备:', player.name);
    if (!devices.find(d => d.id === player.id)) {
      devices.push({
        id: player.id,
        name: player.name,
        host: player.host,
        port: player.port
      });
    }
  });
  
  castClient.on('remove', (player) => {
    console.log('设备移除:', player.name);
    devices = devices.filter(d => d.id !== player.id);
  });
}

// 启动DLNA发现
initDLNA();

// 加载视频源配置
function loadConfig() {
  const configFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.json') && f.includes('kvideo'));
  if (configFiles.length === 0) {
    throw new Error('未找到视频源配置文件');
  }
  const configPath = path.join(__dirname, configFiles[0]);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return config.settings.sources.filter(s => s.enabled).sort((a, b) => a.priority - b.priority);
}

// 从API获取数据
async function fetchFromAPI(url, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      const buffer = Buffer.from(response.data);
      
      try {
        const utf8Text = buffer.toString('utf-8');
        const data = JSON.parse(utf8Text);
        if (data && typeof data === 'object') return data;
      } catch {}
      
      try {
        const gbkText = iconv.decode(buffer, 'gbk');
        const data = JSON.parse(gbkText);
        if (data && typeof data === 'object') return data;
      } catch {}
      
      throw new Error('无法解析API响应');
    } catch (error) {
      if (i === retries - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// 从share链接获取实际的m3u8 URL
async function getRealUrl(url) {
  if (!url.includes('/share/')) {
    return url;
  }
  
  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const html = response.data;
    const urlMatch = html.match(/const\s+url\s*=\s*["']([^"']+\.m3u8[^"']*?)["']/);
    if (urlMatch && urlMatch[1]) {
      let m3u8Path = urlMatch[1];
      const urlObj = new URL(url);
      if (m3u8Path.startsWith('/')) {
        return `${urlObj.protocol}//${urlObj.host}${m3u8Path}`;
      } else {
        const basePath = url.substring(0, url.lastIndexOf('/'));
        return `${basePath}/${m3u8Path}`;
      }
    }
    
    return url;
  } catch (error) {
    return url;
  }
}

// 解析播放链接
function parsePlayUrls(vodPlayFrom, vodPlayUrl) {
  if (!vodPlayFrom || !vodPlayUrl) return [];
  
  const sources = vodPlayFrom.split('$$$');
  const urlGroups = vodPlayUrl.split('$$$');
  
  const result = [];
  
  for (let i = 0; i < sources.length; i++) {
    const sourceName = sources[i];
    const urlGroup = urlGroups[i] || '';
    
    const episodes = urlGroup.split('#').map(ep => {
      const parts = ep.split('$');
      if (parts.length >= 2) {
        return {
          name: parts[0],
          url: parts.slice(1).join('$')
        };
      }
      return null;
    }).filter(ep => ep && ep.url);
    
    if (episodes.length > 0) {
      result.push({
        sourceName,
        episodes
      });
    }
  }
  
  return result;
}

// 存储下载任务状态
const downloadTasks = new Map();

// API: 获取视频源列表
app.get('/api/sources', (req, res) => {
  try {
    const sources = loadConfig();
    res.json({ success: true, sources });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 搜索视频
app.get('/api/search', async (req, res) => {
  const { keyword, sourceId } = req.query;
  
  if (!keyword) {
    return res.status(400).json({ success: false, error: '请输入搜索关键词' });
  }
  
  try {
    const sources = loadConfig();
    const results = [];
    
    const searchSources = sourceId 
      ? sources.filter(s => s.id === sourceId)
      : sources;
    
    const promises = searchSources.map(async (source) => {
      try {
        const url = `${source.baseUrl}?wd=${encodeURIComponent(keyword)}`;
        const data = await fetchFromAPI(url);
        
        if (data.code === 1 && data.list && data.list.length > 0) {
          for (const item of data.list) {
            results.push({
              ...item,
              sourceId: source.id,
              sourceName: source.name,
              sourceBaseUrl: source.baseUrl
            });
          }
        }
      } catch (error) {
        // 忽略单个源的错误
      }
    });
    
    await Promise.allSettled(promises);
    
    // 去重
    const uniqueResults = [];
    const seen = new Set();
    
    for (const result of results) {
      const key = `${result.vod_name}_${result.vod_year || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueResults.push(result);
      }
    }
    
    res.json({ success: true, results: uniqueResults });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 获取视频详情
app.get('/api/detail', async (req, res) => {
  const { sourceBaseUrl, vodId } = req.query;
  
  if (!sourceBaseUrl || !vodId) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }
  
  try {
    const url = `${sourceBaseUrl}?ac=detail&ids=${vodId}`;
    const data = await fetchFromAPI(url);
    
    if (data.code === 1 && data.list && data.list.length > 0) {
      const detail = data.list[0];
      const playSources = parsePlayUrls(detail.vod_play_from, detail.vod_play_url);
      
      res.json({ 
        success: true, 
        detail: {
          id: detail.vod_id,
          name: detail.vod_name,
          year: detail.vod_year,
          area: detail.vod_area,
          director: detail.vod_director,
          actor: detail.vod_actor,
          score: detail.vod_score,
          content: detail.vod_content ? detail.vod_content.replace(/<[^>]+>/g, '') : '',
          pic: detail.vod_pic,
          remarks: detail.vod_remarks,
          playSources
        }
      });
    } else {
      res.status(404).json({ success: false, error: '未找到视频详情' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 开始下载任务
app.post('/api/download', async (req, res) => {
  const { videoName, episodes } = req.body;
  
  if (!videoName || !episodes || episodes.length === 0) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }
  
  const taskId = Date.now().toString();
  const downloadDir = path.join(DOWNLOADS_DIR, videoName.replace(/[<>:"/\\|?*]/g, '_'));
  
  // 初始化任务状态
  downloadTasks.set(taskId, {
    id: taskId,
    videoName,
    status: 'running',
    total: episodes.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    current: '',
    currentProgress: 0,
    files: [],
    startTime: Date.now()
  });
  
  // 异步执行下载
  (async () => {
    const task = downloadTasks.get(taskId);
    
    for (let i = 0; i < episodes.length; i++) {
      const episode = episodes[i];
      const safeName = episode.name.replace(/[<>:"/\\|?*]/g, '_');
      
      // 检查文件是否已存在
      const existingFiles = fs.existsSync(downloadDir) ? fs.readdirSync(downloadDir) : [];
      const isDownloaded = existingFiles.some(f => f.startsWith(safeName) && (f.endsWith('.ts') || f.endsWith('.mp4')));
      
      if (isDownloaded) {
        console.log(`跳过已下载: ${episode.name}`);
        task.current = `${episode.name} (已存在)`;
        task.skipped++;
        task.completed++;
        continue;
      }
      
      task.current = episode.name;
      task.currentProgress = 0;
      
      try {
        console.log(`\n开始下载: ${episode.name}`);
        console.log(`原始URL: ${episode.url}`);
        
        const realUrl = await getRealUrl(episode.url);
        console.log(`真实URL: ${realUrl}`);
        
        const isM3U8 = realUrl.includes('.m3u8');
        console.log(`是否M3U8: ${isM3U8}`);
        
        if (isM3U8) {
          await downloadM3U8(realUrl, downloadDir, safeName, task);
        } else {
          await downloadDirect(realUrl, downloadDir, safeName, task);
        }
        
        task.completed++;
        task.currentProgress = 100;
      } catch (error) {
        task.failed++;
        console.error(`下载失败 ${episode.name}: ${error.message}`);
      }
    }
    
    task.status = 'completed';
    task.current = '';
    task.currentProgress = 0;
  })();
  
  res.json({ success: true, taskId });
});

// API: 获取下载任务状态
app.get('/api/download/status/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = downloadTasks.get(taskId);
  
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  
  res.json({ success: true, task });
});

// API: 获取已下载的视频列表
app.get('/api/downloads', (req, res) => {
  try {
    if (!fs.existsSync(DOWNLOADS_DIR)) {
      return res.json({ success: true, downloads: [] });
    }
    
    const videoDirs = fs.readdirSync(DOWNLOADS_DIR);
    const downloads = [];
    
    for (const videoDir of videoDirs) {
      const videoPath = path.join(DOWNLOADS_DIR, videoDir);
      const stat = fs.statSync(videoPath);
      
      if (stat.isDirectory()) {
        const files = fs.readdirSync(videoPath)
          .filter(f => f.endsWith('.ts') || f.endsWith('.mp4') || f.endsWith('.mkv'))
          .map(f => {
            const filePath = path.join(videoPath, f);
            const fileStat = fs.statSync(filePath);
            return {
              name: f,
              size: fileStat.size,
              path: filePath
            };
          });
        
        if (files.length > 0) {
          downloads.push({
            name: videoDir,
            path: videoPath,
            files,
            totalSize: files.reduce((sum, f) => sum + f.size, 0)
          });
        }
      }
    }
    
    res.json({ success: true, downloads });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 生成本地TS文件的m3u8播放列表
app.get('/api/playlist', (req, res) => {
  const { filePath } = req.query;
  
  if (!filePath) {
    return res.status(400).json({ success: false, error: '缺少文件路径' });
  }
  
  // 安全检查
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(DOWNLOADS_DIR)) {
    return res.status(403).json({ success: false, error: '访问被拒绝' });
  }
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: '文件不存在' });
  }
  
  // 生成m3u8播放列表
  const fileName = path.basename(filePath);
  const streamUrl = `/api/stream?filePath=${encodeURIComponent(filePath)}`;
  
  const m3u8 = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
${streamUrl}
#EXT-X-ENDLIST`;
  
  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(m3u8);
});

// API: 获取投屏设备列表
app.get('/api/cast/devices', (req, res) => {
  // 刷新设备列表
  castClient.update();
  
  // 等待一段时间收集设备
  setTimeout(() => {
    res.json({ 
      success: true, 
      devices: devices,
      currentDevice: currentDevice ? {
        id: currentDevice.id,
        name: currentDevice.name
      } : null
    });
  }, 2000);
});

// API: 投屏视频到设备
app.post('/api/cast/play', async (req, res) => {
  const { deviceId, filePath, fileName } = req.body;
  
  if (!deviceId || !filePath) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }
  
  // 安全检查
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(DOWNLOADS_DIR)) {
    return res.status(403).json({ success: false, error: '访问被拒绝' });
  }
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: '文件不存在' });
  }
  
  // 查找设备
  const device = devices.find(d => d.id === deviceId);
  if (!device) {
    return res.status(404).json({ success: false, error: '设备未找到' });
  }
  
  try {
    // 构建视频URL（需要本机IP地址）
    const os = require('os');
    const networkInterfaces = os.networkInterfaces();
    let localIP = '127.0.0.1';
    
    // 查找本机IP
    for (const name of Object.keys(networkInterfaces)) {
      for (const iface of networkInterfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          localIP = iface.address;
          break;
        }
      }
    }
    
    const videoUrl = `http://${localIP}:${PORT}/api/stream?filePath=${encodeURIComponent(filePath)}`;
    
    console.log(`投屏到 ${device.name}: ${videoUrl}`);
    
    // 使用dlnacasts播放
    const player = castClient.players[deviceId];
    if (player) {
      player.play(videoUrl, {
        title: fileName || path.basename(filePath),
        type: mime.lookup(filePath) || 'video/mp2t'
      });
      
      currentDevice = device;
      
      player.on('status', (status) => {
        console.log('播放状态:', status);
      });
      
      res.json({ success: true, message: '已开始投屏' });
    } else {
      res.status(404).json({ success: false, error: '设备未找到' });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 停止投屏
app.post('/api/cast/stop', (req, res) => {
  if (currentDevice) {
    const player = castClient.players[currentDevice.id];
    if (player) {
      player.stop();
    }
    currentDevice = null;
    res.json({ success: true, message: '已停止投屏' });
  } else {
    res.json({ success: true, message: '没有正在进行的投屏' });
  }
});

// API: 投屏控制 - 暂停/继续
app.post('/api/cast/pause', (req, res) => {
  if (currentDevice) {
    const player = castClient.players[currentDevice.id];
    if (player) {
      player.pause();
      res.json({ success: true, message: '已暂停' });
    } else {
      res.status(404).json({ success: false, error: '设备未找到' });
    }
  } else {
    res.status(400).json({ success: false, error: '没有正在进行的投屏' });
  }
});

app.post('/api/cast/resume', (req, res) => {
  if (currentDevice) {
    const player = castClient.players[currentDevice.id];
    if (player) {
      player.resume();
      res.json({ success: true, message: '已继续播放' });
    } else {
      res.status(404).json({ success: false, error: '设备未找到' });
    }
  } else {
    res.status(400).json({ success: false, error: '没有正在进行的投屏' });
  }
});

// API: 投屏控制 - 设置音量
app.post('/api/cast/volume', (req, res) => {
  const { volume } = req.body;
  
  if (currentDevice && volume !== undefined) {
    const player = castClient.players[currentDevice.id];
    if (player) {
      player.volume(volume);
      res.json({ success: true, message: '音量已设置' });
    } else {
      res.status(404).json({ success: false, error: '设备未找到' });
    }
  } else {
    res.status(400).json({ success: false, error: '没有正在进行的投屏或缺少音量参数' });
  }
});

// API: 视频流播放
app.get('/api/stream', (req, res) => {
  const { filePath } = req.query;
  
  if (!filePath) {
    return res.status(400).json({ success: false, error: '缺少文件路径' });
  }
  
  // 安全检查：只允许访问downloads目录下的文件
  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(DOWNLOADS_DIR)) {
    return res.status(403).json({ success: false, error: '访问被拒绝' });
  }
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: '文件不存在' });
  }
  
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mimeType = mime.lookup(filePath) || 'video/mp2t';
  
  const range = req.headers.range;
  
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunksize = (end - start) + 1;
    
    const file = fs.createReadStream(filePath, { start, end });
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mimeType,
    };
    
    res.writeHead(206, head);
    file.pipe(res);
  } else {
    const head = {
      'Content-Length': fileSize,
      'Content-Type': mimeType,
    };
    
    res.writeHead(200, head);
    fs.createReadStream(filePath).pipe(res);
  }
});

// 下载m3u8文件
async function downloadM3U8(url, outputDir, filename, task) {
  await mkdirp(outputDir);
  
  console.log(`下载M3U8: ${url}`);
  
  const m3u8Response = await axios.get(url, {
    timeout: 30000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': url
    }
  });
  
  const m3u8Content = m3u8Response.data;
  console.log(`M3U8内容前500字符:\n${m3u8Content.substring(0, 500)}`);
  
  const lines = m3u8Content.split('\n');
  const tsUrls = [];
  let isM3U8 = false;
  let baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
  
  // 检查是否是嵌套的m3u8（包含带宽信息但没有ts片段）
  let isNestedM3U8 = false;
  let nestedUrl = null;
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    if (trimmedLine === '#EXTM3U') {
      isM3U8 = true;
      continue;
    }
    
    if (trimmedLine.startsWith('#')) continue;
    
    if (trimmedLine && isM3U8) {
      // 如果是m3u8文件，递归下载
      if (trimmedLine.endsWith('.m3u8')) {
        isNestedM3U8 = true;
        if (trimmedLine.startsWith('http')) {
          nestedUrl = trimmedLine;
        } else if (trimmedLine.startsWith('/')) {
          const urlObj = new URL(url);
          nestedUrl = `${urlObj.protocol}//${urlObj.host}${trimmedLine}`;
        } else {
          nestedUrl = baseUrl + trimmedLine;
        }
        console.log(`检测到嵌套M3U8: ${nestedUrl}`);
        break;
      }
      
      // 否则是ts片段
      let tsUrl;
      if (trimmedLine.startsWith('http')) {
        tsUrl = trimmedLine;
      } else if (trimmedLine.startsWith('/')) {
        const urlObj = new URL(url);
        tsUrl = `${urlObj.protocol}//${urlObj.host}${trimmedLine}`;
      } else {
        tsUrl = baseUrl + trimmedLine;
      }
      tsUrls.push(tsUrl);
    }
  }
  
  // 如果是嵌套的m3u8，递归下载
  if (isNestedM3U8 && nestedUrl) {
    return downloadM3U8(nestedUrl, outputDir, filename, task);
  }
  
  if (tsUrls.length === 0) {
    throw new Error('未找到有效的视频片段');
  }
  
  console.log(`找到 ${tsUrls.length} 个TS片段`);
  
  const tsDir = path.join(outputDir, `${filename}_ts`);
  await mkdirp(tsDir);
  
  const downloadedFiles = [];
  let downloaded = 0;
  
  for (let i = 0; i < tsUrls.length; i++) {
    const tsUrl = tsUrls[i];
    const tsFile = path.join(tsDir, `segment_${String(i).padStart(5, '0')}.ts`);
    
    // 检查片段是否已下载
    if (fs.existsSync(tsFile)) {
      downloadedFiles.push(tsFile);
      downloaded++;
      continue;
    }
    
    try {
      const response = await axios.get(tsUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': url
        }
      });
      
      fs.writeFileSync(tsFile, response.data);
      downloadedFiles.push(tsFile);
      downloaded++;
      
      // 更新进度
      if (task) {
        task.currentProgress = Math.round((downloaded / tsUrls.length) * 100);
      }
    } catch (error) {
      console.error(`下载片段失败 ${i}: ${error.message}`);
    }
  }
  
  console.log(`成功下载 ${downloaded}/${tsUrls.length} 个片段`);
  
  // 合并ts文件
  const tsOutputFile = path.join(outputDir, `${filename}.ts`);
  const writeStream = fs.createWriteStream(tsOutputFile);
  
  for (const tsFile of downloadedFiles) {
    if (fs.existsSync(tsFile)) {
      const data = fs.readFileSync(tsFile);
      writeStream.write(data);
    }
  }
  
  writeStream.end();
  
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
  });
  
  // 清理临时文件
  fs.rmSync(tsDir, { recursive: true, force: true });
  
  // 转换为MP4
  const mp4File = path.join(outputDir, `${filename}.mp4`);
  try {
    if (task) {
      task.currentProgress = -1; // 表示正在转换
    }
    await convertTsToMp4(tsOutputFile, mp4File);
    
    // 删除TS文件
    fs.unlinkSync(tsOutputFile);
    
    task.files.push({
      name: `${filename}.mp4`,
      size: fs.statSync(mp4File).size,
      path: mp4File
    });
    
    return mp4File;
  } catch (error) {
    // 转换失败，保留TS文件
    console.error('转换MP4失败，保留TS文件:', error.message);
    task.files.push({
      name: `${filename}.ts`,
      size: fs.statSync(tsOutputFile).size,
      path: tsOutputFile
    });
    return tsOutputFile;
  }
}

// 直接下载视频文件
async function downloadDirect(url, outputDir, filename, task) {
  await mkdirp(outputDir);
  
  console.log(`直接下载: ${url}`);
  
  let ext;
  try {
    const urlPath = new URL(url).pathname;
    ext = path.extname(urlPath);
  } catch (e) {
    ext = '';
  }
  
  if (!ext) {
    ext = '.mp4';
  }
  
  const outputFile = path.join(outputDir, `${filename}${ext}`);
  console.log(`保存到: ${outputFile}`);
  
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 300000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  
  const totalLength = parseInt(response.headers['content-length'], 10);
  let downloadedLength = 0;
  
  const writer = fs.createWriteStream(outputFile);
  response.data.pipe(writer);
  
  // 跟踪下载进度
  response.data.on('data', (chunk) => {
    downloadedLength += chunk.length;
    if (task && totalLength) {
      task.currentProgress = Math.round((downloadedLength / totalLength) * 100);
    }
  });
  
  return new Promise((resolve, reject) => {
    writer.on('finish', () => {
      if (task) task.currentProgress = 100;
      task.files.push({
        name: `${filename}${ext}`,
        size: fs.statSync(outputFile).size,
        path: outputFile
      });
      resolve(outputFile);
    });
    writer.on('error', reject);
  });
}

// 确保下载目录存在
mkdirp.sync(DOWNLOADS_DIR);

// 启动服务器
app.listen(PORT, () => {
  console.log(`服务器已启动: http://localhost:${PORT}`);
});
