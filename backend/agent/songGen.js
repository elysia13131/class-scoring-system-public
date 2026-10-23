/**
 * songGen.js —— 人声歌曲异步任务管理器（后端进程内常驻）
 *
 * 两条歌曲链路，同一管理器调度（异步提交立即返回，完成后激活 AI 发 mp3 配话）：
 *
 * 1) generate（原创唱歌）——acedata Suno persona：用豆包复刻音色样本克隆的
 *    persona 演唱原创歌，说话与唱歌同声；acesSong 内部提交→轮询→下载。
 *    凭据 ACEDATA_API_KEY；未配置返回「未配置」引导文案。
 *
 * 2) cover（翻唱还原原版）——clonevoice 深度音频 RVC：把一首已有歌（公版/
 *    传统/获授权）的人声换成 Anaxis 专属音色的 RVC 模型，旋律+伴奏保持原曲。
 *    submitCover 提交 → 平台异步（首次自动训练模型）→ 回调 POST 到企业配置
 *    的回调地址 → handleCallback(orderId, body) 下载 coverUrl → 完成。
 *    凭据 CLONEVOICE_TOKEN；未配置返回引导文案。
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const { getDataPath } = require('../utils/dataPath');

/** Anaxis 音色在 clonevoice 的声音模型归属标识（决定模型复用，勿改） */
const CV_USER_ID = 'anaxis-voice';
const CV_GENDER = 'FEMALE';
/** 首次建模参考音频（说话样本）公网 URL：默认 Anaxis persona 样本托管地址；
 * 生产用 CLONEVOICE_REF_AUDIO_URL 环境变量覆盖为正式域名直链 */
const CV_REF_URL = process.env.CLONEVOICE_REF_AUDIO_URL
  || 'https://your-domain.example.com/api/wechat/steward/media/persona_s4.wav';
/** 回调长时间未到判超时（ms）——含首次建模时间，放宽到 30 分钟 */
const CV_TIMEOUT = 30 * 60 * 1000;

function needCredSong() {
  return '唱歌功能未启用（后端未配置 ACEDATA_API_KEY）';
}
function needCredCover() {
  return '翻唱原版歌曲未启用（后端未配置 CLONEVOICE_TOKEN，深度音频开放平台企业 token）';
}

/**
 * 异步任务管理器（单 worker 顺序执行任务提交；cover 提交后挂起等外部回调）：
 *   submit(opts, ctx) → job（立即返回，AI 先回话）
 *   opts.mode: 'song'(默认, acedata/Suno 原创) | 'cover'(clonevoice RVC 翻唱)
 *   ctx: { memberId, callerId, chatroomId? }（同 mediaGen）
 *   onComplete(job) / onError(job, err) 由上层注入（注册媒体 + 激活 AI 发送）。
 *   handleCallback(orderId, body) 由 clonevoice 回调端点调用（外部异步结果）。
 */
class SongGenManager {
  constructor({ onComplete, onError } = {}) {
    this.onComplete = onComplete || (async () => {});
    this.onError = onError || (async () => {});
    this.jobs = new Map();    // jobId → job（generate 完成后即删；cover 挂起到回调/超时）
    this.queue = [];          // 待执行 jobId（FIFO）
    this.active = false;      // 是否正在执行（单 worker）
    this.enabled = !!String(process.env.ACEDATA_API_KEY || '').trim();
    this.coverEnabled = !!String(process.env.CLONEVOICE_TOKEN || '').trim();
    this._reaper = setInterval(() => this._reap(), 60 * 1000);
    if (this._reaper.unref) this._reaper.unref();
  }

  submit(opts, ctx) {
    const mode = String((opts && opts.mode) || 'song').toLowerCase();
    if (mode === 'cover') {
      if (!this.coverEnabled) throw new Error(needCredCover());
    } else if (!this.enabled) {
      throw new Error(needCredSong());
    }
    const prefix = mode === 'cover' ? 'cv' : 'song';
    const jobId = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
    const job = {
      jobId,
      mode,                    // 'song' | 'cover'
      opts: opts || {},
      ctx: ctx || {},          // { memberId, callerId, chatroomId? }
      status: 'queued',        // queued → running → completed / failed / await_callback
      createdAt: Date.now(),
    };
    this.jobs.set(jobId, job);
    this.queue.push(jobId);
    this._drain();
    return job;
  }

