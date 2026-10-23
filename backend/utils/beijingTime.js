/**
 * 北京时间工具函数
 * 所有时间判定统一使用北京时间（UTC+8），避免服务器时区偏差
 */

const BEIJING_OFFSET = 8 * 60 * 60 * 1000; // UTC+8

/** 返回当前北京时间对应的 Date 对象（getHours/getMinutes/getDay 等均为北京时间） */
function beijingNow() {
  return new Date(Date.now() + BEIJING_OFFSET);
}

/** 返回北京时间日期字符串 YYYY-MM-DD */
function beijingDateStr() {
  return beijingNow().toISOString().substring(0, 10);
}

/** 返回北京时间 offsetDays 天后的日期字符串 YYYY-MM-DD */
function beijingDateStrOffset(offsetDays) {
  const d = new Date(Date.now() + BEIJING_OFFSET);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().substring(0, 10);
}

/** 返回北京时间 ISO 字符串（用于记录时间戳） */
function beijingISO() {
  return beijingNow().toISOString();
}

module.exports = { beijingNow, beijingDateStr, beijingDateStrOffset, beijingISO };