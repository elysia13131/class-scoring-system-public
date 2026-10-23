/**
 * acesSong —— acedata（Suno Chirp 聚合）人声歌曲生成 util。
 *
 * 目的：用 Suno persona（由豆包复刻音色 S_ 的说话样本克隆）唱整曲——
 * 说话与唱歌同一音色。acedata 是第三方聚合 API（api.acedata.cloud），
 * Bearer token 鉴权（非火山 SigV4）。
 *
 * 流程（异步任务式）：
 *   POST /suno/audios  （action=generate + persona_id + prompt/lyric）→ task_id
 *   POST /suno/tasks   （id=task_id 轮询）→ data[] state=succeeded → audio_url
 *   下载 audio_url → 本地 mp3。
 *
 * 环境变量（可覆盖默认值）：
 *   ACEDATA_API_KEY      acedata Bearer token（控制台平台.acedata.cloud → API Key）
 *   ACEDATA_SUNO_PERSONA Suno persona_id（默认内置已验证的 Anaxis S4 Voice）
 *   ACEDATA_SUNO_MODEL   默认 chirp-v5-5（支持 persona 的最新模型）
 *   ACEDATA_SUNO_API     默认 https://api.acedata.cloud
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_BASE = String(process.env.ACEDATA_SUNO_API || 'https://api.acedata.cloud').replace(/\/+$/, '');
const API_KEY = String(process.env.ACEDATA_API_KEY || '').trim();
const PERSONA_ID = String(process.env.ACEDATA_SUNO_PERSONA || 'b4b70a17-a4ed-46c1-9382-68751679a48a').trim();
const MODEL = String(process.env.ACEDATA_SUNO_MODEL || 'chirp-v5-5').trim();

/** 未配置 token 时的可读文案 */
function needCred() {
  return '唱歌需要 acedata 的 API Key（环境变量 ACEDATA_API_KEY）。配置后就能用 Suno 唱完整首歌发过来啦～';
}

/** acedata 通用 POST（Bearer 鉴权 + JSON body）→ 解析 JSON */
function post(pathname, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) { reject(new Error(needCred())); return; }
    const payload = JSON.stringify(body);
    const req = https.request(`${API_BASE}${pathname}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch { /* 非 JSON */ }
        if (res.statusCode >= 400) {
          reject(new Error(`Suno 接口 HTTP ${res.statusCode}：${text.slice(0, 240)}`));
          return;
        }
        if (j && j.success === false) {
          const msg = (j.error && j.error.message) || '未知错误';
          reject(new Error(`Suno 接口错误：${msg}`));
          return;
        }
        if (j) { resolve(j); return; }
        reject(new Error(`Suno 返回异常（非 JSON）: ${text.slice(0, 160)}`));
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Suno 接口超时')));
    req.on('error', (e) => reject(new Error('Suno 接口请求失败：' + e.message)));
    req.end(payload);
  });
}

/** 下载音频 URL 到本地（跟随重定向） */
function downloadTo(url, outDir) {
  return new Promise((resolve, reject) => {
    const mod = /^https:/i.test(url) ? https : require('http');
    const ext = path.extname(new URL(url).pathname) || '.mp3';
    const filePath = path.join(outDir, `song_${Date.now()}_${crypto.randomBytes(5).toString('hex')}${ext}`);
    const file = fs.createWriteStream(filePath);
    const req = mod.get(url, { timeout: 90000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.destroy();
        downloadTo(res.headers.location, outDir).then(resolve, reject);
        return;
      }
      if (res.statusCode >= 400) {
        file.destroy();
        reject(new Error(`歌曲下载 HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
    });
    req.on('timeout', () => req.destroy(new Error('歌曲下载超时（90s）')));
    req.on('error', (e) => { file.destroy(); fs.unlink(filePath, () => {}); reject(new Error('歌曲下载失败：' + e.message)); });
    file.on('finish', () => { file.close(); resolve({ path: filePath, size: fs.statSync(filePath).size }); });
    file.on('error', (e) => { fs.unlink(filePath, () => {}); reject(new Error('歌曲写入失败：' + e.message)); });
  });
}

/**
 * 生成一首人声歌曲（Suno persona 演唱，同复刻音色）。
 * @param {object} opts —— 对齐官方 /suno/audios generate（custom）字段：
 *  { lyric(可选，歌词，含 [verse]/[chorus] 段落标记),
 *    lyric_prompt(可选，主题描述——无歌词时官方据此自动生成歌词，与 lyric 互斥给一),
 *    title(可选，歌名), style(可选，官方 style：曲风/情绪/速度/乐器描述),
 *    duration(可选，目标时长秒 10~360；**没传就不传 duration，走官方控制**);
 *    其余 persona/model 由本模块固定（人声=复刻音色 persona）。 }
 * @param {object} env { outDir, timeoutMs, onProgress }
 * @returns {Promise<{path, fileName, taskId, songName, audioUrl}>}
 */
