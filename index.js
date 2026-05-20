const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const inquirer = require('inquirer');
const iconv = require('iconv-lite');
const { program } = require('commander');
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
      
      // 尝试GB18030解码
      try {
        const gb18030Text = iconv.decode(buffer, 'gb18030');
        const data = JSON.parse(gb18030Text);
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
  
  for (const source of sources) {
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
      // 忽略单个源的错误，继续尝试其他源
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

// 下载m3u8文件
async function downloadM3U8(url, outputDir, filename, onProgress) {
  // 获取真实的m3u8 URL
  const m3u8Url = await getRealUrl(url);
  
  try {
    // 获取m3u8内容
    const m3u8Response = await axios.get(m3u8Url, {
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': m3u8Url
      }
    });
    
    let m3u8Content = m3u8Response.data;
    
    // 解析m3u8获取ts片段URL
    const lines = m3u8Content.split('\n');
    const tsUrls = [];
    let isM3U8 = false;
    let baseUrl = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1);
    
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine === '#EXTM3U') {
        isM3U8 = true;
        continue;
      }
      
      if (trimmedLine.startsWith('#')) continue;
      
      if (trimmedLine && isM3U8) {
        let tsUrl;
        if (trimmedLine.startsWith('http')) {
          tsUrl = trimmedLine;
        } else if (trimmedLine.startsWith('/')) {
          const urlObj = new URL(m3u8Url);
          tsUrl = `${urlObj.protocol}//${urlObj.host}${trimmedLine}`;
        } else {
          tsUrl = baseUrl + trimmedLine;
        }
        tsUrls.push(tsUrl);
      }
    }
    
    if (tsUrls.length === 0) {
      // 可能是嵌套的m3u8，尝试获取真正的m3u8
      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine.startsWith('#') && trimmedLine.endsWith('.m3u8')) {
          let realM3u8Url;
          if (trimmedLine.startsWith('http')) {
            realM3u8Url = trimmedLine;
          } else if (trimmedLine.startsWith('/')) {
            const urlObj = new URL(m3u8Url);
            realM3u8Url = `${urlObj.protocol}//${urlObj.host}${trimmedLine}`;
          } else {
            realM3u8Url = baseUrl + trimmedLine;
          }
          return downloadM3U8(realM3u8Url, outputDir, filename, onProgress);
        }
      }
      throw new Error('未找到有效的视频片段');
    }
    
    // 创建输出目录
    await mkdirp(outputDir);
    
    // 下载所有ts片段
    const total = tsUrls.length;
    let downloaded = 0;
    const tsDir = path.join(outputDir, `${filename}_ts`);
    await mkdirp(tsDir);
    
    for (let i = 0; i < tsUrls.length; i++) {
      const tsUrl = tsUrls[i];
      const tsFile = path.join(tsDir, `segment_${String(i).padStart(5, '0')}.ts`);
      
      try {
        const response = await axios.get(tsUrl, {
          responseType: 'arraybuffer',
          timeout: 60000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Referer': m3u8Url
          }
        });
        
        fs.writeFileSync(tsFile, response.data);
        downloaded++;
        
        if (onProgress) {
          onProgress(downloaded, total);
        }
      } catch (error) {
        // 单个片段下载失败，继续尝试其他片段
      }
    }
    
    // 尝试合并ts文件
    const outputFile = path.join(outputDir, `${filename}.ts`);
    const writeStream = fs.createWriteStream(outputFile);
    
    for (let i = 0; i < downloaded; i++) {
      const tsFile = path.join(tsDir, `segment_${String(i).padStart(5, '0')}.ts`);
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
    
    return outputFile;
  } catch (error) {
    throw new Error(`下载失败: ${error.message}`);
  }
}

// 直接下载视频文件（非m3u8格式）
async function downloadVideo(url, outputDir, filename) {
  await mkdirp(outputDir);
  
  const ext = path.extname(new URL(url).pathname) || '.mp4';
  const outputFile = path.join(outputDir, `${filename}${ext}`);
  
  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 300000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });
  
  const writer = fs.createWriteStream(outputFile);
  response.data.pipe(writer);
  
  return new Promise((resolve, reject) => {
    writer.on('finish', () => resolve(outputFile));
    writer.on('error', reject);
  });
}

