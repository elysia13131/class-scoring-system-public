/**
 * adminContexts.js —— 管理员上下文注册表
 *
 * 微信管家「管理员登录 名称 管理员密码」：名称可自由注册（首次登录即注册），
 * 名称只是上下文键——决定对话历史（conversation_memory / dsh session）归属，
 * 真正的身份凭证是管理员密码（config.adminPasswords，登录时校验一次）。
 *
 * 上下文 id 形如 `admin-张三`：作为 engine memberId / 工具 callerId 使用，
 * 后端 isAdminCaller 对已注册的 admin- 上下文直接放行敏感操作（免密码）。
 */
const fs = require('fs');
const path = require('path');
const { getDataPath } = require('../utils/dataPath');

const FILE = getDataPath('admin_contexts.json');
const ID_PREFIX = 'admin-';
/** 名称字符集（也是文件名/上下文 id 的安全集）：中文/字母/数字/点/下划线/连字符 */
const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9._-]{1,20}$/;

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch { return {}; }
}

function writeAll(all) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.warn('[adminContexts] 写入失败:', e.message);
  }
}

/** 名称是否合法（可注册） */
function validName(name) {
  return NAME_RE.test(String(name || ''));
}

/** 名称 → 上下文 id（admin-名称） */
function contextIdOf(name) {
  return `${ID_PREFIX}${String(name)}`;
}

/** 上下文 id → 名称（非 admin- 前缀返回 null） */
function nameOfContext(contextId) {
  const id = String(contextId || '');
  return id.startsWith(ID_PREFIX) ? id.slice(ID_PREFIX.length) : null;
}

/**
 * 注册/续期一个管理员上下文（登录成功时调用）。
 * @returns {boolean} 是否为新注册（true = 首次）
 */
function register(name) {
  const key = String(name);
  const all = readAll();
  const isNew = !all[key];
  const now = new Date().toISOString();
  all[key] = { createdAt: all[key]?.createdAt || now, lastLogin: now };
  writeAll(all);
  return isNew;
}

/** 上下文 id 是否为已注册的管理员上下文（后端权限闸用） */
function isAdminContextId(contextId) {
  const name = nameOfContext(contextId);
  if (!name || !validName(name)) return false;
  return !!readAll()[name];
}

/** 已注册列表（管理/调试用） */
function list() {
  return readAll();
}

module.exports = { validName, contextIdOf, nameOfContext, register, isAdminContextId, list, FILE };
