/**
 * doubaoVoice —— 豆包声音复刻 2.0 语音合成 → 微信语音条（silk）转换。
 *
 * 合成：火山引擎语音合成大模型 HTTP 单向流式接口（非流式一次性取回）
 *   POST https://openspeech.bytedance.com/api/v3/tts/unidirectional
 *   新版控制台鉴权：X-Api-Key（控制台 > API Key 管理）+ X-Api-Request-Id
 *   复刻音色资源：Resource-Id = seed-icl-2.0（豆包声音复刻大模型2.0）
 *   输出 format=wav（24000Hz 单声道）→ 直接喂 silk-wasm 编码器（无需 ffmpeg）。
 *
 * 转换：silk-wasm encode(WAV) → SILK_V3 帧；补微信所需的 `#!SILK_V3` 头，
 *   与 GeWeAPI /message/postVoice（仅支持 silk）对接，发成微信原生语音条。
 *
 * 环境变量（可覆盖默认值）：
 *   DOUBAO_TTS_API_KEY      API Key（默认内置在代码中，控制台可换）
 *   DOUBAO_TTS_SPEAKER      复刻音色 ID（默认 S_4zWi1fb12）
 *   DOUBAO_TTS_RESOURCE_ID  资源 ID（默认 seed-icl-2.0）
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_BASE = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const API_KEY = String(process.env.DOUBAO_TTS_API_KEY || '242625ef-dc29-4136-9515-819d7f61242b').trim();
const SPEAKER = String(process.env.DOUBAO_TTS_SPEAKER || 'S_4zWi1fb12').trim();
const RESOURCE_ID = String(process.env.DOUBAO_TTS_RESOURCE_ID || 'seed-icl-2.0').trim();
const SAMPLE_RATE = 24000;
let _silkModPromise;
function getSilk() {
  if (!_silkModPromise) {
    _silkModPromise = Promise.resolve(require('silk-wasm'));
  }
  return _silkModPromise;
}

/** 标准 WAV → 提取 data 块的 PCM（s16le）字节；不是标准块结构时原样返回 */
function extractWavPcm(wavBuf) {
  if (wavBuf.slice(0, 4).toString('ascii') !== 'RIFF') return wavBuf;
  let p = 12; // 跳过 RIFF 头 + size + WAVE
  while (p + 8 <= wavBuf.length) {
    const id = wavBuf.toString('ascii', p, p + 4);
    const sz = wavBuf.readUInt32LE(p + 4);
    if (id === 'data') {
      const end = Math.min(p + 8 + sz, wavBuf.length);
      return wavBuf.subarray(p + 8, end);
    }
    p += 8 + sz + (sz % 2); // chunk 按 2 字节对齐
  }
  return wavBuf;
}

/** 落盘前清理目录里超过 24 小时的旧产物（发送后文件即无价值，防止长期堆积占持久卷） */
function cleanOldFiles(dir, keepAgeMs = 24 * 3600 * 1000) {
  try {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).mtimeMs < Date.now() - keepAgeMs) fs.unlinkSync(p);
      } catch { /* 并发已删/占用则跳过 */ }
    }
  } catch { /* 目录不存在不用管 */ }
}

/** 请求失败/未配置时的可读文案（供 AI 如实转述，不编不该读的） */
function fmtErr(msg) {
  return `语音合成失败：${msg}（改发文字即可）`;
}

/**
 * 合成一句语音 → 返回微信可发语音条。
 * @param {string} text 要念的文字（自然口语；strip 控制字符，截 300 字防超限）
 * @param {object} opts { outDir: 落盘目录 }
 * @returns {Promise<{path:string, durationMs:number, chars:number}>}
 */
