/**
 * StewardManager —— 单号微信管家（一个独立微信号，全员加好友）
 *
 * 与 WeChatBotManager（iLink per-member 模式）的差异：
 * - 一个微信号「Anaxis」登录 iPad 协议（GeweChannel / WechatyChannel）
 * - 所有成员加它好友，按 wxid ↔ memberId 绑定表路由到各自 Agent 会话
 * - 主动发消息无 contextToken 前置限制（加好友即可发）
 *
 * 对外接口与 WeChatBotManager 兼容：
 *   sendToMember(memberId, text) / sendToMemberImage(memberId, path)
 *   getStatus() / isBotOnline(memberId) / reloadFromBackup()
 * （dailyReport 等 5 处调用零改动）
 *
 * 防风控硬指标（出站队列，按 129 人规模调整）：
 * - 同一联系人消息间隔 ≥2.5s + 随机抖动 0-2s（真人连发节奏，不机械）
 * - 全局日发送共享 ≤1500 条保险丝（无单联系人上限，防失控通知风暴）
 * - 队列扫描式调度：不同联系人交错发送，无队头阻塞（129 人并发不串联延迟）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const axios = require('axios');
const { hasAnsweredToday } = require('../agent/pushScheduler');
const { renderChartToImage } = require('../agent/chartImageRenderer');
const { getDataPath } = require('../utils/dataPath');
const { GeweChannel, CALLBACK_TOKEN } = require('./geweChannel');

// 表情包存储：data/stickers/（持久化卷，可经 CLI 远程增删）；
// 首次启动从代码内置目录 seed（不覆盖已有——用户远程更新后以卷上数据为准）。
// manifest 动态读取（mtime 缓存）：CLI 更新清单后无需重启即生效。
const BUILTIN_STICKER_DIR = path.join(__dirname, 'stickers');
const STICKER_DIR = getDataPath('stickers');
const MEDIA_STORE_FILE = getDataPath('wechat', 'media-store.json');   // mediaId→文件 登记表（重启恢复）
let _stickersCache = { mtime: 0, list: [] };

function _seedStickers() {
  try {
    const manifest = path.join(BUILTIN_STICKER_DIR, 'manifest.json');
    if (!fs.existsSync(manifest)) return;
    fs.mkdirSync(STICKER_DIR, { recursive: true });
    const dstManifest = path.join(STICKER_DIR, 'manifest.json');
    if (fs.existsSync(dstManifest)) return;   // 已有（用户更新过/已 seed）→ 不覆盖
    fs.copyFileSync(manifest, dstManifest);
    for (const f of fs.readdirSync(BUILTIN_STICKER_DIR)) {
      if (f === 'manifest.json') continue;
      try { fs.copyFileSync(path.join(BUILTIN_STICKER_DIR, f), path.join(STICKER_DIR, f)); } catch {}
    }
    console.log(`[Steward] 表情包已种子到持久卷: ${STICKER_DIR}`);
  } catch (e) {
    console.warn('[Steward] 表情包种子失败（内置清单不可用）:', e.message);
  }
}

/** 当前可用表情包（manifest mtime 变化时重读；文件缺失的条目剔除，避免发送 404） */
function getStickerList() {
  try {
    const manifest = path.join(STICKER_DIR, 'manifest.json');
    if (!fs.existsSync(manifest)) return [];
    const mtime = fs.statSync(manifest).mtimeMs;
    if (mtime !== _stickersCache.mtime) {
      const list = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      _stickersCache = {
        mtime,
        list: (Array.isArray(list) ? list : [])
          .map(s => ({ ...s, file: path.join(STICKER_DIR, s.file || `${s.id}.png`) }))
          .filter(s => s.id && s.text && fs.existsSync(s.file)),
      };
    }
  } catch { /* manifest 损坏 → 用上次缓存 */ }
  return _stickersCache.list;
}
_seedStickers();

// ---------------- 表情包转静态图（微信表情 MsgType 47 入上下文兜底） ----------------
// 微信表情消息两种形态：
//   a. 系统内置表情：XML 无 cdnurl → downloadMedia 返回 null → 只能文字标记进上下文
//   b. 自定义表情：多为 GIF 动图 → sharp 转静态 JPG 首帧（vision 友好）；
//      静态图（jpg/png/webp）且体积可控则原样直传；无 sharp / 转换失败 → 文字标记。
// 保证「发表情包」永不因格式问题扑街：要么 AI 看图，要么只有一行文字标记，不报错打断。
let _sharpMod = undefined;
function _loadSharp() {   // 惰性加载：模块缺失（生产未装）返回 null，不影响主流程
  if (_sharpMod === undefined) {
    try { _sharpMod = require('sharp'); } catch { _sharpMod = null; }
  }
  return _sharpMod;
}
let _silkWasmMod = undefined;
function _loadSilkWasm() {   // 惰性加载：未装 silk-wasm 返回 null，语音降级 [语音] 标记
  if (_silkWasmMod === undefined) {
    try { _silkWasmMod = require('silk-wasm'); } catch { _silkWasmMod = null; }
  }
  return _silkWasmMod;
}
const STICKER_VISION_BUDGET = 1_500_000;   // 与群图附图上限一致

/**
 * 表情包下载产物 → vision 可用的静态图字节（jpeg/png/webp），转不了返回 null。
 * GIF 动图取首帧转 JPG（最长边 512，控体积）；静态图且 ≤ 预算原样直传。
 */
async function stickerToStaticImage(media) {
  try {
    if (!media || !media.path || !fs.existsSync(media.path)) return null;
    const buf = fs.readFileSync(media.path);
    if (!buf || buf.length === 0) return null;
    const mime = String(media.mime || '');
    if (/^image\/(jpeg|png|webp)$/i.test(mime) && buf.length <= STICKER_VISION_BUDGET) return buf;
    const sharp = _loadSharp();
    if (!sharp) return null;                       // 无图像库：GIF/大图转不了
    const jpg = await sharp(buf, { animated: false })
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer()
      .catch(() => null);
    return jpg && jpg.length > 0 && jpg.length <= STICKER_VISION_BUDGET ? jpg : null;
  } catch { return null; }
}

// ---------------------- 出站敏感词过滤（微信风控规避） ----------------------
// 模型输出含 军/排长 等军事字词时，出站前谐音替换（军→菌、排长→派长）——
// 军校班日常词汇易触发微信内容风控，账号安全优先。
// 词表 = 内置默认 ∪ data/sensitive-words.json（持久卷，CLI write --merge 可
// 远程增删，mtime 缓存动态重读，改完即生效无需重启）。
// 只作用于出站文本（发送前最后时刻替换；conversation_memory 存原文便于审计）；
// 图片/文件不经文本层不受影响；入站用户消息不过滤。

const DEFAULT_SENSITIVE_WORDS = {
  '军': '菌',
  '排长': '派长',
  '连长': '莲长',
  '营长': '赢长',
  '旅长': '履长',
  '师长': '施长',
  '部队': '布队',
};

const SENSITIVE_WORDS_FILE = getDataPath('sensitive-words.json');
let _sensitiveWordsCache = { mtime: -1, map: {}, sorted: [] };

/** 当前生效敏感词表（远程文件与内置浅合并，远程同名项优先；mtime 变化时重读） */
function getSensitiveWords() {
  try {
    let mtime = 0;
    if (fs.existsSync(SENSITIVE_WORDS_FILE)) mtime = fs.statSync(SENSITIVE_WORDS_FILE).mtimeMs;
    if (mtime !== _sensitiveWordsCache.mtime) {
      let remote = {};
      if (mtime > 0) {
        try { remote = JSON.parse(fs.readFileSync(SENSITIVE_WORDS_FILE, 'utf8')); } catch { /* 文件损坏 → 忽略，仅用内置 */ }
      }
      const map = { ...DEFAULT_SENSITIVE_WORDS };
      for (const [k, v] of Object.entries(remote)) {
        if (typeof k === 'string' && k && typeof v === 'string' && v) map[k] = v;
      }
      // 长 key 优先（如「军长」在「军」前替换），避免单字先命中破坏多字词条
      _sensitiveWordsCache = { mtime, map, sorted: Object.keys(map).sort((a, b) => b.length - a.length) };
    }
  } catch (e) { /* 读取异常 → 沿用上次缓存 */ }
  return _sensitiveWordsCache;
}

/** 出站文本谐音替换（无词表/无命中返回原文；split/join 免 regex 转义） */
function sanitizeSensitiveText(text) {
  if (typeof text !== 'string' || !text) return text;
  const { sorted, map } = getSensitiveWords();
  if (sorted.length === 0) return text;
  let out = text;
  for (const key of sorted) out = out.split(key).join(map[key]);
  return out;
}

const BINDINGS_FILE = getDataPath('wechat_bindings.json');
const GROUPS_FILE = getDataPath('wechat_groups.json');
const adminCtx = require('../data/adminContexts');
const ordinaryUsers = require('../data/ordinaryUsers');
const overdrive = require('../utils/overdriveState');
const { AntiRepeat } = require('../utils/antirepeat');
const handoff = require('../utils/overdriveHandoff');

// 防复读：模型连续输出相同文本时的固定转向话术 + 注入引擎的打破事件
const REPEAT_TURN_LINE = '（我好像卡住重复了，你先换个说法，或者让我停下重来～）';
const REPEAT_BREAK_EVENT = '你刚才的回复连续重复多次，疑似陷入复读循环。停止复读：不要重复之前任何一句。说明你刚才卡在哪里，或请她把问题换个说法再问一遍。';
const WELCOME = '你好，我是班级管家 Anaxis～\n回复 绑定 姓名 密码 开始使用（例如：绑定 张三 xxx123）\n换手机不用解绑，直接重新绑定即可（旧设备自动下线）\n不用了想退出：回复 解绑 姓名 密码\n忘记密码或绑不上：联系管理员处理\n管理员请回复 管理员登录 名称 管理员密码\n也可以直接发我图片/表格，我来帮你录入。';
const BINDING_HINT = '你还没有绑定账号。请回复 绑定 姓名 密码（例如：绑定 张三 xxx123）完成绑定。\n换账号或不再使用：回复 解绑 姓名 密码 解除绑定。\n管理员请回复 管理员登录 名称 管理员密码。';
const ADMIN_LOGIN_HINT = '管理员登录两步就好：\n发送 管理员登录 名称 管理员密码（例如：管理员登录 张三 admin123）\n（名称自己定，用来保存你的独立对话上下文，换设备后用同一名称登录即可继续；密码即管理员密码）';

const OUTBOUND_MIN_INTERVAL = 2500;      // 同联系人最小间隔 2.5s（真人连发节奏）
const OUTBOUND_JITTER_MAX = 2000;        // 随机抖动上限 2s
const DAILY_LIMIT = 1500;                // 全局日发送上限（保险丝：正常聊天碰不到，防失控场景）

class StewardManager {
  constructor({ engine, channel, overdrive: overdriveMgr }) {
    if (!engine) throw new Error('engine is required');
    this.engine = engine;
    // 超限 runtime 管理器（DSH_ENGINE=1 时由 index.js 注入；未注入=超限不可用）
    this.overdriveMgr = overdriveMgr || null;
    // 防复读（Phase6）：行级查重 + 连续重复转向；键 = 会话引擎成员标识
    this.antiRepeat = new AntiRepeat();
    // 通道：默认 GeweChannel；未来平移 PadLocal 时传 WechatyChannel 实例
    this.channel = channel || new GeweChannel();
    this.bindings = this._loadBindings();       // { wxid → memberId }
    this.reverse = {};                          // { memberId → wxid }
    this._rebuildReverse();

    // 出站节流队列
    this._outboundQueue = [];                   // [{ wxid, type, text|imagePath, resolve }]
    this._lastSentTo = {};                      // { wxid → timestamp }
    this._dailyCount = 0;
    this._dailyDate = new Date().toDateString();
    this._draining = false;

    // 消息处理并发保护（每成员独立，复用 engine.isProcessing 语义）
    this._memberBusy = new Set();

    // 注入排队提示去重：一轮处理中只提示一次（后续消息静默入队，
    // AI 会在 drain 轮统一看到，刷提示反而打断聊天节奏）
    this._queueNotified = new Set();
    // 超限 busy 期间的"收到"提示去重（语义同上）
    this._odNotified = new Set();

    // 绑定流程中的待确认状态：{ wxid → { memberId, step } }
    this._pendingBind = new Map();

    // 绑定防爆破：连续 5 次密码错误锁 30 分钟
    this._bindFails = new Map();    // { wxid → { count, lockedUntil } }

    // 绑定引导发送去重：同一 wxid 的被动引导只发一次（主动输入绑定类指令仍逐次回应），防刷屏
    this._bindHinted = new Set();   // 键: 'dm:{wxid}' | 'group:{chatroomId}:{wxid}'

    // 入站媒体库（用户发来的图片/文件）：mediaId → { path, kind, mime, fileName, fromMember, ts }
    // 供 AI 转发工具（class_send_message mediaId）引用；24h TTL + 容量上限。
    // 登记表持久化到 MEDIA_STORE_FILE——部署重启后恢复（否则旧 mediaId 作参考图会「媒体不存在」）
    this._mediaStore = new Map();
    this._loadMediaStore();

    // 群聊开关（data/groups.json）：chatroomId → { enabled, name, ts, scheduleNotify }
    // 默认关闭：管理员在群里 @Anaxis 激活，「Anaxis 下线」停用；
    // scheduleNotify（默认 true）：公共日程到点是否推送到群里
    this.groups = this._loadGroups();
    // 群成员昵称缓存：chatroomId → Map(wxid → nickName)（触发回复/身份标注用）
    this._groupMembers = new Map();
    // 群最近媒体（内存）：chatroomId → [{ mediaId, kind, fileName, data, mime, ts }]
    // 群图片/文件不自动触发；触发文本到达时附带最近 10 分钟的图片（vision）
    this._groupRecentMedia = new Map();
    // 群最近消息缓冲（内存）：chatroomId → [{ sender, text, ts }]，滚动上限 60 条
    // 触发回复时作为轻度上下文注入（引擎侧按字符预算动态压缩）
    this._groupRecent = new Map();
    this._GROUP_RECENT_MAX = 60;

    this._bindChannel();
    this._startMediaDiskGc();
  }

  _loadGroups() {
    try {
      if (fs.existsSync(GROUPS_FILE)) return JSON.parse(fs.readFileSync(GROUPS_FILE, 'utf8'));
    } catch (e) {}
    return {};
  }

  _saveGroups() {
    try {
      fs.mkdirSync(path.dirname(GROUPS_FILE), { recursive: true });
      fs.writeFileSync(GROUPS_FILE, JSON.stringify(this.groups, null, 2));
    } catch (e) {}
  }

  _loadBindings() {
    try {
      if (fs.existsSync(BINDINGS_FILE)) return JSON.parse(fs.readFileSync(BINDINGS_FILE, 'utf8'));
    } catch (e) {}
    return {};
  }

  _saveBindings() {
    try {
      fs.mkdirSync(path.dirname(BINDINGS_FILE), { recursive: true });
      fs.writeFileSync(BINDINGS_FILE, JSON.stringify(this.bindings, null, 2));
    } catch (e) {}
  }

  _rebuildReverse() {
    this.reverse = {};
    for (const [wxid, memberId] of Object.entries(this.bindings)) {
      this.reverse[memberId] = wxid;
    }
  }

  /** 换绑顶替：同一账号（成员/管理员上下文）只保留最新 wxid，旧设备绑定移除 */
  _evictStaleBinding(newWxid, accountId) {
    let evicted = null;
    for (const [wxid, mid] of Object.entries(this.bindings)) {
      if (wxid !== newWxid && String(mid) === String(accountId)) {
        delete this.bindings[wxid];
        evicted = wxid;
      }
    }
    return evicted;
  }

  _bindChannel() {
    this.channel.onMessage((msg) => this._onChannelMessage(msg).catch(e => {
      console.error('[Steward] 消息处理异常:', e.message);
    }));
    this.channel.onFriendship(async (req) => {
      try {
        // GeweChannel：req = {wxid, content, v3, v4, scene}（v3/v4/scene 来自回调 XML，
        // 通过好友必需）；mock 通道兼容旧签名
        await this.channel.acceptFriend(req);
        await this._enqueueOutbound(req.wxid, 'text', WELCOME);
        console.log(`[Steward] 已通过好友申请: ${req.wxid}`);
      } catch (e) {
        console.error(`[Steward] 通过好友申请失败: ${e.message}`);
      }
    });
  }

  /** 启动管家（管理员触发：返回二维码给前端渲染） */
  async start() {
    const result = await this.channel.start();
    return result;
  }

  async stop() {
    await this.channel.stop();
  }

  // ---------- 入站路由 ----------

