/**
 * rvcCover —— clonevoice「深度音频」开放平台 RVC 翻唱 util。
 *
 * 用途：把一首「已有歌」（公版/传统/获授权）用 Anaxis 专属音色的 RVC 模型
 * 还原成原版翻唱（旋律+伴奏保持原曲，人声换成 Anaxis 音色）——补上 Suno
 * persona「只能原创旋律、cover 受 catalog 版权风控」的短板。
 *
 * 链路（外部异步 + 回调）：
 *   POST https://wechatscan.com/a/open/karaoke/cover  （提交，code=200 只代表受理）
 *   → 平台按 userId 首次自动训练 RVC 声音模型（需参考音频 URL），后续复用
 *   → 完成后向企业配置的回调地址 POST {orderId, cost, coverUrl, vocalUrl, bgmUrl}
 *   → 下载 coverUrl（完整翻唱 mp3）。
 *
 * 鉴权：header `token: CLONEVOICE_TOKEN`（不是 Bearer）。计费：任务成功才扣费（¥2/次）。
 *
 * 环境变量：
 *   CLONEVOICE_TOKEN        深度音频开放平台企业 token（必需）
 *   CLONEVOICE_REF_AUDIO_URL Anaxis 参考音频（说话样本）公网 URL——首次为该 userId
 *                            建模时上传；缺省用内置 Anaxis persona 样本托管 URL
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API_HOST = 'wechatscan.com';
const TOKEN = String(process.env.CLONEVOICE_TOKEN || '').trim();

/** 未配置 token 时的可读文案 */
function needCred() {
  return '翻唱原版歌曲需要 clonevoice（深度音频）开放平台的 token（环境变量 CLONEVOICE_TOKEN）。配置后我就能用原曲调给你唱完整的歌啦～';
}

function request(method, pathname, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) { reject(new Error(needCred())); return; }
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = https.request({
      hostname: API_HOST,
      path: pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        token: TOKEN,
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null;
        try { j = JSON.parse(text); } catch {}
        if (res.statusCode >= 400) { reject(new Error(`clonevoice 接口 HTTP ${res.statusCode}：${text.slice(0, 240)}`)); return; }
        resolve(j && typeof j === 'object' ? j : text);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('clonevoice 接口超时')));
    req.on('error', (e) => reject(new Error('clonevoice 请求失败：' + e.message)));
    if (payload) req.end(payload); else req.end();
  });
}

/** clonevoice 错误码 → 可读文案 */
function mapErr(code, msg) {
  const m = {
    6020: '缺少用户标识（userId）',
    6021: '企业 token 无效或未开通 RVC 翻唱能力',
    6022: '余额不足，请充值后重试',
    6023: '歌曲下载失败（检查歌曲 URL 是否公网可访问/文件格式）',
    6024: '还没有可用的声音模型（首次需提供参考音频）',
    6025: '声音模型还在训练中，稍等再试',
    6026: '订单重复或缺少歌曲来源',
    6027: '短视频解析失败（换可直链下载的 mp3 更稳）',
    6028: '回调地址未配置或歌曲提取异常',
  };
  return `翻唱失败（${code}）：${m[code] || msg || '未知错误'}`;
}

/** 提交 RVC 翻唱任务（受理即返回，真实结果走企业回调）。
 * @param {object} opts {
 *   orderId(必填, 客户端唯一订单号=回调关联键),
 *   userId(必填, 决定声音模型归属/复用, 用 Anaxis 固定标识),
 *   userGender('FEMALE'|'MALE'),
 *   promptAudioUrl?(首次建模的参考音频公网 URL 数组),
 *   coverMusicUrl?/videoUrl?(歌曲来源, 二选一),
 *   songName?/singerName?, tune?(-12..12, 默认0), epoch?
 * }
 * @returns {Promise<{code,msg}>}
 */