// 主函数
async function main() {
  console.log(chalk.bold.cyan('\n=== 视频下载工具 ===\n'));
  
  try {
    // 加载配置
    const sources = loadConfig();
    console.log(chalk.green(`✓ 已加载 ${sources.length} 个视频源\n`));
  
  // 搜索视频
  const { keyword } = await inquirer.prompt([{
    type: 'input',
    name: 'keyword',
    message: '请输入要搜索的视频名称:',
    validate: input => input.trim() ? true : '请输入搜索关键词'
  }]);
  
  console.log(chalk.yellow('\n正在搜索...\n'));
  
  const searchResults = await searchVideo(keyword.trim(), sources);
  
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
  
  const { selectedVideo } = await inquirer.prompt([{
    type: 'list',
    name: 'selectedVideo',
    message: '请选择视频:',
    choices: uniqueResults.map((v, i) => ({
      name: `${i + 1}. ${v.vod_name} (${v.vod_year || '未知年份'}) - ${v.sourceName} [${v.vod_remarks || ''}]`,
      value: i
    })),
    pageSize: 20
  }]);
  
  const video = uniqueResults[selectedVideo];
  
  console.log(chalk.yellow('\n正在获取视频详情...\n'));
  
  // 获取视频详情
  const detail = await getVideoDetail(video.sourceBaseUrl, video.vod_id);
  
  console.log(chalk.bold(`\n${detail.vod_name}`));
  if (detail.vod_year) console.log(chalk.gray(`年份: ${detail.vod_year}`));
  if (detail.vod_area) console.log(chalk.gray(`地区: ${detail.vod_area}`));
  if (detail.vod_director) console.log(chalk.gray(`导演: ${detail.vod_director}`));
  if (detail.vod_actor) console.log(chalk.gray(`演员: ${detail.vod_actor}`));
  if (detail.vod_score) console.log(chalk.gray(`评分: ${detail.vod_score}`));
  if (detail.vod_content) {
    const content = detail.vod_content.replace(/<[^>]+>/g, '').substring(0, 200);
    console.log(chalk.gray(`简介: ${content}...`));
  }
  
  // 解析播放链接
  const playSources = parsePlayUrls(detail.vod_play_from, detail.vod_play_url);
  
  if (playSources.length === 0) {
    console.log(chalk.red('\n未找到可下载的视频源'));
    return;
  }
  
  // 选择播放源
  let selectedSource;
  if (playSources.length === 1) {
    selectedSource = playSources[0];
  } else {
    const { sourceIndex } = await inquirer.prompt([{
      type: 'list',
      name: 'sourceIndex',
      message: '请选择播放源:',
      choices: playSources.map((s, i) => ({
        name: `${s.sourceName} (${s.episodes.length} 集)`,
        value: i
      }))
    }]);
    selectedSource = playSources[sourceIndex];
  }
  
  console.log(chalk.green(`\n已选择播放源: ${selectedSource.sourceName}`));
  console.log(chalk.green(`共 ${selectedSource.episodes.length} 集\n`));
  
  // 选择剧集
  const episodes = selectedSource.episodes;
  let selectedEpisodes = [];
  
  if (episodes.length === 1) {
    selectedEpisodes = [0];
    console.log(chalk.green('只有1集，自动选择'));
  } else {
    const { episodeChoice } = await inquirer.prompt([{
      type: 'list',
      name: 'episodeChoice',
      message: '请选择剧集:',
      choices: [
        { name: '下载全部剧集', value: 'all' },
        { name: '选择特定剧集', value: 'select' },
        { name: '输入剧集范围', value: 'range' }
      ]
    }]);
    
    if (episodeChoice === 'all') {
      selectedEpisodes = episodes.map((_, i) => i);
    } else if (episodeChoice === 'select') {
      const { episodes: selected } = await inquirer.prompt([{
        type: 'checkbox',
        name: 'episodes',
        message: '选择要下载的剧集 (空格选择，回车确认):',
        choices: episodes.map((ep, i) => ({
          name: `${ep.name}`,
          value: i,
          checked: false
        })),
        pageSize: 30
      }]);
      selectedEpisodes = selected;
    } else {
      const { rangeInput } = await inquirer.prompt([{
        type: 'input',
        name: 'rangeInput',
        message: '输入剧集范围 (例如: 1-10 或 1,3,5,7):',
        validate: input => {
          if (/^[\d,\-\s]+$/.test(input.trim())) return true;
          return '请输入有效的范围格式';
        }
      }]);
      
      const rangeStr = rangeInput.trim();
      if (rangeStr.includes('-')) {
        const [start, end] = rangeStr.split('-').map(Number);
        for (let i = start - 1; i < end && i < episodes.length; i++) {
          if (i >= 0) selectedEpisodes.push(i);
        }
      } else {
        const indices = rangeStr.split(',').map(s => parseInt(s.trim()) - 1);
        selectedEpisodes = indices.filter(i => i >= 0 && i < episodes.length);
      }
    }
  }
  
  if (selectedEpisodes.length === 0) {
    console.log(chalk.red('未选择任何剧集'));
    return;
  }
  
  console.log(chalk.green(`\n已选择 ${selectedEpisodes.length} 集\n`));
  
  // 创建下载目录
  const downloadDir = path.join(__dirname, 'downloads', detail.vod_name.replace(/[<>:"/\\|?*]/g, '_'));
  
  // 下载选中的剧集
  let successCount = 0;
  let failCount = 0;
  
  for (let i = 0; i < selectedEpisodes.length; i++) {
    const epIndex = selectedEpisodes[i];
    const episode = episodes[epIndex];
    
    console.log(chalk.cyan(`\n[${i + 1}/${selectedEpisodes.length}] 正在下载: ${episode.name}`));
    
    try {
      const isM3U8 = episode.url.includes('.m3u8');
      let outputFile;
      
      if (isM3U8) {
        outputFile = await downloadM3U8(
          episode.url,
          downloadDir,
          episode.name.replace(/[<>:"/\\|?*]/g, '_'),
          (downloaded, total) => {
            process.stdout.write(chalk.gray(`\r  进度: ${downloaded}/${total} 片段`));
          }
        );
      } else {
        outputFile = await downloadVideo(
          episode.url,
          downloadDir,
          episode.name.replace(/[<>:"/\\|?*]/g, '_')
        );
      }
      
      console.log(chalk.green(`\n  ✓ 下载完成: ${outputFile}`));
      successCount++;
    } catch (error) {
      console.log(chalk.red(`\n  ✗ 下载失败: ${error.message}`));
      failCount++;
    }
  }
  
  console.log(chalk.bold.cyan('\n=== 下载完成 ==='));
  console.log(chalk.green(`成功: ${successCount} 集`));
  if (failCount > 0) {
    console.log(chalk.red(`失败: ${failCount} 集`));
  }
  console.log(chalk.gray(`保存位置: ${downloadDir}`));
  
  } catch (error) {
    console.error(chalk.red(`\n错误: ${error.message}`));
    process.exit(1);
  }
}

// 运行主函数
main().catch(error => {
  console.error(chalk.red(`\n程序错误: ${error.message}`));
  process.exit(1);
});