  async _onChannelMessage(msg) {
    // 丢弃即留痕：入站报文结构变化时下面两条分支会把所有消息静默吞掉
    if (msg.isSelf) {
      console.log(`[Steward] 忽略自发消息（from=${msg.wxid} to=${msg.toWxid || '-'}）`);
      return;
    }
    if (msg.isRoom) return this._onGroupMessage(msg); // 群聊走独立路由
    if (!msg.wxid) {
      console.warn(`[Steward] 忽略无 wxid 入站（msgType=${msg.msgType}）`);
      return;
    }

    // 绑定/登录/解绑/管理员登录指令：无论是否已绑定都直接处理（已绑定的"绑定"= 换绑，
    // "解绑"= 清除）——不进 AI 对话（指令是确定性操作，不该让模型处理认证）
    // 注意：下面的媒体归一（_plainMediaText）会把它改写成可读文本，必须用 let
    let text = (msg.text || '').trim();
    if (/^(?:绑定|登录|绑定账号|登录账号|解绑|管理员登录|登录管理员|管理员登陆|管理员绑定|绑定管理员)(?:\s|$)/.test(text)) {
      return this._tryBindFlow(msg);
    }

    const memberId = this.bindings[msg.wxid];
    if (!memberId) {
      // 未绑定 → 绑定引导
      return this._tryBindFlow(msg);
    }

    // ---------- 私聊超限：开关指令 + 超限会话路由 ----------
    // 授权矩阵（免密范围 = 管理员[系统/管理员上下文] + 普通模式 guest 私聊）：
    //   - 管理员 / 管理员上下文 / 普通模式(guest)：直接说「超限」开、「关闭超限」关，无需密码；
    //   - 其他普通班级成员：开启需管理员密码（超限 管理员密码）；关闭时开启者可免密。
    const isAdminDm = this._isSystemAdmin(memberId) || adminCtx.isAdminContextId(memberId);
    const trustedDm = isAdminDm || ordinaryUsers.isOrdinaryContextId(String(memberId));
    const ovDmEnabled = !!(this.overdriveMgr && overdrive.isEnabled('dm', String(memberId)));
    const odCmd = this.overdriveMgr ? overdrive.parseOverdriveCommand(text) : null;
    if (odCmd) {
      if (odCmd.action === 'open') {
        const pwdOk = !!odCmd.rawPassword && this._verifyAdminPassword(odCmd.rawPassword);
        if (!trustedDm && !pwdOk) {
          await this._enqueueOutbound(msg.wxid, 'text', '开超限需要管理员权限：让管理员说「超限」即可；你带管理员密码也行：超限 管理员密码');
          return;
        }
        overdrive.enable('dm', String(memberId), { enabledBy: String(memberId) });
        await this._enqueueOutbound(msg.wxid, 'text', '超限模式开启～我能用完整能力（终端/文件/浏览器/装依赖等），所有操作都在你的专属工作区里，和其他会话互相隔离。想关就说 关闭超限。');
        // 异步交接：普通模式最近对话 → AI 摘要注入超限会话（冷启动缓解）
        this._fireHandoff('dm', String(memberId), 'overdrive');
        return;
      }
      if (odCmd.action === 'close') {
        const rec = overdrive.getRecord('dm', String(memberId));
        const canClose = isAdminDm || (rec && rec.enabledBy && rec.enabledBy === String(memberId));
        if (!canClose) return;   // 非管理员/非开启者：静默忽略
        overdrive.disable('dm', String(memberId));
        this.overdriveMgr && this.overdriveMgr.clearContext(String(memberId)); // 未消费的开启摘要清掉
        this.antiRepeat.reset(String(memberId));
        await this._enqueueOutbound(msg.wxid, 'text', '已关闭超限，回到普通模式啦～');
        this._fireHandoff('dm', String(memberId), 'normal');
        return;
      }
    }

    // 引用 / 合并转发（MsgType 49 appmsg）：归一文本进上下文、正常对话回复（私聊无
    // @ 检测概念：引用与合并转发都作为一条内容消息，AI 看得到并回应——内容已在此处
    // 转为纯文本，不再当作"文件"走媒体分支）
    const spDm = Number(msg.msgType) === 49 ? this._parseSpecialMsg(text) : null;
    if (spDm) {
      if (ovDmEnabled && !odCmd) {
        return this._runOverdriveTurn('dm', String(memberId), msg.wxid, {
          text: spDm.full, sessionId: null, options: { isAdmin: isAdminDm },
        });
      }
      if (this.engine.isProcessing(memberId)) {
        this.engine.injectUserMessage(memberId, spDm.full);
        if (!this._queueNotified.has(memberId)) {
          this._queueNotified.add(memberId);
          await this._enqueueOutbound(msg.wxid, 'text', '（这条收到啦～我先把上一句说完，马上就接着回你）');
        }
        return;
      }
      this._queueNotified.delete(memberId);
      return this._runAgentTurn(memberId, msg.wxid, (callbacks) =>
        this.engine.processMessageStreamWithCallback(memberId, spDm.full, null, { isAdmin: isAdminDm }, callbacks));
    }

    // 视频（MsgType 43 视频 / 62 小视频）：下载入库 + 告知 AI 可主动 class_video_understand
    // 看内容（不进 plainText 文字标记、不自动调 VL——模型按需才看，省成本）
    if (msg.msgType === 43 || msg.msgType === 62) {
      return this._handleVideoInput(memberId, msg, text);
    }
    // 其他媒体类型（34 语音 / 35 名片 / 43 视频 / 48 位置 / 62 小视频 / 63 视频号 /
    // 10002 系统消息等）：AI 能解析的解析成可读文本（位置/名片/视频号标题），解析不了
    // 的降级成文字标记——统一不再把原始 XML 塞进上下文
    const plainDm = await this._plainMediaText(msg, text);
    if (plainDm !== null) {
      text = plainDm;
      msg.text = text;   // 下游队列注入/答卷/agent turn 统一用可读文本，不再把原始 XML 塞进上下文
    }

    // 超限开启中的会话：文本/媒体都路由到超限 runtime（普通引擎不介入）
    if (ovDmEnabled && !odCmd) {
      if (msg.msgType === 3 || msg.msgType === 47 || msg.msgType === 49) {
        return this._handleOverdriveMediaInput(String(memberId), msg);
      }
      return this._runOverdriveTurn('dm', String(memberId), msg.wxid, {
        text: text || '',
        sessionId: null,
        options: { isAdmin: isAdminDm },
      });
    }

    // 图片/表情/文件（MsgType 3 图片 / 47 表情 / 49 文件）→ 多模态录入（v2 接入 dsh vision）
    if (msg.msgType === 3 || msg.msgType === 47 || msg.msgType === 49) {
      // 上轮对话处理中 → 等本轮结束再处理媒体（保留 vision 看图；否则并发 run
      // 同一 member session 会打乱上下文）。最多等 60s，超时先告知收到、不并发。
      if (this.engine.isProcessing(memberId)) {
        const free = await this._waitNotProcessing(memberId, 60000);
        if (!free) {
          await this._enqueueOutbound(msg.wxid, 'text', '收到啦，等我回完上一条就仔细看呀');
          return;
        }
      }
      return this._handleMediaInput(memberId, msg);
    }

    // 文本 → 管理员每日一问直答（仅旧引擎保留现有体验；
    // dsh 引擎走会话内回答：每日一问已由 AI 在上下文里发出，回复自然进对话，
    // AI 调 class_submit_checkin 工具落库）
    const isAdmin = this._isSystemAdmin(memberId) || adminCtx.isAdminContextId(memberId);
    const dshMode = typeof this.engine.processProactiveMessage === 'function';
    if (!dshMode && isAdmin && !hasAnsweredToday(memberId)) {
      const text = (msg.text || '').trim();
      if (text) {
        try {
          const PORT = process.env.PORT || 3001;
          const replyRes = await axios.post(`http://127.0.0.1:${PORT}/api/checkin/feedback`, {
            memberId, type: 'question', text, isAdmin: true,
          });
          const feedback = replyRes.data?.feedback || '';
          await this._enqueueOutbound(msg.wxid, 'text', `📋 ${feedback || '收到你的回答，明天见！'}`);
          return;
        } catch (e) {
          console.error(`[Steward] 管理员答题失败 ${memberId}:`, e.message);
          await this._enqueueOutbound(msg.wxid, 'text', '收到你的回答，但处理时出了点问题，稍后再试吧');
          return;
        }
      }
    }

    // 上轮对话处理中 → 注入队列（drain 轮消化：AI 说完上轮自然接上）；
    // 一轮只提示一次，后续静默入队，避免刷屏
    if (this.engine.isProcessing(memberId)) {
      this.engine.injectUserMessage(memberId, (msg.text || '').trim());
      if (!this._queueNotified.has(memberId)) {
        this._queueNotified.add(memberId);
        await this._enqueueOutbound(msg.wxid, 'text', '（这条收到啦～我先把上一句说完，马上就接着回你）');
      }
      return;
    }
    this._queueNotified.delete(memberId);

    await this._processAgentMessage(memberId, msg);
  }

  // ---------- 群聊路由 ----------

  /**
   * 群消息处理（仅文本 v1；图片/文件后续接入）：
   * - 开关：默认关闭——管理员 @Anaxis 激活（无需指令词），「Anaxis 下线/关闭」停用
   * - 触发条件：被 @Anaxis 或消息含唤醒词 Anaxis；未触发一律忽略（129 人群防刷屏/防 API 爆炸）
   * - 发送者身份：wxid → 绑定表 memberId；未绑定显示昵称（群成员缓存），AI 引导私聊绑定
   * - 隐私：群 session 人设约束——个人成绩/录入等敏感操作引导私聊，群内不展示
   */
  async _onGroupMessage(msg) {
    const chatroomId = msg.wxid;
    if (!chatroomId || chatroomId.indexOf('@chatroom') === -1) return;
    // 群消息正文 = 剥离发送者前缀后的 Content（geweChannel 已解析 senderWxid）
    let text = String(msg.text || '');
    const senderWxid = msg.senderWxid || '';
    if (senderWxid) {
      const idx = text.indexOf('\n');
      if (idx !== -1 && text.substring(0, idx).replace(/:$/, '') === senderWxid) {
        text = text.substring(idx + 1);
      }
    }
    text = text.trim();
    // 引用 / 合并转发特殊消息（MsgType 49 appmsg）：
    //   引用 → 归一文本继续正常群消息流程（被 @/含唤醒词的引用消息照常触发）；
    //   合并转发 → 只入背景上下文（下次触发时 AI 看得到），不判定 @/唤醒词、不触发
    let contentText = text;
    let wakeText = null;
    const spMsg = Number(msg.msgType) === 49 ? this._parseSpecialMsg(text) : null;
    if (spMsg) {
      if (spMsg.kind === 'chatrecord') {
        await this._groupNoteBackground(chatroomId, senderWxid, spMsg.full);
        return;
      }
      contentText = spMsg.full;
      wakeText = spMsg.selfText || '';
    }
    // 其他媒体类型（34 语音 / 35 名片 / 43 视频 / 48 位置 / 62 小视频 / 63 视频号 /
    // 10002 系统消息等）：AI 能解析的解析成可读文本，解析不了的降级成文字标记——
    // 被 @ 触发时以可读文本进上下文，未触发则经最近消息缓冲进背景；语音一律先转文字
    //（SenseVoiceSmall 免费，未触发也转——所有语音默认优先转好再进上下文）
    const plainGroup = await this._plainMediaText(msg, text);
    if (plainGroup !== null) contentText = plainGroup;
    // 触发/指令判定用文本：普通消息=正文；引用消息仅用「用户自己输入」部分，
    // 防止被引用的旧内容（可能含唤醒词）误唤醒
    const userText = wakeText !== null ? wakeText : text;
    // 进上下文的文本：@提及 → 已绑定显示班级姓名、未绑定显示微信昵称
    const displayText = await this._groupAtDisplayText(chatroomId, msg, contentText);
    // 诊断日志：群消息是否到达后端（触发/静默一眼可见）
    const gEnabled = !!this.groups[chatroomId]?.enabled;
    const gSenderId = senderWxid ? this.bindings[senderWxid] : null;
    console.log(`[Steward] 群消息 ${chatroomId} 发者=${senderWxid || '?'} 绑定=${gSenderId || '无'} 已启用=${gEnabled} @bot=${!!msg.isAtBot} 含唤醒=${/anaxis/i.test(userText)}`);
    // 群图片/表情/文件/视频（MsgType 3/47/49/43/62）：下载入库不触发（图片无法 @；
    // 防 API 爆炸），触发文本到达时附带最近图片（vision）+ 媒体 mediaId 可按需读取
    if (!spMsg && (Number(msg.msgType) === 3 || Number(msg.msgType) === 47 || Number(msg.msgType) === 49
      || Number(msg.msgType) === 43 || Number(msg.msgType) === 62)) {
      if (!this.groups[chatroomId]?.enabled) return;
      return this._ingestGroupMedia(chatroomId, msg, text);
    }
    if (!contentText) return;

    const senderMemberId = senderWxid ? this.bindings[senderWxid] : null;
    // 群管理员判定（管理员模型：不按职位）：
    // ① 管理员绑定——「管理员登录 名称 管理员密码」注册的 admin 上下文（wxid 绑定到 admin_xxx）
    // ② 系统管理员——DSH_ADMIN_IDS，当前仅周祎宸(612)
    // 班长/指导员等职位不算管理员（管理权限由密码判定，不是职位）
    const isAdminSender = !!senderMemberId && (this._isSystemAdmin(senderMemberId) || adminCtx.isAdminContextId(senderMemberId));

    // ---------- 群聊普通模式切换 ----------
    // 「@Anaxis 普通模式」→ 任意已绑定用户（不限管理员）把群切成普通模式：
    // AI 脱离班级平台，只聊天/表情/搜索/生图等；「@Anaxis 平台模式」仅管理员切回。
    // 触发词必须同时含 @Anaxis/Anaxis 与「普通模式」字面，避免误触。
    if (msg.isAtBot || /anaxis/i.test(text)) {
      if (/普通模式/.test(text)) {
        if (!senderMemberId) {
          const nick = await this._groupNick(chatroomId, senderWxid);
          await this._enqueueOutbound(chatroomId, 'text',
            `${nick ? `@${nick} ` : ''}想切普通模式呀～先私聊我发送 绑定 昵称 1006（普通模式，不入班级平台），就能在这个群用啦`);
          return;
        }
        const wasOrdinary = this.groups[chatroomId]?.mode === 'ordinary';
        this.groups[chatroomId] = { ...this.groups[chatroomId], enabled: true, mode: 'ordinary', ts: Date.now() };
        this._saveGroups();
        if (!wasOrdinary) {
          await this._enqueueOutbound(chatroomId, 'text', '好呀，这个群切成普通模式啦～我不碰班级数据，就陪大家聊天、斗图、搜图、生成图片视频～想让管理员说「@Anaxis 平台模式」切回班级模式。');
        }
        return;
      }
      if (/^(平台模式|班级模式)$/.test(text)) {
        if (!isAdminSender) return;   // 切回平台模式仅限管理员（防止普通用户把班级群降级）
        this.groups[chatroomId] = { ...this.groups[chatroomId], mode: 'platform', ts: Date.now() };
        this._saveGroups();
        await this._enqueueOutbound(chatroomId, 'text', '好，切回平台模式啦～');
        return;
      }
    }

    // ---------- 群聊超限模式（开放 dsh 完整原生能力） ----------
    // 授权矩阵：
    //   普通模式群（已脱离班级平台）：任意已绑定成员 @Anaxis 超限 免密开、@Anaxis 关闭超限 免密关；
    //   平台群：管理员 @Anaxis 超限 免密开；其他成员 @Anaxis 超限 管理员密码 开；关闭 → 管理员或开启者。
    // 指令解析见 utils/overdriveState（防日常误伤）。真正的能力切换由 OverdriveManager 承接。
    if (this.overdriveMgr) {
      const ovCmd = overdrive.parseOverdriveCommand(userText);
      if (ovCmd && (msg.isAtBot || /anaxis/i.test(userText))) {
        const roomKey = chatroomId;
        const isOrdGroup = this.groups[chatroomId]?.mode === 'ordinary';
        const isBound = !!senderMemberId;
        // 普通模式群：任意已绑定成员免密开/关（群内人人平等）
        if (isOrdGroup && isBound && ovCmd.action === 'open') {
          if (!this.groups[chatroomId]?.enabled) {
            this.groups[chatroomId] = { ...this.groups[chatroomId], enabled: true, ts: Date.now() };
            this._saveGroups();
          }
          overdrive.enable('group', roomKey, { enabledBy: senderMemberId });
          await this._enqueueOutbound(chatroomId, 'text',
            '超限模式开启～这个群里我能用完整能力（终端/文件/浏览器/装依赖等），所有操作都在本群专属工作区里，不碰班级数据。想关就 @Anaxis 关闭超限。');
          // 异步交接：普通群对话 → AI 摘要注入超限群会话（冷启动缓解）
          this._fireHandoff('group', roomKey, 'overdrive');
          return;
        }
        if (isOrdGroup && isBound && ovCmd.action === 'close') {
          overdrive.disable('group', roomKey);
          this.overdriveMgr.clearContext(roomKey); // 未消费的开启摘要清掉
          this.antiRepeat.reset(`group-${roomKey}`);
          await this._enqueueOutbound(chatroomId, 'text', '已关闭超限，回到普通模式啦～');
          this._fireHandoff('group', roomKey, 'normal');
          return;
        }
        // 普通模式群里的未绑定成员：不处理指令，交给下方"未绑定发言者"绑定引导；
        // 平台群照旧：管理员 @Anaxis 超限 免密开；其他成员带管理员密码；关闭 → 管理员或开启者。
        if (isOrdGroup && !isBound) {
          // fallthrough
        } else if (ovCmd.action === 'open') {
          const pwdOk = !!ovCmd.rawPassword && this._verifyAdminPassword(ovCmd.rawPassword);
          if (!isAdminSender && !pwdOk) {
            await this._enqueueOutbound(chatroomId, 'text',
              '开超限需要管理员权限：让管理员 @Anaxis 超限 即可；你带管理员密码也行：@Anaxis 超限 管理员密码');
            return;
          }
          // 群若未启用则随超限一并启用（管理员语境才可能走到这里）
          if (!this.groups[chatroomId]?.enabled) {
            this.groups[chatroomId] = { ...this.groups[chatroomId], enabled: true, ts: Date.now() };
            this._saveGroups();
          }
          overdrive.enable('group', roomKey, { enabledBy: senderMemberId || '' });
          await this._enqueueOutbound(chatroomId, 'text',
            '超限模式开启～这个群里我能用完整能力（终端/文件/浏览器/装依赖等），所有操作都在本群专属工作区，出群即隔离。想关就 @Anaxis 关闭超限。');
          // 异步交接：普通群对话 → AI 摘要注入超限群会话（冷启动缓解）
          this._fireHandoff('group', roomKey, 'overdrive');
          return;
        } else if (ovCmd.action === 'close') {
          const rec = overdrive.getRecord('group', roomKey);
          const canClose = isAdminSender || (rec && rec.enabledBy && rec.enabledBy === senderMemberId);
          if (!canClose) return;   // 非管理员/非开启者：静默忽略
          overdrive.disable('group', roomKey);
          this.overdriveMgr.clearContext(roomKey); // 未消费的开启摘要清掉
          this.antiRepeat.reset(`group-${roomKey}`);
          await this._enqueueOutbound(chatroomId, 'text', '已关闭超限，回到普通模式啦～');
          // 异步交接：超限群对话 → AI 摘要注入普通群会话
          this._fireHandoff('group', roomKey, 'normal');
          return;
        }
      }
    }

    // 关闭指令（管理员）：Anaxis 下线 / Anaxis 关闭
    if (/^anaxis\s*(下线|关闭|睡觉)$/i.test(text)) {
      if (!isAdminSender) return;   // 非管理员关不了，静默忽略（群里别刷存在感）
      this.groups[chatroomId] = { ...this.groups[chatroomId], enabled: false, ts: Date.now() };
      this._saveGroups();
      await this._enqueueOutbound(chatroomId, 'text', '好叭，我去睡觉了，@Anaxis 就能叫醒我～');
      return;
    }

    // 群日程通知开关（管理员）
    if (/^日程通知(开启|打开)$/.test(text)) {
      if (!isAdminSender) return;
      this.groups[chatroomId] = { ...this.groups[chatroomId], scheduleNotify: true, ts: Date.now() };
      this._saveGroups();
      await this._enqueueOutbound(chatroomId, 'text', '好，公共日程到点我会往群里提醒～');
      return;
    }
    if (/^日程通知关闭$/.test(userText)) {
      if (!isAdminSender) return;
      this.groups[chatroomId] = { ...this.groups[chatroomId], scheduleNotify: false, ts: Date.now() };
      this._saveGroups();
      await this._enqueueOutbound(chatroomId, 'text', '好，群里不再发日程提醒，私聊的还是照常哦');
      return;
    }

    // 群开关未开启：管理员 @Anaxis 即开启（无需指令词）
    if (!this.groups[chatroomId]?.enabled) {
      if (isAdminSender && (msg.isAtBot || /anaxis/i.test(text))) {
        this.groups[chatroomId] = { ...this.groups[chatroomId], enabled: true, ts: Date.now() };
        this._saveGroups();
        // 群欢迎词：AI 口吻（进群 session 上下文），失败降级静态文案
        const r = await this.sendProactiveToGroup(chatroomId, 'group_welcome').catch(() => null);
        if (r?.success) return;
        await this._enqueueOutbound(chatroomId, 'text', [
          '好耶！Anaxis 上线啦～',
          '@Anaxis 或者消息里带上 Anaxis 我就会回应；群里适合聊天、接梗、问公共信息（成绩排名这些私聊我细说哦）。',
          '管理员可以在群里安排公共日程，到点我会提醒；「日程通知关闭」可以停掉提醒。',
        ].join('\n'));
      }
      return;
    }

    // 最近消息入缓冲（含未触发消息——触发时作为轻度上下文注入；seen 水位去重）
    const senderName = senderMemberId
      ? (this._findMemberById(senderMemberId)?.name || senderWxid)
      : (await this._groupNick(chatroomId, senderWxid) || '群成员');
    const buf = this._groupRecent.get(chatroomId) || [];
    buf.push({ sender: senderName, text: contentText.substring(0, 300), ts: Date.now(), seen: false });
    if (buf.length > this._GROUP_RECENT_MAX) buf.splice(0, buf.length - this._GROUP_RECENT_MAX);
    this._groupRecent.set(chatroomId, buf);

    // 触发判定：被 @Anaxis 或消息含 Anaxis（只用 Anaxis，不识别灵枢）
    const isAwake = msg.isAtBot || /anaxis/i.test(userText);
    if (!isAwake) return;

    // 未绑定发言者：普通模式群 → 直接可 @AI（群内人人可用，不要求绑定）：
    // 用 wxid 作临时身份进会话（caller 复合 g:{群}:{wxid}，后端普通会话判定
    // 已放行娱乐工具）。平台模式群 → 轻量绑定引导（不进 AI——无 callerId 模型
    // 工具全废；普通成员涉敏感操作本就引导私聊）。
    let effectiveSenderId = senderMemberId;
    if (!effectiveSenderId) {
      const isOrdGroup = this.groups[chatroomId]?.mode === 'ordinary';
      if (isOrdGroup) {
        effectiveSenderId = senderWxid;   // 临时身份：普通模式群未绑定成员也可 @AI
      } else {
        const groupHintKey = `group:${chatroomId}:${senderWxid}`;
        if (!this._bindHinted.has(groupHintKey)) {
          this._bindHinted.add(groupHintKey);
          const nick = await this._groupNick(chatroomId, senderWxid);
          await this._enqueueOutbound(chatroomId, 'text',
            `${nick ? `@${nick} ` : ''}你好呀！我是班级管家 Anaxis～我还不认识你，先私聊我发送 绑定 姓名 密码（例如：绑定 张三 xxx123）就能用啦`);
        }
        return;
      }
    }

    // 剥掉 @Anaxis 唤醒词前缀（正文交给模型时去掉呼叫部分）
    const cleanText = displayText.replace(/@?anaxis\s*/gi, (m, off) => (off === 0 ? '' : m)).trim() || displayText;

    // 群 session（dsh）：group-{chatroomId}，发言者身份标注进上下文；
    // callerId 复合格式 g:{chatroomId}:{memberId}——后端 send 工具解析后默认回群
    const sessionId = `group-${chatroomId}`;
    const nick = await this._groupNick(chatroomId, senderWxid);
    const member = this._findMemberById(effectiveSenderId);
    const guestName = ordinaryUsers.nameOfContext(effectiveSenderId);
    const senderLabel = member ? `${member.name}（学号 ${effectiveSenderId}）`
      : guestName ? `${guestName}（普通模式）` : (nick || senderWxid);

    if (typeof this.engine.processGroupMessage !== 'function') {
      // 旧引擎不支持群聊（v1 群聊为 dsh 专属）
      return;
    }
    if (this.engine.isProcessing(sessionId)) {
      // 群聊与私聊同队列：上轮处理中 → 注入队列（drain 轮消化，AI 说完上轮自然接上）；
      // 一轮只提示一次，后续静默入队，避免刷屏
      this.engine.injectUserMessage(sessionId, `群消息 ${senderLabel}：${cleanText}`);
      if (!this._queueNotified.has(sessionId)) {
        this._queueNotified.add(sessionId);
        await this._enqueueOutbound(chatroomId, 'text', '（收到啦～我先回完上一条，马上接着回）');
      }
      return;
    }
    this._queueNotified.delete(sessionId);
    // 去重水位：只注入尚未送入会话的消息（session 历史里已有的不重发——
    // 否则群消息少于 60 条时，每次触发都会把已见过的消息整段重复注入）。
    // 当前触发消息本身直接进 session，一并标记已见。
    const unseen = buf.filter(e => !e.seen);
    const recent = unseen.slice(0, -1);
    for (const e of buf) e.seen = true;

    // 最近群媒体：10 分钟内未见的图片附带给 AI（vision），图片/文件都提示 mediaId
    //（图片可作 refImage 参考图——之前只给字节不给编号，AI 群聊拿不到图号）
    const now = Date.now();
    const recentMedia = (this._groupRecentMedia.get(chatroomId) || [])
      .filter(m => now - m.ts < 10 * 60 * 1000 && !m.seen);
    for (const m of recentMedia) m.seen = true;
    const images = recentMedia
      .filter(m => m.kind === 'image' && m.data)
      .map(m => ({ data: m.data, mimeType: m.mime || 'image/jpeg' }));
    const recentFiles = recentMedia
      .filter(m => m.kind === 'image' || m.kind === 'file' || m.kind === 'emote' || m.kind === 'video')
      .map(m => m.kind === 'emote'
        ? `表情包（${m.sender || '群成员'}发的，${m.note || '未能转图'}）`
        : m.kind === 'image'
          ? `${m.mediaId}（图片，${m.sender || '群成员'}发的）`
          : m.kind === 'video'
            ? `${m.mediaId}（视频，${m.sender || '群成员'}发的；她想让你看视频内容时用 class_video_understand）`
            : `${m.mediaId}（${m.fileName}）`);
    // 超限群路由：会话处于超限 → 本消息送超限 runtime（独立上下文 + 全量原生 + 专属工作区）
    if (this.overdriveMgr && overdrive.isEnabled('group', chatroomId)) {
      // 图片过子进程协议传 base64：超大图直接附图代价高 → 提示 AI 用 ov_save_attachment 落盘再处理
      const OD_IMG_BUDGET = 1_500_000;
      const odImages = images
        .filter(im => im && im.data && im.data.length <= OD_IMG_BUDGET)
        .slice(0, 4)
        .map(im => ({ data: im.data.toString('base64'), mimeType: im.mimeType || 'image/jpeg' }));
      const odDropped = images.length - odImages.length;
      const odPayload = {
        sessionId,
        senderLabel,
        senderMemberId: String(effectiveSenderId),
        text: odDropped > 0
          ? `${cleanText}\n（另 ${odDropped} 张较大的群图片未直接附图；需要就用 class_media_list 找编号，ov_save_attachment 落盘后处理）`
          : cleanText,
        // 忙时注入（drain 轮）用的带发言者标注版本——群会话必须知道谁在说话
        injectText: `群消息 ${senderLabel}：${cleanText}`,
        recent,
        images: odImages,
        recentFiles,
        // 超限群沿用群本身模式：普通模式群超限依然不碰班级数据（仅开放原生能力+陪伴工具）
        options: { ordinary: this.groups[chatroomId]?.mode === 'ordinary' },
      };
      return this._runOverdriveTurn('group', chatroomId, chatroomId, odPayload);
    }

    await this._runAgentTurn(sessionId, chatroomId, (callbacks) =>
      this.engine.processGroupMessage(sessionId, senderLabel, String(effectiveSenderId), cleanText, callbacks,
        recent, images, recentFiles,
        { ordinary: this.groups[chatroomId]?.mode === 'ordinary' }));   // 普通模式群：AI 脱离班级平台
  }

