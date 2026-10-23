/**
 * 学期与成绩文件路径工具
 *
 * 独立于 index.js，供各 agent 工具、路由、脚本复用同一套学期解析逻辑，
 * 避免「扁平 scores_week_N.json.gz」与「scores/semester_4/scores_week_N.json.gz」路径不一致。
 *
 * 仅依赖 config.json 与 dataPath，不反向依赖 index.js（避免循环依赖）。
 */

const fs = require('fs');
const path = require('path');
const { getDataPath } = require('./dataPath');

// 默认学期（当 config.json 尚未配置 semesters 时使用，用来把存量数据归到「大二下」）
const DEFAULT_SEMESTERS = [
  { id: 1, name: '大一上', startDate: '2024-09-02T00:00:00+08:00' },
  { id: 2, name: '大一下', startDate: '2025-03-03T00:00:00+08:00' },
  { id: 3, name: '大二上', startDate: '2025-09-01T00:00:00+08:00' },
  { id: 4, name: '大二下', startDate: '2026-03-02T00:00:00+08:00' }
];
const DEFAULT_CURRENT_SEMESTER_ID = 4;

function readConfig() {
  try {
    const p = getDataPath('config.json');
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

function getSemesters() {
  const config = readConfig();
  if (Array.isArray(config.semesters) && config.semesters.length > 0) {
    return config.semesters;
  }
  const startDate = config.startDate || '2026-03-02T00:00:00+08:00';
  return [{ id: DEFAULT_CURRENT_SEMESTER_ID, name: '大二下', startDate }];
}

function getCurrentSemesterId() {
  const config = readConfig();
  if (config.currentSemesterId) return Number(config.currentSemesterId);
  const sems = getSemesters();
  const now = Date.now();
  let cur = sems[0];
  for (const s of sems) {
    if (new Date(s.startDate).getTime() <= now) cur = s;
  }
  return Number(cur.id);
}

function getCurrentSemester() {
  const sid = getCurrentSemesterId();
  const sems = getSemesters();
  return sems.find(s => Number(s.id) === sid) || sems[0];
}

/**
 * 按学期起点计算当前周次（统一用真实 UTC 时刻差，避免与 index.js 的 Date.now() 口径不一致）。
 * 周次从 1 开始，最小为 1。
 */
function getCurrentWeek(semesterId) {
  const sems = getSemesters();
  const sid = semesterId || getCurrentSemesterId();
  const semester = sems.find(s => Number(s.id) === Number(sid)) || sems[0];
  const startDateStr = (semester && semester.startDate) || readConfig().startDate || '2026-03-02T00:00:00+08:00';
  if (!startDateStr) return 1;
  const start = new Date(startDateStr);
  const diff = Date.now() - start.getTime();
  return Math.max(1, Math.floor(diff / (7 * 24 * 60 * 60 * 1000)) + 1);
}

function getScoresDir(semesterId) {
  const sid = semesterId || getCurrentSemesterId();
  return getDataPath('scores', `semester_${sid}`);
}

/**
 * 学期日期范围（用于按 month 过滤 fitness 等月度数据，不改数据结构）。
 * end 为下一学期 startDate；末学期（无下一学期）按 6 个月推导。
 */
function getSemesterDateRange(semesterId) {
  const sems = getSemesters().slice().sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  const sid = semesterId || getCurrentSemesterId();
  const idx = sems.findIndex(s => Number(s.id) === Number(sid));
  const semester = idx >= 0 ? sems[idx] : sems[0];
  const start = new Date(semester.startDate || '2026-03-02T00:00:00+08:00');
  let end;
  if (idx >= 0 && idx < sems.length - 1) {
    end = new Date(sems[idx + 1].startDate);
  } else {
    end = new Date(start.getTime() + 6 * 30.5 * 24 * 60 * 60 * 1000);
  }
  return { start, end };
}

/**
 * 判断 "YYYY-MM" 格式月份是否落在指定学期范围内。
 */
function monthInSemester(month, semesterId) {
  if (!month) return false;
  const m = String(month).substring(0, 7);
  const monthEnd = new Date(`${m}-28T23:59:59+08:00`);
  const { start, end } = getSemesterDateRange(semesterId);
  return monthEnd >= start && monthEnd < end;
}

/**
 * 推导学期对应的 rank_scores semester 标签（如 "2026-春"/"2025-秋"）。
 * 规则：startDate 月份 2-7 月为"春"，8-次年1月为"秋"，年份取 startDate 年份（秋季学期年份）。
 */
function getSemesterRankLabel(semesterId) {
  const sems = getSemesters();
  const sid = semesterId || getCurrentSemesterId();
  const semester = sems.find(s => Number(s.id) === Number(sid)) || sems[0];
  const start = new Date(semester.startDate || '2026-03-02T00:00:00+08:00');
  const month = start.getMonth() + 1;
  const year = start.getFullYear();
  const season = (month >= 2 && month <= 7) ? '春' : '秋';
  return `${year}-${season}`;
}

function getScoreFilePath(week, semesterId) {
  return path.join(getScoresDir(semesterId), `scores_week_${week}.json.gz`);
}

function getBMIFilePath(week, semesterId) {
  return path.join(getScoresDir(semesterId), `bmi_week_${week}.json.gz`);
}

/**
 * 补齐 config.json 中的 semesters 配置（幂等）。
 * 若缺失则写入默认 4 个学期，并把 currentSemesterId 设为第 4 学期（大二下）。
 */
function ensureSemestersConfig() {
  const configPath = getDataPath('config.json');
  const config = readConfig();
  let changed = false;

  if (!Array.isArray(config.semesters) || config.semesters.length === 0) {
    config.semesters = DEFAULT_SEMESTERS;
    changed = true;
  }
  if (!config.currentSemesterId) {
    config.currentSemesterId = DEFAULT_CURRENT_SEMESTER_ID;
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }
  return { changed };
}

/**
 * 把旧的扁平 scores_week_N.json.gz / bmi_week_N.json.gz 迁移到当前学期目录（幂等）。
 * 仅 rename 尚不存在的目标文件，源为 .bak 的文件不迁移。
 */
function migrateLegacyScores() {
  const flatDir = getDataPath('scores');
  if (!fs.existsSync(flatDir)) return { moved: 0 };
  const targetDir = getScoresDir();
  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  let moved = 0;
  for (const prefix of ['scores_week_', 'bmi_week_']) {
    const files = fs.readdirSync(flatDir).filter(
      f => f.startsWith(prefix) && f.endsWith('.json.gz')
    );
    for (const f of files) {
      const src = path.join(flatDir, f);
      const dst = path.join(targetDir, f);
      if (!fs.existsSync(dst)) {
        fs.renameSync(src, dst);
        moved++;
      }
    }
  }
  return { moved };
}

module.exports = {
  DEFAULT_SEMESTERS,
  DEFAULT_CURRENT_SEMESTER_ID,
  readConfig,
  getSemesters,
  getCurrentSemesterId,
  getCurrentSemester,
  getCurrentWeek,
  getScoresDir,
  getScoreFilePath,
  getBMIFilePath,
  getSemesterDateRange,
  monthInSemester,
  getSemesterRankLabel,
  ensureSemestersConfig,
  migrateLegacyScores
};