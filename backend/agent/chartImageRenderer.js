const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getDataPath } = require('../utils/dataPath');
const TEMP_DIR = getDataPath('chart_images');

function ensureTempDir() {
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }
}

const QUICKCHART_URL = 'https://quickchart.io/chart';

async function renderChartToImage(echartsConfig, width = 600, height = 400) {
  ensureTempDir();

  const chartPayload = {
    width,
    height,
    format: 'png',
    backgroundColor: '#ffffff',
    chart: echartsConfig,
    devicePixelRatio: 2
  };

  try {
    const response = await axios.post(QUICKCHART_URL, chartPayload, {
      responseType: 'arraybuffer',
      timeout: 15000
    });

    const fileName = `chart_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.png`;
    const filePath = path.join(TEMP_DIR, fileName);

    fs.writeFileSync(filePath, Buffer.from(response.data));
    console.log(`[ChartRenderer] 图表已渲染: ${filePath} (${response.data.length} bytes)`);

    return filePath;
  } catch (e) {
    console.error('[ChartRenderer] 渲染失败:', e.message);

    if (e.response) {
      const text = Buffer.from(e.response.data || '').toString().substring(0, 200);
      console.error('[ChartRenderer] 服务端响应:', text);
    }

    return null;
  }
}

function cleanupOldFiles(maxAgeMinutes = 60) {
  try {
    ensureTempDir();
    const files = fs.readdirSync(TEMP_DIR);
    const now = Date.now();
    for (const f of files) {
      const fp = path.join(TEMP_DIR, f);
      const stat = fs.statSync(fp);
      if (now - stat.mtimeMs > maxAgeMinutes * 60 * 1000) {
        fs.unlinkSync(fp);
      }
    }
  } catch (e) {}
}

module.exports = { renderChartToImage, cleanupOldFiles };