  _drain() {
    if (this.active) return;
    const jobId = this.queue.shift();
    if (!jobId) return;
    const job = this.jobs.get(jobId);
    if (!job || job.status !== 'queued') { this._drain(); return; }
    this.active = true;
    job.status = 'running';
    this._run(job).catch((e) => {
      console.error(`[SongGen] 执行任务异常 ${jobId}:`, e.message);
      job.status = 'failed';
      job.error = e.message;
      this.jobs.delete(job.jobId);
      return this._safeError(job, e);
    }).finally(() => {
      this.active = false;
      this._drain();
    });
  }

  /** 执行歌曲任务：song → acesSong 全程；cover → 仅提交（平台异步，等回调） */
  async _run(job) {
    if (job.mode === 'cover') return this._submitCover(job);
    const outDir = path.join(__dirname, '..', 'data', 'song');
    try {
      const { generateSong } = require('../utils/acesSong');
      const song = await generateSong(job.opts, { outDir, timeoutMs: 300000 });
      job.filePath = song.path;
      job.fileName = song.fileName || path.basename(song.path);
      job.songName = path.basename(String(job.fileName), path.extname(String(job.fileName))).slice(0, 40);
      job.taskId = song.taskId || '';
      job.status = 'completed';
      this.jobs.delete(job.jobId);
      await this._safeComplete(job);
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
      this.jobs.delete(job.jobId);
      await this._safeError(job, e);
    }
  }

  /** cover：提交 clonevoice 翻唱（仅受理），job 挂起等 handleCallback。
   *  6024（没有可用模型，可能是模型过期/被清）时自动清就绪标记并带参考音频重建重试一次 */
  async _submitCover(job) {
    const rvc = require('../utils/rvcCover');
    const sourceUrl = String(job.opts.sourceUrl || '').trim();
    if (!sourceUrl) throw new Error('翻唱需要歌曲来源链接（sourceUrl）：原版音频或视频链接');
    const kind = rvc.classifySourceUrl(sourceUrl);
    let modelReady = this._cvModelReady();
    for (let attempt = 1; attempt <= 2; attempt++) {
      const submitOpts = {
        orderId: job.jobId,          // 回调关联键（平台原样带回）
        userId: CV_USER_ID,
        userGender: CV_GENDER,
        songName: String(job.opts.songName || '').trim() || undefined,
        singerName: String(job.opts.singerName || '').trim() || undefined,
        tune: job.opts.tune,
      };
      if (kind === 'audio') submitOpts.coverMusicUrl = sourceUrl; else submitOpts.videoUrl = sourceUrl;
      // 首次建模（或 6024 重建）：该 userId 尚无可用模型时带参考音频
      if (!modelReady) {
        submitOpts.promptAudioUrl = [CV_REF_URL];
        console.log(`[SongGen] cover 提交携带参考音频建模（attempt=${attempt}）userId=${CV_USER_ID}`);
      }
      try {
        await rvc.submitCover(submitOpts);
        this._cvMarkModelReady(true);
        job.status = 'await_callback';
        console.log(`[SongGen] cover 已受理 ${job.jobId}（${kind === 'audio' ? 'mp3' : '短视频'}，等待平台回调）`);
        return;
      } catch (e) {
        // 6024：模型不存在/过期 → 清就绪标记，下一轮带参考音频重建后重试一次
        if (Number(e && e.code) === 6024 && attempt === 1) {
          console.warn(`[SongGen] cover 6024 无可用模型，重建模型重试 ${job.jobId}`);
          this._cvMarkModelReady(false);
          modelReady = false;
          continue;
        }
        throw e;
      }
    }
  }