async function synthesizeVoice(text, opts = {}) {
  const t = String(text || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (!t) throw new Error(fmtErr('空文本'));

  const reqid = crypto.randomUUID();
  // bodyObj 在 synthOnce 内按当轮文本构建（60s 超长保护需要随截断后的文本重新合成）

  // ---- 1) 合成（v3 单向流式；响应 = 多段 JSON 流式拼接） ----
  // 每段都是 {code:0, data:<base64 音频分片>}，段与段直接相连（间或 \n），
  // 最后 1-2 段 data 为空表示结束。所有段的 data 依次 base64 解码后再拼接 =
  // 完整音频。偶见直接二进制（RIFF 开头）的整体响应，一并兼容。
  const decodeSegments = (buf) => {
    // 从头扫描「上一个 JSON 结束 → 下一个 { 开始」的完整 JSON 段
    const scanEnd = (start) => {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < buf.length; i++) {
        const c = buf[i];
        if (inStr) { if (esc) esc = false; else if (c === 0x5c) esc = true; else if (c === 0x22) inStr = false; continue; }
        if (c === 0x22) inStr = true;
        else if (c === 0x7b) depth++;
        else if (c === 0x7d) { depth--; if (depth === 0) return i + 1; }
      }
      return -1;
    };
    const parts = [];
    let pos = 0;
    let found = false;
    while (pos < buf.length) {
      const end = scanEnd(pos);
      if (end < 0 || end > buf.length) break;
      let j = null;
      try { j = JSON.parse(buf.subarray(pos, end).toString('utf8')); } catch { break; }
      if (!j) break;
      found = true;
      // 成功态：code=0（中间分片）与 code=20000000（结束标记 OK）都正常；其余为错误
      const code = Number(j.code);
      if (code !== 0 && code !== 20000000) {
        throw new Error(fmtErr(`[${j.code}] ${j.message || j.status_msg || '未知错误'}`));
      }
      if (j.data) parts.push(Buffer.from(String(j.data), 'base64'));
      // 跳到下一段：end 之后允许\n 空白，随后是下一个 { 或 EOF
      let next = end;
      while (next < buf.length && (buf[next] === 0x0a || buf[next] === 0x0d || buf[next] === 0x20)) next++;
      pos = next;
    }
    if (found && parts.length > 0) return Buffer.concat(parts);
    return null;
  };

  const decodeAudio = (buf) => {
    // ① 整体纯二进制音频（RIFF 开头）
    if (buf.slice(0, 4).toString('ascii') === 'RIFF') return buf;
    // ② 多段 JSON 拼接（标准形态）
    const joined = decodeSegments(buf);
    if (joined) return joined;
    throw new Error('返回格式异常（既不是音频也不是 JSON）');
  };

  const synthOnce = (rid, speakText) => new Promise((resolve, reject) => {
    const bodyObj = {
      user: { uid: 'steward' },
      req_params: {
        // 注意：不要带 model 字段！误传 model 会返回 45000001 InvalidModel。
        // 复刻音色（speaker=S_…）经 X-Api-Resource-Id: seed-icl-2.0 即路由到声音复刻模型。
        text: String(speakText || '').slice(0, 300),
        speaker: SPEAKER,
        audio_params: {
          format: 'wav',
          sample_rate: SAMPLE_RATE,
        },
      },
    };
    const data = Buffer.from(JSON.stringify(bodyObj));
    const req = https.request(API_BASE, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Api-Key': API_KEY,
        'X-Api-Resource-Id': RESOURCE_ID,
        'X-Api-Request-Id': rid,
        'Content-Length': data.length,
      },
      timeout: 60000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) {
          reject(new Error(fmtErr(`HTTP ${res.statusCode} ${buf.toString('utf8').slice(0, 200)}`)));
          return;
        }
        try { resolve(decodeAudio(buf)); }
        catch (e) { reject(e); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('合成超时（60s）')));
    req.on('error', (e) => reject(new Error(fmtErr(e.message))));
    req.end(data);
  });

  // ---- 1.5) 60s 超长保护：合成后按 WAV 实际时长判定，超过 60s（微信语音条硬上限）
  // 按比例截短文本重新合成，最多 4 轮，确保最终时长安全落在 60s 内。
  const MAX_MS = 60 * 1000;                    // 微信语音条硬上限（超过会显示异常）
  const wavMs = (buf) => Math.max(1, Math.round(((buf.length - 44) / (SAMPLE_RATE * 2)) * 1000)); // RIFF 头 44B

  const synthWithRetry = async (speakText) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await synthOnce(attempt === 1 ? reqid : crypto.randomUUID(), speakText);
      } catch (e) {
        // 仅"格式异常"（响应不完整/瞬时）重试，换新 reqid 最多 2 次；
        // 业务错误（InvalidModel、鉴权、HTTP 4xx/5xx）直接抛给上层如实反馈
        if (attempt >= 3 || !/^返回格式异常/.test(e.message || '')) throw e;
        console.warn(`[DoubaoVoice] 合成响应异常，重试 ${attempt}/3: ${e.message}`);
        await new Promise((r) => setTimeout(r, 600 * attempt));
      }
    }
    throw new Error('合成失败（连续异常）');
  };

  // 首轮按 300 字上限合成；超长 → 按「58s 目标 / 实测时长」比例裁字，重新合成
  let speakText = t.slice(0, 300);
  let audioBuf = null;
  for (let round = 0; round < 4; round++) {
    audioBuf = await synthWithRetry(speakText);
    const ms = wavMs(audioBuf);
    if (ms <= MAX_MS) break;
    // 目标留 2s 余量（58s），按时长比例砍字数，至少保底 20 字避免死循环
    const nextLen = Math.max(20, Math.floor((speakText.length * 58 * 1000) / ms));
    if (nextLen >= speakText.length) break;   // 字数没缩短 → 放弃继续裁（用当前结果）
    speakText = String(speakText).slice(0, nextLen);
    console.warn(`[DoubaoVoice] 合成 ${ms}ms 超 60s 上限，裁到 ${nextLen} 字重合成（round ${round + 1}）`);
  }

  // ---- 2) WAV → silk（silk-wasm encode；实测传 WAV 缓冲会被当 PCM 编：剥头取 PCM + 显式采样率） ----
  let enc;
  try {
    const silk = await getSilk();
    const pcm = extractWavPcm(audioBuf);
    enc = await silk.encode(new Uint8Array(pcm), SAMPLE_RATE);
  } catch (e) {
    throw new Error(fmtErr(`silk 编码失败：${e.message}`));
  }
  let silkData = Buffer.from(enc.data);
  // 微信语音格式 = 0x02 + "#!SILK_V3"（版本字节在前、无 0xFFFF 尾部）；
  // silk-wasm encode 产物正是该容器（实测 head = 0x02#!SILK_V3），
  // 千万不要再前置 "#!SILK_V3"——会变成双重头导致微信无法播放。

  // ---- 3) 落盘（随机名，避免并发冲撞；顺带清理旧产物） ----
  const outDir = (opts && opts.outDir) || path.join(__dirname, '..', 'data', 'tts_voice');
  fs.mkdirSync(outDir, { recursive: true });
  cleanOldFiles(outDir);
  const filePath = path.join(outDir, `voice_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.silk`);
  fs.writeFileSync(filePath, silkData);

  const durationMs = Math.max(1, Math.round(enc.duration || 0));
  console.log(`[DoubaoVoice] 合成完成 ${path.basename(filePath)} ${(audioBuf.length / 1024).toFixed(0)}KB→${(silkData.length / 1024).toFixed(0)}KB silk, ${durationMs}ms, chars=${t.length}`);
  return { path: filePath, durationMs, chars: t.length };
}

module.exports = { synthesizeVoice };