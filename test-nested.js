const axios = require('axios');

async function test() {
  // 测试嵌套的m3u8
  const baseUrl = 'https://vip.ffzy-online1.com/20230102/20025_03cc86d0/';
  const nestedM3u8Url = baseUrl + '2000k/hls/mixed.m3u8';
  
  console.log('测试嵌套M3U8:', nestedM3u8Url);
  
  try {
    const response = await axios.get(nestedM3u8Url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    console.log('\n响应状态:', response.status);
    console.log('响应内容:');
    console.log(response.data);
  } catch (error) {
    console.log('请求失败:', error.message);
  }
}

test();