async function submitCover(opts = {}) {
  const orderId = String(opts.orderId || '').trim();
  const userId = String(opts.userId || '').trim();
  if (!orderId) throw new Error('缺少 orderId');
  if (!userId) throw new Error('缺少 userId');
  const body = {
    orderId,
    userId,
    userGender: String(opts.userGender || 'FEMALE').toUpperCase() === 'MALE' ? 'MALE' : 'FEMALE',
  };
  const refs = Array.isArray(opts.promptAudioUrl) ? opts.promptAudioUrl.filter(Boolean)
    : (opts.promptAudioUrl ? [opts.promptAudioUrl] : []);
  if (refs.length > 0) body.promptAudioUrl = refs;
  if (String(opts.coverMusicUrl || '').trim()) body.coverMusicUrl = String(opts.coverMusicUrl).trim();
  if (String(opts.videoUrl || '').trim()) body.videoUrl = String(opts.videoUrl).trim();
  if (!body.coverMusicUrl && !body.videoUrl) throw new Error('翻唱需要歌曲来源：sourceUrl（mp3/短视频链接）至少给一个');
  if (String(opts.songName || '').trim()) body.coverMusicName = String(opts.songName).trim();
  if (String(opts.singerName || '').trim()) body.coverSingerName = String(opts.singerName).trim();
  if (opts.tune !== undefined && opts.tune !== null && String(opts.tune).trim() !== '') {
    body.tune = Math.min(12, Math.max(-12, Math.round(Number(opts.tune))));
  }
  if (opts.epoch !== undefined && opts.epoch !== null) body.epoch = Math.max(1, Math.round(Number(opts.epoch)));

  const j = await request('POST', '/a/open/karaoke/cover', body, 60000);
  if (j && j.code === 200) return { code: 200, msg: j.msg || 'ok' };
  if (j && j.code) {
    const err = new Error(mapErr(Number(j.code), j.msg));
    err.code = Number(j.code);   // 结构化错误码（songGen 层可据此做 6024 自动重建等）
    throw err;
  }
  throw new Error(`翻唱提交异常：${JSON.stringify(j).substring(0, 200)}`);
}

/** 下载音频 URL 到本地（跟随重定向，返回 {path,size}） */
function downloadTo(url, outDir) {
  return new Promise((resolve, reject) => {
    const mod = /^https:/i.test(url) ? https : http;
    const ext = path.extname(new URL(url).pathname) || '.mp3';
    const filePath = path.join(outDir, `cover_${Date.now()}_${crypto.randomBytes(5).toString('hex')}${ext}`);
    const file = fs.createWriteStream(filePath);
    const req = mod.get(url, { timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.destroy();
        downloadTo(res.headers.location, outDir).then(resolve, reject);
        return;
      }
      if (res.statusCode >= 400) { file.destroy(); reject(new Error(`翻唱结果下载 HTTP ${res.statusCode}`)); return; }
      res.pipe(file);
    });
    req.on('timeout', () => req.destroy(new Error('翻唱结果下载超时')));
    req.on('error', (e) => { file.destroy(); fs.unlink(filePath, () => {}); reject(new Error('翻唱结果下载失败：' + e.message)); });
    file.on('finish', () => { file.close(); resolve({ path: filePath, size: fs.statSync(filePath).size }); });
    file.on('error', (e) => { fs.unlink(filePath, () => {}); reject(new Error('翻唱结果写入失败：' + e.message)); });
  });
}

/** 按来源 URL 粗判：短视频平台/视频类链接 → videoUrl；否则当 mp3 直链 */
function classifySourceUrl(url) {
  const u = String(url || '').trim().toLowerCase();
  if (!u) return '';
  if (/bilibili|b23\.tv|douyin|iesdouyin|kuaishou|weishi\.qq|youtu\.be|youtube\.com/.test(u)) return 'video';
  const p = (() => { try { return new URL(u).pathname; } catch { return ''; } })();
  if (/\.(mp3|m4a|wav|flac|aac)(\?|$)/.test(p)) return 'audio';
  return 'video'; // 无法确认时交给平台解析（短视频模式容错更广）
}

module.exports = { submitCover, downloadTo, needCred, mapErr, classifySourceUrl };
