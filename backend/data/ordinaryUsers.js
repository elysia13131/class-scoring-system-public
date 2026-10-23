/**
 * ordinaryUsers.js —— 普通模式用户注册表
 *
 * 微信管家「绑定 昵称 1006」：不属于平台的人（无学号、不在 members.json）使用。
 * 首次用某昵称 + 普通模式口令即注册该昵称，之后同昵称换设备再登录即可恢复
 * 同一会话。昵称在普通用户集合内全局唯一；口令 ORDINARY_PASSCODE 固定为 1006
 *（普通模式专用口令，与人设/数据均隔离）。
 *
 * 会话/身份 id 形如 `guest-昵称`：作为 engine memberId / 工具 callerId 使用。
 * 后端对 guest-* 会话按「普通模式」处理——禁用平台数据工具，仅保留
 * 聊天/表情/搜索/生图等非平台能力（详见 agent-tool 白名单）。
 *
 * 与平台成员姓名的关系：普通昵称不与成员姓名做冲突检查——寻址规则不同，
 * 跨会话发送成员目标=学号，发送普通用户目标=精确普通昵称，二者互不干扰。
 */
const fs = require('fs');
const path = require('path');
const { getDataPath } = require('../utils/dataPath');

const FILE = getDataPath('ordinary_users.json');
const ID_PREFIX = 'guest-';
/** 普通模式固定口令：绑定 昵称 1006 即注册/登录普通模式 */
const ORDINARY_PASSCODE = '1006';
/** 名称字符集（与 adminContexts 一致）：中文/字母/数字/点/下划线/连字符 */
const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9._-]{1,20}$/;

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeAll(all) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.warn('[ordinaryUsers] 写入失败:', e.message);
  }
}

/** 名称是否合法（可注册） */
function validName(name) {
  return NAME_RE.test(String(name || ''));
}

/** 口令是否等于普通模式固定口令 */
function checkPasscode(passcode) {
  return String(passcode || '') === ORDINARY_PASSCODE;
}

/** 名称 → 会话/身份 id（guest-名称） */
function contextIdOf(name) {
  return `${ID_PREFIX}${String(name)}`;
}

/** 会话/身份 id → 名称（非 guest- 前缀返回 null） */
function nameOfContext(contextId) {
  const id = String(contextId || '');
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : null;
}

/** 精确名称是否存在 */
function exists(name) {
  return !!readAll()[String(name)];
}

/**
 * 注册/登录一个普通模式用户（口令校验通过时调用）。
 * @returns {{ isNew: boolean }} true = 首次注册该昵称
 */
function register(name) {
  const key = String(name);
  const all = readAll();
  const isNew = !all[key];
  const now = new Date().toISOString();
  all[key] = { nickname: key, createdAt: all[key]?.createdAt || now, lastLogin: now };
  writeAll(all);
  return { isNew };
}

/** 身份 id 是否为已注册的普通模式用户（后端权限闸用） */
function isOrdinaryContextId(contextId) {
  const name = nameOfContext(contextId);
  if (!name || !validName(name)) return false;
  return !!readAll()[name];
}

/** 已注册列表（管理/调试用） */
function list() {
  return readAll();
}

module.exports = {
  validName,
  checkPasscode,
  contextIdOf,
  nameOfContext,
  exists,
  register,
  isOrdinaryContextId,
  list,
  FILE,
  ID_PREFIX,
  ORDINARY_PASSCODE,
};
