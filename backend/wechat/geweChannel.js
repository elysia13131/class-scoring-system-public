/**
 * GeweChannel —— GeweChat（iPad 协议）REST 通道实现
 *
 * 两种部署形态（同一套通道代码，环境变量切换）：
 *   - 云托管（默认）：GeWeAPI 商业服务（api.geweapi.com），前缀 /gewe/v2/api，
 *     token = GEWE_TOKEN（控制台「Token中心」生成），回调注册 /login/setCallback
 *   - 自部署：GeweChat Docker（github.com/Devo919/Gewechat），前缀 /v2/api，
 *     token 走 /tools/getTokenId 自动获取，回调注册 /tools/setCallback
 *
 * 对齐真实 API（已逐接口核对 GeweChat Java 源码与 GeWeAPI 官方文档）：
 *   - 所有接口 POST，请求头 X-GEWE-TOKEN
 *   - 发文本 /message/postText {appId, toWxid, content, ats}
 *   - 发图片 /message/postImage {appId, toWxid, imgUrl}——imgUrl 必须是 GeweChat
 *     服务器可下载的公网 URL → 图表文件经 /api/wechat/steward/media/:file 暴露
 *   - 回调注册 {token, callbackUrl}（全局配置，callbackUrl 公网可达，
 *     云 /login/setCallback、自部署 /tools/setCallback，均先发 {testMsg} 测试消息验证）
 *   - 登录：/login/getLoginQrCode {appId, type, regionId, proxyIp, aid}（复用持久化
 *     appId——新 appId 次日掉线，原 appId 登录后可长期在线；type=mac 默认支持
 *     autoSliding；regionId 选账号注册地同省线路；aid=AID 本地代理编号，登录链路
 *     走本地网络出口——解决"需验证设备连接至相同网络"）→ /login/checkLogin 轮询
 *     5s（data.status=2 成功，expiredTime<=5 换码，mac 可带 autoSliding 自动滑块；
 *     返回 url 无 status = 人脸/滑块二次验证，/qrcode 端点切换为验证码）→
 *     /login/checkOnline {appId} 免验证重登
 *   - 回调消息：{TypeName:'AddMsg', Appid, Wxid, Data:{FromUserName:{string},...}}；
 *     好友申请 = AddMsg + MsgType 37（Content 为 XML：fromusername/encryptusername=v3/
 *     <ticket v4="...">/scene）；自消息 = FromUserName.string === Wxid；
 *     去重 = Appid + NewMsgId（服务重启/同步会重复推送）
 *   - 通过好友 /contacts/addContacts {appId, scene, option:3, v3, v4, content}
 *
 * 部署形态：默认 GeWeAPI 云托管（GEWE_TOKEN + 可选 GEWE_AID 本地代理解决设备验证）；
 * 自部署则 GEWE_API 指向同省 VPS 上的 GeweChat Docker。后端在云上，
 * 回调用公网 URL（GEWE_CALLBACK_URL），媒体图同源暴露。
 *
 * 通道接口（与 WechatyChannel 同构，业务层零感知）：
 *   start() / stop() / sendText(wxid, text) / sendImage(wxid, localPath)
 *   onMessage(handler) / onFriendship(handler) / getStatus() / getQrcode()
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const { getDataPath } = require('../utils/dataPath');

// GEWE_API 网关地址，两种部署形态：
// - 云托管（默认）：GeWeAPI 商业服务 https://api.geweapi.com，接口前缀 /gewe/v2/api，
//   token 用 GEWE_TOKEN（控制台「Token中心」生成，云上无 getTokenId 接口）
// - 自部署：GeweChat Docker http://VPS_IP:2531，前缀 /v2/api，token 走 /tools/getTokenId
function resolveBase() {
  let base = process.env.GEWE_API || 'https://api.geweapi.com';
  base = base.replace(/\/+$/, '');
  if (/\/(gewe\/)?v2\/api$/.test(base)) return base;   // 已带前缀，原样使用
  const cloud = process.env.GEWE_MODE === 'cloud' || /geweapi\.com/i.test(base);
  return cloud ? `${base}/gewe/v2/api` : `${base}/v2/api`;
}
const GEWE_BASE = resolveBase();
// 云托管判定：地址为 GeWeAPI 云服务、显式 GEWE_MODE=cloud，或配置了控制台 token
const IS_CLOUD = process.env.GEWE_MODE === 'cloud' || /geweapi\.com/i.test(GEWE_BASE) || !!process.env.GEWE_TOKEN;
/** 朋友圈可见范围公共参数（空数组默认全员可见；privacy=true 仅自己可见） */
function _snsScope(opts = {}) {
  return {
    allowWxIds: (opts.allowWxIds || []).map(String).filter(Boolean),
    atWxIds: (opts.atWxIds || []).map(String).filter(Boolean),
    disableWxIds: (opts.disableWxIds || []).map(String).filter(Boolean),
    privacy: !!opts.privacy,
    allowTagIds: [],
    disableTagIds: [],
  };
}
// 云托管 token（控制台 Token 中心生成）；自部署留空 → getTokenId 自动获取
const CLOUD_TOKEN = process.env.GEWE_TOKEN || '';
// 回调注册路径差异：云 /login/setCallback；自部署 /tools/setCallback
const SET_CALLBACK_PATH = IS_CLOUD ? '/login/setCallback' : '/tools/setCallback';
const CALLBACK_PATH = '/api/wechat/steward/callback';
// 回调地址（公网完整 URL，GeweChat 推消息用；本地开发可不配 → 不注册回调）
const CALLBACK_URL = process.env.GEWE_CALLBACK_URL || '';
// 可选：校验回调请求携带的 token（部分 GeweChat 版本不带该字段 → 宽容放行）
const CALLBACK_TOKEN = process.env.GEWE_CALLBACK_TOKEN || '';
// 媒体目录：图表渲染产物（GeweChat 通过 media 端点公网拉取）
const MEDIA_DIR = getDataPath('chart_images');
// 入站媒体落盘目录（用户发来的图片/文件，CDN 下载后保存）
const UPLOAD_DIR = getDataPath('uploads');
// 常见文件后缀 → MIME（downloadMedia 返回给 vision/转发的元信息）
const MIME_MAP = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv', txt: 'text/plain', json: 'application/json',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf', zip: 'application/zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
};

