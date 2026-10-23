/**
 * automationStore.js —— 定时任务（automation）存储 v2
 *
 * 通用「到点唤醒 AI 执行预设指令」的定时任务，三种 cadence（定时方式）：
 *   once     一次性：{ onceAt: 'YYYY-MM-DD HH:mm' }（北京时间），触发后自动停用
 *   weekly   每周多选日期：{ weekdays: [1..7], time: 'HH:mm' }（1=周一 … 7=周日，
 *            全选即每天同一时刻），到匹配日的 time 触发
 *   interval 间隔：{ everyMinutes: N }（N≥1，分钟；外部常传 everyHours=N*60）
 *
 * 兼容旧字段（自动升级）：fixedTime 'HH:mm' = weekly 全选（原每日定点）；
 * intervalMinutes = interval（分钟）。读取时统一规范化出 cadence。
 *
 * 时间基准与 scheduleStore 一致：北京时钟读数经 Date.UTC 转数值，
 * 与 beijingNow().getTime() 同基准，避免 ±8h 偏差。
 * 到期判定分钟级窗口（120s），配合 pushScheduler 60s 轮询防漏；重复型任务
 * 由 markRun 推进 lastRunAt，当天/间隔未满不再重复触发。
 */
const fs = require('fs');
const path = require('path');
const { beijingISO, beijingNow, beijingDateStr } = require('../utils/beijingTime');
const { getDataPath } = require('../utils/dataPath');

const AUTOMATION_FILE = getDataPath('automations.json');

function read() {
  let list = [];
  try {
    if (fs.existsSync(AUTOMATION_FILE)) list = JSON.parse(fs.readFileSync(AUTOMATION_FILE, 'utf-8'));
  } catch { list = []; }
  if (!Array.isArray(list)) list = [];
  // 旧记录统一升级出 cadence（懒迁移，不落盘）
  for (const a of list) a.cadence = normalizeCadence(a);
  return list;
}