async function generateSong(opts = {}, env = {}) {
  const outDir = env.outDir || path.join(__dirname, '..', 'data', 'song');
  fs.mkdirSync(outDir, { recursive: true });
  // 清理 24h 前旧歌曲（已发送的文件无保留价值，防持久卷堆积）
  try {
    for (const f of fs.readdirSync(outDir)) {
      const p = path.join(outDir, f);
      try { if (fs.statSync(p).mtimeMs < Date.now() - 24 * 3600 * 1000) fs.unlinkSync(p); } catch {}
    }
  } catch {}

  // 对齐官方字段：lyric / lyric_prompt（二选一，至少一个）
  const lyric = String(opts.lyric || '').trim();
  const lyricPrompt = String(opts.lyric_prompt || '').trim();
  if (!lyric && !lyricPrompt) throw new Error('歌曲需要歌词（lyric）或主题描述（lyric_prompt），至少给一个');
  const style = String(opts.style || '').trim();

  // ---- 1) 提交生成任务（官方 custom 模式；async → 立即拿 task_id） ----
  const body = {
    action: 'generate',
    model: MODEL,
    persona_id: PERSONA_ID,
    custom: true,
    async: true,
  };
  if (lyric) {
    // 完整歌词 → lyric 字段
    body.lyric = lyric;
    body.title = String(opts.title || '').trim() || '我们的歌';
  } else {
    // 只给主题 → lyric_prompt 让官方自动配词（Suno 会唱中文）
    body.lyric_prompt = lyricPrompt;
  }
  if (style) body.style = style;
  // duration 仅在显式要求时透传（官方 10~360s custom+chirp-v5-5）；没传就不传 → 官方控制
  if (opts.duration !== undefined && opts.duration !== null && String(opts.duration).trim() !== '') {
    body.duration = Math.min(360, Math.max(10, Math.round(Number(opts.duration))));
  }
  if (env.onProgress) env.onProgress(5);
  console.log(`[AcesSong] 提交生成 model=${MODEL} persona=${PERSONA_ID} custom lyric=${!!lyric} lyric_prompt=${!lyric && !!lyricPrompt} theme=${lyricPrompt.slice(0, 40) || '(歌词模式)'}${body.duration ? ` dur=${body.duration}s` : ''}`);
  const created = await post('/suno/audios', body, 120000);
  const taskId = String(created.task_id || created.taskId || '');
  if (!taskId) throw new Error(`Suno 任务创建失败：${JSON.stringify(created).substring(0, 240)}`);

  // ---- 2) 轮询任务直到 succeeded（Suno 完整歌 1-4 分钟） ----
  const timeoutMs = env.timeoutMs || 300000;
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('歌曲生成超时（还没唱完，稍后可以再让我试一次）');
    }
    const q = await post('/suno/tasks', { id: taskId }, 120000).catch(async () => {
      // 轮询偶发超时/5xx：退避后重试，不判失败
      await new Promise((r) => setTimeout(r, 4000));
      return null;
    });
    if (q) {
      const items = (q.response && q.response.data) || [];
      // 成功：第一首 succeeded 且带 audio_url
      const doneItem = items.find((it) => it && (it.state === 'succeeded' || it.audio_url));
      const failedItem = items.find((it) => it && it.state === 'failed');
      if (doneItem && doneItem.audio_url) {
        const songName = String(doneItem.title || '').trim() || '我们的歌';
        const downloaded = await downloadTo(doneItem.audio_url, outDir);
        console.log(`[AcesSong] 完成 task=${taskId} 「${songName}」 ${(downloaded.size / 1024).toFixed(0)}KB`);
        return {
          path: downloaded.path,
          fileName: `${songName.slice(0, 40)}.mp3`,
          taskId,
          songName,
          audioUrl: doneItem.audio_url,
        };
      }
      if (failedItem) {
        throw new Error(`歌曲生成失败：${JSON.stringify(failedItem).substring(0, 200)}`);
      }
      const running = items.length > 0;
      if (env.onProgress) env.onProgress(running ? 40 : 10);
    }
    // 退避轮询（10s 起步，上限 30s）
    const wait = Math.min(30000, 10000 + Math.floor(Math.random() * 5000));
    await new Promise((r) => setTimeout(r, wait));
  }
}

module.exports = { generateSong, needCred };
