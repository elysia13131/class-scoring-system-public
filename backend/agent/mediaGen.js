/**
 * mediaGen.js —— Agnes AI 生图/生视频异步任务管理器（后端进程内常驻）
 *
 * 为什么异步：生图 10-60 秒、生视频 1-5 分钟，AI 回合不能干等——
 * 工具调用只负责「提交任务 + 立即回话」，完成由本管理器后台轮询驱动：
 *   submit() 落任务 → 后台 worker 调 Agnes API（生图同步请求 / 生视频轮询）
 *   → 完成时 onComplete(filePath) → 上层注册媒体 + 激活 AI 发送结果。
 *
 * Agnes AI API（官方文档核对，2026-07；国内站实测 2026-09）：
 *   - 国内站（key 有效）：{base}=https://api.agnes-ai.cn
 *   - 图片  POST {base}/v1/images/generations   模型 agnes-image-2.1-flash / agnes-image-2.5-flash
 *   - 视频  POST {base}/v1/videos               模型 agnes-video-v2.0 / agnes-video-2.5-flash（异步）
 *   - 视频轮询 GET {base}/agnesapi?video_id=xxx
 *   - 鉴权：Authorization: Bearer <AGNES_API_KEY>
 *
 * 环境变量：
 *   AGNES_API_KEY        必填（未配置 → 工具返回「未启用」，功能整体关闭）
 *   AGNES_API_BASE       默认 https://api.agnes-ai.cn（国内站；国际站为 apihub.agnes-ai.com）
 *   AGNES_IMAGE_MODEL    默认 agnes-image-2.5-flash（接入方式与 2.1 兼容）
 *   AGNES_VIDEO_MODEL    默认 agnes-video-2.5-flash（mode/seconds/720P 新契约；v2.0 旧契约自动适配）
 *   AGNES_POLL_INTERVAL  视频轮询间隔 ms（默认 10000）
 *   AGNES_JOB_TTL_MS     任务超时（默认 30 分钟）
 *   AGNES_MAX_CONCURRENT 生图/生视频并发上限（默认 2，超出进 FIFO 队列等待）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const axios = require('axios');
const { getDataPath } = require('../utils/dataPath');

const AGNES_API_BASE = (process.env.AGNES_API_BASE || 'https://api.agnes-ai.cn').replace(/\/+$/, '');
const AGNES_API_KEY = process.env.AGNES_API_KEY || '';
const AGNES_IMAGE_MODEL = process.env.AGNES_IMAGE_MODEL || 'agnes-image-2.5-flash';
const AGNES_VIDEO_MODEL = process.env.AGNES_VIDEO_MODEL || 'agnes-video-2.5-flash';
const POLL_INTERVAL_MS = Number(process.env.AGNES_POLL_INTERVAL || 10000);
const JOB_TTL_MS = Number(process.env.AGNES_JOB_TTL_MS || 30 * 60 * 1000);
const BACKOFF_BASE_MS = Number(process.env.AGNES_BACKOFF_BASE_MS || 5000);      // 限流回队退避基数（指数翻倍，上限 60s）
const POLL_RETRY_MS = Number(process.env.AGNES_POLL_RETRY_MS || 10000);         // 轮询被限流时的等待
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;   // 结果文件上限 100MB
const MEDIA_DIR = getDataPath('uploads');       // 与入站媒体同目录（24h 磁盘 GC 一致）

/** Agnes API 统一请求（Bearer 鉴权；GET 不带 body） */
async function agnesRequest(apiPath, { method = 'POST', body } = {}) {
  if (!AGNES_API_KEY) throw new Error('AGNES_API_KEY 未配置');
  const isGet = method.toUpperCase() === 'GET';
  const res = await axios({
    method: isGet ? 'GET' : 'POST',
    url: `${AGNES_API_BASE}${apiPath}`,
    timeout: 120000,                       // 生图请求本身可能耗时较长
    headers: {
      Authorization: `Bearer ${AGNES_API_KEY}`,
      ...(isGet ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(isGet ? {} : { data: body }),
  });
  return res.data;
}

/** 判读是否为限流/并发超限错误（Agnes 官方控制并发 → 我们只退回队列等待） */
function isRateLimited(err) {
  const status = err?.response?.status;
  if (status === 429 || status === 503) return true;
  const msg = String(err?.message || '') + ' ' + String(err?.response?.data?.error || err?.response?.data?.message || '');
  return /(rate\s?limit|too many|concurr|limit exceeded|限流|并发|排队|繁忙|overload)/i.test(msg);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** 生图：同步请求，返回本地落盘文件 { filePath, fileName, mime, size }
 *  refImages：可选参考图 URL 数组（图生图/多图合成，来自上下文她发来的图片） */
async function generateImage({ prompt, size, refImages }) {
  const refs = Array.isArray(refImages) ? refImages.map(u => String(u).trim()).filter(Boolean) : [];
  const body = {
    model: AGNES_IMAGE_MODEL,
    prompt: String(prompt || '').trim(),
    size: size || '1024x1024',
    // 官方要求 response_format 必须放 extra_body（顶层会被忽略/报错）
    extra_body: { response_format: 'url' },
  };
  if (refs.length > 0) body.extra_body.image = refs;   // 图生图/多图合成
  const data = await agnesRequest('/v1/images/generations', { body });
  const item = (data?.data && data.data[0]) || {};
  let buf = null;
  let ext = 'png';
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, 'base64');
  } else if (item.url) {
    const dl = await axios.get(item.url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: MAX_DOWNLOAD_BYTES });
    buf = Buffer.from(dl.data);
    ext = path.extname(new URL(item.url).pathname).replace('.', '').toLowerCase() || 'png';
  }
  if (!buf) throw new Error(`生图接口未返回图片数据: ${JSON.stringify(data).substring(0, 200)}`);
  if (!/^(png|jpg|jpeg|gif|webp)$/.test(ext)) ext = 'png';
  return saveResult(buf, `agnes-img-${Date.now()}.${ext}`, ext === 'png' ? 'image/png' : `image/${ext === 'jpg' ? 'jpeg' : ext}`);
}

