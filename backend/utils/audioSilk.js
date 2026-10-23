/**
 * audioSilk —— 歌曲音频（mp3/m4a 等）转微信语音条（silk）工具。
 *
 * 用途：生成的歌 <60s 时以微信原生语音条发出（比文件消息更像"她亲口唱的"）。
 * 微信语音条只收 silk（GeWe /message/postVoice）；歌曲是 mp3 → 需先解码成 PCM
 * （@audio/decode-mp3，WASM mpg123，Node 可跑）→ 降采样到 24kHz（silk 上限）→
 * silk-wasm encode → 补 `#!SILK_V3` 头落盘。
 *
 * 规则：
 *   - 解码后时长 >= 60s（微信语音条硬上限）→ 返回 {tooLong:true}，上层走文件消息；
 *   - 解码/silk 编码失败 → 返回 {error: msg}，上层同样降级为文件消息；
 *   - 成功 → { path, durationMs }。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_MS = 60 * 1000;   // 微信语音条硬上限
const TARGET_RATE = 24000;  // silk 支持的最高采样率

/** silk-wasm 懒加载单例（与 doubaoVoice 同库复用） */
let _silkModPromise;
function getSilk() {
  if (!_silkModPromise) _silkModPromise = Promise.resolve(require('silk-wasm'));
  return _silkModPromise;
}

/** @audio/decode-mp3 懒加载（ESM，dynamic import） */
let _mp3DecPromise;
function getMp3Decoder() {
  if (!_mp3DecPromise) {
    _mp3DecPromise = import('@audio/decode-mp3').then((m) => m.default || m);
  }
  return _mp3DecPromise;
}

/**
 * 尝试把 mp3 转成微信语音条 silk（时长探测 + 编码一体）。
 * @param {string} audioPath mp3 文件绝对路径
 * @param {string} outDir    落盘目录（data/tts_voice 之类）
 * @returns {Promise<{ok:true,path:string,durationMs:number}|{ok:false,tooLong?:boolean,reason?:string}>}
 */
async function tryVoiceSilk(audioPath, outDir = '') {
  try {
    const buf = fs.readFileSync(audioPath);
    const decodeMp3 = await getMp3Decoder();
    const { channelData, sampleRate } = await decodeMp3(new Uint8Array(buf));
    const n = channelData[0].length;
    if (!n || !sampleRate) return { ok: false, reason: '解码无输出' };
    const durMs = Math.round((n / sampleRate) * 1000);
    if (durMs >= MAX_MS) return { ok: false, tooLong: true, reason: `时长 ${(durMs / 1000).toFixed(1)}s 超语音条上限` };

    // 多声道平均 → mono Float32
    const mono = channelData[0];
    for (let c = 1; c < channelData.length; c++) {
      const other = channelData[c];
      for (let i = 0; i < n; i++) mono[i] = (mono[i] + other[i]) / 2;
    }
    // 线性降采样到 24kHz → Int16 PCM（s16le 字节）
    const outN = Math.floor((n * TARGET_RATE) / sampleRate);
    const pcm = new Int16Array(outN);
    if (sampleRate === TARGET_RATE) {
      for (let i = 0; i < outN; i++) pcm[i] = Math.max(-1, Math.min(1, mono[i])) * 32767 | 0;
    } else {
      for (let i = 0; i < outN; i++) {
        const src = Math.min(Math.floor((i * sampleRate) / TARGET_RATE), n - 1);
        pcm[i] = Math.max(-1, Math.min(1, mono[src])) * 32767 | 0;
      }
    }

    const silk = await getSilk();
    const enc = await silk.encode(new Uint8Array(pcm.buffer), TARGET_RATE);
    // 微信语音格式 = 0x02 + "#!SILK_V3"（版本字节在前、无 0xFFFF 尾部）；
    // silk-wasm encode 产物正是该容器，直接落盘，不要再补任何头。
    const silkData = Buffer.from(enc.data);
    const outDir2 = outDir || path.join(__dirname, '..', 'data', 'tts_voice');
    fs.mkdirSync(outDir2, { recursive: true });
    const filePath = path.join(outDir2, `song_voice_${Date.now()}_${crypto.randomBytes(6).toString('hex')}.silk`);
    fs.writeFileSync(filePath, silkData);
    const finalMs = Math.max(1, Math.round(enc.duration || durMs));
    return { ok: true, path: filePath, durationMs: finalMs, srcMs: durMs };
  } catch (e) {
    return { ok: false, reason: e.message || 'silk 转换失败' };
  }
}

module.exports = { tryVoiceSilk };