  /**
   * 群内不触发的消息入背景缓冲（合并转发聊天记录等）：进 _groupRecent，下次有人
   * @Anaxis 触发时随 recent 一起注入 AI 上下文——AI 看得到但不因它唤醒。
   */
  async _groupNoteBackground(chatroomId, senderWxid, noteText) {
    if (!this.groups[chatroomId]?.enabled) return;
    const nick = await this._groupNick(chatroomId, senderWxid);
    const buf = this._groupRecent.get(chatroomId) || [];
    buf.push({ sender: nick || senderWxid || '群成员', text: String(noteText).substring(0, 300), ts: Date.now(), seen: false });
    if (buf.length > this._GROUP_RECENT_MAX) buf.splice(0, buf.length - this._GROUP_RECENT_MAX);
    this._groupRecent.set(chatroomId, buf);
    console.log(`[Steward] 群消息入背景（不触发）: ${String(noteText).slice(0, 40)} @ ${chatroomId}`);
  }

  /**
   * 群媒体入库（不触发 AI）：进最近消息缓冲，@/唤醒词触发时与其他最近消息
   * 一起注入上下文——图片 vision 附带（10 分钟内），文件提示 mediaId 按需读取。
   * 文件 lazy 入库（不落盘，读取时才从微信 CDN 拉）；图片立即下载（vision 要 buffer）。
   * 群内附件标记 fromGroup（群成员可读/可转发——群里本来大家可见）。
   */
  async _ingestGroupMedia(chatroomId, msg, xml) {
    const senderWxid = msg.senderWxid || '';
    const senderMemberId = senderWxid ? this.bindings[senderWxid] : null;
    const isImage = Number(msg.msgType) === 3;
    const isEmote = Number(msg.msgType) === 47;

    let entry;
    if (isImage) {
      let media = null;
      try {
        media = await this.channel.downloadMedia({ ...msg, text: xml });
      } catch (e) {
        console.error(`[Steward] 群图片下载失败 ${chatroomId}:`, e.message);
        return;
      }
      if (!media) return;
      const mediaId = this._registerMedia(media, senderMemberId || senderWxid || '', xml, chatroomId);
      console.log(`[Steward] 群图片已入库: ${mediaId} ${media.fileName} @ ${chatroomId}`);
      entry = {
        kind: 'image', mediaId, fileName: media.fileName, mime: media.mime,
        ts: Date.now(), data: null, seen: false,
      };
      try { entry.data = fs.readFileSync(media.path); } catch (e) {}
    } else if (isEmote) {
      // 群表情包：能转静态图 → 入库（后续触发时给 AI 看图）；转不了（系统表情/
      // 无直链/转换失败）→ 文字标记进上下文（触发时显示「表情包（未能转图）」）
      let media = null;
      try {
        media = await this.channel.downloadMedia({ ...msg, text: xml });
      } catch (e) {
        console.warn(`[Steward] 群表情下载失败 ${chatroomId}: ${e.message}`);
      }
      const emoteImg = media ? await stickerToStaticImage(media) : null;
      if (emoteImg) {
        const mediaId = this._registerMedia(media, senderMemberId || senderWxid || '', xml, chatroomId);
        console.log(`[Steward] 群表情转图已入库: ${mediaId} @ ${chatroomId}`);
        entry = {
          kind: 'image', mediaId, fileName: media.fileName, mime: 'image/jpeg',
          ts: Date.now(), data: emoteImg, seen: false, emote: true,
        };
      } else {
        console.log(`[Steward] 群表情无法转图（文字标记）@ ${chatroomId}`);
        entry = { kind: 'emote', ts: Date.now(), seen: false, note: '未能转图' };
      }
    } else if (Number(msg.msgType) === 43 || Number(msg.msgType) === 62) {
      // 群视频：先登记 CDN 直链（下载慢/失败不阻塞，AI 读视频走 cdnUrl），后台异步
      // 补全本地文件（供转发/朋友圈）。触发时提示 mediaId。
      const cdnUrl = this._videoCdnUrlFromXml(String(xml || '')) || '';
      const mediaId = this._registerMedia({
        kind: 'video', path: '', fileName: `video_${Date.now()}.mp4`, mime: 'video/mp4',
        size: 0, lazy: true, cdnUrl,
      }, senderMemberId || senderWxid || '', xml, chatroomId);
      console.log(`[Steward] 群视频已登记: ${mediaId} @ ${chatroomId}${cdnUrl ? '（CDN 直链就绪）' : '（待下载）'}`);
      this.channel.downloadMedia({ ...msg, text: xml }).then((media) => {
        if (!media) return;
        const ent = this._mediaStore.get(mediaId);
        if (ent) {
          ent.path = media.path;
          ent.fileName = media.fileName || ent.fileName;
          ent.mime = media.mime || ent.mime;
          ent.size = media.size;
          if (media.cdnUrl) ent.cdnUrl = ent.cdnUrl || media.cdnUrl;
          ent.lazy = false;
          this._saveMediaStore();
        }
        console.log(`[Steward] 群视频后台下载完成: ${mediaId} @ ${chatroomId}`);
      }).catch(() => {});
      entry = {
        kind: 'video', mediaId, fileName: `video.mp4`, mime: 'video/mp4',
        ts: Date.now(), seen: false, data: null,
      };
    } else {
      // 文件：lazy——只解析元信息，不下载
      const meta = this._fileMetaFromXml(xml);
      if (!meta) return;   // 非文件类 appmsg（链接卡片等），忽略
      const mediaId = this._registerMedia(
        { kind: 'file', path: '', fileName: meta.fileName, mime: '', size: 0, lazy: true },
        senderMemberId || senderWxid || '', xml, chatroomId);
      console.log(`[Steward] 群文件 lazy 入库: ${mediaId} ${meta.fileName} @ ${chatroomId}（不落盘）`);
      entry = { kind: 'file', mediaId, fileName: meta.fileName, ts: Date.now(), seen: false };
    }

    // 发送者名（缓冲标注）
    entry.sender = senderMemberId
      ? (this._findMemberById(senderMemberId)?.name || senderWxid)
      : (await this._groupNick(chatroomId, senderWxid) || '群成员');

    const list = this._groupRecentMedia.get(chatroomId) || [];
    list.push(entry);
    if (list.length > this._GROUP_RECENT_MAX) list.splice(0, list.length - this._GROUP_RECENT_MAX);
    this._groupRecentMedia.set(chatroomId, list);
  }

  /** 群成员昵称 Map（wxid → nickName）：缓存 30 分钟，缺失/过期且在线时拉取刷新。
   *  _groupMembers 值为 { ts, map }（Map 直存仅测试/兜底用）。 */
  async _groupMemberMap(chatroomId) {
    let cache = this._groupMembers.get(chatroomId);
    if (cache instanceof Map) return cache;   // 外部直接塞的裸 Map（单测），视作最新
    const stale = !cache || Date.now() - cache.ts > 30 * 60 * 1000;
    if (stale && this.channel && typeof this.channel.getChatroomMembers === 'function' && this.channel.online) {
      let map = new Map();
      try {
        const members = await this.channel.getChatroomMembers(chatroomId);
        map = new Map(members.map(m => [m.wxid, m.nickName]));
      } catch (e) { console.warn(`[Steward] 群成员拉取失败 ${chatroomId}: ${e.message}`); }
      this._groupMembers.set(chatroomId, { ts: Date.now(), map });
      cache = this._groupMembers.get(chatroomId);
    }
    return cache && cache.map instanceof Map ? cache.map : new Map();
  }

  /** 群成员昵称（缓存 30 分钟；缺失时拉一次群成员列表） */
  async _groupNick(chatroomId, wxid) {
    if (!wxid) return '';
    const map = await this._groupMemberMap(chatroomId);
    return map.get(wxid) || '';
  }

