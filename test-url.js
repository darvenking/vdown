const axios = require('axios');

async function test() {
  // 测试一个典型的share链接
  const shareUrl = 'https://vip.ffzy-online1.com/share/73b0224bc6bcf2334b92e18bf15ef7e9';
  
  console.log('测试share链接:', shareUrl);
  
  try {
    const response = await axios.get(shareUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const html = response.data;
    console.log('\nHTML内容:');
    console.log(html);
    
    // 提取m3u8 URL
    const urlMatch = html.match(/const\s+url\s*=\s*["']([^"']+\.m3u8[^"']*?)["']/);
    if (urlMatch && urlMatch[1]) {
      let m3u8Path = urlMatch[1];
      console.log('\n找到m3u8路径:', m3u8Path);
      
      const urlObj = new URL(shareUrl);
      const fullUrl = urlObj.protocol + '//' + urlObj.host + m3u8Path;
      console.log('完整URL:', fullUrl);
      
      // 测试m3u8 URL
      try {
        const m3u8Response = await axios.get(fullUrl, {
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        console.log('\nM3U8响应状态:', m3u8Response.status);
        console.log('M3U8内容:');
        console.log(m3u8Response.data.substring(0, 500));
      } catch (error) {
        console.log('\nM3U8请求失败:', error.message);
      }
    }
  } catch (error) {
    console.log('请求失败:', error.message);
  }
}

test();
