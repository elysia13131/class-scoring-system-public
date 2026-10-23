/**
 * overdriveState —— 超限模式会话状态（Phase1）
 *
 * 超限模式 = 该会话（群聊/私聊）开放 dsh 完整原生能力（终端/文件/浏览器…，
 * 由独立 runtime 承载，见 Phase2+）。本模块只负责：
 *   1. 指令解析：普通/管理员口令由调用方（steward）校验，这里做纯文本识别；
 *   2. 会话状态持久化：哪个会话处于超限、谁开的、何时最后活跃；
 *   3. 空闲判定：供超限 runtime 管理器做空闲回收。
 *
 * 会话 key：私聊 = memberId（已绑定），群聊 = chatroomId（g: 群id 归一到群 id）。
 * 状态存 data/overdrive-state.json（持久化卷），与其余数据文件一致。
 */

const fs = require('fs');
const path = require('path');
const { getDataPath } = require('./dataPath');

const STATE_FILE = 'overdrive-state.json';
/** 空闲回收阈值：最后活跃超过该时长 → 可回收（超限 runtime 关闭，状态保留待重开） */
const IDLE_RECYCLE_MS = 30 * 60 * 1000;

let _cache = null; // 进程内缓存，读多写少

function statePath() {
  return getDataPath(STATE_FILE);
}

function load() {
  if (_cache) return _cache;
  try {
    const raw = fs.readFileSync(statePath(), 'utf8');
    _cache = JSON.parse(raw) || {};
  } catch {
    _cache = {};
  }
  return _cache;
}

function persist() {
  const dir = path.dirname(statePath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(_cache || {}, null, 2));
}

/** 归一化会话 key：群复合 g:群id:学号 → 群id */
function sessionKey(kind, rawKey) {
  const s = String(rawKey || '');
  const g = /^g:([^:]+)/.exec(s);
  if (kind === 'group' || g) return g ? g[1] : s;
  return s; // 私聊 memberId
}

/**
 * 识别超限开关指令。口令不在此校验（由 steward 调用方核对管理员密码）。
 * @param {string} text 原始消息文本（群聊可含 @Anaxis 等）
 * @returns {null|{action:'open'|'close', rawPassword?:string, commandTail?:string}}
 *   open 时若带口令则 rawPassword 为其后首个连续 token；
 *   识别不到返回 null（交由正常对话处理）。
 */
function parseOverdriveCommand(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  // 去 @机器人 前缀/@空格（群里 @Anaxis 超限）
  const cleaned = t
    .replace(/@[^\s@]{1,20}[\s:：]*/g, ' ')   // @Anaxis、@AI 等
    .replace(/\s+/g, ' ')
    .trim();
  if (/^关闭\s*超限/.test(cleaned)) return { action: 'close' };
  // 开启必须是指令形态：允许"请/帮/帮我/开启/打开/进入"开头（可带 @ 已在上面剥掉），
  // 后面跟空格/冒号/结尾或密码。排除日常对话误伤（如"这个超限了吧/超限了"）。
  const openRe = /^(?:请|帮我(?:开启|打开|进入)?|(?:开启|打开|进入))?\s*超限(?:\s|$|[:：])/;
  if (openRe.test(cleaned)) {
    const rest = cleaned.replace(/^(?:请|帮我(?:开启|打开|进入)?|(?:开启|打开|进入))?\s*超限\s*/, '').trim();
    const m = /^(\S+)/.exec(rest);
    const rawPassword = m ? m[1] : undefined;
    return { action: 'open', rawPassword, commandTail: rest };
  }
  return null;
}

/** 开启/确认活跃 */
function markActive(kind, rawKey, meta = {}) {
  const st = load();
  const key = sessionKey(kind, rawKey);
  const rec = st[key] || { kind, scopeKey: key, enabledBy: '', startedAt: Date.now(), lastActive: Date.now() };
  rec.kind = kind;
  rec.lastActive = Date.now();
  if (meta.enabledBy) rec.enabledBy = meta.enabledBy;
  st[key] = rec;
  persist();
  return rec;
}

/** 开启超限（覆盖写开关状态）；返回记录 */
function enable(kind, rawKey, meta = {}) {
  const st = load();
  const key = sessionKey(kind, rawKey);
  const rec = {
    kind,
    scopeKey: key,
    enabled: true,
    enabledBy: meta.enabledBy || '',
    startedAt: Date.now(),
    lastActive: Date.now(),
  };
  st[key] = rec;
  persist();
  return rec;
}

/** 关闭超限（保留记录但 enabled=false，工作区暂存） */
function disable(kind, rawKey) {
  const st = load();
  const key = sessionKey(kind, rawKey);
  if (st[key]) {
    st[key].enabled = false;
    st[key].closedAt = Date.now();
    persist();
  }
  return st[key] || null;
}

function isEnabled(kind, rawKey) {
  const st = load();
  const rec = st[sessionKey(kind, rawKey)];
  return !!(rec && rec.enabled);
}

function getRecord(kind, rawKey) {
  const st = load();
  return st[sessionKey(kind, rawKey)] || null;
}

/** 当前开启的全部记录 */
function listEnabled() {
  const st = load();
  return Object.values(st).filter((r) => r.enabled);
}

/**
 * 空闲回收：把超过 IDLE_RECYCLE_MS 未活跃的开启会话标记为可回收
 * （调用方据此关闭超限 runtime）。返回被回收的 scopeKey 列表。
 */
function sweepIdle(now = Date.now()) {
  const st = load();
  const reaped = [];
  for (const [key, rec] of Object.entries(st)) {
    if (rec.enabled && rec.lastActive && now - rec.lastActive > IDLE_RECYCLE_MS) {
      rec.enabled = false;
      rec.reapedAt = now;
      reaped.push(key);
    }
  }
  if (reaped.length) persist();
  return reaped;
}

/** 进程内缓存失效（测试/文件被外部改时用） */
function resetCache() {
  _cache = null;
}

module.exports = {
  STATE_FILE,
  IDLE_RECYCLE_MS,
  parseOverdriveCommand,
  sessionKey,
  enable,
  disable,
  markActive,
  isEnabled,
  getRecord,
  listEnabled,
  sweepIdle,
  resetCache,
};