  /**
   * 解析出站文本里的 @昵称 → 群成员 wxid（真实艾特）。
   * 只精确匹配群内昵称；未匹配的忽略（文本原样保留）；艾特管家自己不算。
   */
  async _resolveGroupAt(chatroomId, text) {
    if (!String(chatroomId).endsWith('@chatroom')) return [];
    const names = [...String(text || '').matchAll(/@([^\s@，。！？、,.!?;；：“”"'《》〈〉<>（）()]+)/g)]
      .map(m => m[1].trim()).filter(Boolean);
    if (names.length === 0) return [];
    const map = await this._groupMemberMap(chatroomId);
    const out = [];
    const seen = new Set();
    for (const n of names) {
      if (/^(anaxis|灵枢|管家)$/i.test(n)) continue;   // 艾特自己没意义
      let hit = null;
      for (const [wxid, nick] of map) {
        if (nick === n) { hit = wxid; break; }
      }
      if (hit && !seen.has(hit)) { seen.add(hit); out.push(hit); }
    }
    return out;
  }

  /** 群成员 ↔ 平台用户映射（覆盖率查询：管理员/CLI 用） */
  async groupCoverage(chatroomId) {
    const members = await this.channel.getChatroomMembers(chatroomId);
    const bound = members.filter(m => this.bindings[m.wxid]);
    return {
      total: members.length,
      bound: bound.length,
      unbound: members.filter(m => !this.bindings[m.wxid])
        .map(m => ({ wxid: m.wxid, nickName: m.nickName })),
      boundList: bound.map(m => ({
        memberId: this.bindings[m.wxid], nickName: m.nickName,
      })),
      enabled: !!this.groups[chatroomId]?.enabled,
    };
  }

  _findMemberById(memberId) {
    const m = this._getMembers().find(x => String(x.id) === String(memberId));
    return m || null;
  }

  /** 发群消息（出站队列复用：chatroomId 即 wxid 键，同节奏限流） */
  async sendToGroup(chatroomId, text) {
    if (!this.channel.online) return { success: false, error: '管家未在线' };
    return this._enqueueOutbound(chatroomId, 'text', text);
  }

  /**
   * 群聊主动消息（dsh 引擎专属）：群欢迎 / 公共日程通知
   * 事件指令进群 session → AI 人设口吻生成 → 发到群里。
   * 群级开关：groups[chatroomId].scheduleNotify（日程通知用，默认 true）。
   */
  async sendProactiveToGroup(chatroomId, kind, payload = {}) {
    if (!this.groups[chatroomId]?.enabled) return { success: false, error: '群助手未开启' };
    // 普通模式群：不推送班级平台的公共日程（群已脱离平台）
    if (kind === 'schedule_notify' && this.groups[chatroomId]?.mode === 'ordinary') {
      return { success: false, skipped: true, error: '普通模式群不推送班级日程' };
    }
    if (kind === 'schedule_notify' && this.groups[chatroomId]?.scheduleNotify === false) {
      return { success: false, skipped: true, error: '群日程通知已关闭' };
    }
    if (typeof this.engine.processGroupProactiveMessage !== 'function') {
      return { success: false, error: '引擎不支持群主动消息（非 dsh 引擎）' };
    }
    const sessionId = `group-${chatroomId}`;
    // 群会话处理中 → 等待（与私聊主动消息同策略；否则群日程到点撞上群对话输出会静默丢失）
    if (this.engine.isProcessing(sessionId)) {
      const free = await this._waitNotProcessing(sessionId, 90000);
      if (!free) return { success: false, error: '群会话处理中，跳过本次主动消息' };
    }
    try {
      const result = await this._runAgentTurn(sessionId, chatroomId, (callbacks) =>
        this.engine.processGroupProactiveMessage(chatroomId, kind, payload, callbacks));
      return { success: true, content: result?.content };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // ---------- 超限（overdrive）消息路由与运行 ----------

  /** 超限会话引擎成员标识（与 OverdriveManager.engineMemberKey 同义，防循环依赖内联） */
  _odEngineKey(kind, scopeKey) {
    return kind === 'group' ? `group-${scopeKey}` : String(scopeKey);
  }

  /**
   * 超限回合执行：行级流式转发（同真人节奏逐句发出）+ 防复读 + 忙时排队提示。
   * 引擎侧（worker 子进程）由 OverdriveManager 串行承载；本方法不阻塞调用方太久：
   * 忙时返回 { queued:true }（消息已注入，AI 忙完自动接上）。
   */
  async _runOverdriveTurn(kind, scopeKey, wxid, payload = {}) {
    if (!this.overdriveMgr) return { ok: false, error: '超限不可用' };
    // dm/proactive 必须携带 worker 侧会话身份：payload 缺 memberId 时，
    // overdriveWorker 会把 undefined 字符串化成 "undefined"，引擎据此建成
    // member-undefined 空会话、记忆落 undefined_dsh_overdrive.json——
    // 身份/记忆文件/截图白名单全部失效（根因修复，单点收口覆盖所有调用点）。
    // 群消息由 sessionId 承载会话身份，无需注入。
    if (kind !== 'group' && payload.memberId === undefined) {
      payload = { ...payload, memberId: String(scopeKey) };
    }
    const engineKey = this._odEngineKey(kind, scopeKey);
    // 冷启动（worker/引擎首次拉起较慢）：先告诉她在准备
    if (!this.overdriveMgr.isReady(String(scopeKey))) {
      await this._enqueueOutbound(wxid, 'text', '（超限环境在准备，第一次会稍等一会儿～）').catch(() => {});
    }
    const onText = (text) => {
      const line = String(text || '').trim();
      if (!line) return;
      const verdict = this.antiRepeat.check(engineKey, line);
      if (verdict === 'dup') return;                       // 与上一条相同 → 丢弃
      if (verdict === 'tripped') {                         // 连续重复 → 转向 + 注入打破事件
        this._enqueueOutbound(wxid, 'text', REPEAT_TURN_LINE).catch(() => {});
        this.overdriveMgr.injectEvent(kind, scopeKey, REPEAT_BREAK_EVENT).catch(() => {});
        return;
      }
      this._enqueueOutbound(wxid, 'text', line).catch(() => {});
    };
    const r = await this.overdriveMgr.process(kind, scopeKey, payload, { onText });
    if (!r) return { ok: false, error: '超限引擎无响应' };
    if (r.queued) {
      // 忙：消息已注入（引擎 drain 会作为下一轮消化）——提示一次即可
      if (!this._odNotified.has(engineKey)) {
        this._odNotified.add(engineKey);
        await this._enqueueOutbound(wxid, 'text', '（这条收到啦～等我回完上一条就仔细回你）').catch(() => {});
      }
      return r;
    }
    this._odNotified.delete(engineKey);
    if (!r.ok && r.error) {
      console.error(`[Steward] 超限处理失败 ${scopeKey}:`, r.error);
      await this._enqueueOutbound(wxid, 'text', `抱歉，超限处理时出了点问题（${String(r.error).substring(0, 120)}）`).catch(() => {});
    }
    return r;
  }

  /** 等待某超限会话空闲（媒体/主动消息并发保护），超时返回 false */
  _waitOverdriveIdle(scopeKey, timeoutMs) {
    if (!this.overdriveMgr) return Promise.resolve(true);
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (!this.overdriveMgr.isProcessing(scopeKey)) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 2000);
      };
      check();
    });
  }

  /**
   * 模式切换交接（异步、尽力而为）：源模式的最近对话由 AI 生成摘要，
   * 作为引擎系统事件注入目标模式会话，缓解切换后的冷启动。
   *   toMode='overdrive'：普通记忆 → 超限 worker（pushContext，随下一条消息注入）
   *   toMode='normal'   ：超限记忆 → 主引擎会话（injectSystemEvent）
   */
  async _fireHandoff(kind, scopeKey, toMode) {
    try {
      const engineMember = this._odEngineKey(kind, scopeKey);
      if (toMode === 'overdrive') {
        const txt = await handoff.handoffText(engineMember, 'normal');
        if (txt && this.overdriveMgr) this.overdriveMgr.pushContext(kind, String(scopeKey), txt);
      } else {
        const txt = await handoff.handoffText(engineMember, 'overdrive');
        if (txt && this.engine && typeof this.engine.injectSystemEvent === 'function') {
          this.engine.injectSystemEvent(engineMember, txt);
        }
      }
    } catch (e) {
      console.warn('[Steward] 超限切换摘要生成失败（跳过交接）:', e.message);
    }
  }

  /** 超限私聊媒体入口：文件 → 提示 AI 落盘处理；图片 → vision（超预算提示落盘） */
  async _handleOverdriveMediaInput(memberId, msg) {
    const wxid = msg.wxid;
    if (!this.overdriveMgr) return { ok: false, error: '超限不可用' };
    const isAdmin = this._isSystemAdmin(memberId) || adminCtx.isAdminContextId(memberId);
    // 同会话媒体不并发：等当前轮结束后再附图（worker 引擎串行，避免打乱上下文）
    if (this.overdriveMgr.isProcessing(memberId)) {
      const free = await this._waitOverdriveIdle(memberId, 60000);
      if (!free) {
        await this._enqueueOutbound(wxid, 'text', '收到啦，等我回完上一条就仔细看呀');
        return;
      }
    }
    const rawXml = String(msg.text || '');

    // 文件（MsgType 49）：lazy 入库，落盘由 ov_save_attachment 按需完成
    if (Number(msg.msgType) === 49) {
      const meta = this._fileMetaFromXml(rawXml);
      if (!meta) {
        return this._enqueueOutbound(wxid, 'text', '收到，不过这个类型我处理不了呀');
      }
      const mediaId = this._registerMedia(
        { kind: 'file', path: '', fileName: meta.fileName, mime: '', size: 0, lazy: true },
        memberId, rawXml);
      const prompt = [
        `她发来文件 ${meta.fileName}（附件编号 ${mediaId}，7 天内有效）。当前是超限模式。`,
        '自然告诉她收到了。需要内容时：能用 class_read_file 直接读（表格会解析成文本）；要用命令行/脚本处理就把文件落盘——调 ov_save_attachment 存到工作区 inbox/ 后再用文件系统/终端工具处理。她若明确说了要做什么（解析/统计/转格式/批处理），该落盘就落盘、该做就做。',
      ].join('\n');
      return this._runOverdriveTurn('dm', memberId, wxid, { text: prompt, sessionId: null, options: { isAdmin } });
    }

    // 表情包（MsgType 47）：能转静态图 → 附图；系统表情/转不了 → 文字标记（不报错打断）
    if (Number(msg.msgType) === 47) {
      let emedia = null;
      try {
        emedia = await this.channel.downloadMedia(msg);
      } catch (e) {
        console.error(`[Steward] 超限表情下载失败 ${memberId}:`, e.message);
      }
      const emojiImg = emedia ? await stickerToStaticImage(emedia) : null;
      const eprompt = emojiImg
        ? '她发来一个表情包（已转成静态图，你能看到）。看图回应：斗图/表达情绪就自然接住；她若对内容提问按图回答。'
        : '她发来一个表情包（系统内置表情或无法转图，你看不到图像内容）。自然接一句就好。';
      const eimgs = emojiImg ? [{ data: emojiImg.toString('base64'), mimeType: 'image/jpeg' }] : [];
      return this._runOverdriveTurn('dm', memberId, wxid, {
        text: eprompt, sessionId: null, images: eimgs, options: { isAdmin },
      });
    }

    // 图片（MsgType 3）：立即下载 → 注册 → vision（超预算大图提示落盘后用 fs 工具读）
    let media = null;
    try {
      media = await this.channel.downloadMedia(msg);
    } catch (e) {
      console.error(`[Steward] 超限图片下载失败 ${memberId}:`, e.message);
    }
    if (!media) {
      return this._enqueueOutbound(wxid, 'text', '呜…图片取不下来，稍后再发一次试试呀');
    }
    const mediaId = this._registerMedia(media, memberId, rawXml);
    const prompt = [
      `她发来一张图片（附件编号 ${mediaId}，当前超限模式）。`,
      '看图回应她。图片较大未能直接附图时：ov_save_attachment 落盘后用文件系统/看图工具读取；她若让你照这张图做处理（转格式/识别/分析/图生视频），按需落盘处理。',
    ].join('\n');
    let imageData = null;
    try { imageData = fs.readFileSync(media.path); } catch (e) {}
    if (!imageData) {
      return this._enqueueOutbound(wxid, 'text', '呜…图片文件读不出来，再发一次试试呀');
    }
    const imgs = imageData.length <= 1_500_000
      ? [{ data: imageData.toString('base64'), mimeType: media.mime }]
      : [];
    const text = imgs.length ? prompt : `${prompt}\n（图片较大未直接附图：用 ov_save_attachment 落盘后处理）`;
    return this._runOverdriveTurn('dm', memberId, wxid, {
      text, sessionId: null, images: imgs, options: { isAdmin },
    });
  }

  /** Agent 消息处理：流式分条发送（跳句即发）+ 图表转图（从 WeChatBotManager._onMessage 移植） */
  async _processAgentMessage(memberId, msg) {
    const isAdmin = this._isSystemAdmin(memberId) || adminCtx.isAdminContextId(memberId);
    return this._runAgentTurn(memberId, msg.wxid, (callbacks) =>
      this.engine.processMessageStreamWithCallback(memberId, (msg.text || '').trim(), null, { isAdmin }, callbacks));
  }

  /**
   * AI 主动消息（dsh 引擎专属）：每日一问 / 日程通知 / 绑定欢迎等系统事件
   * 经引擎生成（人设口吻）→ 流式发微信；事件与回复都拼接入 dsh 上下文，
   * 成员回复时 AI 记得自己主动说过什么。
   * 功能开关（proactivePrefs）：daily_question / schedule_notify 关闭时跳过
   * （返回 skipped）；bind_welcome 一次性，不受开关控制。
   */
  async sendProactiveMessage(memberId, kind, payload = {}) {
    const wxid = this.reverse[String(memberId)];
    if (!wxid) return { success: false, error: `成员 ${memberId} 未绑定微信号` };
    if (typeof this.engine.processProactiveMessage !== 'function') {
      return { success: false, error: '引擎不支持主动消息（非 dsh 引擎）' };
    }
    // 普通模式用户不参与平台主动功能（每日一问/日程提醒归属班级平台）；
    // bind_welcome（普通欢迎）与 automation（自己设的定时任务）不受此限制
    if (kind !== 'bind_welcome' && kind !== 'automation' && ordinaryUsers.isOrdinaryContextId(memberId)) {
      console.log(`[Steward] 跳过主动消息 ${memberId} (${kind})：普通模式无平台主动功能`);
      return { success: false, skipped: true, error: '普通模式无平台主动功能' };
    }
    // 功能开关检查（bind_welcome 除外）
    if (kind !== 'bind_welcome') {
      const { getPrefs, FEATURE_LABELS } = require('../data/proactivePrefs');
      const prefs = getPrefs(memberId);
      if (prefs[kind] === false) {
        console.log(`[Steward] 跳过主动消息 ${memberId} (${kind})：成员已关闭`);
        return { success: false, skipped: true, error: `${FEATURE_LABELS[kind] || kind}已关闭` };
      }
    }
    // 同成员会话处理中 → 等待（避免同 session 并发 run 打乱上下文），最多 90s
    if (this.engine.isProcessing(memberId)) {
      const free = await this._waitNotProcessing(memberId, 90000);
      if (!free) return { success: false, error: '成员会话处理中，跳过本次主动消息' };
    }
    // 超限开启中的成员：主动消息（每日一问/日程提醒/定时任务等）进超限 runtime——
    // 她的回复留在超限上下文，模式语义连续（普通上下文不掺超限内容）。
    if (this.overdriveMgr && overdrive.isEnabled('dm', String(memberId))) {
      if (this.overdriveMgr.isProcessing(String(memberId))) {
        const free = await this._waitOverdriveIdle(String(memberId), 90000);
        if (!free) return { success: false, error: '成员会话处理中，跳过本次主动消息' };
      }
      try {
        const r = await this._runOverdriveTurn('proactive', String(memberId), wxid, {
          kind: 'proactive',
          memberId: String(memberId),
          proactiveKind: kind,
          proactivePayload: payload || {},
        });
        return { success: !!r.ok, content: r.content || '' };
      } catch (e) {
        console.error(`[Steward] 超限主动消息失败 ${memberId} (${kind}):`, e.message);
        return { success: false, error: e.message };
      }
    }
    try {
      const result = await this._runAgentTurn(memberId, wxid, (callbacks) =>
        this.engine.processProactiveMessage(memberId, kind, payload, callbacks));
      return { success: true, content: result?.content };
    } catch (e) {
      console.error(`[Steward] 主动消息失败 ${memberId} (${kind}):`, e.message);
      return { success: false, error: e.message };
    }
  }

  /** 执行一条到期定时任务：到点在目标会话（runFor）唤醒 AI 生成并发出（进上下文） */
  async runAutomation(auto) {
    if (!auto || !auto.prompt) return { success: false, error: '定时任务无效（缺 prompt）' };
    const owner = String(auto.runFor || auto.createdBy || '');
    if (!owner) return { success: false, error: '定时任务缺少目标会话' };
    if (owner.startsWith('group-')) return { success: false, error: '群定时任务暂不支持，请改为私聊任务' };
    const wxid = this.reverse[owner];
    if (!wxid) return { success: false, error: `目标 ${owner} 未绑定微信号` };
    console.log(`[Steward] 执行定时任务 ${auto.id}「${auto.name || ''}」 → ${owner}`);
    const r = await this.sendProactiveMessage(owner, 'automation',
      { name: auto.name || '定时任务', prompt: auto.prompt, cadence: auto.cadence })
      .catch(e => ({ success: false, error: e.message }));
    if (r?.success) return { success: true, content: r.content };
    if (r?.skipped) return { success: false, skipped: true, error: r.error };
    return { success: false, error: r?.error || '定时任务生成失败' };
  }

  /** 静默生成主动消息内容（不发送微信）：一次生成供群发复用——全员公共日程用，避免逐人单独生成 */
  async generateProactiveContent(memberId, kind, payload = {}) {
    if (typeof this.engine.processProactiveMessage !== 'function') {
      return { success: false, error: '引擎不支持主动消息（非 dsh 引擎）' };
    }
    if (this.engine.isProcessing(memberId)) {
      const free = await this._waitNotProcessing(memberId, 90000);
      if (!free) return { success: false, error: '会话处理中，跳过本次生成' };
    }
    try {
      let buffer = '';
      const silent = {
        onToken: (t) => { buffer += t; },
        onToolCall: () => {}, onToolResult: () => {},
        onChart: () => {}, onForm: () => {},
        onError: () => {}, onDone: () => {},
      };
      const result = await this.engine.processProactiveMessage(memberId, kind, payload, silent);
      return { success: true, content: result?.content || buffer };
    } catch (e) {
      console.error(`[Steward] 主动消息生成失败 ${memberId} (${kind}):`, e.message);
      return { success: false, error: e.message };
    }
  }

  /** 注入静默系统事件（进成员会话上下文，随她下一条消息一次性消费——AI 记得发过什么） */
  injectMemberEvent(memberId, text) {
    return !!(this.engine && typeof this.engine.injectSystemEvent === 'function'
      && this.engine.injectSystemEvent(String(memberId), String(text)));
  }

  /** 等待成员会话空闲（轮询 2s），超时返回 false */
  _waitNotProcessing(memberId, timeoutMs) {
    const start = Date.now();
    return new Promise((resolve) => {
      const check = () => {
        if (!this.engine.isProcessing(memberId)) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 2000);
      };
      check();
    });
  }

  /** 通用 Agent 回合执行：run(callbacks) 驱动引擎，输出流式分条发微信 + 图表转图（用户消息与主动消息共用） */
  async _runAgentTurn(memberId, wxid, run) {
    this._memberBusy.add(memberId);
    try {
      let buffer = '';
      // 流式分条：模型输出中每出现换行（一句话跳句）→ 当前行完成 → 立即入队发送。
      // 首条消息在模型输出第一行结束时（亚秒级）就出发，不等整个回复完成；
      // 后续行由出站队列按真人节奏（2.5s+抖动）连发。
      // 防复读（Phase6）：同一会话连续相同行 → 拦截丢弃；达阈值转向 + 注入打破事件。
      const sendLine = (text) => {
        const line = String(text).trim();
        if (!line) return;
        const verdict = this.antiRepeat.check(memberId, line);
        if (verdict === 'dup') return;                 // 与上一条相同 → 丢弃
        if (verdict === 'tripped') {                   // 连续重复 → 固定转向话术 + 打破事件
          this._enqueueOutbound(wxid, 'text', REPEAT_TURN_LINE).catch(() => {});
          this._injectRepeatBreak(memberId);
          return;
        }
        this._enqueueOutbound(wxid, 'text', line).catch(() => {});
      };
      const flushBuffer = () => {
        if (buffer) { sendLine(buffer); buffer = ''; }
      };

      const chartConfigs = [];

      const result = await run({
        onToken: (token) => {
          buffer += token;
          // 逐换行切分：行完成立即发（跳句即发，不等回合结束）
          let nl;
          while ((nl = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, nl);
            buffer = buffer.substring(nl + 1);
            sendLine(line);
          }
        },
        onToolCall: () => { flushBuffer(); },   // 工具调用前的文本先发出
        onToolResult: () => {},
        onChart: (data) => { if (data?.config) chartConfigs.push(data.config); },
        onForm: () => {},
        onError: () => {
          flushBuffer();
          sendLine('抱歉，处理时出现错误。');
        },
        onDone: () => { flushBuffer(); },
      });

      // 图表转图片发送
      if (chartConfigs.length > 0) {
        for (const config of chartConfigs) {
          try {
            const imagePath = await renderChartToImage(config, 600, 400);
            if (imagePath) {
              await this._enqueueOutbound(wxid, 'image', imagePath);
              console.log(`[Steward] 图表图片已发送 → ${memberId}`);
            } else {
              await this._enqueueOutbound(wxid, 'text', '图表生成失败，请稍后重试');
            }
          } catch (e) {
            console.error('[Steward] 图表发送失败:', e.message);
            await this._enqueueOutbound(wxid, 'text', '图表发送失败，可尝试用浏览器打开系统查看');
          }
        }
      }
      return result;
    } catch (err) {
      console.error(`[Steward] 消息处理失败 ${memberId}:`, err.message);
      await this._enqueueOutbound(wxid, 'text', '抱歉，处理消息时出现错误。').catch(() => {});
      return { content: '', error: err.message };
    } finally {
      this._memberBusy.delete(memberId);
    }
  }

  /** 防复读转向：向该会话引擎注入打破事件（下一轮模型输入携带，自主脱离复读） */
  _injectRepeatBreak(engineMember) {
    try {
      if (this.engine && typeof this.engine.injectSystemEvent === 'function') {
        this.engine.injectSystemEvent(String(engineMember), REPEAT_BREAK_EVENT);
      }
    } catch (e) {
      console.warn('[Steward] 防复读打破事件注入失败:', e.message);
    }
  }

  /**
   * 多模态输入（图片/文件）：
   * - CDN 下载原文件 → data/uploads/ → 注册媒体库（mediaId 供转发）
   * - 图片：vision 多模态会话（dsh 引擎，模型直接看图）
   * - 表格文件（xlsx/xls/csv）：SheetJS 解析为文本表格进会话（AI 提取/识别 → 按权限规则写入）
   * - 其他文件：告知收到 + 文件名，问需求
   */
  async _handleMediaInput(memberId, msg) {
    const isAdmin = this._isSystemAdmin(memberId) || adminCtx.isAdminContextId(memberId);
    const dshMode = typeof this.engine.processProactiveMessage === 'function';
    const rawXml = String(msg.text || '');

    // 文件（MsgType 49）：lazy 入库——不下载落盘，只记 XML；读取/转发时才按需从
    // 微信 CDN 拉（downloadCdn）/CDN 直转。大多数文件从不被读，省服务器存储与流量。
    if (Number(msg.msgType) === 49) {
      const meta = this._fileMetaFromXml(rawXml);
      if (!meta) {
        // 非 appmsg 文件（链接卡片等）：无 CDN 参数，按下载失败兜底
        return this._enqueueOutbound(msg.wxid, 'text',
          dshMode ? '收到了～不过这个类型我处理不了呀' : '收到，但该消息类型暂不支持。');
      }
      const mediaId = this._registerMedia(
        { kind: 'file', path: '', fileName: meta.fileName, mime: '', size: 0, lazy: true },
        memberId, rawXml);
      console.log(`[Steward] 文件 lazy 入库: ${mediaId} ${meta.fileName}（不落盘，读取时才从微信 CDN 拉）`);
      if (!dshMode) {
        return this._enqueueOutbound(msg.wxid, 'text', `收到你的文件 ${meta.fileName} 📎。`);
      }
      const prompt = [
        `她发来文件 ${meta.fileName}（附件编号 ${mediaId}，7 天内有效）。`,
        '先自然地告诉她收到了。需要内容时用 class_read_file 按 mediaId 读取（表格会解析成文本，按需再读，不要收到就读）。她想转发给别人时用 class_send_message 的 mediaId 参数；文件类附件会直接从微信服务器转发原文件。',
        '如果她明确说了要做什么（录入、统计、转发），该读就读、该办就办。',
      ].join('\n');
      return this._runAgentTurn(memberId, msg.wxid, (callbacks) =>
        this.engine.processMessageStreamWithCallback(memberId, prompt, null, { isAdmin }, callbacks));
    }

    // 表情包（MsgType 47）：能转图 → 静态图给 AI 看；系统表情/转不了 → 文字标记进
    // 上下文（不再报「取不下来」之类错误打断对话）
    if (Number(msg.msgType) === 47) {
      return this._handleStickerInput(memberId, msg, rawXml, dshMode, isAdmin);
    }

    // 图片：vision 需要字节，下载优先；下载失败（CDN 瞬时不稳/超时）仍登记 CDN 直链，
    // AI 需要时再重试——不让图片因一次下载失败就彻底丢失
    let media = null;
    let mediaErr = '';
    try {
      media = await this.channel.downloadMedia(msg);
    } catch (e) {
      mediaErr = e.message;
      console.error(`[Steward] 媒体下载失败 ${memberId}:`, e.message);
    }
    if (!media) {
      // 兜底：从 XML 提取 CDN 直链先登记（图片/表情 string 的 http 直链可直接用）
      const cdnUrl = this._mediaCdnUrlFromXml(Number(msg.msgType), String(rawXml || ''));
      if (cdnUrl) {
        const mediaId = this._registerMedia({
          kind: 'image', path: '', fileName: `image_${Date.now()}.jpg`, mime: 'image/jpeg',
          size: 0, lazy: true, cdnUrl,
        }, memberId, rawXml);
        console.log(`[Steward] 图片 CDN 已登记（下载失败 ${mediaErr || ''}）: ${mediaId}`);
        const prompt = [
          `她发来一张图片（附件编号 ${mediaId}，fragment 直链已登记）。当前下载没成功，可能需要稍后重试读取。`,
          '如果她问起这张图，告诉她收到了但图片暂时没加载出来，让她稍等或重新发一次；不要假装看到了内容。',
        ].join('\n');
        return this._runAgentTurn(memberId, msg.wxid, (callbacks) =>
          this.engine.processMessageStreamWithCallback(memberId, prompt, null, { isAdmin }, callbacks));
      }
      return this._enqueueOutbound(msg.wxid, 'text',
        dshMode ? '呜…这个文件我没能取下来，稍后再发一次试试呀'
          : '收到你的图片/文件，但下载失败了，请稍后重试。');
    }
    const mediaId = this._registerMedia(media, memberId, rawXml);
    console.log(`[Steward] 媒体已入库: ${mediaId} (${media.kind}, ${(media.size / 1024).toFixed(1)}KB) ${media.fileName}`);

    if (!dshMode) {
      // 旧引擎无 vision：不进对话，按 v1 语义提示（媒体文件已留存，绑定 mediaId 可转发）
      return this._enqueueOutbound(msg.wxid, 'text',
        `收到你的${media.kind === 'image' ? '图片' : `文件 ${media.fileName}`} 📎。图片识别功能需要新版对话引擎，暂时请在 App 内上传，我会第一时间处理。`);
    }

    {
      const prompt = [
        `她发来一张图片（附件编号 ${mediaId}；转发给别人用 class_send_message 的 mediaId 参数；她想「照着这张图改/合成/让图动起来」时把这个编号传给 class_generate_image / class_generate_video 的 refImage 作参考图）。`,
        '看图回应她：可能是随手分享（像朋友看图聊天）、报数据（按体能标准反应）或数据表截图。',
        '如果是成绩/体能等数据表且她要求录入系统：按人设权限规则处理——涉及官方数据上传，普通成员要么向她要管理员密码，要么用 class_request_admin 转告管理员，别口头虚报「已写入」。',
      ].join('\n');
      let imageData = null;
      try { imageData = fs.readFileSync(media.path); } catch (e) {}
      if (!imageData) {
        return this._enqueueOutbound(msg.wxid, 'text', '呜…图片文件读不出来，再发一次试试呀');
      }
      return this._runAgentTurn(memberId, msg.wxid, (callbacks) =>
        this.engine.processMessageStreamWithCallback(memberId, prompt, null,
          { isAdmin, images: [{ data: imageData, mimeType: media.mime }] }, callbacks));
    }
  }

  /**
   * 私聊表情包（MsgType 47）→ AI 上下文：
   *  - 能转静态图 → 附图（vision 看一眼再自然接住，斗图/情绪表达场景）
   *  - 系统内置表情 / 下载失败 / 转不了 → 一行文字标记进上下文（不报错打断）
   */
  async _handleStickerInput(memberId, msg, rawXml, dshMode, isAdmin) {
    if (!dshMode) {
      // 旧引擎无 vision：轻量回执即可（表情包不涉及需要解析的内容）
      return this._enqueueOutbound(msg.wxid, 'text', '收到你的表情包～');
    }
    let media = null;
    try {
      media = await this.channel.downloadMedia(msg);
    } catch (e) {
      console.error(`[Steward] 表情包下载失败 ${memberId}:`, e.message);
    }
    const imageData = media ? await stickerToStaticImage(media) : null;
    const prompt = imageData
      ? '她发来一个表情包（已转成静态图，你能看到）。看图回应：通常就是斗图/表达情绪，自然接住就好；她若对表情内容提问（是什么图/字/梗），按图回答。'
      : '她发来一个表情包（系统内置表情或无法转图，你看不到图像内容）。自然接一句就好——是表情包不是文字，她没说明意图就不用追问。';
    const ctx = imageData
      ? { isAdmin, images: [{ data: imageData, mimeType: 'image/jpeg' }] }
      : { isAdmin };
    return this._runAgentTurn(memberId, msg.wxid, (callbacks) =>
      this.engine.processMessageStreamWithCallback(memberId, prompt, null, ctx, callbacks));
  }

  /**
   * 私聊视频（MsgType 43 视频 / 62 小视频）→ 入库 + AI 上下文。
   * 下载不阻塞回复：先登记 media（带从 XML 或 downloadCdn 获得的 CDN 直链），
   * 后台异步下载补全本地 path（供转发/朋友圈）——AI 要读视频内容时
   * class_video_understand 优先直传 cdnUrl 给 VL（服务端拉取，无本地超时/清理问题）。
   */
  async _handleVideoInput(memberId, msg, rawXml) {
    const dshMode = typeof this.engine.processProactiveMessage === 'function';
    const isAdmin = this._isSystemAdmin(memberId) || adminCtx.isAdminContextId(memberId);
    const mediaIdInput = this._videoCdnUrlFromXml(String(rawXml || '')) || '';
    // 立即登记（本地文件可能尚未就绪，path 为空；cdnUrl 就绪则 AI 可直接读）
    const mediaId = this._registerMedia({
      kind: 'video', path: '', fileName: `video_${Date.now()}.mp4`, mime: 'video/mp4',
      size: 0, lazy: true, cdnUrl: mediaIdInput,
    }, memberId, rawXml);
    console.log(`[Steward] 视频已登记: ${mediaId}${mediaIdInput ? '（CDN 直链就绪）' : '（待下载）'}`);
    // 后台下载：不阻塞回复；下载成功补全 path，失败保留 cdnUrl 供 VL 读取
    this.channel.downloadMedia(msg).then((media) => {
      if (!media) { console.warn(`[Steward] 视频后台下载失败 ${memberId}（保留 CDN 直链，VL 可读）`); return; }
      const entry = this._mediaStore.get(mediaId);
      if (entry) {
        entry.path = media.path;
        entry.fileName = media.fileName || entry.fileName;
        entry.mime = media.mime || entry.mime;
        entry.size = media.size;
        if (media.cdnUrl) entry.cdnUrl = entry.cdnUrl || media.cdnUrl;
        entry.lazy = false;
        this._saveMediaStore();
      }
      console.log(`[Steward] 视频后台下载完成: ${mediaId} (${(media.size / 1024).toFixed(1)}KB)`);
    }).catch((e) => console.warn(`[Steward] 视频后台下载异常 ${memberId}:`, e.message));
    if (!dshMode) {
      return this._enqueueOutbound(msg.wxid, 'text', '收到你的视频 📹。');
    }
    const prompt = [
      `她发来一条视频（附件编号 ${mediaId}，7 天内有效${mediaIdInput ? '，CDN 直链已就绪可直接看' : ''}）。`,
      '先自然地告诉她收到了。视频画面你现在还看不到——她明确问视频里有什么/讲了什么/想知道内容时，用 class_video_understand 看（按附件编号，优先直连 CDN；视频理解有成本，别一收到就调，也别拒绝——她说要看就看）。',
    ].join('\n');
    return this._runAgentTurn(memberId, msg.wxid, (callbacks) =>
      this.engine.processMessageStreamWithCallback(memberId, prompt, null, { isAdmin }, callbacks));
  }

  /** 从视频消息 XML 提取可直连的 CDN 视频 URL（cdnvideourl/cdnurl 属性） */
  _videoCdnUrlFromXml(xml) {
    try {
      const attrM = String(xml).match(/<videomsg[^>]*\s(cdnvideourl|cdnurl)="([^"]*)"/i);
      const u = attrM ? attrM[2] : '';
      return /^https?:\/\//i.test(u) ? u.replace(/&amp;/g, '&') : '';
    } catch { return ''; }
  }