/** 生视频：创建异步任务，返回 { videoId, duration, modelName }
 *  refImage：可选单张参考图 URL（图生视频）
 *  契约按模型分支：
 *   - agnes-video-v2.0：num_frames（≤441 且 8n+1）+ frame_rate + 顶层 image 图生视频
 *   - agnes-video-2.5-flash：mode(text/reference) + seconds 字符串(4-12) + size 固定 "720P"
 *     + aspect_ratio；图生视频 → mode=reference + images[]（参考图 URL 数组，≤5） */
async function submitVideo({ prompt, seconds, refImage }) {
  const ref = String(refImage || '').trim();
  const is25 = /2\.5/.test(AGNES_VIDEO_MODEL);
  let data;
  let duration;
  if (is25) {
    const secs = Math.max(4, Math.min(12, Math.round(Number(seconds) || 5)));
    const body = {
      model: AGNES_VIDEO_MODEL,
      prompt: String(prompt || '').trim(),
      mode: ref ? 'reference' : 'text',
      seconds: String(secs),
      size: '720P',
      aspect_ratio: '16:9',
    };
    if (ref) body.images = [ref];   // reference 模式参考图：公网 URL 或裸 base64（最多 5 张；data: 前缀不被接受）
    data = await agnesRequest('/v1/videos', { body });
    duration = secs;
  } else {
    // num_frames 必须 ≤441 且满足 8n+1；时长映射官方推荐（24fps）
    const frames = { 3: 81, 5: 121, 10: 241, 18: 441 }[Number(seconds) || 5] || 121;
    const body = {
      model: AGNES_VIDEO_MODEL,
      prompt: String(prompt || '').trim(),
      width: 1152,
      height: 768,
      num_frames: frames,
      frame_rate: 24,
    };
    if (ref) body.image = ref;   // 图生视频：需公共可访问的图片 URL
    data = await agnesRequest('/v1/videos', { body });
    duration = Math.round(frames / 24);
  }
  const videoId = data?.video_id || data?.task_id || data?.id;
  if (!videoId) throw new Error(`创建视频任务失败: ${JSON.stringify(data).substring(0, 200)}`);
  return { videoId: String(videoId), duration, modelName: AGNES_VIDEO_MODEL };
}

/** 视频轮询：返回 { status, metadata:{url}, error }；2.5 系列带 model_name（reference/keyframe 必须） */
async function pollVideo(videoId, modelName) {
  const qs = `video_id=${encodeURIComponent(videoId)}`
    + (/2\.5/.test(String(modelName || '')) ? `&model_name=${encodeURIComponent(String(modelName))}` : '');
  const data = await agnesRequest(`/agnesapi?${qs}`, { method: 'GET' });
  return data;
}

/** 下载视频结果并落盘 */
async function downloadVideo(videoUrl, fileName) {
  const dl = await axios.get(videoUrl, { responseType: 'arraybuffer', timeout: 120000, maxContentLength: MAX_DOWNLOAD_BYTES });
  const buf = Buffer.from(dl.data);
  let ext = path.extname(fileName || '').replace('.', '').toLowerCase() || 'mp4';
  if (!/^(mp4|mov|webm|mkv)$/.test(ext)) ext = 'mp4';
  return saveResult(buf, `agnes-video-${Date.now()}.${ext}`, 'video/mp4');
}