// 登录线路参数（解决"需验证此设备连接至相同网络"/异地风控的关键）：
// - GEWE_LOGIN_TYPE：ipad | mac（默认 mac：checkLogin 支持 autoSliding 自动滑块验证）
// - GEWE_REGION_ID：平台内置线路地区（陕西=610000，与微信号注册地同省优先）
// - GEWE_AID：AID 本地代理 6 位编号（本机运行 gewe-AidNet 客户端获取；
//   登录链路走本地网络出口 → 与手机同网络即可通过设备验证；主动加好友也必须用此方式）
// - GEWE_AUTO_SLIDING：mac 模式自动滑块验证（默认开，置 0 关闭走 App 手动验证）
const LOGIN_TYPE = process.env.GEWE_LOGIN_TYPE === 'ipad' ? 'ipad' : 'mac';
const REGION_ID = process.env.GEWE_REGION_ID || '610000';
const LOGIN_AID = process.env.GEWE_AID || '';
const AUTO_SLIDING = process.env.GEWE_AUTO_SLIDING !== '0';
// 云托管控制台「在线登录」拿到的 appId（不想走接口扫码时：控制台配 AID 登录 →
// 复制 appId 填到这里 → 后端直接 checkOnline 上线，避免后端另生成新 appId 互相挤掉）
const EXTERNAL_APP_ID = process.env.GEWE_APP_ID || '';

const STATE_FILE = getDataPath('wechat', 'gewe-session.json');

// 回调消息去重容量（Appid+NewMsgId）
const DEDUP_MAX = 500;

/**
 * 回调报文归一：把 GeWeAPI 云托管的扁平 camelCase 推送映射成旧 GeweChat 回调形态。
 *
 * 两套报文完全不同（实测云端推送顶层字段）：
 *   自部署 /v2/api: { TypeName:'AddMsg', Wxid, Data:{ FromUserName:{string}, ToUserName:{string},
 *                     Content:{string}, MsgType, NewMsgId, CreateTime } }
 *   云托管推送:     { appid, wxid, eventCode, msgId, newMsgId, msgType, fromUser, toUser,
 *                     content, createTime, isSelf, pushContent, pushType, sendType, userId,
 *                     tokenId, tokenName }
 * 只认旧形态时云端每条消息都会因 TypeName 取不到而被静默丢弃（路由仍回 200），
 * 表现为「GeWe 控制台显示回调 200、AI 却完全没有收到消息」。
 */
/**
 * 云托管 v2 回调的 msgType 是字符串枚举（TEXT/IMAGE/...，全 39 种见官方
 * 《回调结构说明 v2.0》），自部署 GeweChat 是数字 MsgType；下游
 * （steward/_plainMediaText）全按数字判断，收到字符串会变成 NaN 落到未知类型。
 * 这里把枚举名映射回微信 MsgType，编号以官方 v1.0 回调文档为准。
 */
const CLOUD_MSG_TYPE_MAP = {
  TEXT: 1,
  IMAGE: 3,
  VOICE: 34,
  VIDEO: 43,
  EMOJI: 47,
  LOCATION: 48,
  CARD: 42,
  FRIEND_VERIFY: 37,      // 好友验证：Content 为 XML，交给 _parseFriendRequest
  FINDER_FEED: 63,        // 视频号
  // 以下都按可读文本处理（10002）：_plainMediaText 会剥掉 XML 标签把正文交给 AI，
  // 保证转账/红包/群公告/拍一拍/系统提示这类消息 AI 也「看得见」，而不是一句
  // 无信息量的「[微信消息]」
  ANNOUNCEMENT: 10002,
  SYSTEM: 10002,
  TRANSFER: 10002,
  RED_PACKET: 10002,
  GROUP_INVITE: 10002,
  GROUP_TODO: 10002,
  PAT_MSG: 10002,
  REVOKE_MSG: 10002,
  REMOVE_FROM_GROUP: 10002,
  GROUP_DISMISS: 10002,
  GROUP_NAME_CHANGE: 10002,
};

// appmsg 家族：content 是 XML 时走 49（引用/合并转发解析器、文件下载分支），
// content 不是 XML（云托管可能只给摘要文本）时退回 10002 当可读文本，
// 否则会被 steward 的文件分支当成待下载文件处理
const CLOUD_APPMSG_TYPES = new Set([
  'FILE', 'LINK', 'MINI_PROGRAM', 'QUOTE', 'APP_MSG', 'CHAT_RECORD', 'DOWNLOAD', 'UPLOAD',
]);

const CLOUD_EVENT_TYPES = new Set([
  'FRIEND_CONFIRM', 'SYSTEM', 'REVOKE_MSG', 'PAT_MSG',
  'RECONNECT_SUCCESS', 'RECONNECT_FAIL', 'LONG_SUCCESS', 'LONG_FAIL',
  'Long_Serve_Start_Success', 'Long_Serve_Close',
  'LOGIN_SUCCESS', 'LOGIN_ERROR', 'LOGOUT', 'UNKNOWN',
]);

/** content 是否是 v1 形态的 appmsg XML（<msg>/<appmsg>，可带 xml 声明） */
function isAppmsgXml(s) {
  return /^\s*(?:<\?xml[^>]*>\s*)?<(?:msg|appmsg)\b/i.test(String(s || ''));
}

function normalizeMsgType(v, rawContent) {
  if (typeof v === 'number') return v;
  if (v === undefined || v === null) return 0;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const name = s.toUpperCase();
  if (CLOUD_APPMSG_TYPES.has(name)) return isAppmsgXml(rawContent) ? 49 : 10002;
  const code = CLOUD_MSG_TYPE_MAP[name];
  if (code !== undefined) return code;
  // 未知枚举名：走 10002 让 AI 至少能看到 content，同时留日志便于后续补映射
  console.warn(`[GeweChannel] 未知云托管 msgType=${s}，按可读文本处理`);
  return 10002;
}

/**
 * 从云托管群事件报文里找群 id。官方 v2 文档没写群 id 字段名，实测 fromUser 是
 * 发送者个人、toUser 是机器人账号，群 id 既不在文档字段里也不在我的日志字段里，
 * 因此按「字段名无关」的方式解析：先试常见候选名，再对全部字符串字段兜底扫
 * "xxx@chatroom"（群 id 一定带这个后缀）。
 */
function resolveCloudRoomId(payload) {
  const CANDIDATES = ['roomId', 'roomid', 'chatroomId', 'chatRoomId', 'chatroomid',
    'groupId', 'groupid', 'roomName', 'chatroomName'];
  for (const k of CANDIDATES) {
    const v = payload[k];
    if (typeof v === 'string' && v.endsWith('@chatroom')) return v;
  }
  for (const v of Object.values(payload)) {
    if (typeof v !== 'string') continue;
    const m = v.match(/[\w-]+@chatroom/);
    if (m) return m[0];
  }
  return '';
}