  /** 从任意媒体消息 XML 提取可直连的 CDN URL（图片/表情/语音/视频/文件）。
   *  返回空串表示无直链（消息可能已过期或字段缺失）。 */
  _mediaCdnUrlFromXml(msgType, xml) {
    try {
      const s = String(xml || '');
      const u = (t) => String(t || '').replace(/&amp;/g, '&').trim();
      const attr = (tag, name) => {
        const m = s.match(new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`));
        return m ? u(m[1]) : '';
      };
      const el = (name) => {
        const m = s.match(new RegExp(`<${name}>([^<]*)</${name}>`));
        return m ? u(m[1]) : '';
      };
      let url = '';
      if (msgType === 3) {            // 图片：高清优先，常规次之，缩略兜底
        url = attr('img', 'cdnhdimgurl') || attr('img', 'cdnmidimgurl') || attr('img', 'cdnthumburl');
      } else if (msgType === 47) {    // 表情：原图/缩略（多为 http 直链）
        url = attr('emoji', 'cdnurl') || attr('emoji', 'cdnthumburl');
      } else if (msgType === 34) {    // 语音：cdnurl 直链
        url = attr('voicemsg', 'cdnurl');
      } else if (msgType === 43 || msgType === 62) {  // 视频（走 _videoCdnUrlFromXml 语义一致）
        url = this._videoCdnUrlFromXml(s);
      } else if (msgType === 49) {    // 文件：cdnattachurl（部分需 downloadCdn 换直链，此处登记原始值）
        url = el('cdnattachurl') || el('attachid');
      }
      return /^https?:\/\//i.test(url) ? url : '';
    } catch { return ''; }
  }

  /**
   * 合并转发 recorditem → 逐条可读文本。
   * recorditem 内 CDATA 是 <dataitem><datatype>N</datatype><data>消息XML</data>…
   * 逐条提取发送者/内容/类型（文本原文、图片/表情/语音/视频/文件给标记）。
   * 成功返回 { full, count, lines }；解析失败（压缩/异形结构）返回 null 由调用方兜底。
   */
  _parseChatRecord(xml) {
    try {
      const u = (t) => String(t || '').trim()
        .replace(/&lt;(\/?\w+)&gt;/g, '<$1>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
      const rm = String(xml).match(/<recorditem[\s\S]*?(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/recorditem>/i);
      if (!rm) return null;
      const inner = rm[1];
      const items = [];
      for (const m of inner.matchAll(/<dataitem>([\s\S]*?)<\/dataitem>/g)) items.push(m[1]);
      if (items.length === 0) return null;
      const lines = [];
      for (const item of items) {
        const data = (item.match(/<data>([\s\S]*?)<\/data>/) || [])[1] || item;
        const msgXml = u(data);
        const fu = msgXml.match(/<(?:fromusername|FromUserName)>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/(?:fromusername|FromUserName)>/i);
        const sender = fu ? fu[1].trim() : '';
        const head = sender ? `${sender}：` : '';
        const cM = msgXml.match(/<content>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/);
        const titleM = msgXml.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        const title = titleM ? u(titleM[1]) : '';
        let text;
        if (/<img\b/i.test(msgXml)) text = '[图片]';
        else if (/<emoji\b/i.test(msgXml)) text = '[表情]';
        else if (/<voice\b/i.test(msgXml)) text = '[语音]';
        else if (/<vedio\b|<video\b/i.test(msgXml)) text = '[视频]';
        else if (/<appmsg\b/i.test(msgXml)) text = `[${title || '消息'}]`;
        else if (cM) {
          text = u(cM[1]).replace(/^<\s*msgsource[\s\S]*?<\/\s*msgsource>\s*/i, '').trim() || '[消息]';
        } else {
          text = '[消息]';
        }
        text = text.replace(/\u2005/g, ' ').replace(/<[^>]+>/g, '').trim() || '[消息]';
        lines.push(`${head}${text}`.trim());
      }
      if (lines.length === 0) return null;
      const MAX_NOTE_LINES = 20;
      const shown = lines.slice(0, MAX_NOTE_LINES);
      const note = shown.join('\n')
        + (lines.length > MAX_NOTE_LINES ? `\n…（共 ${lines.length} 条，以上展示前 ${MAX_NOTE_LINES} 条）` : '');
      return { full: `【合并转发的聊天记录】\n${note}`, count: lines.length, lines };
    } catch { return null; }
  }

  /**
   * 群消息文本里的 @提及 → 可读名字：
   * 已绑定成员的 wxid → 班级姓名；未绑定 → 微信昵称（AtUsers/msgSource 与群成员缓存补全）。
   * 只替换 @wxid / @昵称 整段，不影响正文其他内容。
   */
  async _groupAtDisplayText(chatroomId, msg, rawText) {
    const raw = String(rawText || '');
    if (!raw.includes('@')) return raw;
    const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const ats = [];
    try {
      for (const u of (msg.raw?.AtUsers || msg.raw?.atUsers || msg.raw?.AtUsersList || [])) {
        ats.push({
          wxid: String(u.wxid || u.Wxid || u.userName || u.UserName || ''),
          nick: String(u.nickName || u.NickName || u.nick || u.Nick || ''),
        });
      }
    } catch {}
    try {
      const sm = String(msg.raw?.MsgSource || msg.raw?.msgSource || '').match(/<atuserlist>(.*?)<\/atuserlist>/);
      if (sm) {
        for (const id of sm[1].split(',').map((x) => x.trim()).filter(Boolean)) {
          if (!ats.some((a) => a.wxid === id)) ats.push({ wxid: id, nick: '' });
        }
      }
    } catch {}
    if (ats.length === 0) return raw;
    let map = null;
    let out = raw;
    for (const a of ats) {
      if (!a.wxid) continue;
      if (!map) map = await this._groupMemberMap(chatroomId);
      const nick = a.nick || map.get(a.wxid) || '';
      const boundId = this.bindings[a.wxid];
      const show = boundId
        ? (this._findMemberById(boundId)?.name || nick || a.wxid)
        : (nick || a.wxid);
      if (!show) continue;
      // 文本里的 @wxid → 显示名；@微信昵称 → 显示名（微信昵称与显示名不同时才换）
      if (show !== a.wxid) {
        out = out.replace(new RegExp('(^|[^\\w-])@' + esc(a.wxid) + '(?=\\s|$)', 'g'), '$1@' + show);
      }
      if (nick && show !== nick) {
        out = out.replace(new RegExp('(^|[^\\w-])@' + esc(nick) + '(?=\\s|$)', 'g'), '$1@' + show);
      }
    }
    return out;
  }

  /**
   * PCM s16le → 标准 WAV（44 字节头 + 数据），喂 ASR 用。
   */
  _pcmToWav(pcm) {
    const n = pcm.length;   // 字节数（pcm_s16le 单声道）
    const buf = Buffer.alloc(44 + n);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);            // PCM
    buf.writeUInt16LE(1, 22);            // 单声道
    buf.writeUInt32LE(16000, 24);
    buf.writeUInt32LE(16000 * 2, 28);    // 字节率
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n, 40);
    Buffer.from(pcm.buffer || pcm, pcm.byteOffset || 0, n).copy(buf, 44);
    return buf;
  }

  /**
   * 微信语音 → 文字（所有语音进上下文前默认先转好，转失败才降级 [语音] 标记）。
   * 优先级：
   * ① 协议自带识别文本（RecogWord/recog/RecogText 等，客户端开自动转文字才会带，不保证有）；
   * ② 自建 ASR（OpenAI 兼容 /audio/transcriptions）——默认硅基流动 FunAudioLLM/SenseVoiceSmall
   *    （免费模型），可用环境变量 ASR_BASE_URL / ASR_API_KEY / ASR_MODEL 覆盖（如换 whisper-1）：
   *    下载语音 → silk-wasm 解码 PCM 16k → WAV → ASR。
   * 未配 ASR_API_KEY 或任一环节失败 → 返回 ''（调用方降级成 [语音] 标记，不报错打断）。
   */
  async _voiceToText(msg, xml) {
    try {
      // ① 协议自带转文字结果（部分客户端/通道会带）
      const recog = ['RecogWord', 'recog', 'RecogText', 'recognized', 'asrText']
        .map((f) => (typeof msg?.raw?.[f] === 'string' ? msg.raw[f].trim() : ''))
        .find((v) => v);
      if (recog) return recog;
      // ② 自建 ASR（默认硅基流动 SenseVoiceSmall 免费模型；未配 key 降级 [语音]）
      const base = String(process.env.ASR_BASE_URL || 'https://api.siliconflow.cn/v1').trim();
      const key = String(process.env.ASR_API_KEY || '').trim();
      if (!key) {
        console.warn('[Steward] 收到语音且协议未带转文字；未配置 ASR_API_KEY（默认硅基流动 SenseVoiceSmall），降级 [语音] 标记');
        return '';
      }
      const media = await this.channel.downloadMedia({ ...msg, text: xml });
      if (!media || !media.path || !fs.existsSync(media.path)) return '';
      let audioBuf = fs.readFileSync(media.path);
      if (!audioBuf || audioBuf.length === 0) return '';
      const head = audioBuf.slice(0, 12).toString('latin1');
      // 已是 wav/mp3 直接用；否则当 silk 解码
      if (!/^RIFF|^ID3|^\xff\xfb|^\xff\xf3/i.test(head)) {
        const silkWasm = _loadSilkWasm();
        if (!silkWasm) {
          console.warn('[Steward] 无 silk-wasm 解码库，语音降级 [语音]');
          return '';
        }
        try {
          const dec = await silkWasm.decode(new Uint8Array(audioBuf), 16000);
          if (!dec || !dec.data || dec.data.length === 0) return '';
          audioBuf = this._pcmToWav(Buffer.from(dec.data));
        } catch (e) {
          console.warn('[Steward] silk 解码失败:', e.message);
          return '';
        }
      }
      if (!audioBuf || audioBuf.length === 0) return '';
      const fd = new FormData();
      fd.append('file', new Blob([audioBuf], { type: 'audio/wav' }), 'voice.wav');
      fd.append('model', String(process.env.ASR_MODEL || 'FunAudioLLM/SenseVoiceSmall').trim());
      const res = await axios.post(`${base.replace(/\/+$/, '')}/audio/transcriptions`, fd, {
        headers: {
          Authorization: `Bearer ${key}`,
          ...(typeof fd.getHeaders === 'function' ? fd.getHeaders() : {}),
        },
        timeout: 45000,
      });
      return String(res.data?.text || res.data?.output?.text || '').trim();
    } catch (e) {
      console.warn('[Steward] 语音转文字失败:', e.message);
      return '';
    }
  }

  /**
   * 其他媒体类型统一归一成可读文本/标记（AI 看不懂的一律不进原始 XML）：
   *   - 48 位置：解析 <location poiname/label> → [位置：xxx]
   *   - 35 名片：解析 <nickname> → [名片：xxx]
   *   - 43/62 视频/小视频：<videomsg> 内 <title>/<des> → [视频：xxx]
   *   - 63 视频号：<finderFeed finderFeedTitle> → [视频号：xxx]
   * - 34 语音：进上下文前先转文字（SenseVoiceSmall 免费，协议自带 RecogWord 优先），转失败 → [语音]
   * - 10002/57 系统消息/旧引用：剥 XML 标签，剩可读中文用原文（撤回/入群提示），否则打标记
   *   - 其余未知类型 → [微信消息]
   * 返回 null 表示类型已由其他分支处理（1 文本 / 3 图片 / 47 表情 / 49 appmsg / 37 申请 / 51 状态）。
   */
  async _plainMediaText(msg, xml, opts = {}) {
    const t = Number(msg.msgType);
    const s0 = String(xml || '');
    if (t === 1 || t === 3 || t === 47 || t === 49 || t === 51 || t === 37) return null;
    const u = (txt) => String(txt || '').trim()
      .replace(/&lt;(\/?\w+)&gt;/g, '<$1>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    const tagAttr = (tag, name) => {
      const m = s0.match(new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`));
      return m ? u(m[1]) : '';
    };
    const tagText = (tag) => {
      const m = s0.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return m ? u(m[1]) : '';
    };
    try {
      if (t === 48) {
        const label = tagAttr('location', 'poiname') || tagAttr('location', 'label');
        return label ? `[位置：${label}]` : '[位置]';
      }
      if (t === 35) {
        const nick = tagText('nickname');
        return nick ? `[名片：${nick}]` : '[名片]';
      }
      if (t === 43 || t === 62) {
        const title = tagText('title') || tagText('des');
        return title ? `[视频：${title}]` : (t === 62 ? '[小视频]' : '[视频]');
      }
      if (t === 63) {
        const title = tagAttr('finderFeed', 'finderFeedTitle') || tagAttr('finderFeed', 'description') || tagText('finderFeedTitle');
        const base = title ? `[视频号：${title}]` : '[视频号]';
        // 附视频直链：AI 想看内容时可直接拿 mediaUrl 调 class_video_understand
        const url = tagAttr('finderFeed', 'mediaUrl');
        return /^https?:\/\//i.test(url) ? `${base}\n视频链接：${url.trim()}` : base;
      }
      if (t === 34) {
        // 所有语音进上下文前默认先转文字（SenseVoiceSmall 免费）；转失败才降级 [语音]
        const asr = await this._voiceToText(msg, s0);
        return asr ? `[语音转文字]${asr}` : '[语音]';
      }
      // 10002 系统消息 / 57 旧版引用：CDATA 内容保留、剥 XML 标签，剩可读文本用原文，否则打标记
      if (t === 10002 || t === 57) {
        const plain = u(s0
          .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
          .replace(/<[^>]+>/g, ' '))
          .replace(/\s+/g, ' ').trim();
        if (plain) return plain;
        return t === 57 ? '[引用消息]' : '[系统消息]';
      }
      return '[微信消息]';
    } catch { return '[微信消息]'; }
  }

