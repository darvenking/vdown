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

// 配置项
const FFMPEG_PATH = process.env.FFMPEG_PATH || (
  process.platform === 'win32' 
    ? 'E:\\sdk\\ffmpeg\\bin\\ffmpeg.exe' 
    : '/usr/bin/ffmpeg'
);
const DOWNLOADS_DIR = process.env.DOWNLOADS_DIR || path.join(__dirname, 'downloads');
const DOWNLOAD_CONCURRENCY = parseInt(process.env.DOWNLOAD_CONCURRENCY) || 10;
const DB_FILE = path.join(__dirname, 'db.json');

// 简单的JSON数据库
class SimpleDB {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { tasks: [], history: [] };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const content = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(content);
      }
    } catch (error) {
      console.error('加载数据库失败:', error.message);
      this.data = { tasks: [], history: [] };
    }
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('保存数据库失败:', error.message);
    }
  }
}

const db = new SimpleDB(DB_FILE);

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

// 获取配置文件路径
function getConfigPath() {
  const configFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.json') && f.includes('kvideo'));
  if (configFiles.length === 0) {
    // 创建默认配置文件
    const defaultPath = path.join(__dirname, 'kvideo-settings.json');
    const defaultConfig = {
      settings: {
        sources: [],
        sortBy: "default",
        searchHistory: true,
        watchHistory: true
      }
    };
    fs.writeFileSync(defaultPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
    return defaultPath;
  }
  return path.join(__dirname, configFiles[0]);
}

// 加载视频源配置
function loadConfig() {
  const configPath = getConfigPath();
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return (config.settings.sources || []).filter(s => s.enabled !== false).sort((a, b) => (a.priority || 999) - (b.priority || 999));
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

// 下载管理器
class DownloadManager {
  constructor() {
    this.tasks = new Map();
  }

  // 创建任务
  async createTask(videoName, episodes) {
    const taskId = Date.now().toString();
    const downloadDir = path.join(DOWNLOADS_DIR, videoName.replace(/[<>:"/\\|?*]/g, '_'));
    
    const task = {
      id: taskId,
      videoName,
      downloadDir,
      status: 'pending',
      total: episodes.length,
      completed: 0,
      skipped: 0,
      failed: 0,
      current: '',
      currentProgress: 0,
      files: [],
      episodes: episodes.map(ep => ({
        ...ep,
        status: 'pending',
        progress: 0
      })),
      startTime: Date.now(),
      endTime: null
    };
    
    this.tasks.set(taskId, task);
    
    // 保存到数据库
    db.data.tasks.push(task);
    db.save();
    
    // 开始执行下载
    this.executeTask(taskId);
    
    return taskId;
  }

  // 执行任务
  async executeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    
    task.status = 'running';
    await this.updateTask(task);
    
    for (let i = 0; i < task.episodes.length; i++) {
      const episode = task.episodes[i];
      const safeName = episode.name.replace(/[<>:"/\\|?*]/g, '_');
      
      // 检查文件是否已存在
      const existingFiles = fs.existsSync(task.downloadDir) ? fs.readdirSync(task.downloadDir) : [];
      const isDownloaded = existingFiles.some(f => f.startsWith(safeName) && (f.endsWith('.ts') || f.endsWith('.mp4')));
      
      if (isDownloaded) {
        console.log(`跳过已下载: ${episode.name}`);
        episode.status = 'skipped';
        task.current = `${episode.name} (已存在)`;
        task.skipped++;
        task.completed++;
        await this.updateTask(task);
        continue;
      }
      
      episode.status = 'downloading';
      task.current = episode.name;
      task.currentProgress = 0;
      await this.updateTask(task);
      
      try {
        console.log(`\n开始下载: ${episode.name}`);
        const realUrl = await getRealUrl(episode.url);
        const isM3U8 = realUrl.includes('.m3u8');
        
        if (isM3U8) {
          await downloadM3U8(realUrl, task.downloadDir, safeName, task);
        } else {
          await downloadDirect(realUrl, task.downloadDir, safeName, task);
        }
        
        episode.status = 'completed';
        task.completed++;
        task.currentProgress = 100;
      } catch (error) {
        episode.status = 'failed';
        task.failed++;
        console.error(`下载失败 ${episode.name}: ${error.message}`);
      }
      
      await this.updateTask(task);
    }
    
    task.status = 'completed';
    task.current = '';
    task.currentProgress = 0;
    task.endTime = Date.now();
    await this.updateTask(task);
    
    // 添加到历史记录
    db.data.history.push({
      id: task.id,
      videoName: task.videoName,
      total: task.total,
      completed: task.completed,
      skipped: task.skipped,
      failed: task.failed,
      startTime: task.startTime,
      endTime: task.endTime
    });
    db.save();
  }

  // 更新任务状态
  async updateTask(task) {
    const index = db.data.tasks.findIndex(t => t.id === task.id);
    if (index !== -1) {
      db.data.tasks[index] = task;
      db.save();
    }
  }

  // 获取任务状态
  getTask(taskId) {
    return this.tasks.get(taskId);
  }

  // 获取所有任务
  getAllTasks() {
    return Array.from(this.tasks.values());
  }

  // 暂停任务
  async pauseTask(taskId) {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'running') {
      task.status = 'paused';
      await this.updateTask(task);
    }
  }

  // 恢复任务
  async resumeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (task && task.status === 'paused') {
      task.status = 'running';
      await this.updateTask(task);
      this.executeTask(taskId);
    }
  }

  // 删除任务
  async deleteTask(taskId) {
    this.tasks.delete(taskId);
    db.data.tasks = db.data.tasks.filter(t => t.id !== taskId);
    db.save();
  }

  // 获取历史记录
  getHistory() {
    return db.data.history;
  }
}

const downloadManager = new DownloadManager();

// API: 开始下载任务
app.post('/api/download', async (req, res) => {
  const { videoName, episodes } = req.body;
  
  if (!videoName || !episodes || episodes.length === 0) {
    return res.status(400).json({ success: false, error: '缺少参数' });
  }
  
  try {
    const taskId = await downloadManager.createTask(videoName, episodes);
    res.json({ success: true, taskId });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 获取下载任务状态
app.get('/api/download/status/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = downloadManager.getTask(taskId);
  
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }
  
  res.json({ success: true, task });
});

// API: 获取所有下载任务
app.get('/api/download/tasks', (req, res) => {
  const tasks = downloadManager.getAllTasks();
  res.json({ success: true, tasks });
});

// API: 暂停下载任务
app.post('/api/download/pause/:taskId', async (req, res) => {
  const { taskId } = req.params;
  await downloadManager.pauseTask(taskId);
  res.json({ success: true, message: '任务已暂停' });
});

// API: 恢复下载任务
app.post('/api/download/resume/:taskId', async (req, res) => {
  const { taskId } = req.params;
  await downloadManager.resumeTask(taskId);
  res.json({ success: true, message: '任务已恢复' });
});

// API: 删除下载任务
app.delete('/api/download/:taskId', async (req, res) => {
  const { taskId } = req.params;
  await downloadManager.deleteTask(taskId);
  res.json({ success: true, message: '任务已删除' });
});

// API: 获取下载历史
app.get('/api/download/history', (req, res) => {
  const history = downloadManager.getHistory();
  res.json({ success: true, history });
});

// API: 获取配置
app.get('/api/config', (req, res) => {
  const sources = loadConfig();
  res.json({
    success: true,
    config: {
      port: PORT,
      ffmpegPath: FFMPEG_PATH,
      downloadsDir: DOWNLOADS_DIR,
      downloadConcurrency: DOWNLOAD_CONCURRENCY,
      sourcesCount: sources.length
    }
  });
});

// API: 更新配置
app.post('/api/config', (req, res) => {
  const { downloadConcurrency } = req.body;
  
  if (downloadConcurrency !== undefined) {
    const value = parseInt(downloadConcurrency);
    if (value > 0 && value <= 50) {
      // 更新内存中的配置
      global.downloadConcurrency = value;
      res.json({ success: true, message: '配置已更新', downloadConcurrency: value });
    } else {
      res.status(400).json({ success: false, error: '并发数必须在1-50之间' });
    }
  } else {
    res.status(400).json({ success: false, error: '缺少配置项' });
  }
});

// API: 获取视频源列表
app.get('/api/sources', (req, res) => {
  try {
    const sources = loadConfig();
    res.json({ success: true, sources });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 保存视频源列表
app.post('/api/sources', (req, res) => {
  const { sources } = req.body;
  
  if (!sources || !Array.isArray(sources)) {
    return res.status(400).json({ success: false, error: '无效的数据' });
  }
  
  try {
    const configPath = getConfigPath();
    const config = {
      settings: {
        sources: sources,
        sortBy: "default",
        searchHistory: true,
        watchHistory: true
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ success: true, message: '视频源已保存' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 导出视频源配置
app.get('/api/sources/export', (req, res) => {
  try {
    const sources = loadConfig();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=sources.json');
    res.json({ settings: { sources } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 导入视频源配置
app.post('/api/sources/import', (req, res) => {
  const { sources } = req.body;
  
  if (!sources || !Array.isArray(sources)) {
    return res.status(400).json({ success: false, error: '无效的数据格式' });
  }
  
  try {
    // 验证数据格式
    for (const source of sources) {
      if (!source.id || !source.name || !source.baseUrl) {
        return res.status(400).json({ success: false, error: '数据格式错误：缺少必要字段' });
      }
    }
    
    const configPath = getConfigPath();
    const config = {
      settings: {
        sources: sources,
        sortBy: "default",
        searchHistory: true,
        watchHistory: true
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ success: true, message: `成功导入 ${sources.length} 个视频源` });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 添加单个视频源
app.post('/api/sources/add', (req, res) => {
  const { source } = req.body;
  
  if (!source || !source.id || !source.name || !source.baseUrl) {
    return res.status(400).json({ success: false, error: '缺少必要字段' });
  }
  
  try {
    const sources = loadConfig();
    
    // 检查ID是否重复
    if (sources.some(s => s.id === source.id)) {
      return res.status(400).json({ success: false, error: '视频源ID已存在' });
    }
    
    sources.push({
      ...source,
      enabled: source.enabled !== false,
      priority: source.priority || sources.length + 1
    });
    
    const configPath = getConfigPath();
    const config = {
      settings: {
        sources: sources,
        sortBy: "default",
        searchHistory: true,
        watchHistory: true
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ success: true, message: '视频源已添加' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 删除视频源
app.delete('/api/sources/:id', (req, res) => {
  const { id } = req.params;
  
  try {
    const sources = loadConfig();
    const filtered = sources.filter(s => s.id !== id);
    
    if (filtered.length === sources.length) {
      return res.status(404).json({ success: false, error: '视频源不存在' });
    }
    
    const configPath = getConfigPath();
    const config = {
      settings: {
        sources: filtered,
        sortBy: "default",
        searchHistory: true,
        watchHistory: true
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ success: true, message: '视频源已删除' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// API: 更新视频源
app.put('/api/sources/:id', (req, res) => {
  const { id } = req.params;
  const { source } = req.body;
  
  try {
    const sources = loadConfig();
    const index = sources.findIndex(s => s.id === id);
    
    if (index === -1) {
      return res.status(404).json({ success: false, error: '视频源不存在' });
    }
    
    sources[index] = { ...sources[index], ...source };
    
    const configPath = getConfigPath();
    const config = {
      settings: {
        sources: sources,
        sortBy: "default",
        searchHistory: true,
        watchHistory: true
      }
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    res.json({ success: true, message: '视频源已更新' });
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
  
  const downloadedFiles = new Array(tsUrls.length);
  let downloaded = 0;
  let failed = 0;
  
  // 并发下载TS片段
  const CONCURRENCY = global.downloadConcurrency || DOWNLOAD_CONCURRENCY; // 使用配置的并发数
  
  async function downloadSegment(index) {
    const tsUrl = tsUrls[index];
    const tsFile = path.join(tsDir, `segment_${String(index).padStart(5, '0')}.ts`);
    
    // 检查片段是否已下载
    if (fs.existsSync(tsFile)) {
      downloadedFiles[index] = tsFile;
      downloaded++;
      return;
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
      downloadedFiles[index] = tsFile;
      downloaded++;
      
      // 更新进度
      if (task) {
        task.currentProgress = Math.round((downloaded / tsUrls.length) * 100);
      }
    } catch (error) {
      failed++;
      console.error(`下载片段 ${index} 失败: ${error.message}`);
    }
  }
  
  // 分批并发下载
  for (let i = 0; i < tsUrls.length; i += CONCURRENCY) {
    const batch = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, tsUrls.length); j++) {
      batch.push(downloadSegment(j));
    }
    await Promise.all(batch);
  }
  
  console.log(`成功下载 ${downloaded}/${tsUrls.length} 个片段，失败 ${failed} 个`);
  
  // 检查是否有失败的片段
  if (failed > 0) {
    console.log(`警告: ${failed} 个片段下载失败`);
  }
  
  // 按顺序合并ts文件，跳过失败的片段
  const tsOutputFile = path.join(outputDir, `${filename}.ts`);
  const writeStream = fs.createWriteStream(tsOutputFile);
  
  for (let i = 0; i < downloadedFiles.length; i++) {
    if (downloadedFiles[i]) {
      const data = fs.readFileSync(downloadedFiles[i]);
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
  console.log(`下载并发数: ${DOWNLOAD_CONCURRENCY}`);
  console.log(`下载目录: ${DOWNLOADS_DIR}`);
  console.log(`FFmpeg路径: ${FFMPEG_PATH}`);
});
