const fs = require('fs');
const path = require('path');
const { beijingISO, beijingNow } = require('../utils/beijingTime');
const { getDataPath } = require('../utils/dataPath');
const SCHEDULE_FILE = getDataPath('schedules.json');

function readSchedules() {
  try {
    if (!fs.existsSync(SCHEDULE_FILE)) return [];
    return JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf-8'));
  } catch { return []; }
}

function writeSchedules(data) {
  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(data, null, 2));
}

function generateId() {
  return 'sched_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

function getSchedulesByMember(memberId) {
  return readSchedules().filter(s => s.targetMemberIds.includes(memberId));
}

/**
 * 解析 dueAt（'YYYY-MM-DD HH:mm[:ss]' 空格格式 / 'YYYY-MM-DDTHH:mm...' ISO 格式）→ 北京时间毫秒。
 * 返回基准与 beijingNow().getTime() 一致（北京时刻直接作为数值）：Date.UTC 把 HH:mm 当作
 * 北京时钟数值，与 beijingNow() 的偏移量同基准，避免时区换算差 8 小时。
 * 必须用毫秒比较：空格(0x20) 在字符串比较中恒小于 'T'(0x54)，直接比较字符串会导致
 * 到期判定（dueAt <= now / dueAt > oneMinuteAgo）对空格格式永远不成立——定时提醒失效。
 */
function _parseDueMs(dueAt) {
  const m = String(dueAt).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], m[6] ? +m[6] : 0);
}

function getUpcomingSchedules(memberId, limit = 10) {
  const nowMs = beijingNow().getTime();
  return readSchedules()
    .filter(s => s.targetMemberIds.includes(memberId))   // 每日重复日程：dueAt 为下一次提醒时刻
    .map(s => ({ s, t: _parseDueMs(s.dueAt) }))
    .filter(x => x.t != null && x.t > nowMs)
    .sort((a, b) => a.t - b.t)
    .slice(0, limit)
    .map(x => x.s);
}

function getAllUpcomingSchedules(limit = 100) {
  const nowMs = beijingNow().getTime();
  return readSchedules()
    .map(s => ({ s, t: _parseDueMs(s.dueAt) }))
    .filter(x => x.t != null && x.t > nowMs)
    .sort((a, b) => a.t - b.t)
    .slice(0, limit)
    .map(x => x.s);
}

function getDueSchedules() {
  const nowMs = beijingNow().getTime();
  const oneMinuteAgoMs = nowMs - 60000;
  return readSchedules().filter(s => {
    if (s.notified) return false;
    const t = _parseDueMs(s.dueAt);
    return t != null && t <= nowMs && t > oneMinuteAgoMs;
  });
}

function markNotified(scheduleId) {
  const schedules = readSchedules();
  const idx = schedules.findIndex(s => s.id === scheduleId);
  if (idx >= 0) {
    const s = schedules[idx];
    if (s.repeat === 'daily') {
      // 每日重复：通知后把 dueAt 推进到下一天同一时刻，重置通知标记——形成每日循环
      const next = _nextDailyDueAt(s.dueAt);
      if (next) {
        s.dueAt = next;
        s.notified = false;
        s.meta = s.meta || {};
        s.meta.lastNotifiedAt = beijingISO();
        s.meta.repeatCount = (s.meta.repeatCount || 0) + 1;
        writeSchedules(schedules);
        return;
      }
    }
    s.notified = true;
    s.meta = s.meta || {};
    s.meta.notifiedAt = beijingISO();
    writeSchedules(schedules);
  }
}

/** 每日重复日程推进：'YYYY-MM-DD HH:mm'（北京时间）→ 下一天同一时刻（日期字段 +1，时间原样保留，无时区换算） */
function _nextDailyDueAt(dueAt) {
  const m = String(dueAt).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const next = new Date(Date.UTC(y, mo - 1, d) + 24 * 3600 * 1000);   // 下一自然日（UTC 域日期运算）
  const p = n => String(n).padStart(2, '0');
  return `${next.getUTCFullYear()}-${p(next.getUTCMonth() + 1)}-${p(next.getUTCDate())} ${m[4]}:${m[5]}`;
}

function createSchedule({ title, description, dueAt, createdBy, targetMemberIds, isGlobal, repeat, scope, groupChatroomId }) {
  const schedules = readSchedules();
  // 日程类型三态：personal=个人（只提醒 targetMemberIds）/ global=全员公共（全员+开启的群）
  // / group=群日程（只提醒指定群，独立类型，不推全员）——优先级：显式 scope > isGlobal
  const resolvedScope = scope === 'group' ? 'group'
    : scope === 'global' ? 'global'
    : isGlobal ? 'global' : 'personal';
  const schedule = {
    id: generateId(),
    title: title || '未命名日程',
    description: description || '',
    dueAt,
    createdBy: createdBy || 'system',
    targetMemberIds: targetMemberIds || [],
    isGlobal: resolvedScope === 'global',
    scope: resolvedScope,
    groupChatroomId: resolvedScope === 'group' ? (groupChatroomId || '') : '',
    repeat: repeat === 'daily' ? 'daily' : 'none',   // none=一次性；daily=每天同一时刻重复（通知后自动推进）
    notified: false,
    createdAt: beijingISO(),
    meta: {}
  };
  schedules.push(schedule);
  writeSchedules(schedules);
  return schedule;
}

function deleteSchedule(scheduleId, memberId) {
  const schedules = readSchedules();
  const idx = schedules.findIndex(s => s.id === scheduleId);
  if (idx < 0) return false;
  if (schedules[idx].createdBy !== memberId && schedules[idx].createdBy !== 'system') return false;
  schedules.splice(idx, 1);
  writeSchedules(schedules);
  return true;
}

function getSchedulesByDate(dateStr, memberId) {
  const schedules = readSchedules().filter(s => s.targetMemberIds.includes(memberId));
  return schedules.filter(s => (s.dueAt || '').substring(0, 10) === dateStr);
}

module.exports = {
  readSchedules,
  writeSchedules,
  getSchedulesByMember,
  getUpcomingSchedules,
  getAllUpcomingSchedules,
  getDueSchedules,
  getSchedulesByDate,
  markNotified,
  createSchedule,
  deleteSchedule
};