  /**
   * 解析微信特殊消息（引用 / 合并转发）XML → 归一化文本。
   * 两者都是 MsgType 49（appmsg）：
   *   - 引用消息：<appmsg type=57> 内 <refer><content>被引用原内容</content>
   *   - 合并转发：<appmsg type=19> 内 <recorditem>（合并转发合集，含逐条消息）
   *   - 链接卡片：<appmsg> 带 <url>（公众号文章/网页分享/小程序）→ 文本标识可进上下文
   * 返回 null（普通消息/解析失败）或 { kind, full, selfText, refText }：
   *   - kind='quote'：selfText=用户自己输入的当前文本（触发判定用它，防止被引用的
   *     旧内容误唤醒）；full=引用原文+自己文本（进上下文的完整内容）
   *   - kind='chatrecord'：full=合并转发逐条内容（解析失败时概括）
   *   - kind='link'：full=标题+摘要+链接（AI 可用 class_fetch_url 读正文）
   */
  _parseSpecialMsg(xml) {
    const s0b = String(xml || '').replace(/^\uFEFF/, '').trim();
    const s0 = s0b;
    try {
      // 开头放宽：支持外层 <msg>，也支持微信转发时缺外层直接 <appmsg> 的形态
      if (!/^(?:<msg\b|<appmsg\b)/i.test(s0)
        && !/<appmsg\b/i.test(s0)
        && !/<refer>/i.test(s0)
        && !/<recorditem/i.test(s0)) return null;
      const u = (t) => String(t || '').trim()
        .replace(/&lt;(\/?\w+)&gt;/g, '<$1>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
        .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
      const el = (name) => {
        const m = s0.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
        return m ? m[1] : '';
      };
      const stripCdata = (t) => String(t || '')
        .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/i, '$1');
      const title = u(stripCdata(el('title')));
      const des = u(stripCdata(el('des')));

      // 合并转发：recorditem 存在（聊天记录合集）→ 逐条解析出真实内容，AI 可读
      if (/<recorditem/i.test(s0)) {
        const cr = this._parseChatRecord(s0);
        if (cr) {
          return { kind: 'chatrecord', full: cr.full };
        }
        // 解析失败（压缩/异形结构）→ 概括兜底
        const countM = des.match(/(\d+)\s*条/);
        return {
          kind: 'chatrecord',
          full: `【合并转发】${title || '聊天记录'}${des ? `（${des}）` : ''}${countM ? `，共 ${countM[1]} 条` : ''}。这条合并转发暂无法解析出逐条内容。`,
        };
      }

      // 引用：<refer> 块存在
      const rm = s0.match(/<refer>([\s\S]*?)<\/refer>/);
      if (rm) {
        const refBlock = rm[1];
        const refText = u((refBlock.match(/<content>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/) || [])[1] || '');
        const refUser = u((refBlock.match(/<fromusr>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/fromusr>/) || [])[1] || '');
        // 用户自己输入的当前文本：showmessage → des → title（剥资源型前缀/引用尾巴）
        let selfText = u(el('showmessage')) || u(el('des'));
        if (!selfText) {
          let t = title;
          const msgSrcM = t.match(/^<\s*msgsource[^>]*>[\s\S]*?<\/\s*msgsource>\s*[\r\n]*/i);
          if (msgSrcM) t = t.slice(msgSrcM[0].length);
          t = t.split(/\n>/)[0].trim();   // 去掉「\n>原消息」尾巴（部分版本把引用拼在 title 里）
          selfText = t;
        }
        return {
          kind: 'quote',
          selfText,
          refText: refText || '(原文不可读)',
          full: `【引用】${refUser ? '来自「' + refUser + '」：' : ''}${refText || '(原文不可读)'}${selfText ? `\n她自己接着说：${selfText}` : ''}`,
        };
      }

      // 链接卡片（公众号文章/网页分享/小程序）：title + des + url → 文本进上下文，
      // AI 需要内容时用 class_fetch_url 打开链接读正文。
      // url 支持 <url> / <lowurl> / <dataurl> 子元素与 appmsg url="..." 属性（不同客户端
      // 转发公众号文章时字段形态不一，漏一个就导致整条消息掉进"处理不了"）。
      let linkUrl = u((s0.match(/<url>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/url>/) || [])[1] || '');
      if (!/^https?:\/\//i.test(linkUrl)) {
        linkUrl = u((s0.match(/<lowurl>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/lowurl>/) || [])[1] || '');
      }
      if (!/^https?:\/\//i.test(linkUrl)) {
        linkUrl = u((s0.match(/<dataurl>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/dataurl>/) || [])[1] || '');
      }
      if (!/^https?:\/\//i.test(linkUrl)) {
        const urlAttr = s0.match(/<appmsg[^>]*\surl="([^"]*)"/i);
        linkUrl = urlAttr ? u(urlAttr[1]) : '';
      }
      if (/^https?:\/\//i.test(linkUrl)) {
        return {
          kind: 'link',
          full: `【链接】${title ? `\n${title}` : ''}${des ? `\n${des}` : ''}\n链接：${linkUrl.trim()}`,
        };
      }
      // 文件类 appmsg（appattach 含真实 CDN 参数，如 .xlsx/.pdf）交给文件分支
      //（lazy 入库 + class_read_file），此处不截胡。公众号卡片常带空 appattach
      //（只有缩略图元数据、fileext/cdnattachurl 为空）→ 不满足，继续按链接处理。
      const _elA = (n) => {
        const m = s0.match(new RegExp(`<${n}>([\\s\\S]*?)</${n}>`));
        return m ? String(m[1]).trim() : '';
      };
      const _fileExt = _elA('fileext');
      const _cdnUrl = _elA('cdnattachurl') || _elA('attachid');
      if (_fileExt && _cdnUrl) return null;
      // 有 appmsg 卡片（小程序/音乐/文件等）但无 URL：标题/描述也能作为可读内容进上下文
      //（不报"处理不了"——AI 至少能回应卡片主题，链接缺失时如实说明）
      if (/<appmsg\b/i.test(s0) && (title || des)) {
        return {
          kind: 'link',
          full: `【链接卡片】${title ? `\n${title}` : ''}${des ? `\n${des}` : ''}${linkUrl ? `\n链接：${linkUrl.trim()}` : ''}\n（卡片未带可打开的网页链接）`,
        };
      }
    } catch { /* 解析失败按普通消息处理 */ }
    return null;
  }

  /** 文件消息 XML → {fileName}（不下载，只取元信息；无 CDN 参数返回 null） */
  _fileMetaFromXml(xml) {
    try {
      const u = (s) => String(s || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      const el = (name) => {
        const m = String(xml).match(new RegExp(`<${name}>([^<]*)</${name}>`));
        return m ? u(m[1]) : '';
      };
      const fileExt = el('fileext');
      const cdnUrl = el('cdnattachurl') || el('attachid');
      if (!fileExt || !cdnUrl) return null;   // 非文件类 appmsg（链接卡片等）
      const title = el('title') || `file.${fileExt}`;
      return { fileName: title, fileExt: fileExt.toLowerCase() };
    } catch (e) {
      return null;
    }
  }

  /**
   * 按需取媒体内容：lazy 入库（仅 XML 未落盘）的文件在读取/转发降级时才从
   * 微信 CDN 下载（downloadCdn）→ 回填 path 供后续复用。
   * 返回补全后的 media（含 path）；失败/过期返回 null。
   */
  async ensureMediaContent(mediaId) {
    const entry = this._mediaStore.get(String(mediaId));
    if (!entry) return null;
    if (entry.path && fs.existsSync(entry.path)) return entry;
    if (!entry.rawXml) return null;
    let media = null;
    try {
      media = await this.channel.downloadMedia({
        msgType: entry.kind === 'image' ? 3 : (entry.kind === 'video' ? 43 : 49), text: entry.rawXml,
      });
    } catch (e) {
      console.error(`[Steward] lazy 媒体按需下载失败 ${mediaId}:`, e.message);
      return null;
    }
    if (!media) return null;
    entry.path = media.path;
    entry.fileName = entry.fileName || media.fileName;
    entry.mime = entry.mime || media.mime;
    entry.size = media.size;
    // 回填新换的 CDN 直链：原始 cdnUrl（微信签名直链）可能已过期，downloadCdn 会换一条
    // 新的 7 天临时直链——写回 entry.cdnUrl，7 天登记期内初始链接失效后仍能续链读取。
    if (media.cdnUrl) entry.cdnUrl = String(media.cdnUrl).trim();
    this._saveMediaStore();
    return entry;
  }

  /** 文件 → 文本（class_read_file 后端解析；xlsx/xls/csv/txt/json） */
  parseFileForConversation(filePath) {
    return this._parseFileForConversation(filePath);
  }

  /** 媒体入库：24h TTL 清理 + 200 条容量上限，返回 mediaId（img-xxxxxxxx / file-xxxxxxxx）
   *  rawXml：原始消息 XML（文件 CDN 直转用——转发时直接复制微信服务器上的文件）
   *  fromGroup：群消息入库标记（群内文件大家可见，群成员可读/可转发） */
  _registerMedia(media, memberId, rawXml = '', fromGroup = '') {
    const now = Date.now();
    // TTL 7 天：CDN 直链（微信原始 URL 数天到数周 / downloadCdn 7 天临时直链）长于本地
    // 文件（24h 磁盘 GC）——登记期对齐 CDN，AI 才能在本地文件过期后仍按 mediaId 读取。
    for (const [id, m] of this._mediaStore) {
      if (now - m.ts > 7 * 24 * 3600 * 1000) this._mediaStore.delete(id);
    }
    while (this._mediaStore.size >= 200) {
      // 超容量：淘汰最旧
      let oldest = null, oldestTs = Infinity;
      for (const [id, m] of this._mediaStore) if (m.ts < oldestTs) { oldestTs = m.ts; oldest = id; }
      if (!oldest) break;
      this._mediaStore.delete(oldest);
    }
    const id = `${media.kind === 'image' ? 'img' : 'file'}-${crypto.randomBytes(4).toString('hex')}`;
    this._mediaStore.set(id, {
      ...media, fromMember: String(memberId),
      rawXml: rawXml || undefined, fromGroup: fromGroup || undefined, ts: now,
    });
    this._saveMediaStore();
    return id;
  }

  /** mediaId 登记表落盘（全量重写；200 条上限，写入开销可忽略） */
  _saveMediaStore() {
    try {
      fs.mkdirSync(path.dirname(MEDIA_STORE_FILE), { recursive: true });
      fs.writeFileSync(MEDIA_STORE_FILE, JSON.stringify([...this._mediaStore.entries()]));
    } catch (e) {
      console.warn('[Steward] 媒体登记表落盘失败:', e.message);
    }
  }

  /** 启动恢复：读盘重建 _mediaStore——本地文件仍在磁盘 或 仍持有 CDN 直链即可恢复
   *  （uploads GC 只清本地文件；CDN 时效更长，本地文件过期后仍可按 mediaId 用 CDN 读） */
  _loadMediaStore() {
    try {
      if (!fs.existsSync(MEDIA_STORE_FILE)) return;
      const entries = JSON.parse(fs.readFileSync(MEDIA_STORE_FILE, 'utf8'));
      if (!Array.isArray(entries)) return;
      const now = Date.now();
      for (const [id, m] of entries) {
        if (!id || !m) continue;
        if (now - (m.ts || 0) > 7 * 24 * 3600 * 1000) continue;      // 超 TTL 不恢复
        const hasPath = m.path && fs.existsSync(m.path);
        const hasCdn = m.cdnUrl && /^https?:\/\//i.test(String(m.cdnUrl));
        if (!hasPath && !hasCdn) continue;                            // 文件被 GC 且无 CDN → 不可恢复
        this._mediaStore.set(String(id), m);
      }
      if (this._mediaStore.size > 0) {
        console.log(`[Steward] 媒体登记表已恢复 ${this._mediaStore.size} 条（重启后旧 mediaId 仍可引用）`);
      }
    } catch (e) {
      console.warn('[Steward] 媒体登记表恢复失败:', e.message);
    }
  }

  /**
   * 磁盘媒体 GC（每小时）：uploads（入站媒体，24h 后过期）与 chart_images
   * （出站媒体 URL 源，48h 后基本无人再拉）过期文件删除。
   * 内存 _mediaStore 过期淘汰只删引用不删文件——这里补磁盘侧。
   */
  _startMediaDiskGc() {
    const clean = (dir, ttlMs, label) => {
      try {
        if (!fs.existsSync(dir)) return;
        const now = Date.now();
        for (const f of fs.readdirSync(dir)) {
          const fp = path.join(dir, f);
          try {
            const st = fs.statSync(fp);
            if (st.isFile() && now - st.mtimeMs > ttlMs) fs.unlinkSync(fp);
          } catch (e) {}
        }
      } catch (e) {
        console.error(`[Steward] 媒体磁盘清理失败 (${label}):`, e.message);
      }
    };
    const UPLOAD_DIR = require('./geweChannel').UPLOAD_DIR;
    const MEDIA_DIR = require('./geweChannel').MEDIA_DIR;
    setInterval(() => {
      clean(UPLOAD_DIR, 24 * 3600 * 1000, 'uploads');
      clean(MEDIA_DIR, 48 * 3600 * 1000, 'chart_images');
    }, 60 * 60 * 1000);
    console.log('[Steward] 媒体磁盘 GC 已启动（每小时：uploads 24h / chart_images 48h）');
  }

  /** 供 agent-tool 转发查询（不存在/过期 → null） */
  getMedia(mediaId) {
    const m = this._mediaStore.get(String(mediaId));
    if (!m) return null;
    if (Date.now() - m.ts > 7 * 24 * 3600 * 1000) { this._mediaStore.delete(String(mediaId)); return null; }
    return m;
  }

  /**
   * 会话可用媒体清单（AI 查历史附件编号用——上下文滚动后 AI 记不住 img-xxx，
   * 用此工具找回编号再引用）：本人（fromMember 匹配）或所在群内（fromGroup 匹配）的媒体。
   * 只返回摘要（mediaId/kind/fileName/mime），不暴露内容与发送者隐私细节。
   */
  listMedia({ memberId, chatroomId } = {}) {
    const out = [];
    const all = !memberId && !chatroomId;    // 无过滤 = 管理员全量视图（只含摘要）
    for (const [id, m] of this._mediaStore) {
      const mine = memberId && String(m.fromMember) === String(memberId);
      const inGroup = chatroomId && m.fromGroup === chatroomId;
      if (!all && !mine && !inGroup) continue;
      out.push({
        mediaId: id,
        kind: m.kind,
        fileName: m.fileName || '',
        mime: m.mime || '',
        ts: m.ts,
        senderMemberId: m.fromGroup ? (m.fromMember || '') : undefined,
      });
    }
    out.sort((a, b) => b.ts - a.ts);
    return out;
  }

  /**
   * 成员所在群列表（跨会话发群用）：候选群 = 已启用群（this.groups）∪ 缓存里出现过的群，
   * 在线时逐个确保成员缓存新鲜后按 wxid 反查。返回 [{ chatroomId, label }]，label 给 AI 识别群。
   */
  async listMemberGroups(memberId) {
    const wxid = this.reverse[String(memberId)];
    if (!wxid) return [];
    const cids = new Set(Object.keys(this.groups || {}));
    for (const cid of this._groupMembers.keys()) cids.add(String(cid));
    const out = [];
    for (const cid of cids) {
      const memberMap = await this._groupMemberMap(String(cid));
      if (!memberMap.has(wxid)) continue;
      const nicks = [...memberMap.entries()]
        .filter(([w]) => w !== wxid)
        .map(([, n]) => n).filter(Boolean);
      const selfNick = memberMap.get(wxid);
      const label = nicks.length > 0
        ? `群里有 ${[selfNick].filter(Boolean).concat(nicks.slice(0, 2)).join('、')}${nicks.length > 2 ? ` 等 ${nicks.length + 1} 人` : ''}`
        : `群（${String(cid).slice(0, 10)}）`;
      out.push({ chatroomId: String(cid), label });
    }
    return out;
  }

  /** 成员名（学号 → 姓名；找不到返回学号） */
  memberName(memberId) {
    const m = this._findMemberById ? this._findMemberById(String(memberId)) : null;
    return m && m.name ? String(m.name) : String(memberId);
  }

  /** 登记 AI 生成的媒体（生图/生视频结果）→ mediaId，供 AI 后续 class_send_media 发送 */
  registerGeneratedMedia(filePath, fileName, mime, memberId, fromGroup = '', extra = {}) {
    const kind = String(mime || '').startsWith('image/') ? 'image' : 'file';
    const size = (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })();
    return this._registerMedia(
      { kind, path: filePath, fileName, mime: mime || '', size, lazy: false, ...extra },
      memberId, '', fromGroup);
  }

  /**
   * 表格/文本文件 → 会话文本（SheetJS；前 60 行 × 15 列 markdown，超出注明）。
   * 读不了（二进制/超限）返回 null。
   */
  _parseFileForConversation(filePath) {
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    try {
      if (ext === 'xlsx' || ext === 'xls') {
        const XLSX = require('xlsx');
        const wb = XLSX.readFile(filePath);
        const parts = [];
        for (const name of wb.SheetNames.slice(0, 3)) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
          if (rows.length === 0) continue;
          const shown = rows.slice(0, 60).map(r => r.slice(0, 15));
          const md = shown.map(r => `| ${r.map(c => String(c ?? '')).join(' | ')} |`).join('\n');
          const more = rows.length > 60 ? `\n（共 ${rows.length} 行，仅展示前 60 行）` : '';
          parts.push(`【工作表 ${name}】\n${md}${more}`);
        }
        return parts.length > 0 ? parts.join('\n\n').substring(0, 8000) : null;
      }
      if (ext === 'csv' || ext === 'txt' || ext === 'json') {
        const text = fs.readFileSync(filePath, 'utf8');
        if (text.length > 8000) return `${text.substring(0, 8000)}\n（内容过长，截断）`;
        return text || null;
      }
    } catch (e) {
      console.error(`[Steward] 文件解析失败 (${ext}):`, e.message);
    }
    return null;
  }

  // ---------- 绑定/登录流程（初始身份认证，用户与管理员通用、友好兜底） ----------

  /**
   * 绑定指令宽容解析：用户常照提示文案带上「」等引号（如「绑定 张三 xxx」
   * 或 绑定「张三」xxx），正则提取剥离后再匹配，避免引号卡住登录。
   */
  _normalizeBindText(text) {
    let t = text;
    // 整句被引号包裹：剥首尾（「」『』“”‘’英文双引号，允许尾带标点）
    t = t.replace(/^[「『“”"'‘]+/, '').replace(/[」』“”"'’]+[。.!！]?$/, '');
    // 词间引号包裹姓名/密码：绑定「张三」xxx → 绑定 张三 xxx（连续引号+空白压缩）
    t = t.replace(/[「『“”"'‘’]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t;
  }

  async _tryBindFlow(msg) {
    const text = this._normalizeBindText((msg.text || '').trim());
    const wxid = msg.wxid;

    // 解绑指令（独立分支）
    if (/^解\b/.test(text) || /^解绑/.test(text)) return this._tryUnbind(msg);

    // 防爆破锁定：连续 5 次密码错误锁 30 分钟（成员密码与管理员密码共用计数）
    const fail = this._bindFails.get(wxid);
    if (fail && fail.lockedUntil > Date.now()) {
      const mins = Math.ceil((fail.lockedUntil - Date.now()) / 60000);
      return this._enqueueOutbound(wxid, 'text', `密码错误次数过多，请 ${mins} 分钟后再试。`);
    }

    // ---------- 管理员登录（独立入口）：名称 + 管理员密码 ----------
    // 名称可自由注册（首次登录即注册），只是上下文键（决定对话历史归属）；
    // 真正的身份凭证是管理员密码（config.adminPasswords，登录时校验一次）。
    const am = text.match(/^(?:管理员登录|登录管理员|管理员登陆|管理员绑定|绑定管理员)(?:\s+(\S+)(?:\s+(\S+))?)?\s*$/);
    if (am) {
      const [, name, password] = am;
      if (!name) return this._enqueueOutbound(wxid, 'text', ADMIN_LOGIN_HINT);
      if (!password) {
        return this._enqueueOutbound(wxid, 'text', `还差管理员密码：发送 管理员登录 ${name} 管理员密码`);
      }
      if (!adminCtx.validName(name)) {
        return this._enqueueOutbound(wxid, 'text', '管理员名称仅支持中文/字母/数字（1-20 字），换一个试试。');
      }
      const verify = this._verifyAdminPassword(password);
      if (verify === 'unset') {
        return this._enqueueOutbound(wxid, 'text', '系统还没有设置管理员密码，请先在后台设置后再登录。');
      }
      if (!verify) {
        const tip = this._bindFailTip(wxid);
        return this._enqueueOutbound(wxid, 'text',
          `管理员密码不对，再试一次：管理员登录 ${name} 管理员密码\n${tip}`.trim());
      }
      return this._finishAdminBind(wxid, name);
    }

    // ---------- 成员登录：姓名 + 密码（重名由密码区分，无需学号） ----------
    const m = text.match(/^(?:绑定|登录|绑定账号|登录账号)\s+(\S+)(?:\s+(\S+))?\s*$/);
    if (!m) {
      // 只发指令词没带参数 → 分步引导（含管理员入口说明）
      if (/^(?:绑定|登录|绑定账号|登录账号)$/.test(text)) {
        return this._enqueueOutbound(wxid, 'text',
          '好的，两步就好：\n发送 绑定 姓名 密码（例如：绑定 张三 xxx123，姓名用全名更准确）\n管理员请发 管理员登录 名称 管理员密码');
      }
      if (/^(?:解绑)(?:\s+\S+)?$/.test(text)) {
        return this._enqueueOutbound(wxid, 'text', '发送 解绑 姓名 密码（例如：解绑 张三 xxx123，解绑当前绑定的账号）');
      }
      // 被动兜底引导：同一 wxid 只发一次，避免每条无关消息都回一遍完整绑定文案刷屏
      const hintKey = `dm:${wxid}`;
      if (this._bindHinted.has(hintKey)) return;
      this._bindHinted.add(hintKey);
      return this._enqueueOutbound(wxid, 'text', BINDING_HINT);
    }
    const [, name, password] = m;
    if (!password) {
      return this._enqueueOutbound(wxid, 'text', `还差密码：发送 绑定 ${name} 你的密码`);
    }

    // ---------- 普通模式（不属于平台的人）：口令固定 1006 ----------
    // 「绑定 昵称 1006」→ 首次注册该昵称（普通用户集合内全局唯一），
    // 之后同昵称再登录恢复同一会话（AI 脱离平台：禁班级数据，保留聊天陪伴）。
    // 明文口令 1006 与成员 bcrypt 密码天然隔离——平台成员登录走下方 bcrypt 校验。
    if (password === ordinaryUsers.ORDINARY_PASSCODE) {
      if (!ordinaryUsers.validName(name)) {
        return this._enqueueOutbound(wxid, 'text', '昵称仅支持中文/字母/数字（1-20 字），换一个试试。');
      }
      return this._finishOrdinaryBind(wxid, name);
    }

    // 姓名解析 → 候选（全名 → 名字），密码在候选中区分重名（唯一命中即通过）
    const found = this._findMembersByName(name);
    if (found.error) return this._enqueueOutbound(wxid, 'text', found.error);
    const withPwd = found.members.filter(mm => mm.password);
    if (withPwd.length === 0) {
      return this._enqueueOutbound(wxid, 'text', `账号 ${name} 未设置密码，请联系管理员处理`);
    }
    const matched = withPwd.filter(mm => bcrypt.compareSync(password, mm.password));
    if (matched.length === 0) {
      const tip = this._bindFailTip(wxid);
      return this._enqueueOutbound(wxid, 'text', `密码不对，再试一次：绑定 ${name} 密码\n${tip}`.trim());
    }
    if (matched.length > 1) {
      return this._enqueueOutbound(wxid, 'text',
        `有多位 ${name} 的密码相同，无法确定是哪一位，请联系管理员区分账号。`);
    }
    return this._finishBind(wxid, matched[0]);
  }

  /**
   * 姓名 → 候选成员解析（不暴露学号，学号是系统内部编码）：
   * ① 全名匹配；② 名字（不带姓，兼容复姓）匹配。
   * 返回 { members }（可能多位，交给密码区分）或 { error }（未命中给出可操作提示）。
   */
  _findMembersByName(name) {
    const members = this._getMembers();
    if (members.length === 0) return { error: '班级名册还没准备好，请稍后再试' };
    const key = String(name).trim();
    // ① 全名
    const byFullName = members.filter(mm => String(mm.name || '').trim() === key);
    if (byFullName.length > 0) return { members: byFullName };
    // ② 名字（不带姓）：全名去掉姓氏后匹配（复姓用 endsWith 兜底）
    const byGivenName = members.filter(mm => {
      const n = String(mm.name || '').trim();
      return n.length >= 2 && (n.substring(1) === key || n.endsWith(key));
    });
    if (byGivenName.length > 0) return { members: byGivenName };
    return { error: `没找到 ${key} 这个人。确认姓名后重发：绑定 姓名 密码` };
  }

  /** 管理员密码校验（与后端 verifyAdminPwd 同源：config.adminPasswords bcrypt 比对） */
  _verifyAdminPassword(password) {
    if (!password) return false;
    try {
      const config = JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf8'));
      if (!config.adminPasswords || config.adminPasswords.length === 0) return 'unset';
      return config.adminPasswords.some(hash => bcrypt.compareSync(String(password), hash));
    } catch (e) {
      return false;
    }
  }

  /** 管理员登录收尾：注册上下文 + 绑定（换设备顶替）+ AI 欢迎语（说明独立上下文与能力） */
  async _finishAdminBind(wxid, name) {
    this._bindFails.delete(wxid);
    const contextId = adminCtx.contextIdOf(name);
    const evicted = this._evictStaleBinding(wxid, contextId);
    this.bindings[wxid] = contextId;
    this._saveBindings();
    this._rebuildReverse();
    const isNew = adminCtx.register(name);
    console.log(`[Steward] 管理员登录成功: ${wxid} → ${contextId}${evicted ? `（换设备，旧 ${evicted} 已移除）` : ''}${isNew ? '（新注册）' : ''}`);

    // AI 欢迎语：经 dsh 会话生成（进上下文，管理员上下文专属指令）
    const r = await this.sendProactiveMessage(contextId, 'bind_welcome',
      { adminContext: true, adminName: name, isNew }).catch(() => null);
    if (r?.success) return;

    // 降级静态文案（非 dsh 引擎 / 生成失败）
    return this._enqueueOutbound(wxid, 'text', [
      `管理员登录成功（${name}）。`,
      '你可以直接跟我对话：查班级数据、发广播通知、安排日程、处理同学的审批请求。',
      `这个管理员上下文的对话记录独立保存在「${name}」名下，换设备后用同一名称登录即可继续。`,
    ].join('\n'));
  }

  /** 普通模式绑定收尾：注册/登录 guest 上下文 + 绑定（换设备顶替）+ 普通欢迎语 */
  async _finishOrdinaryBind(wxid, name) {
    this._bindFails.delete(wxid);
    const contextId = ordinaryUsers.contextIdOf(name);
    const evicted = this._evictStaleBinding(wxid, contextId);
    this.bindings[wxid] = contextId;
    this._saveBindings();
    this._rebuildReverse();
    const { isNew } = ordinaryUsers.register(name);
    console.log(`[Steward] 普通模式绑定成功: ${wxid} → ${contextId}${evicted ? `（换设备，旧 ${evicted} 已移除）` : ''}${isNew ? '（新注册）' : ''}`);

    // AI 欢迎语：经 dsh 会话生成（普通模式专属指令，进上下文）
    const r = await this.sendProactiveMessage(contextId, 'bind_welcome',
      { ordinary: true, name, isNew }).catch(() => null);
    if (r?.success) return;

    // 降级静态文案（非 dsh 引擎 / 生成失败）：不涉及平台功能
    return this._enqueueOutbound(wxid, 'text', [
      `绑定成功，${name}！`,
      '你现在是普通模式——我不在班级平台上，只专心陪你聊天：表情包、网络搜索和图片、AI 生图/生视频都能用。',
      '换微信直接重新绑定同名即可；不用了发「解绑 昵称 1006」。',
    ].join('\n'));
  }

  /** 密码错误提示（含剩余次数警告） */
  _bindFailTip(wxid) {
    this._recordBindFail(wxid);
    const cur = this._bindFails.get(wxid);
    if (cur && cur.lockedUntil > Date.now()) {
      return '⚠️ 错误次数太多，已锁定 30 分钟。';
    }
    const left = 5 - (cur ? cur.count : 1);
    return left > 0 ? `（密码错 ${cur.count} 次，${left} 次后将临时锁定）` : '';
  }

  /** 绑定收尾：落库 + 换绑顶替（旧设备移除）+ AI 欢迎语（管理员附身份说明） */
  async _finishBind(wxid, member) {
    this._bindFails.delete(wxid);
    const evicted = this._evictStaleBinding(wxid, String(member.id));
    this.bindings[wxid] = String(member.id);
    this._saveBindings();
    this._rebuildReverse();
    console.log(`[Steward] 绑定成功: ${wxid} → ${member.id} (${member.name})${evicted ? `（换绑，旧 ${evicted} 已移除）` : ''}`);

    const isAdmin = this._isSystemAdmin(String(member.id));
    // AI 欢迎语：经 dsh 会话生成（进上下文，绑定即成为会话第一条消息，功能开关一并告知）
    const r = await this.sendProactiveMessage(String(member.id), 'bind_welcome',
      isAdmin ? { admin: true } : {}).catch(() => null);
    if (r?.success) return;

    // 降级静态文案（非 dsh 引擎 / 生成失败）：功能清单 + 管理员身份一并告知
    const lines = [
      `绑定成功，${member.name}！`,
      '你可以直接跟我聊天：记录训练数据、查班级信息、看日程；图片和文件直接发我就能看见。',
      '默认功能：每日一问（每天晚上 22:00 左右）、日程提醒——不想要随时说「关闭每日一问」或「全部关闭」。',
      '换微信要重新绑定；不用了发「解绑 姓名 密码」即可。',
    ];
    if (isAdmin) {
      lines.push('管理员模式：你的敏感操作（广播、排日程、查他人数据）免密码，同学的审批请求会转发到你这里。');
    }
    return this._enqueueOutbound(wxid, 'text', lines.join('\n'));
  }

  // 解绑：当前绑定决定凭证类型——成员（姓名+个人密码）/ 管理员上下文（名称+管理员密码）
  async _tryUnbind(msg) {
    const text = this._normalizeBindText((msg.text || '').trim());
    const wxid = msg.wxid;
    const m = text.match(/^解绑\s+(\S+)(?:\s+(\S+))?\s*$/);
    if (!m) return this._enqueueOutbound(wxid, 'text', '发送 解绑 姓名 密码（例如：解绑 张三 xxx123）');
    const [, idOrName, password] = m;
    if (!password) return this._enqueueOutbound(wxid, 'text', `还差密码：发送 解绑 ${idOrName} 密码`);
    const current = this.bindings[wxid];

    // 管理员上下文解绑
    if (adminCtx.nameOfContext(current)) {
      const name = adminCtx.nameOfContext(idOrName) || idOrName;   // 兼容 admin-名称 或裸名称
      if (adminCtx.contextIdOf(name) !== current) {
        return this._enqueueOutbound(wxid, 'text', '该微信没有绑定这个管理员名称');
      }
      if (!this._verifyAdminPassword(password)) {
        return this._enqueueOutbound(wxid, 'text', `解绑失败：管理员密码不正确${this._bindFailTip(wxid)}`);
      }
      delete this.bindings[wxid];
      this._saveBindings();
      this._rebuildReverse();
      console.log(`[Steward] 解绑: ${wxid} ← ${current}`);
      return this._enqueueOutbound(wxid, 'text', '已解绑。需要时重新发送 管理员登录 名称 管理员密码。');
    }

    // 普通模式（guest-*）解绑：昵称 + 固定口令 1006
    if (ordinaryUsers.nameOfContext(current)) {
      const oname = ordinaryUsers.nameOfContext(idOrName) || idOrName;
      if (ordinaryUsers.contextIdOf(oname) !== current) {
        return this._enqueueOutbound(wxid, 'text', '该微信没有绑定这个普通昵称');
      }
      if (!ordinaryUsers.checkPasscode(password)) {
        return this._enqueueOutbound(wxid, 'text', `解绑失败：普通模式口令不正确${this._bindFailTip(wxid)}`);
      }
      delete this.bindings[wxid];
      this._saveBindings();
      this._rebuildReverse();
      console.log(`[Steward] 解绑: ${wxid} ← ${current}`);
      return this._enqueueOutbound(wxid, 'text', '已解绑。需要时重新发送 绑定 昵称 1006。');
    }

    // 成员解绑：姓名 + 密码（重名由密码区分）
    const found = this._findMembersByName(idOrName);
    if (found.error) return this._enqueueOutbound(wxid, 'text', found.error);
    const matched = found.members.filter(mm => mm.password && bcrypt.compareSync(password, mm.password));
    if (matched.length !== 1) {
      return this._enqueueOutbound(wxid, 'text', `解绑失败：密码不正确${this._bindFailTip(wxid)}`);
    }
    const member = matched[0];
    if (this.bindings[wxid] !== String(member.id)) {
      return this._enqueueOutbound(wxid, 'text', '该微信没有绑定此账号');
    }
    delete this.bindings[wxid];
    this._saveBindings();
    this._rebuildReverse();
    console.log(`[Steward] 解绑: ${wxid} ← ${member.id}`);
    return this._enqueueOutbound(wxid, 'text', '已解绑。需要时重新发送 绑定 姓名 密码。');
  }

  /** 绑定密码错误计数：连续 5 次 → 锁 30 分钟 */
  _recordBindFail(wxid) {
    const cur = this._bindFails.get(wxid) || { count: 0, lockedUntil: 0 };
    cur.count += 1;
    if (cur.count >= 5) {
      cur.lockedUntil = Date.now() + 30 * 60 * 1000;
      cur.count = 0;
    }
    this._bindFails.set(wxid, cur);
  }

  _getMembers() {
    try {
      const f = getDataPath('members.json');
      if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (e) {}
    return [];
  }

  /** 系统管理员（ADMIN_MEMBER_IDS / DSH_ADMIN_IDS，与后端工具闸同源） */
  _isSystemAdmin(memberId) {
    const ids = (process.env.DSH_ADMIN_IDS || '612').split(',').map(s => s.trim()).filter(Boolean);
    return ids.includes(String(memberId));
  }

  // ---------- 出站节流队列（防风控硬指标） ----------

  _enqueueOutbound(wxid, type, payload) {
    // 出站文本统一过敏感词（谐音替换）：AI 流式分条、工具转发、提示文案
    // 全部经此入队——单一收口，无遗漏路径。替换发生在发送前最后时刻，
    // conversation_memory / 会话上下文仍存原文。
    if (type === 'text' && typeof payload === 'string') {
      payload = sanitizeSensitiveText(payload);
    }
    return new Promise((resolve) => {
      this._outboundQueue.push({ wxid, type, payload, resolve });
      if (!this._draining) this._drainQueue();
    });
  }

  async _drainQueue() {
    this._draining = true;
    while (this._outboundQueue.length > 0) {
      // 日限额：超限顺延（队列保留，次日继续）——班级低频场景几乎不会触发
      const today = new Date().toDateString();
      if (today !== this._dailyDate) {
        this._dailyDate = today;
        this._dailyCount = 0;
        this._dailyLimitWarned = false;
      }
      if (this._dailyCount >= DAILY_LIMIT) {
        if (!this._dailyLimitWarned) {
          this._dailyLimitWarned = true;
          console.warn(`[Steward] ⚠️ 触达全局日限额 ${DAILY_LIMIT}（正常聊天不应触发，疑似失控/通知风暴）。剩余 ${this._outboundQueue.length} 条顺延次日，不丢弃`);
        }
        await new Promise(r => setTimeout(r, 60 * 1000));
        continue;
      }

      // 扫描式调度：发第一条"已到期"的消息（该联系人距上次发送 ≥ 最小间隔）。
      // 不同联系人交错发送（129 人并发不串联延迟）；同联系人内部顺序天然保持
      //（lastSentTo 未更新时其后同 wxid 消息都不可能到期）。
      const now = Date.now();
      let pickIdx = -1;
      for (let i = 0; i < this._outboundQueue.length; i++) {
        const it = this._outboundQueue[i];
        const last = this._lastSentTo[it.wxid] || 0;
        if (now - last >= OUTBOUND_MIN_INTERVAL) { pickIdx = i; break; }
      }
      if (pickIdx === -1) {
        // 全部未到期：小步等待（≤1s）后重扫，不做长睡眠阻塞
        let minWait = Infinity;
        for (const it of this._outboundQueue) {
          const w = OUTBOUND_MIN_INTERVAL - (Date.now() - (this._lastSentTo[it.wxid] || 0));
          if (w > 0 && w < minWait) minWait = w;
        }
        await new Promise(r => setTimeout(r, Math.max(100, Math.min(minWait, 1000))));
        continue;
      }

      const item = this._outboundQueue.splice(pickIdx, 1)[0];

      // 人性化抖动：0-2s 再发（真人连发的自然停顿）
      const jitter = Math.floor(Math.random() * OUTBOUND_JITTER_MAX);
      if (jitter > 0) await new Promise(r => setTimeout(r, jitter));

      try {
        if (item.type === 'text') {
          // 群文本：解析 @昵称 → 真实艾特（ats 逗号串）；私聊/未匹配名字不带 ats
          const ats = String(item.wxid).endsWith('@chatroom')
            ? await this._resolveGroupAt(String(item.wxid), String(item.payload))
            : [];
          await this.channel.sendText(item.wxid, item.payload, ats);
        } else if (item.type === 'image') {
          await this.channel.sendImage(item.wxid, item.payload);
        } else if (item.type === 'file') {
          // 生成/落盘文件发送（postFile：本地文件经公网媒体端点 → 微信文件消息）
          await this.channel.sendFile(item.wxid, item.payload.path, item.payload.fileName);
        } else if (item.type === 'video') {
          // 视频消息发送（postVideo：视频+缩略图经公网媒体端点 → 微信视频卡片）
          await this.channel.sendVideo(item.wxid, item.payload.path, item.payload.thumbPath, item.payload.duration);
        } else if (item.type === 'voice') {
          // 语音条发送（postVoice：silk 文件 + 时长 → 微信语音消息）
          await this.channel.sendVoice(item.wxid, item.payload.path, item.payload.durationMs);
        } else if (item.type === 'file-forward') {
          // CDN 直转：原始 XML 转发微信服务器上的同一份文件（不经我们服务器）
          await this.channel.forwardFile(item.wxid, item.payload.xml);
        }
        this._lastSentTo[item.wxid] = Date.now();
        this._dailyCount++;
        item.resolve({ success: true });
        console.log(`[Steward] 出站 → ${item.wxid} (${item.type}, 今日 ${this._dailyCount}/${DAILY_LIMIT})`);
      } catch (e) {
        console.error(`[Steward] 出站失败 ${item.wxid}: ${e.message}`);
        item.resolve({ success: false, error: e.message });
        await new Promise(r => setTimeout(r, 3000));
      }
    }
    this._draining = false;
  }

  // ---------- 对外兼容接口（与 WeChatBotManager 同签名） ----------

  async sendToMember(memberId, text) {
    const wxid = this.reverse[String(memberId)];
    if (!wxid) return { success: false, error: `成员 ${memberId} 未绑定微信号` };
    if (!this.channel.online) return { success: false, error: '管家未在线' };
    return this._enqueueOutbound(wxid, 'text', text);
  }

  async sendToMemberImage(memberId, imagePath) {
    // 群 id 透传（@chatroom 直接作为出站 wxid，工具层群 caller 复用此出口）
    if (String(memberId).endsWith('@chatroom')) {
      if (!this.channel.online) return { success: false, error: '管家未在线' };
      return this._enqueueOutbound(String(memberId), 'image', imagePath);
    }
    const wxid = this.reverse[String(memberId)];
    if (!wxid) return { success: false, error: `成员 ${memberId} 未绑定微信号` };
    if (!this.channel.online) return { success: false, error: '管家未在线' };
    return this._enqueueOutbound(wxid, 'image', imagePath);
  }

  /** 发文件（本地路径 + 文件名；群 id 透传同 image 出口） */
  async sendToMemberFile(memberId, filePath, fileName) {
    if (String(memberId).endsWith('@chatroom')) {
      if (!this.channel.online) return { success: false, error: '管家未在线' };
      return this._enqueueOutbound(String(memberId), 'file', { path: filePath, fileName: fileName || filePath });
    }
    const wxid = this.reverse[String(memberId)];
    if (!wxid) return { success: false, error: `成员 ${memberId} 未绑定微信号` };
    if (!this.channel.online) return { success: false, error: '管家未在线' };
    return this._enqueueOutbound(wxid, 'file', { path: filePath, fileName: fileName || filePath });
  }

  /** 发视频消息（视频+缩略图+时长；群 id 透传同 image 出口） */
  async sendToMemberVideo(memberId, videoPath, thumbPath, duration) {
    const payload = { path: videoPath, thumbPath: thumbPath || '', duration: Number(duration) || 1 };
    if (String(memberId).endsWith('@chatroom')) {
      if (!this.channel.online) return { success: false, error: '管家未在线' };
      return this._enqueueOutbound(String(memberId), 'video', payload);
    }
    const wxid = this.reverse[String(memberId)];
    if (!wxid) return { success: false, error: `成员 ${memberId} 未绑定微信号` };
    if (!this.channel.online) return { success: false, error: '管家未在线' };
    return this._enqueueOutbound(wxid, 'video', payload);
  }

  /** 发语音条（silk 文件 + 时长；群 id 透传同 image 出口） */
  async sendToMemberVoice(memberId, silkPath, durationMs) {
    const payload = { path: silkPath, durationMs: Number(durationMs) || 1000 };
    if (String(memberId).endsWith('@chatroom')) {
      if (!this.channel.online) return { success: false, error: '管家未在线' };
      return this._enqueueOutbound(String(memberId), 'voice', payload);
    }
    const wxid = this.reverse[String(memberId)];
    if (!wxid) return { success: false, error: `成员 ${memberId} 未绑定微信号` };
    if (!this.channel.online) return { success: false, error: '管家未在线' };
    return this._enqueueOutbound(wxid, 'voice', payload);
  }

  /** 发歌曲文件（mp3；群 id 透传同 image 出口） */
  async sendToMemberSong(memberId, songPath, fileName) {
    return this.sendToMemberFile(memberId, songPath, fileName);
  }

  /** CDN 直转文件（原始 XML；群 id 透传） */
  async forwardFileTo(memberId, xml) {
    if (!this.channel.online) return { success: false, error: '管家未在线' };
    return this._enqueueOutbound(String(memberId), 'file-forward', { xml: String(xml) });
  }

  /** 发表情包（manifest 里的 id → data/stickers/，走出站图片队列） */
  async sendToMemberSticker(memberId, stickerId) {
    const st = getStickerList().find(s => s.id === String(stickerId));
    if (!st) {
      // 自愈：清单可能被远程更新过，把当前可用表情一并返回给 AI 自行修正
      const available = getStickerList().map(s => `${s.id}(${s.text})`).join('、');
      return { success: false, error: `未知表情包 ${stickerId}（当前可用: ${available || '无'}）` };
    }
    // st.file 已是 data/stickers/ 下的绝对路径（getStickerList 拼接过）——直接使用，
    // 不能再用 path.join 拼接（会把绝对路径再拼一层，路径重复 → 文件不存在 → 发送失败）
    return this.sendToMemberImage(memberId, st.file);
  }

  /** 群里发表情包（工具层群 caller 用；群 id 透传 sendToMemberImage） */
  async sendToGroupSticker(chatroomId, stickerId) {
    return this.sendToMemberImage(String(chatroomId), this._stickerPath(stickerId));
  }

  _stickerPath(stickerId) {
    const st = getStickerList().find(s => s.id === String(stickerId));
    if (!st) {
      const available = getStickerList().map(s => `${s.id}(${s.text})`).join('、');
      throw new Error(`未知表情包 ${stickerId}（当前可用: ${available || '无'}）`);
    }
    return st.file;   // 绝对路径（同上，不重复拼接）
  }

  /** 表情包清单（动态：CLI 远程更新 manifest 后立即生效，无需重启） */
  getStickers() {
    return getStickerList().map(({ id, file, text, use }) => ({ id, text, use }));
  }

  getStatus() {
    const boundMembers = Object.keys(this.reverse).length;
    const st = {
      mode: 'steward',                    // 区分于 per-member 模式
      enabled: true,
      channel: this.channel.getStatus(),
      boundMembers,
      online: this.channel.online,
      dailySent: this._dailyCount,
      queueLength: this._outboundQueue.length,
    };
    // 超限模式运行状态（供管理端查看）
    if (this.overdriveMgr) {
      st.overdrive = {
        enabled: overdrive.listEnabled().map((r) => ({ scopeKey: r.scopeKey, kind: r.kind, startedAt: r.startedAt, lastActive: r.lastActive })),
        workers: this.overdriveMgr.listWorkers(),
        activeCount: this.overdriveMgr.workerCount(),
      };
    } else {
      st.overdrive = { enabled: [] };
    }
    return st;
  }

  getQrcode() {
    return this.channel.getQrcode();
  }

  isBotOnline(memberId) {
    const wxid = this.reverse[String(memberId)];
    return !!(wxid && this.channel.online);
  }

  getBindings() {
    return Object.entries(this.bindings).map(([wxid, memberId]) => ({ wxid, memberId }));
  }

  /** 解绑（成员换号 / 退学清理） */
  unbindMember(memberId) {
    for (const [wxid, mid] of Object.entries(this.bindings)) {
      if (String(mid) === String(memberId)) {
        delete this.bindings[wxid];
      }
    }
    this._saveBindings();
    this._rebuildReverse();
    return true;
  }

  /** GeweChat 回调转发入口（index.js 挂路由后调用） */
  handleChannelCallback(payload) {
    // 回调鉴权：配置了 token 且请求体携带 token 字段时严格校验
    // （部分 GeweChat 版本的常规回调不带该字段 → 宽容放行；测试消息必带）
    if (CALLBACK_TOKEN && payload && typeof payload === 'object') {
      const t = payload.Token || payload.token;
      if (t !== undefined && t !== CALLBACK_TOKEN) {
        throw new Error('回调 token 不匹配');
      }
    }
    this.channel.handleCallback(payload);
  }

  async reloadFromBackup() {
    this.bindings = this._loadBindings();
    this._rebuildReverse();
    return Object.keys(this.bindings).length;
  }

  getBackupData() {
    return { bindings: this.bindings, count: Object.keys(this.bindings).length };
  }
}

module.exports = StewardManager;
// 测试导出：敏感词过滤纯函数（scripts/test-sensitive-words.js 单测用）
module.exports.sanitizeSensitiveText = sanitizeSensitiveText;
module.exports._resetSensitiveWordsCache = () => { _sensitiveWordsCache = { mtime: -1, map: {}, sorted: [] }; };
