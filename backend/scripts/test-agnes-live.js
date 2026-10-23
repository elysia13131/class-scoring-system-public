/**
 * test-agnes-live.js —— Agnes 国内站（api.agnes-ai.cn）真实接口冒烟测试
 * 验证：文生图(2.5)、带参考图生图、生视频(2.5 新契约)→轮询→下载
 * 注意：视频免费档限速 1 个/分钟，脚本内只提交一次视频。
 * 用法：AGNES_API_KEY=<key> node scripts/test-agnes-live.js
 */
if (!process.env.AGNES_API_KEY) {
  console.error('请设置环境变量 AGNES_API_KEY（如：AGNES_API_KEY=sk-xxx node scripts/test-agnes-live.js）');
  process.exit(1);
}
process.env.AGNES_POLL_INTERVAL = '5000';

const mg = require('../agent/mediaGen');
const fs = require('fs');

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('AGNES_API_BASE =', require('../agent/mediaGen').AGNES_API_BASE);
  console.log('image model:', require('../agent/mediaGen').AGNES_IMAGE_MODEL, '| video model:', require('../agent/mediaGen').AGNES_VIDEO_MODEL);

  // 1. 文生图（2.5-flash）
  const img = await mg.generateImage({ prompt: 'a cute robot cat sitting on a desk, soft light, high detail', size: '1024x1024' });
  console.log('[1] 文生图 OK:', img.fileName, img.mime, img.size, 'bytes');
  if (!fs.existsSync(img.filePath) || fs.statSync(img.filePath).size === 0) throw new Error('图片未落盘');

  // 2. 带参考图生图（用刚生成的图 URL —— 直接传本地文件路径不行，需要公共 URL；
  //    这里用 data URI 验证参考图通道；后端走公共媒体 URL，链路一致）
  const b64 = fs.readFileSync(img.filePath).toString('base64');
  const dataUri = `data:image/png;base64,${b64}`;
  const img2 = await mg.generateImage({ prompt: 'keep the cat, change background to night city', size: '1024x1024', refImages: [dataUri] });
  console.log('[2] 图生图(参考图) OK:', img2.fileName, img2.size, 'bytes');
  if (!fs.existsSync(img2.filePath) || fs.statSync(img2.filePath).size === 0) throw new Error('参考图结果未落盘');

  // 3. 生视频（2.5-flash 新契约 text 模式）→ 轮询 → 下载
  console.log('   等待视频限速窗口（1 次/分钟，全局共享）...');
  await sleep(60_000);
  const { videoId, duration, modelName } = await mg.submitVideo({ prompt: 'a cat walking in the garden', seconds: 5 });
  console.log('[3] 生视频提交 OK: videoId =', String(videoId).substring(0, 30) + '...', '时长', duration, 's, model =', modelName);
  const deadline = Date.now() + 3 * 60 * 1000;
  let last = '';
  while (Date.now() < deadline) {
    const data = await mg.pollVideo(videoId, modelName);
    const st = String(data?.status || '');
    const prog = data?.progress ?? data?.internal_progress ?? '';
    if (`${st} ${prog}` !== last) { console.log(`   [轮询] status=${st} progress=${prog}${data?.error ? ' err=' + JSON.stringify(data.error).substring(0, 120) : ''}`); last = `${st} ${prog}`; }
    if (st === 'completed') {
      console.log('   [完成响应]', JSON.stringify(data).substring(0, 1200));
      const url = data?.metadata?.url || data?.url || data?.metadata?.video_url || data?.video_url;
      if (!url) throw new Error('完成但缺 url（响应字段见上方）');
      const vid = await mg.downloadVideo(url, 'agnes-video-test.mp4');
      const thumb = await mg.ensureVideoThumb(vid.filePath);
      console.log('[4] 视频完成 OK:', vid.fileName, vid.size, 'bytes | thumb:', thumb.thumbPath);
      if (!fs.existsSync(vid.filePath)) throw new Error('视频未落盘');
      process.exit(0);
    }
    if (st === 'failed') throw new Error('视频生成失败: ' + JSON.stringify(data?.error || data).substring(0, 200));
    await sleep(5000);
  }
  throw new Error('视频 3 分钟未完成（继续轮询中，非失败）');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
