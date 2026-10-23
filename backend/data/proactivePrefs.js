/**
 * proactivePrefs —— 主动消息功能开关（per-member，对话可开关）
 *
 * 成员可通过对话让 AI 调 class_set_prefs 开/关（各功能独立、支持批量 all）。
 * 调度侧（steward.sendProactiveMessage）发送前检查；bind_welcome 不受控（一次性）。
 * 文件：data/proactive_prefs.json
 */
const fs = require('fs');
const { getDataPath } = require('../utils/dataPath');

const FILE = getDataPath('proactive_prefs.json');

// 受控的主动消息功能（key 与 proactive kind 对齐）
const FEATURES = ['daily_question', 'schedule_notify'];
const DEFAULTS = Object.fromEntries(FEATURES.map(f => [f, true]));

function readAll() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

/** 取成员开关（缺省全开） */
function getPrefs(memberId) {
  const saved = readAll()[String(memberId)] || {};
  const merged = { ...DEFAULTS, ...saved };
  for (const k of Object.keys(merged)) if (!FEATURES.includes(k)) delete merged[k];
  return merged;
}

/**
 * 更新开关（patch 只含已知 key；"all" 在此展开为全部功能，与后端 API 行为一致）。
 * 返回更新后的完整开关。
 */
function setPrefs(memberId, patch) {
  const all = readAll();
  const cur = getPrefs(memberId);
  for (const [k, v] of Object.entries(patch || {})) {
    if (k === 'all') {
      for (const f of FEATURES) cur[f] = !!v;
    } else if (FEATURES.includes(k)) {
      cur[k] = !!v;
    }
  }
  all[String(memberId)] = cur;
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  return cur;
}

module.exports = { getPrefs, setPrefs, FEATURES, FEATURE_LABELS: { daily_question: '每日一问', schedule_notify: '日程提醒' } };