  /** clonevoice 声音模型就绪态（持久化 data/cv_state.json，按 userId） */
  _cvStatePath() {
    return getDataPath('cv_state.json');
  }
  _cvModelReady() {
    try {
      const s = JSON.parse(fs.readFileSync(this._cvStatePath(), 'utf8'));
      return s && s[CV_USER_ID] === true;
    } catch { return false; }
  }
  _cvMarkModelReady(ready) {
    try {
      const fp = this._cvStatePath();
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const s = (() => { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return {}; } })();
      s[CV_USER_ID] = !!ready;
      fs.writeFileSync(fp, JSON.stringify(s));
    } catch (e) { console.error('[SongGen] cv_state 写入失败:', e.message); }
  }

  /** 超时看护：cover 挂起超时判失败 */
  _reap() {
    const now = Date.now();
    for (const [jobId, job] of this.jobs) {
      if (job.status === 'await_callback' && now - job.createdAt > CV_TIMEOUT) {
        console.warn(`[SongGen] cover 回调超时 ${jobId}`);
        this.jobs.delete(jobId);
        this._safeError(job, new Error('翻唱超时没等到结果（平台处理较久或回调失败），可以稍后再让我试一次'));
      }
    }
  }

  /**
   * clonevoice 回调入口（由后端 /api/cv/notify/<secret> 调用）。
   * @param {string} orderId 提交时的 jobId
   * @param {object} body { orderId, userId, cost, coverUrl, vocalUrl, bgmUrl, ... }
   */
  async handleCallback(orderId, body) {
    const job = this.jobs.get(String(orderId || ''));
    if (!job) { console.log(`[SongGen] 收到未知/已处理回调 orderId=${orderId}，忽略`); return; }
    const outDir = path.join(__dirname, '..', 'data', 'song');
    fs.mkdirSync(outDir, { recursive: true });
    const coverUrl = body && String(body.coverUrl || '').trim();
    const vocalUrl = body && String(body.vocalUrl || '').trim();
    // 视频源时平台回传的完整翻唱是 .mp4（带画面）——按产品策略不发 mp4 完整音乐，
    // 用 vocalUrl（纯人声 mp3）当歌曲本体；没有 vocal 才退回 coverUrl。
    const isVideoOut = /\.(mp4|m4a|webm)($|\?)/i.test(coverUrl);
    const dl = isVideoOut && vocalUrl ? vocalUrl : (coverUrl || vocalUrl);
    if (!dl) {
      const msg = (body && (body.msg || body.status)) || '平台未返回翻唱音频';
      this.jobs.delete(job.jobId);
      await this._safeError(job, new Error(`翻唱处理失败：${msg}`));
      return;
    }
    try {
      const rvc = require('../utils/rvcCover');
      const d = await rvc.downloadTo(dl, outDir);
      job.filePath = d.path;
      // 回调 coverUrl 可能是 .mp4（视频源时平台输出带画面翻唱）；文件名按真实扩展名，防 mp4 内容挂 .mp3 名
      const ext = path.extname(d.path) || '.mp3';
      const rawName = String(job.opts.songName || '翻唱').trim().replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || '翻唱';
      job.fileName = rawName + ext;
      job.songName = String(job.opts.songName || '翻唱').trim().slice(0, 40) || '翻唱';
      job.status = 'completed';
      this.jobs.delete(job.jobId);
      console.log(`[SongGen] cover 完成 ${job.jobId} → ${(d.size / 1024).toFixed(0)}KB${isVideoOut ? '（视频源→纯人声 vocal）' : ''}`);
      await this._safeComplete(job);
      return;
    } catch (e) {
      this.jobs.delete(job.jobId);
      await this._safeError(job, e);
      return;
    }
  }

  async _safeComplete(job) {
    try { await this.onComplete(job); } catch (e) { console.error(`[SongGen] onComplete 失败 ${job.jobId}:`, e.message); }
  }

  async _safeError(job, err) {
    console.error(`[SongGen] 任务失败 ${job.jobId}:`, err.message);
    try { await this.onError(job, err); } catch (e) { console.error('[SongGen] onError 失败:', e.message); }
  }

  stop() {
    if (this._reaper) clearInterval(this._reaper);
    this.jobs.clear();
    this.queue.length = 0;
  }
}

module.exports = { SongGenManager };