/**
 * 视频缩略图：优先 ffmpeg 抽首帧；环境无 ffmpeg → 纯色占位 PNG（微信视频卡片的
 * 缩略帧，深色 16:9）。返回 { thumbPath, thumbMime }。
 */
async function ensureVideoThumb(videoPath) {
  // 1. ffmpeg 抽首帧
  try {
    const thumb = path.join(MEDIA_DIR, `agnes-thumb-${Date.now()}.jpg`);
    execFileSync('ffmpeg',
      ['-y', '-i', videoPath, '-vframes', '1', '-vf', 'scale=480:-2', thumb],
      { timeout: 20000, stdio: 'ignore' });
    if (fs.existsSync(thumb) && fs.statSync(thumb).size > 0) {
      return { thumbPath: thumb, thumbMime: 'image/jpeg' };
    }
  } catch { /* 无 ffmpeg → 占位图 */ }
  // 2. 纯色占位 PNG（深蓝灰，16:9）
  const thumb = path.join(MEDIA_DIR, `agnes-thumb-${Date.now()}.png`);
  fs.writeFileSync(thumb, solidPng(480, 270, 38, 44, 58));
  return { thumbPath: thumb, thumbMime: 'image/png' };
}

/** 纯色 PNG 生成（PNG 签名 + IHDR + zlib IDAT + IEND；CRC32 表查表实现） */
function solidPng(width, height, r, g, b) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0;                                    // filter: none
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }
  const idat = zlib.deflateSync(raw);
  const crcTable = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c;
    }
    return t;
  })();
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: truecolor RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function saveResult(buf, fileName, mime) {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const filePath = path.join(MEDIA_DIR, fileName);
  fs.writeFileSync(filePath, buf);
  return { filePath, fileName, mime, size: buf.length };
}

/**
 * 异步任务管理器（并发队列模型）：
 *   submit(type, opts, ctx) → job（立即返回，AI 先回话）
 *   生图/生视频共用同一 FIFO 队列：worker 池逐个拉起任务执行；
 *   并发上限由 Agnes 官方控制——接口返回限流/并发超限错误时，
 *   任务退回队列尾部（指数退避后重试），不会直接失败。
 *   每个任务覆盖完整生命周期（生图：同步请求 10-60s；
 *   生视频：提交→轮询→下载→完成），结束释放槽位并拉起下一个。
 *   onComplete(job) / onError(job, err) 由上层注入（注册媒体 + 激活 AI 发送）。
 */
class MediaGenManager {
  constructor({ onComplete, onError, impl } = {}) {
    this.onComplete = onComplete || (async () => {});
    this.onError = onError || (async () => {});
    // 可注入 impl 便于测试；生产默认用真实 Agnes API 实现
    this._impl = impl || { generateImage, submitVideo, pollVideo, downloadVideo, ensureVideoThumb };
    this.enabled = !!AGNES_API_KEY;
    // worker 池大小（默认 2）。不是并发上限——Agnes 官方控制并发，
    // 超限时我们只是把任务退回队列等待，这里控制同时处理几个任务。
    this.maxConcurrent = Math.max(1, Number(process.env.AGNES_MAX_CONCURRENT || 2));
    this.jobs = new Map();        // jobId → job
    this.queue = [];              // 待执行 jobId（FIFO，限流/并发超限时排队）
    this.active = 0;              // 执行中任务数
  }