/** 群 @ 判定：v2 未文档化 @ 字段，先扫名字含 at/mention 的字段，再看正文里的 @ 文本 */
function detectCloudAt(payload, botWxid, rawContent) {
  for (const [k, v] of Object.entries(payload)) {
    if (!/at|mention/i.test(k)) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v === undefined ? '' : v) || '';
    if (botWxid && s.includes(botWxid)) return true;
  }
  const text = String(rawContent || '');
  return !!botWxid && text.includes(`@${botWxid}`);
}

function normalizeCallbackPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.TypeName || payload.typeName || payload.type) return payload;              // 已是旧形态
  if (payload.fromUser === undefined && payload.content === undefined) return payload;   // 未识别，交给下游
  const from = String(payload.fromUser || '');
  const to = String(payload.toUser || '');
  const raw = payload.content === undefined ? '' : String(payload.content);
  const botWxid = String(payload.wxid || '');
  const eventCode = String(payload.eventCode || '');
  // 群/私聊靠 eventCode 区分（实测 group_msg_event / private_msg_event），
  // 少数形态也会把群 id 直接放在 fromUser
  const isGroup = /^group/i.test(eventCode) || from.endsWith('@chatroom');
  const fromIsRoom = from.endsWith('@chatroom');

  let fromUser = from;
  let toUser = to;
  let content = raw;
  let roomId = '';
  if (isGroup) {
    roomId = fromIsRoom ? from : resolveCloudRoomId(payload);
    if (roomId) {
      // 转成 v1 群消息约定：FromUserName=群 id，正文前缀 "发送者wxid:\n"，
      // 下游据此取 senderWxid 并把前缀剥掉
      fromUser = roomId;
      toUser = fromIsRoom ? botWxid : from;
      content = fromIsRoom || !from ? raw : `${from}:\n${raw}`;
    }
  }

  return {
    TypeName: 'AddMsg',
    Appid: payload.appid,
    Wxid: botWxid,
    Data: {
      NewMsgId: payload.newMsgId !== undefined ? payload.newMsgId : payload.msgId,
      MsgType: normalizeMsgType(payload.msgType, raw),
      FromUserName: { string: fromUser },
      ToUserName: { string: toUser },
      Content: { string: content },
      CreateTime: payload.createTime,
    },
    _cloud: {
      eventCode: payload.eventCode,
      pushType: payload.pushType,
      sendType: payload.sendType,
      isSelf: typeof payload.isSelf === 'boolean' ? payload.isSelf : null,
      isGroup,
      roomId,
      atBot: isGroup ? detectCloudAt(payload, botWxid, raw) : false,
      rawPayload: payload,     // 仅用于诊断日志（群 id 字段名未文档化时靠它定位）
    },
  };
}

class GeweChannel {
  constructor() {
    this.appId = null;      // 设备 id（登录后持久化复用，换新 appId 次日掉线）
    this.token = null;      // GeweChat API token（X-GEWE-TOKEN）
    this.online = false;
    this.qrcode = null;     // { qrUrl, appId, uuid, timestamp }
    this._msgHandler = null;
    this._friendHandler = null;
    this._polling = false;
    this._seenMsgs = new Map();   // Appid-NewMsgId → 收到时间（去重）
    this._loadState();
  }