function write(data) {
  fs.writeFileSync(AUTOMATION_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return 'auto_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

/** 'YYYY-MM-DD HH:mm[:ss]' / ISO → 北京毫秒（Date.UTC 基准，同 beijingNow） */
function parseBeijingMs(dt) {
  const m = String(dt).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

/** 规范化 weekdays（1=周一..7=周日）：数组/逗号字符串 → 去重排序的 1..7 */
function normalizeWeekdays(wd) {
  const arr = Array.isArray(wd)
    ? wd
    : typeof wd === 'string' && String(wd).trim()
      ? String(wd).split(/[,，\s]+/).map(Number)
      : [];
  const set = new Set(arr.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 7));
  return [...set].sort((a, b) => a - b);
}

/** 旧字段/新参数 → cadence 对象；无法解析返回 null */
function normalizeCadence(a) {
  if (a && a.cadence && a.cadence.kind) return a.cadence;
  if (!a) return null;
  // legacy：fixedTime('HH:mm' 每日定点) → weekly 全选
  if (a.fixedTime) return { kind: 'weekly', weekdays: [1, 2, 3, 4, 5, 6, 7], time: a.fixedTime };
  // legacy / 新参数：间隔（分钟；everyHours/intervalHours=小时×60）
  const mins = a.everyMinutes || (a.everyHours ? a.everyHours * 60 : (a.intervalHours ? a.intervalHours * 60 : (a.intervalMinutes || 0)));
  if (mins > 0) return { kind: 'interval', everyMinutes: mins };
  // 新参数一次性
  if (a.onceAt) return { kind: 'once', onceAt: a.onceAt };
  // 新参数 weekly 快捷
  if (a.time) return { kind: 'weekly', weekdays: normalizeWeekdays(a.weekdays).length ? normalizeWeekdays(a.weekdays) : [1, 2, 3, 4, 5, 6, 7], time: a.time };
  return null;
}

/**
 * 创建定时任务。
 * @param {object} args
 * @param {string} [args.name] 名称
 * @param {string} args.prompt 到点唤醒 AI 执行的指令（注入该会话上下文）
 * @param {string} args.createdBy 创建者/归属（memberId / admin-名称 / guest-昵称）
 * @param {string} [args.runFor] 触发对象（目标会话 owner）；缺省 = createdBy
 * @param {object} [args.cadence] { kind:'once', onceAt } | { kind:'weekly', weekdays, time } | { kind:'interval', everyMinutes }
 * @param {string} [args.onceAt] 快捷：一次性 'YYYY-MM-DD HH:mm'
 * @param {number[]|string} [args.weekdays] 快捷：每周日期 1..7
 * @param {string} [args.time] 快捷：每周时刻 'HH:mm'
 * @param {number} [args.everyHours] 快捷：间隔小时
 * @param {number} [args.intervalMinutes] 快捷：间隔分钟（旧）
 */
function createAutomation(args) {
  if (!args || !args.prompt) throw new Error('prompt 为必填项');
  const cadence = normalizeCadence(args);
  if (!cadence) throw new Error('请指定定时方式：onceAt（一次性）/ weekdays+time（每周）/ everyHours 或 intervalMinutes（间隔）');
  if (cadence.kind === 'once' && !parseBeijingMs(cadence.onceAt)) {
    throw new Error(`onceAt 格式应为 YYYY-MM-DD HH:mm（北京时间）：${cadence.onceAt}`);
  }
  if (cadence.kind === 'weekly' && (!/^\d{2}:\d{2}$/.test(cadence.time))) {
    throw new Error(`weekly 需要 time=HH:mm（北京时间）：${cadence.time}`);
  }
  if (cadence.kind === 'weekly' && (!cadence.weekdays || cadence.weekdays.length === 0)) {
    throw new Error('weekly 需要 weekdays（1=周一..7=周日；全选即每天）');
  }
  const list = read();
  const now = beijingISO();
  const auto = {
    id: generateId(),
    name: args.name || '定时任务',
    prompt: String(args.prompt),
    createdBy: args.createdBy || 'system',
    runFor: args.runFor || args.createdBy || 'system',
    enabled: true,
    cadence,
    lastRunAt: now,          // 创建时刻起算（weekly 当天不重跑 / interval 从此刻计时）
    createdAt: now,
    meta: {},
  };
  list.push(auto);
  write(list);
  return auto;
}

/** 删除任务（本人 / system 可删） */
function deleteAutomation(id, memberId) {
  const list = read();
  const idx = list.findIndex(a => a.id === id);
  if (idx < 0) return false;
  if (list[idx].createdBy !== memberId && list[idx].createdBy !== 'system') return false;
  list.splice(idx, 1);
  write(list);
  return true;
}

/** 启停（本人 / system） */
function toggleEnabled(id, memberId, enabled) {
  const list = read();
  const a = list.find(x => x.id === id);
  if (!a) return false;
  if (a.createdBy !== memberId && a.createdBy !== 'system') return false;
  a.enabled = !!enabled;
  write(list);
  return true;
}

/** 某 owner 的任务列表（自己建的 + system 公共的；普通模式只看到自己建的） */
function getAutomationsByMember(memberId) {
  return read().filter(a => a.createdBy === memberId || a.createdBy === 'system');
}

/** 到期任务（北京毫秒窗口 120s；重复型由 lastRunAt 判重推进） */
function getDueAutomations() {
  const now = beijingNow();
  const nowMs = now.getTime();
  const today = beijingDateStr();
  return read().filter(a => {
    if (!a.enabled) return false;
    const cd = a.cadence;
    if (!cd) return false;
    if (cd.kind === 'once') {
      const at = parseBeijingMs(cd.onceAt);
      if (at == null) return false;
      // 一次性：窗口内触发一次（markRun 后 enabled=false，永不重复）
      return nowMs >= at && nowMs <= at + 120000;
    }
    if (cd.kind === 'weekly') {
      if (!cd.weekdays || cd.weekdays.length === 0 || !/^\d{2}:\d{2}$/.test(cd.time)) return false;
      // 北京日期 → UTC 域算周几/目标时刻（不依赖服务器本地时区）
      const [yy, mo, dd] = today.split('-').map(Number);
      const jsDay = new Date(Date.UTC(yy, mo - 1, dd)).getUTCDay();       // 0=周日
      if (!cd.weekdays.includes(jsDay === 0 ? 7 : jsDay)) return false;   // 转 1=周一..7=周日
      const [h, mm] = cd.time.split(':').map(Number);
      const target = new Date(Date.UTC(yy, mo - 1, dd, h, mm, 0));
      if (nowMs < target.getTime() || nowMs > target.getTime() + 120000) return false;
      // 当天该时刻只触发一次（lastRunAt 日期若为今天则已跑过）
      const lastDate = a.lastRunAt ? a.lastRunAt.substring(0, 10) : '';
      return lastDate !== today;
    }
    if (cd.kind === 'interval') {
      const mins = cd.everyMinutes || 0;
      if (mins <= 0 || !a.lastRunAt) return false;
      return nowMs - new Date(a.lastRunAt).getTime() >= mins * 60000;
    }
    return false;
  });
}

/** 标记已跑：推进 lastRunAt；一次性任务触发后停用 */
function markRun(id) {
  const list = read();
  const a = list.find(x => x.id === id);
  if (!a) return;
  a.lastRunAt = beijingISO();
  if (a.cadence && a.cadence.kind === 'once') a.enabled = false;
  write(list);
}

module.exports = {
  createAutomation,
  deleteAutomation,
  toggleEnabled,
  getAutomationsByMember,
  getDueAutomations,
  markRun,
  read,
};
