const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const iconv = require('iconv-lite');
const { mkdirp } = require('mkdirp');

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
      
      // 尝试UTF-8解码（大多数API使用UTF-8）
      try {
        const utf8Text = buffer.toString('utf-8');
        const data = JSON.parse(utf8Text);
        if (data && typeof data === 'object') return data;
      } catch {}
      
      // 尝试GBK解码
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

// 搜索视频
async function searchVideo(keyword, sources) {
  const results = [];
  
  for (const source of sources.slice(0, 3)) { // 只测试前3个源
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
      console.log(chalk.gray(`  跳过源 ${source.name}: ${error.message}`));
    }
  }
  
  return results;
}

// 获取视频详情
async function getVideoDetail(sourceBaseUrl, vodId) {
  const url = `${sourceBaseUrl}?ac=detail&ids=${vodId}`;
  const data = await fetchFromAPI(url);
  
  if (data.code === 1 && data.list && data.list.length > 0) {
    return data.list[0];
  }
  throw new Error('获取视频详情失败');
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
          url: parts.slice(1).join('$') // URL中可能包含$
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

// 从share链接获取实际的m3u8 URL
async function getRealUrl(url) {
  // 如果不是share链接，直接返回
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
    
    // 从HTML中提取m3u8 URL
    const urlMatch = html.match(/const\s+url\s*=\s*["']([^"']+\.m3u8[^"']*?)["']/);
    if (urlMatch && urlMatch[1]) {
      let m3u8Path = urlMatch[1];
      
      // 构建完整的URL
      const urlObj = new URL(url);
      if (m3u8Path.startsWith('/')) {
        return `${urlObj.protocol}//${urlObj.host}${m3u8Path}`;
      } else {
        // 相对路径
        const basePath = url.substring(0, url.lastIndexOf('/'));
        return `${basePath}/${m3u8Path}`;
      }
    }
    
    // 如果没有找到m3u8 URL，返回原始URL
    return url;
  } catch (error) {
    // 如果获取失败，返回原始URL
    return url;
  }
}

// 测试主函数
async function test() {
  console.log(chalk.bold.cyan('\n=== 视频下载工具测试 ===\n'));
  
  try {
    // 加载配置
    const sources = loadConfig();
    console.log(chalk.green(`✓ 已加载 ${sources.length} 个视频源\n`));
    
    // 测试搜索
    const keyword = '你的名字';
    console.log(chalk.yellow(`正在搜索: ${keyword}\n`));
    
    const searchResults = await searchVideo(keyword, sources);
    
    if (searchResults.length === 0) {
      console.log(chalk.red('未找到相关视频'));
      return;
    }
    
    // 去重并显示搜索结果
    const uniqueResults = [];
    const seen = new Set();
    
    for (const result of searchResults) {
      const key = `${result.vod_name}_${result.vod_year || ''}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueResults.push(result);
      }
    }
    
    console.log(chalk.green(`找到 ${uniqueResults.length} 个视频:\n`));
    
    uniqueResults.forEach((v, i) => {
      console.log(chalk.cyan(`${i + 1}. ${v.vod_name} (${v.vod_year || '未知年份'}) - ${v.sourceName} [${v.vod_remarks || ''}]`));
    });
    
    // 选择第一个视频
    const video = uniqueResults[0];
    console.log(chalk.yellow(`\n正在获取视频详情: ${video.vod_name}\n`));
    
    // 获取视频详情
    const detail = await getVideoDetail(video.sourceBaseUrl, video.vod_id);
    
    console.log(chalk.bold(`\n${detail.vod_name}`));
    if (detail.vod_year) console.log(chalk.gray(`年份: ${detail.vod_year}`));
    if (detail.vod_area) console.log(chalk.gray(`地区: ${detail.vod_area}`));
    if (detail.vod_director) console.log(chalk.gray(`导演: ${detail.vod_director}`));
    if (detail.vod_actor) console.log(chalk.gray(`演员: ${detail.vod_actor}`));
    if (detail.vod_score) console.log(chalk.gray(`评分: ${detail.vod_score}`));
    
    // 解析播放链接
    const playSources = parsePlayUrls(detail.vod_play_from, detail.vod_play_url);
    
    if (playSources.length === 0) {
      console.log(chalk.red('\n未找到可下载的视频源'));
      return;
    }
    
    console.log(chalk.green(`\n找到 ${playSources.length} 个播放源:\n`));
    
    playSources.forEach((s, i) => {
      console.log(chalk.cyan(`${i + 1}. ${s.sourceName} (${s.episodes.length} 集)`));
      s.episodes.slice(0, 3).forEach((ep, j) => {
        console.log(chalk.gray(`   ${j + 1}. ${ep.name}: ${ep.url.substring(0, 60)}...`));
      });
      if (s.episodes.length > 3) {
        console.log(chalk.gray(`   ... 还有 ${s.episodes.length - 3} 集`));
      }
    });
    
    // 测试share链接解析
    console.log(chalk.yellow('\n测试share链接解析...\n'));
    
    const shareUrl = 'https://vip.ffzy-online1.com/share/73b0224bc6bcf2334b92e18bf15ef7e9';
    const realUrl = await getRealUrl(shareUrl);
    
    console.log(chalk.gray(`Share URL: ${shareUrl}`));
    console.log(chalk.green(`Real URL: ${realUrl}`));
    
    console.log(chalk.bold.cyan('\n=== 测试完成 ===\n'));
    
  } catch (error) {
    console.error(chalk.red(`\n错误: ${error.message}`));
    console.error(error.stack);
  }
}

// 运行测试
test();