  submit(type, opts, ctx) {
    if (!this.enabled) throw new Error('生图/生视频未启用（AGNES_API_KEY 未配置）');
    if (type !== 'image' && type !== 'video') throw new Error(`未知生成类型: ${type}`);
    const jobId = `gen-${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      jobId, type, ...opts,
      ctx: ctx || {},             // { memberId, callerId, chatroomId? }
      status: 'queued',           // queued → submitted → running → completed/failed
      providerId: null,
      createdAt: Date.now(),
      retries: 0,                 // 限流回队次数（指数退避）
      lastError: null,
    };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);       // 先进 FIFO 队列，有空闲 worker 立即拉起
    this._drain();
    return job;
  }

  /** 并发闸门：有空闲 worker 才拉起队首任务，否则留在队列等 */
  _drain() {
    while (this.active < this.maxConcurrent && this.queue.length > 0) {
      const jobId = this.queue.shift();
      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'queued') continue;
      this.active += 1;
      job.status = 'submitted';
      this._run(job).catch(e => console.error(`[MediaGen] 执行任务异常 ${jobId}:`, e.message))
        .finally(() => { this.active = Math.max(0, this.active - 1); this._drain(); });
    }
  }

  /** 执行任务全生命周期；限流错误 → 退避后回队，其它错误 → 失败上报 */
  async _run(job) {
    try {
      if (job.type === 'image') {
        await this._runImage(job);
      } else {
        await this._runVideo(job);
      }
    } catch (e) {
      if (job.status === 'completed') return;
      if (isRateLimited(e)) {
        // 并发/限流由 Agnes 官方控制：任务不失败，退避后回队尾等待
        job.retries += 1;
        job.lastError = e.message;
        job.status = 'queued';
        await sleep(Math.min(60_000, BACKOFF_BASE_MS * Math.pow(2, job.retries - 1)));
        if (Date.now() - job.createdAt > JOB_TTL_MS) {
          job.status = 'failed';
          this.jobs.delete(job.jobId);
          await this._safeError(job, new Error('生成任务超时（30 分钟），已放弃'));
          return;
        }
        this.queue.push(job.jobId);   // 回队尾，_drain 会再拉起
        return;
      }
      job.status = 'failed';
      this.jobs.delete(job.jobId);
      await this._safeError(job, e);
    }
  }

  /** 生图：同步请求 + 落盘 → 完成 */
  async _runImage(job) {
    const result = await this._impl.generateImage({ prompt: job.prompt, size: job.size, refImages: job.refImages });
    job.filePath = result.filePath;
    job.fileName = result.fileName;
    job.mime = result.mime;
    job.sizeBytes = result.size;
    job.status = 'completed';
    this.jobs.delete(job.jobId);
    await this._safeComplete(job);
  }

  /** 生视频：提交任务 → 按间隔轮询 → 完成下载/失败报错/超时放弃（独占槽位直到结束） */
  async _runVideo(job) {
    const { videoId, duration, modelName } = await this._impl.submitVideo({ prompt: job.prompt, seconds: job.seconds, refImage: job.refImage });
    job.providerId = videoId;
    job.providerModel = modelName || '';
    job.duration = duration;
    job.status = 'running';
    while (Date.now() - job.createdAt < JOB_TTL_MS) {
      let data;
      try {
        data = await this._impl.pollVideo(job.providerId, job.providerModel);
      } catch (e) {
        if (isRateLimited(e)) {
          // 任务已在 Agnes 创建，轮询被限流 → 等更长再查，不重复提交
          await sleep(POLL_RETRY_MS);
          continue;
        }
        throw e;
      }
      const status = String(data?.status || '').toLowerCase();
      if (status === 'completed') {
        // v2.0 完成响应用 metadata.url；2.5 系列用顶层 url（国内站实测）
        const url = data?.metadata?.url || data?.url || data?.metadata?.video_url || data?.video_url;
        if (!url) throw new Error('视频任务完成但缺少结果 URL');
        const result = await this._impl.downloadVideo(url, `agnes-video-${Date.now()}.mp4`);
        const thumb = await this._impl.ensureVideoThumb(result.filePath);
        job.filePath = result.filePath;
        job.fileName = result.fileName;
        job.mime = result.mime;
        job.sizeBytes = result.size;
        job.thumbPath = thumb.thumbPath;
        job.thumbMime = thumb.thumbMime;
        job.status = 'completed';
        this.jobs.delete(job.jobId);
        await this._safeComplete(job);
        return;
      }
      if (status === 'failed') {
        throw new Error(`视频生成失败: ${JSON.stringify(data?.error || data).substring(0, 200)}`);
      }
      // queued / in_progress / 其它 → 等下一轮
      await sleep(POLL_INTERVAL_MS);
    }
    throw new Error('生成任务超时（30 分钟），已放弃');
  }

  async _safeComplete(job) {
    try { await this.onComplete(job); } catch (e) { console.error(`[MediaGen] onComplete 失败 ${job.jobId}:`, e.message); }
  }

  async _safeError(job, err) {
    console.error(`[MediaGen] 任务失败 ${job.jobId} (${job.type}):`, err.message);
    try { await this.onError(job, err); } catch (e) { console.error('[MediaGen] onError 失败:', e.message); }
  }

  stop() {
    this.jobs.clear();
    this.queue.length = 0;
  }
}

module.exports = { MediaGenManager, generateImage, submitVideo, pollVideo, downloadVideo, ensureVideoThumb, AGNES_API_KEY, AGNES_API_BASE, AGNES_IMAGE_MODEL, AGNES_VIDEO_MODEL };