  _loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.appId = s.appId || null;
        this.token = s.token || null;
      }
    } catch (e) { /* 状态损坏时忽略，走重新扫码 */ }
    // 环境变量注入的 appId 优先（控制台在线登录的设备；防止后端另生成新 appId 互挤）
    if (EXTERNAL_APP_ID) this.appId = EXTERNAL_APP_ID;
  }

  _saveState() {
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      fs.writeFileSync(STATE_FILE, JSON.stringify({ appId: this.appId, token: this.token }, null, 2));
    } catch (e) { /* 持久化失败不阻断 */ }
  }

  /** 获取/刷新 API token（持久化，服务重启后免重取）；token 失效时 _api 会强制刷新 */
  async _ensureToken(force = false) {
    if (CLOUD_TOKEN) {   // 云托管：token 来自控制台配置（云上无 getTokenId 接口）
      this.token = CLOUD_TOKEN;
      return this.token;
    }
    if (this.token && !force) return this.token;
    const res = await axios.post(`${GEWE_BASE}/tools/getTokenId`, {}, { timeout: 15000 });
    const d = res.data || {};
    if (d.ret !== 200) throw new Error(`GeweChat getTokenId: ${d.errMsg || d.msg || '未知错误'}`);
    // 响应 data 即 token 字符串：{'ret':200,'msg':'执行成功','data':'tokenxxx'}
    this.token = typeof d.data === 'string' ? d.data : (d.data && d.data.token) || null;
    if (!this.token) throw new Error('GeweChat getTokenId 未返回 token');
    this._saveState();
    return this.token;
  }

  /** GeweChat REST 统一封装（X-GEWE-TOKEN 头；token 失效自动重取一次重试） */
  async _api(apiPath, body = {}, timeoutMs = 15000) {
    const doReq = () => axios.post(`${GEWE_BASE}${apiPath}`, body, {
      timeout: timeoutMs,
      headers: this.token ? { 'X-GEWE-TOKEN': this.token } : {},
    });
    let res = await doReq();
    const d = res.data || {};
    if (d.ret !== 200 && /token/i.test(String(d.msg || d.errMsg || ''))) {
      await this._ensureToken(true);
      res = await doReq();
    }
    const d2 = res.data || {};
    if (d2.ret !== 200) throw new Error(`GeweChat ${apiPath}: ${d2.errMsg || d2.msg || '未知错误'}`);
    return d2.data;
  }

  /**
   * 启动通道：
   * 1. token 就绪（持久化或 getTokenId）
   * 2. 有持久化 appId → checkOnline 免验证重登
   * 3. 失败 → 扫码登录（getQrcode 供前端渲染）
   * 4. 登录成功 → 注册回调 URL 收消息
   */
  async start() {
    if (this.online) return { online: true };

    try {
      await this._ensureToken();
    } catch (e) {
      throw new Error(`GeweChat 服务不可达（${GEWE_BASE}）: ${e.message}`);
    }

    // 1. 免验证重登（复用持久化 appId）
    if (this.appId) {
      try {
        const alive = await this._api('/login/checkOnline', { appId: this.appId });
        if (alive) {
          this.online = true;
          await this._registerCallback();
          console.log('[GeweChannel] 免验证重登成功（appId 复用）');
          return { online: true };
        }
      } catch (e) {
        console.log(`[GeweChannel] checkOnline 未在线（走扫码登录）: ${e.message}`);
      }
    }

    // 2. 扫码登录（异步等待，getQrcode 供前端渲染）
    this._polling = true;
    this._startQrLogin();
    return { online: false, needQrcode: true };
  }

  /** 扫码登录流程：取码 → 轮询 checkLogin（5s）→ 快过期换码 → 成功落盘 */
  async _startQrLogin() {
    while (this._polling) {
      let qr;
      // 登录线路诊断（日志一眼看出是否走 AID 本地代理——aid 为空 = 走云端机房线路，
      // 微信会一直要求"设备连接至相同网络"，手机端怎么选都过不去）
      console.log(`[GeweChannel] 取登录二维码（线路: type=${LOGIN_TYPE}, regionId=${REGION_ID},`
        + ` aid=${LOGIN_AID || '未配置→走云端线路'}${IS_CLOUD ? ', 云托管' : ', 自部署'}）`);
      try {
        qr = await this._api('/login/getLoginQrCode', {
          appId: this.appId || '',
          type: LOGIN_TYPE,
          regionId: REGION_ID,
          proxyIp: '',
          aid: LOGIN_AID,
        });
      } catch (e) {
        console.error(`[GeweChannel] 取登录二维码失败（10s 后重试）: ${e.message}`);
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      if (qr.appId) {
        this.appId = qr.appId;   // 立即记下（checkLogin 需要 + 新 appId 必须持久化复用）
        this._saveState();
      }
      this.qrcode = {
        // 云端返回 qrData（真实二维码内容）；自部署仅有 uuid → 按官方格式构造
        qrUrl: qr.qrData || `http://weixin.qq.com/x/${qr.uuid}`,
        appId: qr.appId,
        uuid: qr.uuid,
        timestamp: Date.now(),
      };
      console.log('[GeweChannel] 登录二维码已生成，等待管理员扫码');

      // 内层轮询登录状态；异常/快过期 → break 回外层换码
      while (this._polling) {
        await new Promise(r => setTimeout(r, 5000));
        if (!this._polling) return;
        let chk;
        try {
          chk = await this._api('/login/checkLogin', {
            appId: this.appId || '',
            uuid: qr.uuid,
            captchCode: '',
            autoSliding: AUTO_SLIDING,   // mac 模式自动滑块验证（ipad 模式服务端忽略）
          });
        } catch (e) {
          console.log(`[GeweChannel] checkLogin 异常（重新取码）: ${e.message}`);
          break;
        }
        // 跨省/新设备验证：checkLogin 返回 url（验证二维码）而非 status →
        // 把 /qrcode 端点的二维码切换为验证码（iPad 模式=人脸识别 App 扫，
        // Mac 模式=滑块验证 App 扫），验证完成后下轮 checkLogin 返回 status=2
        if (chk && chk.url && chk.status === undefined) {
          if (!this.qrcode || this.qrcode.qrUrl !== chk.url) {
            this.qrcode = {
              qrUrl: chk.url,
              type: 'verification',
              appId: this.appId,
              uuid: qr.uuid,
              timestamp: Date.now(),
            };
            console.log('[GeweChannel] 触发设备验证（跨省/新设备）：/qrcode 端点已切换为验证二维码，'
              + '请用 iPad 人脸识别 App（iOS）或 Mac 滑块验证 App（Android）扫码，3 分钟内有效');
          }
          continue;   // 继续轮询，等验证完成
        }
        const status = Number(chk && chk.status);
        if (status === 2) {   // 2 = 登录成功（0 未扫码 1 已扫码未确认）
          this.online = true;
          this.qrcode = null;   // 登录完成，二维码不再需要（/qrcode 端点回到 404）
          this._saveState();
          await this._registerCallback();
          console.log(`[GeweChannel] 扫码登录成功${chk.nickName ? `（${chk.nickName}）` : ''}，管家已上线`);
          return;
        }
        const expired = Number(chk && chk.expiredTime) || 0;
        if (expired > 0 && expired <= 5) break;   // 二维码快过期 → 换码
      }
    }
  }

  /** 注册回调 URL（全局配置；云 /login/setCallback，自部署 /tools/setCallback，均会先发 {testMsg} 验证公网可达） */
  async _registerCallback() {
    if (!CALLBACK_URL) {
      console.warn('[GeweChannel] 未配置 GEWE_CALLBACK_URL，跳过回调注册（收不到消息，仅可主动发）');
      return;
    }
    try {
      await this._api(SET_CALLBACK_PATH, { token: this.token, callbackUrl: CALLBACK_URL });
      console.log(`[GeweChannel] 回调已注册: ${CALLBACK_URL}`);
    } catch (e) {
      console.error(`[GeweChannel] 回调注册失败: ${e.message}`);
    }
  }

  /** 供 index.js 挂回调路由后转发进来（POST /api/wechat/steward/callback） */
  handleCallback(payload) {
    if (!payload || typeof payload !== 'object') return;

    // GeweChat 注册回调时的可达性测试消息：直接吞掉（路由层已回 200）
    if (payload.testMsg !== undefined) return;

    // 诊断：入站回调识别结果（只记判别字段，不记正文）。报文结构变化时靠它定位，
    // 否则整条入站链路会静默失效——2026-09 云托管换扁平报文即由此发现。
    console.log(`[GeweChannel] 回调入站 eventCode=${payload.eventCode ?? '-'} pushType=${payload.pushType ?? '-'} msgType=${payload.msgType ?? '-'} from=${payload.fromUser ?? '-'} to=${payload.toUser ?? '-'} wxid=${payload.wxid ?? '-'} isSelf=${payload.isSelf ?? '-'}`);

    // 云托管的群聊/私聊事件类通知（好友确认、系统提示、重连、撤回等）不是用户消息，
    // 直接丢弃：否则会被当成一条"[微信消息]"进对话路由，给用户回无关内容
    if (typeof payload.msgType === 'string' && CLOUD_EVENT_TYPES.has(payload.msgType)) {
      console.log(`[GeweChannel] 事件类回调（${payload.msgType}），不进对话`);
      return;
    }

    // 云托管扁平报文 → 旧 GeweChat 形态归一（两套结构字段名完全不同）
    payload = normalizeCallbackPayload(payload);
    const cloud = payload._cloud || null;

    // 群事件：v2 报文没有文档化的群 id 字段，靠 resolveCloudRoomId 兜底解析。
    // 解析不出来时宁可丢弃也绝不能当私聊处理——否则会把群消息私聊回给发送者本人
    if (cloud && cloud.isGroup) {
      const keys = Object.keys(cloud.rawPayload || {}).join(',');
      if (!cloud.roomId) {
        console.warn(`[GeweChannel] 群消息未解析出群 id，已丢弃。顶层字段=${keys} 原文=${JSON.stringify(cloud.rawPayload || {})}`);
        return;
      }
      console.log(`[GeweChannel] 群事件 群id=${cloud.roomId} 发送者=${cloud.rawPayload?.fromUser ?? '-'} atBot=${cloud.atBot} 顶层字段=${keys}`);
    }

    const typeName = payload.TypeName || payload.typeName || payload.type;
    const data = payload.Data || payload.data || {};
    const botWxid = payload.Wxid || payload.wxid || '';
    // 云托管显式给出 isSelf 时以它为准：避免 wxid 字段含义不同导致把用户消息误判成自发
    const cloudIsSelf = payload._cloud ? payload._cloud.isSelf : null;

    // 掉线通知 → 标记离线并自动重登
    if (typeName === 'Offline' || typeName === 'OfflineNotify') {
      this.online = false;
      console.log('[GeweChannel] 掉线通知，稍后自动重登');
      setTimeout(() => this.start().catch(() => {}), 5000);
      return;
    }

    // v1 只处理新消息（ModContacts 等联系人变更事件忽略）
    // 丢弃即留痕：GeWe 改过报文结构时靠这条日志定位，否则表现为完全静默
    if (typeName !== 'AddMsg') {
      console.log(`[GeweChannel] 回调忽略（TypeName=${typeName || '未识别'}，顶层字段=${Object.keys(payload).join(',')}）`);
      return;
    }

    // 去重：Appid + NewMsgId（GeweChat 因重试/历史同步会重复推送）
    const newMsgId = data.NewMsgId || data.newMsgId;
    if (newMsgId !== undefined) {
      const key = `${payload.Appid || ''}-${newMsgId}`;
      if (this._seenMsgs.has(key)) return;
      this._seenMsgs.set(key, Date.now());
      if (this._seenMsgs.size > DEDUP_MAX) {
        const entries = [...this._seenMsgs.entries()].sort((a, b) => a[1] - b[1]);
        for (let i = 0; i < Math.floor(entries.length / 2); i++) this._seenMsgs.delete(entries[i][0]);
      }
    }

    const fromUser = data.FromUserName?.string || data.fromUserName?.string || data.fromUserName || '';
    const toUser = data.ToUserName?.string || data.toUserName?.string || data.toUserName || '';
    const msgType = Number(data.MsgType ?? data.msgType ?? 0);
    const content = data.Content?.string ?? data.content?.string
      ?? (typeof data.content === 'string' ? data.content : '');

    // 状态同步消息（51）：忽略
    if (msgType === 51) return;

    // 好友申请（MsgType 37）：Content 为 XML（申请人 wxid/v3/v4/scene 都在里面；
    // FromUserName 此时应为系统账号 fmessage，不能当申请人用）
    if (msgType === 37) {
      if (!this._friendHandler) return;
      const req = this._parseFriendRequest(content);
      req.wxid = req.wxid || fromUser;
      if (!req.wxid) return;
      this._friendHandler(req).catch(() => {});
      return;
    }

    if (this._msgHandler) {
      // 丢弃即留痕：FromUserName 取不到时上层会静默忽略，这里点出真实字段名
      if (!fromUser) {
        console.warn(`[GeweChannel] AddMsg 缺少 FromUserName（Data 字段=${Object.keys(data).join(',')}），已忽略`);
      }
      // 群消息（FromUserName=@chatroom）：实际发送者在 Content 前缀（"wxid:\n正文"），
      // @信息在 AtUsers/MsgSource 字段（不同版本字段名不同，宽松兼容）
      let senderWxid = '';
      let isAtBot = false;
      if (fromUser.endsWith('@chatroom')) {
        const cm = String(typeof content === 'string' ? content : '').match(/^([\w-]+):?\n([\s\S]*)$/);
        if (cm) senderWxid = cm[1];
        // @ 检测：AtUsers 数组 / msgSource XML 的 atuserlist 里含管家 wxid
        const atList = data.AtUsers || data.atUsers || [];
        const msgSource = data.MsgSource || data.msgSource || '';
        try {
          const atIds = Array.isArray(atList)
            ? atList.map(u => String(u.wxid || u.Wxid || u.userName || ''))
            : [];
          const sourceIds = [];
          const atm = String(msgSource).match(/<atuserlist>(.*?)<\/atuserlist>/);
          if (atm) sourceIds.push(...atm[1].split(',').map(s => s.trim()).filter(Boolean));
          isAtBot = !!botWxid && [...atIds, ...sourceIds].some(id => id === botWxid);
        } catch { /* @ 解析失败按未 @ 处理 */ }
      }
      // 云托管群事件不带 AtUsers/MsgSource，用归一阶段的兜底判定（字段扫描 + @wxid 文本）
      if (cloud && cloud.isGroup) isAtBot = !!cloud.atBot;
      this._msgHandler({
        wxid: fromUser,
        toWxid: toUser,
        senderWxid,                                  // 群消息的实际发送者（私聊时为空）
        isAtBot,                                     // 群消息是否 @ 了管家
        isSelf: cloudIsSelf !== null ? cloudIsSelf
          : (!!botWxid && (senderWxid || fromUser) === botWxid),   // 自消息 = 发送者 === 管家 wxid
        isRoom: !!(fromUser && fromUser.endsWith('@chatroom')),
        msgType,                                     // 1 文本 3 图片 47 表情 49 文件/appmsg 34 语音
        text: typeof content === 'string' ? content : '',
        msgId: newMsgId,
        createTime: data.CreateTime || data.createTime,
        raw: data,
      }).catch(() => {});
    }
  }

  /** 解析好友申请 XML → {wxid, content, v3, v4, scene}（v3=encryptusername，v4=ticket 属性） */
  _parseFriendRequest(xml) {
    const out = { wxid: '', content: '', v3: '', v4: '', scene: 3 };
    try {
      const s = String(xml);
      const attr = (name) => {
        const m = s.match(new RegExp(`${name}="([^"]*)"`));
        return m ? this._xmlUnescape(m[1]) : '';
      };
      out.wxid = attr('fromusername');
      out.v3 = attr('encryptusername');
      out.scene = Number(attr('scene')) || 3;
      out.content = attr('content');
      const t = s.match(/<ticket[^>]*v4="([^"]*)"/);
      if (t) out.v4 = this._xmlUnescape(t[1]);
    } catch { /* 解析失败按默认值，调用方兜底 */ }
    return out;
  }

  _xmlUnescape(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  }

  onMessage(handler) { this._msgHandler = handler; }
  onFriendship(handler) { this._friendHandler = handler; }

  /** 群成员列表：{memberList: [{wxid, nickName}]}（GeWeAPI /group/getChatroomMemberList） */
  async getChatroomMembers(chatroomId) {
    if (!this.online) throw new Error('管家未在线');
    const d = await this._api('/group/getChatroomMemberList', { appId: this.appId, chatroomId });
    const list = d.memberList || d.memberLists || d.memberlist || [];
    return (Array.isArray(list) ? list : []).map(m => ({
      wxid: String(m.wxid || m.Wxid || m.userName || ''),
      nickName: String(m.nickName || m.nickname || m.NickName || ''),
    })).filter(m => m.wxid);
  }

  async sendText(wxid, text, atWxids = []) {
    if (!this.online) throw new Error('管家未在线');
    // ats：@ 成员 wxid 逗号分隔（群聊用）；@谁就在 content 文本里带 @昵称
    await this._api('/message/postText', {
      appId: this.appId, toWxid: wxid, content: text,
      ats: Array.isArray(atWxids) && atWxids.length > 0 ? atWxids.join(',') : '',
    });
  }

  /**
   * 发图片：GeweChat 只接受它自己可下载的 imgUrl → 本地文件经
   * /api/wechat/steward/media/:file 公网端点暴露（origin 同 GEWE_CALLBACK_URL）。
   * @param {string} imagePath 本地图片路径（chart_images 内直接用，外部文件自动拷入）
   */
  async sendImage(wxid, imagePath) {
    if (!this.online) throw new Error('管家未在线');
    const imgUrl = this._toMediaUrl(imagePath);
    await this._api('/message/postImage', { appId: this.appId, toWxid: wxid, imgUrl });
  }

  /**
   * 发文件（xlsx/pdf/txt 等）：与图片同链路——本地文件经公网媒体端点暴露，
   * GeWe 侧下载后以文件消息发出（/message/postFile: fileUrl + fileName）。
   */
  async sendFile(wxid, filePath, fileName) {
    if (!this.online) throw new Error('管家未在线');
    const fileUrl = this._toMediaUrl(filePath);
    await this._api('/message/postFile', {
      appId: this.appId, toWxid: wxid, fileUrl, fileName: path.basename(fileName || filePath),
    });
  }

  /**
   * 发语音条（微信原生语音消息）：GeWe /message/postVoice 只收 silk 格式——
   * 本地 .silk 文件经公网媒体端点暴露为 voiceUrl，必须带时长（毫秒）。
   * @param {string} wxid 好友 wxid 或 @chatroom 群 id
   * @param {string} silkPath 本地 .silk 文件路径（已含 #!SILK_V3 头）
   * @param {number} durationMs 语音时长（毫秒）
   */
  async sendVoice(wxid, silkPath, durationMs) {
    if (!this.online) throw new Error('管家未在线');
    const voiceUrl = this._toMediaUrl(silkPath);
    await this._api('/message/postVoice', {
      appId: this.appId, toWxid: wxid, voiceUrl,
      voiceDuration: Math.max(1, Math.round(Number(durationMs) || 1000)),
    });
  }

  /**
   * 发视频消息（微信原生视频卡片，可直接播放）：GeWe 侧下载后以视频消息发出
   * （/message/postVideo: videoUrl + thumbUrl + videoDuration）。
   * 本地视频与缩略图均经 /api/wechat/steward/media/:file 公网端点暴露。
   * @param {string} videoPath 本地 mp4 路径
   * @param {string} thumbPath 本地缩略图路径（jpg/png）
   * @param {number} duration 播放时长（秒）
   */
  async sendVideo(wxid, videoPath, thumbPath, duration) {
    if (!this.online) throw new Error('管家未在线');
    const videoUrl = this._toMediaUrl(videoPath);
    const thumbUrl = this._toMediaUrl(thumbPath);
    await this._api('/message/postVideo', {
      appId: this.appId, toWxid: wxid,
      videoUrl, thumbUrl,
      videoDuration: Math.max(1, Math.round(Number(duration) || 1)),
    });
  }

  /**
   * 直转文件消息（微信 CDN 侧复制，不经我们服务器）：转发入站文件消息时
   * 用原始 XML 调 /message/forwardFile——接收方收到的就是微信服务器上的同一份文件。
   */
  async forwardFile(wxid, xml) {
    if (!this.online) throw new Error('管家未在线');
    await this._api('/message/forwardFile', { appId: this.appId, toWxid: wxid, xml: String(xml) });
  }

  /** 本地文件 → 公网媒体 URL（chart_images 内直接引用；外部文件拷入并换随机名） */
  _toMediaUrl(localPath) {
    if (!CALLBACK_URL) throw new Error('发图片/文件需要配置 GEWE_CALLBACK_URL（媒体 URL 与回调同源）');
    if (!fs.existsSync(localPath)) throw new Error(`图片文件不存在: ${localPath}`);
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    let file = path.basename(localPath);
    const inMedia = path.dirname(path.resolve(localPath)) === path.resolve(MEDIA_DIR);
    if (!inMedia) {
      const ext = path.extname(file) || '.png';
      file = `media_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
      fs.copyFileSync(localPath, path.join(MEDIA_DIR, file));
    }
    const origin = new URL(CALLBACK_URL).origin;
    return `${origin}/api/wechat/steward/media/${encodeURIComponent(file)}`;
  }

  /**
   * 下载入站媒体（图片/文件）CDN 原文件 → 本地 data/uploads/
   * 图片（MsgType 3）：Content XML 的 <img aeskey cdnmidimgurl length>（常规图优先，
   *   type=2；有 cdnhdimgurl 时高清 type=1）
   * 文件（MsgType 49 appmsg type=6）：<appattach totallen cdnattachurl aeskey fileext>
   * 接口：POST /message/downloadCdn {appId, aesKey, fileId, type, totalSize, suffix}
   *   → {fileUrl}（7 天有效的临时直链）
   * 返回 { kind:'image'|'file', path, fileName, mime, size }；解析不出 CDN 参数 → null
   */
  async downloadMedia(msg) {
    const xml = String(msg.text || '');
    const u = this._xmlUnescape;
    const attr = (tag, name) => {
      const m = xml.match(new RegExp(`<${tag}[^>]*\\s${name}="([^"]*)"`));
      return m ? u(m[1]) : '';
    };

    let kind = '', fileId = '', aesKey = '', totalSize = '', type = '', suffix = '', fileName = '';
    if (Number(msg.msgType) === 3) {
      // 图片：<img> 属性携带 CDN 参数（aeskey/cdnmidimgurl/length）
      kind = 'image';
      const mid = attr('img', 'cdnmidimgurl');
      const hd = attr('img', 'cdnhdimgurl');
      if (hd) { fileId = hd; type = '1'; }          // 高清优先，无则常规
      else if (mid) { fileId = mid; type = '2'; }
      else { fileId = attr('img', 'cdnthumburl'); type = '3'; }   // 兜底缩略图
      aesKey = attr('img', 'aeskey');
      totalSize = attr('img', 'length');
      suffix = 'jpg';
      fileName = `image_${Date.now()}.jpg`;
    } else if (Number(msg.msgType) === 49) {
      // 文件（appmsg type=6）：CDN 参数是 <appattach> 的子元素（非属性）
      kind = 'file';
      const el = (name) => {
        const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
        return m ? u(m[1]) : '';
      };
      fileId = el('cdnattachurl') || el('attachid');
      aesKey = el('aeskey');
      totalSize = el('totallen');
      type = '5';
      const title = el('title');
      suffix = (el('fileext')
        || (title.includes('.') ? title.split('.').pop() : '') || 'bin').toLowerCase();
      fileName = title || `file_${Date.now()}.${suffix}`;
    } else if (Number(msg.msgType) === 47) {
      // 表情消息：<emoji> 属性带 CDN 原图直链（微信标准协议：
      //   cdnurl 原图 / cdnthumburl 缩略图），HTTP 直下，无需 downloadCdn。
      // 动态表情多为 gif（vision 取首帧静态图）；无直链（系统内置表情）无法下载。
      kind = 'image';
      fileId = attr('emoji', 'cdnurl') || attr('emoji', 'cdnthumburl');
      const extMatch = String(fileId).match(/\.(gif|png|jpe?g|webp)(?:$|\?)/i);
      suffix = extMatch ? extMatch[1].toLowerCase().replace('jpeg', 'jpg') : 'gif';
      fileName = `emoji_${attr('emoji', 'md5') || Date.now()}.${suffix}`;
    } else if (Number(msg.msgType) === 34) {
      // 语音消息：<voicemsg cdnurl aeskey>。官方 downloadCdn type 枚举（1/2/3 图、
      // 4 视频、5 文件）未列语音——语音 cdnurl 通常就是完整直链，优先直接下载；
      // 非直链且带 aesKey 才试 downloadCdn type=4 兜底。内容格式下载后嗅探。
      kind = 'voice';
      fileId = attr('voicemsg', 'cdnurl');
      aesKey = attr('voicemsg', 'aeskey');
      totalSize = attr('voicemsg', 'voicelength') || attr('voicemsg', 'length');
      type = '4';
      suffix = 'silk';
      fileName = `voice_${Date.now()}.silk`;
    } else if (Number(msg.msgType) === 43 || Number(msg.msgType) === 62) {
      // 视频/小视频：<videomsg cdnvideourl aeskey length>（downloadCdn type=4 官方枚举；
      // 无 aesKey 且 cdnvideourl 是完整直链时直接下载）。内容格式下载后嗅探。
      kind = 'video';
      fileId = attr('videomsg', 'cdnvideourl') || attr('videomsg', 'cdnurl');
      aesKey = attr('videomsg', 'aeskey');
      totalSize = attr('videomsg', 'length') || attr('videomsg', 'playlength');
      type = '4';
      suffix = 'mp4';
      fileName = `video_${Date.now()}.mp4`;
    }
    if (!fileId) return null;
    if (Number(msg.msgType) !== 47 && Number(msg.msgType) !== 34
      && Number(msg.msgType) !== 43 && Number(msg.msgType) !== 62 && !aesKey) return null;

    // 表情直链直接下载；图片/文件/视频走 downloadCdn 换 7 天临时直链；语音直链优先
    let fileUrl = fileId;
    if (Number(msg.msgType) !== 47) {
      const t34 = Number(msg.msgType) === 34;
      const tVod = Number(msg.msgType) === 43 || Number(msg.msgType) === 62;
      if (t34) {
        // 语音：cdnurl 是完整直链 → 直接下；否则带 aesKey 试 downloadCdn 兜底
        if (!/^https?:\/\//i.test(String(fileId))) {
          if (!aesKey) return null;
          const d = await this._api('/message/downloadCdn', {
            appId: this.appId, aesKey, fileId, type, totalSize: String(totalSize), suffix: 'silk',
          }).catch((e) => { console.warn('[Gewe] 语音 downloadCdn 失败:', e.message); return null; });
          fileUrl = d && d.fileUrl ? d.fileUrl : fileId;
          if (fileUrl === fileId) return null;
        }
      } else if (tVod) {
        // 视频：downloadCdn(type=4) 服务端取临时直链；无 aesKey 且 cdnvideourl 是直链 → 直接下。
        // downloadCdn 服务端要从微信 CDN 拉大文件，慢——60s 超时并重试一次；仍失败且有
        // 完整直链时直接下载兜底。
        if (aesKey) {
          const tryDl = async () => this._api('/message/downloadCdn', {
            appId: this.appId, aesKey, fileId, type, totalSize: String(totalSize), suffix: '',
          }, 60000);
          let d = null;
          try { d = await tryDl(); } catch (e) {
            console.warn('[Gewe] 视频 downloadCdn 失败（重试一次）:', e.message);
            try { d = await tryDl(); } catch (e2) { console.warn('[Gewe] 视频 downloadCdn 重试仍失败:', e2.message); }
          }
          if (d && d.fileUrl) fileUrl = d.fileUrl;
        }
        if (fileUrl === fileId && !/^https?:\/\//i.test(String(fileId))) return null;
      } else {
        const d = await this._api('/message/downloadCdn', {
          appId: this.appId, aesKey, fileId, type, totalSize: String(totalSize), suffix,
        });
        fileUrl = d && d.fileUrl;
        if (!fileUrl) throw new Error('downloadCdn 未返回 fileUrl');
      }
    }

    // 临时直链 → 本地文件
    const res = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 60000 });
    const buf = Buffer.from(res.data);
    if (!buf || buf.length === 0) throw new Error('CDN 文件下载为空');
    // 语音/视频内容格式嗅探（语音 silk/amr/wav；视频 mp4/webm/flv），修正后缀与文件名
    if (Number(msg.msgType) === 34) {
      const head = buf.slice(0, 24).toString('latin1');
      if (head.startsWith('!SILK_V3')) suffix = 'silk';
      else if (head.startsWith('RIFF')) suffix = 'wav';
      else if (head.startsWith('#!AMR')) suffix = 'amr';
      fileName = `voice_${Date.now()}.${suffix}`;
    } else if (Number(msg.msgType) === 43 || Number(msg.msgType) === 62) {
      const head = buf.slice(0, 12).toString('latin1');
      if (head.startsWith('EBML')) suffix = 'webm';
      else if (head.startsWith('FLV')) suffix = 'flv';
      else suffix = 'mp4';   // ftyp 盒覆盖面最广（mp4/mov/3gp）
      fileName = `video_${Date.now()}.${suffix}`;
    }
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const safeExt = String(suffix || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
    const filePath = path.join(UPLOAD_DIR, `${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${safeExt}`);
    fs.writeFileSync(filePath, buf);
    return {
      kind, path: filePath, fileName, size: buf.length,
      // cdnUrl：可被 VL/网页直接拉取的直链（downloadCdn 换取的 7 天临时直链，或原始直链）。
      // 本地文件 24h 后被磁盘 GC 清理，而 CDN 时效更长——下游 video_understand 优先用
      // cdnUrl 直传 VL，避免本地过期/下载超时导致"读不到"。
      cdnUrl: fileUrl && /^https?:\/\//i.test(String(fileUrl)) ? String(fileUrl) : '',
      mime: kind === 'image' ? (MIME_MAP[safeExt] || 'image/jpeg') : (MIME_MAP[safeExt] || 'application/octet-stream'),
    };
  }

  /** 通过好友申请（option=3 同意；v3/v4/scene 来自回调消息 XML） */
  async acceptFriend(req = {}) {
    await this._api('/contacts/addContacts', {
      appId: this.appId,
      scene: Number(req.scene) || 3,
      option: 3,                       // 2 添加好友 3 同意好友 4 拒绝
      v3: req.v3 || '',
      v4: req.v4 || '',
      content: '',
    });
  }

  // ---------- 朋友圈（SNS）发布 ----------
  // 说明：新设备登录后 1-3 天内微信限制朋友圈发布/点赞/评论，期间操作会收到
  // 微信团队提醒（合规要求，代码不吞错误，接口本身正常返回）。
  // 素材来源：私聊/群聊收到的图片视频（mediaId → 本地 → 公网 URL）或任何公网 URL。

  /** 上传朋友圈图片（公网图 URL 列表，1-9 张 → imgInfos：fileUrl/thumbUrl/fileMd5/width/height） */
  async snsUploadImages(imgUrls) {
    const list = (imgUrls || []).map(String).filter(Boolean).slice(0, 9);
    if (list.length === 0) throw new Error('uploadSnsImage 缺少图片 URL');
    const d = await this._api('/sns/uploadSnsImage', { appId: this.appId, imgUrls: list });
    if (!Array.isArray(d) || d.length === 0) throw new Error('uploadSnsImage 无返回');
    return d;
  }

  /** 上传朋友圈视频（视频+封面公网 URL → videoInfo：fileUrl/thumbUrl/fileMd5/length） */
  async snsUploadVideo(thumbUrl, videoUrl) {
    if (!/^https?:\/\//i.test(String(videoUrl || ''))) throw new Error('uploadSnsVideo 缺少视频 URL');
    if (!/^https?:\/\//i.test(String(thumbUrl || ''))) throw new Error('uploadSnsVideo 缺少封面图 URL');
    const d = await this._api('/sns/uploadSnsVideo', { appId: this.appId, thumbUrl, videoUrl });
    return d || null;
  }

  /** 发文字朋友圈 */
  async snsSendText(content, opts = {}) {
    const s = _snsScope(opts);
    return this._api('/sns/sendTextSns', { appId: this.appId, ...s, content: String(content || '') });
  }

  /** 发图片朋友圈（imgInfos 来自 snsUploadImages） */
  async snsSendImages(content, imgInfos, opts = {}) {
    if (!Array.isArray(imgInfos) || imgInfos.length === 0) throw new Error('sendImgSns 缺少 imgInfos');
    const s = _snsScope(opts);
    return this._api('/sns/sendImgSns', {
      appId: this.appId, ...s, content: String(content || ''), imgInfos: imgInfos.slice(0, 9),
    });
  }

  /** 发视频朋友圈（videoInfo 来自 snsUploadVideo） */
  async snsSendVideo(content, videoInfo, opts = {}) {
    if (!videoInfo || !videoInfo.fileUrl) throw new Error('sendVideoSns 缺少 videoInfo');
    const s = _snsScope(opts);
    return this._api('/sns/sendVideoSns', { appId: this.appId, ...s, content: String(content || ''), videoInfo });
  }

  /** 发链接朋友圈（公众号/网页分享；thumbUrl 必填——缺省由后端从页面抓图兜底） */
  async snsSendUrl(p, opts = {}) {
    if (!/^https?:\/\//i.test(String(p.linkUrl || ''))) throw new Error('sendUrlSns 缺少 linkUrl');
    if (!/^https?:\/\//i.test(String(p.thumbUrl || ''))) throw new Error('sendUrlSns 缺少缩略图 thumbUrl');
    const s = _snsScope(opts);
    return this._api('/sns/sendUrlSns', {
      appId: this.appId, ...s,
      content: String(p.content || ''),
      thumbUrl: p.thumbUrl, linkUrl: p.linkUrl,
      title: String(p.title || '分享').slice(0, 100),
      description: String(p.description || '').slice(0, 300),
    });
  }

  getQrcode() {
    return this.qrcode ? { ...this.qrcode } : null;
  }

  getStatus() {
    return {
      channel: 'gewechat',
      online: this.online,
      appId: this.appId,
      hasQrcode: !!this.qrcode,
      callbackConfigured: !!CALLBACK_URL,
      // 登录线路（诊断"设备验证/同网络"问题用：aid 为空即走云端线路）
      loginLine: {
        cloud: IS_CLOUD,
        type: LOGIN_TYPE,
        regionId: REGION_ID,
        aid: LOGIN_AID || null,
      },
    };
  }

  async stop() {
    this._polling = false;
    this.online = false;
    // 不做 logout（保留 appId/token 供下次免验证重登）
  }
}

module.exports = { GeweChannel, GEWE_BASE, IS_CLOUD, SET_CALLBACK_PATH, CALLBACK_PATH, CALLBACK_URL, CALLBACK_TOKEN, MEDIA_DIR, UPLOAD_DIR };
