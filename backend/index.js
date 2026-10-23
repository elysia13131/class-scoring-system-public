const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } = require('docx');
const { beijingNow, beijingISO, beijingDateStr } = require('./utils/beijingTime');
const { getDataDir, getDataPath } = require('./utils/dataPath');
const semesterUtils = require('./utils/semester');
const { webSearch, imageSearch } = require('./utils/webSearch');
const { deepseekSearch } = require('./utils/dsSearch');
const { fetchUrl } = require('./utils/fetchUrl');
const { markdownToDocx } = require('./utils/markdownDocx');
const archiver = require('archiver');
const AdmZip = require('adm-zip');
const multer = require('multer');
const xlsx = require('xlsx');
const { execSync } = require('child_process');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const WeChatBotManager = require('./wechat/index');
const pushManager = require('./agent/pushManager');
const pushScheduler = require('./agent/pushScheduler');
const dailyCheckinRoutes = require('./routes/dailyCheckin');

// ==================== AI Agent Module ====================
let agentEngine = null;
let wechatBot = null;
let steward = null;            // 单号微信管家（GeweChat/iPad 协议，全员加好友模式）
let dshEngine = null;          // dsh 底座引擎（DSH_ENGINE=1 时作为管家专用引擎）
let overdriveManager = null;   // 超限会话 runtime 管理器（按会话拉起独立 worker）
let mediaGen = null;           // Agnes AI 生图/生视频异步任务管理器（AGNES_API_KEY 配置后启用）
let songGen = null;            // 豆包人声歌曲异步任务管理器（submit 立即返回 → 后台生成 → 激活 AI 发歌）
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || crypto.randomBytes(32).toString('hex');
process.env.__INTERNAL_API_KEY = INTERNAL_API_KEY;
// CLI 远程数据管理密钥：优先使用环境变量，未设置则与 INTERNAL_API_KEY 相同
const CLI_API_KEY = process.env.CLI_API_KEY || INTERNAL_API_KEY;
const _initAgentEngine = async () => {
  if (agentEngine) return agentEngine;
  try {
    const AgentEngine = require('./agent/core/Engine');
    const path = require('path');
    const keys = typeof DEEPSEEK_API_KEYS !== 'undefined' ? DEEPSEEK_API_KEYS : [];
    agentEngine = new AgentEngine({
      deepseek: {
        apiKey: keys.length > 0 ? keys[0] : (process.env.DEEPSEEK_API_KEY || ''),
        apiKeys: keys.length > 0 ? keys : (process.env.DEEPSEEK_API_KEY ? [process.env.DEEPSEEK_API_KEY] : []),
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat'
      },
      memory: {
        dataDir: getDataDir()
      }
    });
    await agentEngine.initialize();
    app.set('agentEngine', agentEngine);
    console.log('✅ AI Agent 模块已加载并初始化完成');
  } catch (err) {
    console.warn('⚠️  AI Agent 模块加载失败 (可选):', err.message);
  }
  return agentEngine;
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors());
app.use(express.json());

const DATA_DIR = getDataDir();
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const SCORES_FILE = path.join(DATA_DIR, 'scores.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const ACADEMIC_SCORES_FILE = path.join(DATA_DIR, 'academic_scores.json');
const FITNESS_SCORES_FILE = path.join(DATA_DIR, 'fitness_scores.json');
const RANK_SCORES_FILE = path.join(DATA_DIR, 'rank_scores.json');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const TEMP_DIR = path.join(DATA_DIR, 'temp');
const MEMBER_FILES_FILE = path.join(DATA_DIR, 'member_files.json');
const APK_DIR = path.join(DATA_DIR, 'apk');
const APK_VERSION_FILE = path.join(DATA_DIR, 'apk_version.json');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');
const INJURY_STATUS_FILE = path.join(DATA_DIR, 'injury_status.json');
const FIXED_HEIGHTS_FILE = path.join(DATA_DIR, 'fixed_heights.json');
const EXPERIENCES_FILE = path.join(DATA_DIR, 'experiences.json');
const NOTICES_FILE = path.join(DATA_DIR, 'notices.json');
const UPDATE_NOTICES_FILE = path.join(DATA_DIR, 'update_notices.json');
const DUTIES_FILE = path.join(DATA_DIR, 'duties.json');
const RELATIONSHIP_NOMINATIONS_FILE = path.join(DATA_DIR, 'relationship_nominations.json');
const MEMBER_STATES_FILE = path.join(DATA_DIR, 'member_states.json');
const MAKEUP_PERIODS_FILE = path.join(DATA_DIR, 'makeup_periods.json');
const WEEKLY_REPORTS_FILE = path.join(DATA_DIR, 'weekly_reports.json');
const PLAY_MODE_FILE = path.join(DATA_DIR, 'playmode.json');
const playModeCache = { data: null, ts: 0 }; // 3 秒读缓存
const dailyReport = require('./routes/dailyReport');
const scheduleRoutes = require('./routes/schedules');
const automationRoutes = require('./routes/automations');

// Ensure directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}
if (!fs.existsSync(APK_DIR)) {
  fs.mkdirSync(APK_DIR, { recursive: true });
}

// Clean up temp files older than 1 hour
const copyDirectoryRecursive = (src, dest) => {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
};

const cleanUpTempFiles = () => {
  try {
    const now = Date.now();
    const files = fs.readdirSync(TEMP_DIR);
    files.forEach(file => {
      const filePath = path.join(TEMP_DIR, file);
      const stats = fs.statSync(filePath);
      if (now - stats.mtimeMs > 60 * 60 * 1000) { // 1 hour
        fs.unlinkSync(filePath);
      }
    });
  } catch (err) {
    console.error('Clean up temp files error:', err);
  }
};

// Run cleanup every hour
setInterval(cleanUpTempFiles, 60 * 60 * 1000);
// Run cleanup on startup
cleanUpTempFiles();

// Member files metadata
const readMemberFiles = () => {
  if (!fs.existsSync(MEMBER_FILES_FILE)) return {};
  try {
    return readJSON(MEMBER_FILES_FILE);
  } catch {
    return {};
  }
};
const writeMemberFiles = (data) => {
  writeJSON(MEMBER_FILES_FILE, data);
};

// Relationship nominations
const readRelationshipNominations = () => {
  if (!fs.existsSync(RELATIONSHIP_NOMINATIONS_FILE)) return [];
  try {
    return readJSON(RELATIONSHIP_NOMINATIONS_FILE);
  } catch {
    return [];
  }
};

const writeRelationshipNominations = (data) => {
  writeJSON(RELATIONSHIP_NOMINATIONS_FILE, data);
};

// Member states (for consecutive conditions tracking)
const readMemberStates = () => {
  if (!fs.existsSync(MEMBER_STATES_FILE)) return {};
  try {
    return readJSON(MEMBER_STATES_FILE);
  } catch {
    return {};
  }
};
const writeMemberStates = (data) => {
  writeJSON(MEMBER_STATES_FILE, data);
};

// Makeup periods
const readMakeupPeriods = () => {
  if (!fs.existsSync(MAKEUP_PERIODS_FILE)) return [];
  try {
    return readJSON(MAKEUP_PERIODS_FILE);
  } catch {
    return [];
  }
};
const writeMakeupPeriods = (data) => {
  writeJSON(MAKEUP_PERIODS_FILE, data);
};

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    // 处理中文文件名，确保不乱码
    const originalName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const uniqueName = `${uuidv4()}_${originalName}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow various file types
    const allowedTypes = [
      // 图片格式
      'image/jpeg', 'image/png', 'image/gif', 'image/bmp',
      'image/webp', 'image/svg+xml', 'image/tiff', 'image/x-icon',
      // PDF
      'application/pdf',
      // Office文档
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      // 文本格式
      'text/plain', 'text/csv', 'text/markdown', 'text/html', 'text/xml',
      'application/json', 'application/javascript',
      // 压缩文件
      'application/zip', 'application/x-zip-compressed',
      'application/x-rar-compressed', 'application/x-7z-compressed',
      // 其他格式
      'application/rtf',
      // 视频格式
      'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime',
      'video/x-msvideo', 'video/x-matroska'
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('不支持的文件类型'));
    }
  }
});

// Multer configuration for APK uploads
const apkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, APK_DIR);
  },
  filename: (req, file, cb) => {
    // 始终使用固定文件名，实现自动覆盖
    cb(null, 'app-update.apk');
  }
});

const uploadApk = multer({
  storage: apkStorage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit for APK
  },
  fileFilter: (req, file, cb) => {
    // Allow only APK files
    if (file.mimetype === 'application/vnd.android.package-archive' || 
        file.originalname.toLowerCase().endsWith('.apk')) {
      cb(null, true);
    } else {
      cb(new Error('只支持APK文件'));
    }
  }
});

// Helper functions for APK version management
const readApkVersion = () => {
  if (!fs.existsSync(APK_VERSION_FILE)) {
    return { version: '1.0.0', versionCode: 1, updateRequired: false, releaseNotes: '' };
  }
  try {
    return readJSON(APK_VERSION_FILE);
  } catch {
    return { version: '1.0.0', versionCode: 1, updateRequired: false, releaseNotes: '' };
  }
};

const writeApkVersion = (data) => {
  writeJSON(APK_VERSION_FILE, data);
};

// Serve Frontend Static Files in Production
const frontendDistPath = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendDistPath)) {
  app.use(express.static(frontendDistPath));
}

// Helper to read/write JSON files
const readJSON = (file) => {
  try {
    const data = fs.readFileSync(file, 'utf8');
    if (!data || data.trim() === '') return [];
    return JSON.parse(data);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Error reading file ${file}:`, err);
    return [];
  }
};
const writeJSON = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`Error writing file ${file}:`, err);
  }
};

// ===== 学期模型 =====
// 读取学期配置（返回数组，至少保证当前学期存在）
const getSemesters = () => {
  const config = readJSON(CONFIG_FILE);
  if (Array.isArray(config.semesters) && config.semesters.length > 0) {
    return config.semesters;
  }
  // 兜底：无 semesters 配置时，用全局 startDate 构造一个默认学期
  return [{ id: 4, name: '大二下', startDate: config.startDate || '2026-03-02T00:00:00+08:00' }];
};

// 当前学期 ID（优先 config.currentSemesterId，否则取 startDate <= now 的最新学期）
const getCurrentSemesterId = () => {
  const config = readJSON(CONFIG_FILE);
  if (config.currentSemesterId) return config.currentSemesterId;
  const sems = getSemesters();
  const now = Date.now();
  let cur = sems[0];
  for (const s of sems) {
    if (new Date(s.startDate).getTime() <= now) cur = s;
  }
  return cur.id;
};

// 当前学期对象
const getCurrentSemester = () => {
  const sid = getCurrentSemesterId();
  return getSemesters().find(s => String(s.id) === String(sid)) || getSemesters()[0];
};

// 学期 scores 目录（按学期隔离数据文件）
const getScoresDir = (semesterId) => {
  const sid = semesterId || getCurrentSemesterId();
  return path.join(DATA_DIR, 'scores', `semester_${sid}`);
};

// Helper to get score file path by week
const getScoreFilePath = (week, semesterId) => {
  return path.join(getScoresDir(semesterId), `scores_week_${week}.json.gz`);
};

// Read scores for specific week (sync version for simplicity)
const readScoresByWeek = (week, semesterId) => {
  const filePath = getScoreFilePath(week, semesterId);
  try {
    if (!fs.existsSync(filePath)) {
      return [];
    }
    const buffer = fs.readFileSync(filePath);
    const decompressed = zlib.gunzipSync(buffer);
    const data = decompressed.toString('utf8');
    if (!data || data.trim() === '') return [];
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading compressed file ${filePath}:`, err);
    return [];
  }
};

// Write scores for specific week (sync version for simplicity)
const writeScoresByWeek = (week, data, semesterId) => {
  const filePath = getScoreFilePath(week, semesterId);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const jsonData = JSON.stringify(data, null, 2);
    const compressed = zlib.gzipSync(jsonData);
    fs.writeFileSync(filePath, compressed);
  } catch (err) {
    console.error(`Error writing compressed file ${filePath}:`, err);
  }
};

// Stream-based read (for future use with larger files)
const readScoresByWeekStream = (week) => {
  return new Promise((resolve, reject) => {
    const filePath = getScoreFilePath(week);
    if (!fs.existsSync(filePath)) {
      resolve([]);
      return;
    }
    
    const chunks = [];
    const readStream = fs.createReadStream(filePath);
    const gunzip = zlib.createGunzip();
    
    readStream.pipe(gunzip)
      .on('data', (chunk) => chunks.push(chunk))
      .on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (!data || data.trim() === '') {
          resolve([]);
        } else {
          try {
            resolve(JSON.parse(data));
          } catch (err) {
            console.error('Error parsing JSON:', err);
            resolve([]);
          }
        }
      })
      .on('error', (err) => {
        console.error('Stream error:', err);
        resolve([]);
      });
  });
};

// Stream-based write (for future use with larger files)
const writeScoresByWeekStream = (week, data) => {
  return new Promise((resolve, reject) => {
    const filePath = getScoreFilePath(week);
    const jsonData = JSON.stringify(data, null, 2);
    
    const writeStream = fs.createWriteStream(filePath);
    const gzip = zlib.createGzip();
    
    gzip.pipe(writeStream)
      .on('finish', () => resolve())
      .on('error', (err) => {
        console.error('Stream write error:', err);
        reject(err);
      });
    
    gzip.end(jsonData);
  });
};

// Cache system
const cache = {
  members: { data: null, timestamp: 0 },
  scores: { data: {}, timestamp: {} },
  config: { data: null, timestamp: 0 },
  academicScores: { data: null, timestamp: 0 },
  fitnessScores: { data: null, timestamp: 0 },
  rankScores: { data: null, timestamp: 0 }
};

const CACHE_DURATION = 60 * 1000; // 1 minute cache

// Get members with cache
const getMembers = () => {
  const now = Date.now();
  if (cache.members.data && (now - cache.members.timestamp) < CACHE_DURATION) {
    return cache.members.data;
  }
  const members = readJSON(MEMBERS_FILE);
  cache.members.data = members;
  cache.members.timestamp = now;
  return members;
};

// Get scores for week with cache
const getScoresForWeek = (week, semesterId) => {
  const sid = semesterId || getCurrentSemesterId();
  const cacheKey = `${sid}_${week}`;
  const now = Date.now();
  if (cache.scores.data[cacheKey] && (now - cache.scores.timestamp[cacheKey]) < CACHE_DURATION) {
    return cache.scores.data[cacheKey];
  }
  const scores = readScoresByWeek(week, sid);
  cache.scores.data[cacheKey] = scores;
  cache.scores.timestamp[cacheKey] = now;
  return scores;
};

// Get config with cache
const getConfig = () => {
  const now = Date.now();
  if (cache.config.data && (now - cache.config.timestamp) < CACHE_DURATION) {
    return cache.config.data;
  }
  const config = readJSON(CONFIG_FILE);
  cache.config.data = config;
  cache.config.timestamp = now;
  return config;
};

// Get academic scores with cache
const getAcademicScores = () => {
  const now = Date.now();
  if (cache.academicScores.data && (now - cache.academicScores.timestamp) < CACHE_DURATION) {
    return cache.academicScores.data;
  }
  const academicScores = readJSON(ACADEMIC_SCORES_FILE);
  cache.academicScores.data = academicScores;
  cache.academicScores.timestamp = now;
  return academicScores;
};

// Get fitness scores with cache
const getFitnessScores = () => {
  const now = Date.now();
  if (cache.fitnessScores.data && (now - cache.fitnessScores.timestamp) < CACHE_DURATION) {
    return cache.fitnessScores.data;
  }
  const fitnessScores = readJSON(FITNESS_SCORES_FILE);
  cache.fitnessScores.data = fitnessScores;
  cache.fitnessScores.timestamp = now;
  return fitnessScores;
};

const getRankScores = () => {
  const now = Date.now();
  if (cache.rankScores.data && (now - cache.rankScores.timestamp) < CACHE_DURATION) {
    return cache.rankScores.data;
  }
  const rankScores = readJSON(RANK_SCORES_FILE);
  cache.rankScores.data = rankScores;
  cache.rankScores.timestamp = now;
  return rankScores;
};

// Invalidate cache for specific week
const invalidateWeekCache = (week, semesterId) => {
  const sid = semesterId || getCurrentSemesterId();
  const cacheKey = `${sid}_${week}`;
  delete cache.scores.data[cacheKey];
  delete cache.scores.timestamp[cacheKey];
  // 兼容旧的按周缓存 key
  delete cache.scores.data[week];
  delete cache.scores.timestamp[week];
};

// Invalidate all cache
const invalidateCache = () => {
  cache.members.data = null;
  cache.members.timestamp = 0;
  cache.scores.data = {};
  cache.scores.timestamp = {};
  cache.config.data = null;
  cache.config.timestamp = 0;
  cache.academicScores.data = null;
  cache.academicScores.timestamp = 0;
  cache.fitnessScores.data = null;
  cache.fitnessScores.timestamp = 0;
  cache.rankScores.data = null;
  cache.rankScores.timestamp = 0;
};

// Read all scores from all weeks
const readAllScores = (semesterId) => {
  try {
    const scoresDir = getScoresDir(semesterId);
    if (!fs.existsSync(scoresDir)) {
      return [];
    }
    const files = fs.readdirSync(scoresDir);
    const scoreFiles = files.filter(file => file.startsWith('scores_week_') && file.endsWith('.json.gz'));
    let allScores = [];
    scoreFiles.forEach(file => {
      const week = parseInt(file.replace('scores_week_', '').replace('.json.gz', ''));
      const weekScores = getScoresForWeek(week, semesterId);
      allScores = allScores.concat(weekScores);
    });
    return allScores;
  } catch (err) {
    console.error('Error reading all scores:', err);
    return [];
  }
};

// Initialize files if they don't exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Create scores directory if it doesn't exist
const scoresDir = path.join(DATA_DIR, 'scores');
if (!fs.existsSync(scoresDir)) {
  fs.mkdirSync(scoresDir, { recursive: true });
}
if (!fs.existsSync(CONFIG_FILE)) {
  writeJSON(CONFIG_FILE, { startDate: '2026-03-02T00:00:00+08:00' });
}

// 补齐学期配置，并把旧扁平成绩文件迁移到当前学期目录（幂等，部署后自动完成存量数据迁移）
semesterUtils.ensureSemestersConfig();
const _migrationResult = semesterUtils.migrateLegacyScores();
if (_migrationResult.moved > 0) {
  console.log(`[学期] 已将 ${_migrationResult.moved} 个旧成绩文件迁移到当前学期目录`);
}
if (!fs.existsSync(MEMBERS_FILE)) {
  writeJSON(MEMBERS_FILE, [
    { id: '1', name: '陈小明', class: '一班' },
    { id: '2', name: '王大锤', class: '一班' }
  ]);
}
if (!fs.existsSync(SCORES_FILE)) {
  writeJSON(SCORES_FILE, []);
}
if (!fs.existsSync(RANK_SCORES_FILE)) {
  writeJSON(RANK_SCORES_FILE, []);
}
if (!fs.existsSync(WEEKLY_REPORTS_FILE)) {
  writeJSON(WEEKLY_REPORTS_FILE, []);
}

// Weekly Reports helper
function getWeeklyReports() {
  return readJSON(WEEKLY_REPORTS_FILE) || [];
}
function saveWeeklyReports(reports) {
  writeJSON(WEEKLY_REPORTS_FILE, reports);
}

// ---------- 播放模式配置（playmode.json） ----------
const PLAY_MODE_DEFAULTS = { radarDuration: 8, keepAlive: 3, items: [] };
function getPlayModeConfig() {
  const now = Date.now();
  if (playModeCache.data && now - playModeCache.ts < 3000) return playModeCache.data;
  let cfg = { ...PLAY_MODE_DEFAULTS };
  try {
    if (fs.existsSync(PLAY_MODE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PLAY_MODE_FILE, 'utf8'));
      cfg = { ...PLAY_MODE_DEFAULTS, ...raw, items: Array.isArray(raw.items) ? raw.items : [] };
    }
  } catch { /* 损坏 → 用默认 */ }
  playModeCache.data = cfg; playModeCache.ts = now;
  return cfg;
}
function savePlayModeConfig(cfg) {
  writeJSON(PLAY_MODE_FILE, cfg);
  playModeCache.data = cfg; playModeCache.ts = Date.now();
  return cfg;
}
/** 播放清单校验（服务端唯一收口）；body 各字段可选 → 未给字段取默认 */
function validatePlayModeInput(body) {
  const errs = [];
  const out = { radarDuration: 8, keepAlive: 3, items: [] };
  if (body && body.radarDuration !== undefined) {
    const n = Number(body.radarDuration);
    if (!Number.isFinite(n) || n < 1 || n > 3600) errs.push('radarDuration 需为 1–3600 的数字');
    else out.radarDuration = n;
  }
  if (body && body.keepAlive !== undefined) {
    const k = Number(body.keepAlive);
    if (!Number.isInteger(k) || k < 1 || k > 20) errs.push('keepAlive 需为 1–20 的整数');
    else out.keepAlive = k;
  }
  if (body && body.items !== undefined) {
    if (!Array.isArray(body.items)) errs.push('items 必须是数组');
    else {
      const validClasses = new Set(getMembers().map(m => m.class).filter(Boolean));
      const used = new Set();
      for (let i = 0; i < body.items.length; i++) {
        const it = body.items[i];
        if (!it || typeof it !== 'object') { errs.push(`items[${i}] 不是对象`); continue; }
        const type = String(it.type || '');
        if (type !== 'class' && type !== 'image' && type !== 'url') { errs.push(`items[${i}].type 非法：${type}`); continue; }
        const item = { type, id: String(it.id || `pm_${Date.now().toString(36)}_${i}`) };
        if (used.has(item.id)) errs.push(`items[${i}].id 重复：${item.id}`);
        used.add(item.id);
        if (it.label && typeof it.label === 'string') item.label = it.label.slice(0, 60);
        if (it.duration !== undefined) {
          const d = Number(it.duration);
          if (!Number.isFinite(d) || d < 1 || d > 3600) errs.push(`items[${i}].duration 需为 1–3600`);
          else item.duration = d;
        }
        if (type === 'class') {
          const cls = String(it.className || '');
          if (!validClasses.has(cls)) errs.push(`items[${i}].className 不存在：${cls}`);
          else item.className = cls;
        } else {
          const u = String(it.url || '');
          if (!/^https?:\/\//i.test(u)) errs.push(`items[${i}].url 需以 http(s):// 开头`);
          else item.url = u;
        }
        out.items.push(item);
      }
    }
  }
  return { ok: errs.length === 0, errors: errs, cfg: out };
}

// API Routes
app.get('/api/config', (req, res) => {
  const config = getConfig();
  res.json({ 
    currentWeek: config.currentWeek || getCurrentWeek(),
    startDate: config.startDate,
    semesters: getSemesters(),
    currentSemesterId: getCurrentSemesterId()
  });
});

app.post('/api/config/update-week', (req, res) => {
  const { week, semesterId } = req.body;
  
  if (!week || week < 1) {
    return res.status(400).json({ error: '请输入有效的周次（大于0）' });
  }
  
  const config = getConfig();
  config.currentWeek = week;
  if (semesterId) config.currentSemesterId = semesterId;
  writeJSON(CONFIG_FILE, config);
  cache.config.data = config;
  cache.config.timestamp = Date.now();
  
  res.json({ success: true, message: `周次已更新为第 ${week} 周`, currentWeek: week, currentSemesterId: getCurrentSemesterId() });
});

// 更新学期配置（新增/修改学期起点、切换当前学期）
app.post('/api/config/update-semesters', (req, res) => {
  const { semesters, currentSemesterId } = req.body;
  const config = getConfig();
  
  if (Array.isArray(semesters) && semesters.length > 0) {
    config.semesters = semesters.map(s => ({
      id: Number(s.id),
      name: String(s.name || ''),
      startDate: String(s.startDate || '')
    })).filter(s => s.id && s.startDate);
  }
  if (currentSemesterId) {
    config.currentSemesterId = Number(currentSemesterId);
    // 切换当前学期时清除手动设置的 currentWeek，改为按新起点自动计算
    delete config.currentWeek;
  }
  
  writeJSON(CONFIG_FILE, config);
  cache.config.data = config;
  cache.config.timestamp = Date.now();
  
  res.json({ 
    success: true, 
    semesters: getSemesters(), 
    currentSemesterId: getCurrentSemesterId(),
    currentWeek: getCurrentWeek()
  });
});

app.get('/api/members', (req, res) => {
  res.json(getMembers());
});

// 播放模式配置：公开读（无配置 → 默认 8s + 空清单 → 前端全校兜底）
app.get('/api/playmode', (req, res) => {
  res.json(getPlayModeConfig());
});
// 受保护全量写（CLI playlist 远程维护；鉴权与 /api/cli/* 一致）
app.post('/api/playmode', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader
      || (authHeader !== 'Bearer ' + INTERNAL_API_KEY
          && authHeader !== 'Bearer ' + CLI_API_KEY)) {
    return res.status(401).json({ error: '未授权访问' });
  }
  const { ok, errors, cfg } = validatePlayModeInput(req.body || {});
  if (!ok) return res.status(400).json({ error: errors.join('；') });
  cfg.updatedAt = new Date().toISOString();
  res.json(savePlayModeConfig(cfg));
});

app.post('/api/member/set-password', (req, res) => {
  const { memberId, password } = req.body;
  
  if (!memberId || !password) {
    return res.status(400).json({ error: '成员ID和密码不能为空' });
  }
  
  if (password.length < 4) {
    return res.status(400).json({ error: '密码长度至少4位' });
  }
  
  const members = getMembers();
  const memberIndex = members.findIndex(m => m.id === memberId);
  
  if (memberIndex === -1) {
    return res.status(404).json({ error: '成员未找到' });
  }
  
  members[memberIndex].password = bcrypt.hashSync(password, 10);
  cache.members.data = members;
  cache.members.timestamp = 0;
  writeJSON(MEMBERS_FILE, members);
  
  res.json({ success: true, message: '密码设置成功' });
});

app.post('/api/member/verify-password', (req, res) => {
  const { memberId, password } = req.body;
  
  if (!memberId || !password) {
    return res.status(400).json({ error: '成员ID和密码不能为空' });
  }
  
  const members = getMembers();
  const member = members.find(m => m.id === memberId);
  
  if (!member) {
    return res.status(404).json({ error: '成员未找到' });
  }
  
  if (!member.password) {
    return res.status(401).json({ error: 'PASSWORD_NOT_SET', message: '密码未设置' });
  }
  
  if (!bcrypt.compareSync(password, member.password)) {
    return res.status(401).json({ error: '密码错误' });
  }
  
  res.json({ success: true, message: '验证成功' });
});

app.post('/api/admin/verify-password', (req, res) => {
  const { password, adminDeviceId } = req.body;
  
  if (!password) {
    return res.status(400).json({ error: '密码不能为空' });
  }
  
  const config = getConfig();
  
  if (!config.adminPasswords || config.adminPasswords.length === 0) {
    return res.status(401).json({ error: '管理密码未设置' });
  }
  
  if (!config.adminPasswords.some(hash => bcrypt.compareSync(password, hash))) {
    return res.status(401).json({ error: '密码错误' });
  }

  // 查找是否已有该设备的管理员档案
  const profiles = config.adminProfiles || [];
  let profile = adminDeviceId ? profiles.find(p => p.adminId === adminDeviceId) : null;

  // 如果设备 ID 就是 admin_xxx（微信 Bot 绑定产生的），尝试在微信 Bot 注册表中查找
  if (!profile && adminDeviceId && adminDeviceId.startsWith('admin_')) {
    try {
      const botRegistryPath = getDataPath('wechat', 'bot_registry.json');
      if (fs.existsSync(botRegistryPath)) {
        const registry = JSON.parse(fs.readFileSync(botRegistryPath, 'utf-8'));
        const botEntry = registry.find(b => b.memberId === adminDeviceId && b.isAdmin);
        if (botEntry) {
          profile = { adminId: adminDeviceId, nickname: `管理员 ${adminDeviceId.replace('admin_', '').substring(0, 4).toUpperCase()}` };
        }
      }
    } catch (e) {}
  }

  const needsNickname = !profile;
  
  res.json({ 
    success: true, 
    message: '验证成功', 
    isAdmin: true,
    adminId: profile?.adminId || null,
    nickname: profile?.nickname || null,
    needsNickname
  });
});

app.post('/api/admin/set-nickname', (req, res) => {
  const { adminDeviceId, nickname, password } = req.body;

  if (!adminDeviceId || !nickname) {
    return res.status(400).json({ error: '设备ID和昵称不能为空' });
  }
  if (!password) {
    return res.status(400).json({ error: '密码不能为空' });
  }

  const config = getConfig();
  if (!config.adminPasswords?.some(hash => bcrypt.compareSync(password, hash))) {
    return res.status(401).json({ error: '密码错误' });
  }

  const profiles = config.adminProfiles || [];
  const existing = profiles.find(p => p.adminId === adminDeviceId);
  if (existing) {
    existing.nickname = nickname;
  } else {
    profiles.push({ adminId: adminDeviceId, nickname });
  }
  config.adminProfiles = profiles;
  saveConfig(config);

  res.json({ success: true, adminId: adminDeviceId, nickname });
});

app.post('/api/admin/set-password', (req, res) => {
  const { newPassword, confirmPassword } = req.body;
  
  if (!newPassword || !confirmPassword) {
    return res.status(400).json({ error: '新密码和确认密码不能为空' });
  }
  
  if (newPassword.length < 4) {
    return res.status(400).json({ error: '密码长度至少4位' });
  }
  
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ error: '两次输入的密码不一致' });
  }
  
  const config = getConfig();
  
  if (!config.adminPasswords) {
    config.adminPasswords = [];
  }
  
  if (config.adminPasswords.some(hash => bcrypt.compareSync(newPassword, hash))) {
    return res.status(400).json({ error: '该密码已存在' });
  }

  config.adminPasswords.push(bcrypt.hashSync(newPassword, 10));
  writeJSON(CONFIG_FILE, config);
  cache.config.data = config;
  cache.config.timestamp = Date.now();
  
  res.json({ success: true, message: '管理密码添加成功', totalPasswords: config.adminPasswords.length });
});

app.get('/api/admin/check-password-set', (req, res) => {
  const config = getConfig();
  res.json({ hasPassword: config.adminPasswords && config.adminPasswords.length > 0 });
});

// 获取班级列表（包含班长信息）
app.get('/api/admin/classes', (req, res) => {
  try {
    const members = getMembers();
    const classes = [...new Set(members.map(m => m.class))].filter(c => c);
    
    const classList = classes.map(className => {
      // 查找班长（isBackbone为true且position为"班长"的成员）
      const monitor = members.find(m => m.class === className && m.isBackbone === true && m.position === '班长');
      return {
        name: className,
        monitor: monitor ? { id: monitor.id, name: monitor.name } : null,
        memberCount: members.filter(m => m.class === className).length
      };
    });
    
    res.json({ classes: classList });
  } catch (err) {
    console.error('Error getting classes:', err);
    res.status(500).json({ error: '获取班级列表失败' });
  }
});

// 修改班长
app.post('/api/admin/set-monitor', (req, res) => {
  try {
    const { className, newMonitorId, password } = req.body;
    
    // 验证管理密码
    if (!password) {
      return res.status(400).json({ error: '管理密码不能为空' });
    }
    
    const config = getConfig();
    if (!config.adminPasswords || !config.adminPasswords.includes(password)) {
      return res.status(401).json({ error: '密码错误' });
    }
    
    // 验证参数
    if (!className || !newMonitorId) {
      return res.status(400).json({ error: '班级名称和新班长ID不能为空' });
    }
    
    const members = getMembers();
    const classMembers = members.filter(m => m.class === className);
    
    if (classMembers.length === 0) {
      return res.status(404).json({ error: '班级不存在' });
    }
    
    // 查找新班长
    const newMonitor = classMembers.find(m => m.id === newMonitorId);
    if (!newMonitor) {
      return res.status(404).json({ error: '新班长不在该班级中' });
    }
    
    // 查找旧班长
    const oldMonitor = classMembers.find(m => m.isBackbone === true && m.position === '班长');
    
    // 生成新的班级名称
    const newClassName = newMonitor.name + '班';
    
    // 更新旧班长（只取消班长身份，保留职位）
    if (oldMonitor) {
      oldMonitor.isBackbone = false;
      // 不修改 position，保留用户自己填写的职位
    }
    
    // 更新新班长（设为骨干，但不修改职位）
    newMonitor.isBackbone = true;
    // 不修改 position，由用户自己填写
    
    // 更新所有班级成员的班级名称
    classMembers.forEach(m => {
      m.class = newClassName;
    });
    
    // 保存更新
    writeJSON(MEMBERS_FILE, members);
    cache.members.data = members;
    cache.members.timestamp = 0;
    
    res.json({ 
      success: true, 
      message: `班长已修改为${newMonitor.name}`,
      oldMonitor: oldMonitor ? { id: oldMonitor.id, name: oldMonitor.name } : null,
      newMonitor: { id: newMonitor.id, name: newMonitor.name },
      oldClassName: className,
      newClassName: newClassName
    });
  } catch (err) {
    console.error('Error setting monitor:', err);
    res.status(500).json({ error: '修改班长失败' });
  }
});

// 获取班级成员（用于选择新班长）
app.get('/api/admin/class-members', (req, res) => {
  try {
    const { className } = req.query;
    
    if (!className) {
      return res.status(400).json({ error: '班级名称不能为空' });
    }
    
    const members = getMembers();
    const classMembers = members.filter(m => m.class === className);
    
    res.json({ members: classMembers });
  } catch (err) {
    console.error('Error getting class members:', err);
    res.status(500).json({ error: '获取班级成员失败' });
  }
});

const uploadScores = multer({ dest: 'temp_uploads/' });

app.post('/api/upload/academic-scores', uploadScores.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }
    
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet);
    
    const members = getMembers();
    const academicScores = getAcademicScores();
    const subjects = new Set();
    
    const range = xlsx.utils.decode_range(worksheet['!ref'] || 'A1');
    const allKeys = [];
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = worksheet[xlsx.utils.encode_cell({ r: 0, c: C })];
      if (cell && cell.v && String(cell.v).trim() !== '' && String(cell.v) !== '序号' && String(cell.v) !== '姓名' && String(cell.v) !== '平均成绩') {
        allKeys.push(String(cell.v));
        subjects.add(String(cell.v));
      }
    }
    
    let importedCount = 0;
    
    data.forEach(row => {
      const name = row['姓名'];
      if (!name) return;
      
      const member = members.find(m => m.name === name);
      if (!member) return;
      
      const scores = {};
      allKeys.forEach(key => {
        const value = row[key];
        // 宽松处理：null、undefined时设为空字符串，其他情况保留原始值
        if (value === null || value === undefined) {
          scores[key] = '';
        } else if (typeof value === 'number') {
          // 数值类型直接保存（包括0）
          scores[key] = value;
        } else if (typeof value === 'string') {
          // 字符串类型只trim前后空格，但保留中间内容
          const trimmed = value.trim();
          scores[key] = trimmed;
        } else {
          // 其他类型转换为字符串
          scores[key] = String(value);
        }
      });
      
      if (Object.keys(scores).length > 0) {
        const existingIndex = academicScores.findIndex(a => a.memberId === member.id);
        if (existingIndex >= 0) {
          // 增量更新：合并科目，添加新科目、覆盖已有科目
          const existing = academicScores[existingIndex];
          Object.keys(scores).forEach(key => {
            existing.scores[key] = scores[key];
          });
          existing.timestamp = beijingISO();
        } else {
          academicScores.push({
            memberId: member.id,
            name: name,
            scores: scores,
            timestamp: beijingISO()
          });
        }
        importedCount++;
      }
    });
    
    writeJSON(ACADEMIC_SCORES_FILE, academicScores);
    invalidateCache();
    
    fs.unlinkSync(req.file.path);
    
    res.json({ 
      success: true, 
      message: '成绩导入成功',
      subjects: Array.from(subjects),
      count: importedCount
    });
  } catch (err) {
    console.error('Import error:', err);
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: '导入失败：' + err.message });
  }

  // 触发管理日报生成（学业成绩）
  dailyReport.generateReport(agentEngine, 'academic_score', wechatBot, pushManager, {
    subjects: Array.from(subjects),
    count: importedCount
  }).catch(e =>
    console.error('[DailyReport] 学业成绩触发报告生成失败:', e.message)
  );
});

app.get('/api/member/detail/:memberId', (req, res) => {
  const { memberId } = req.params;
  const members = getMembers();
  const member = members.find(m => m.id === memberId);
  
  if (!member) {
    return res.status(404).json({ error: '成员未找到' });
  }
  
  const academicScores = getAcademicScores();
  const fitnessScores = getFitnessScores();
  
  const memberAcademicScore = academicScores.find(s => s.memberId === memberId);
  let memberFitnessScore = fitnessScores.find(s => s.memberId === memberId);
  
  // 兼容性处理：转换旧格式到新格式
  if (memberFitnessScore && !memberFitnessScore.history && memberFitnessScore.scores) {
    memberFitnessScore = {
      ...memberFitnessScore,
      history: [{
        month: '2026-03', // 默认月份
        scores: memberFitnessScore.scores,
        timestamp: memberFitnessScore.timestamp
      }]
    };
  }
  
  let height = null;
  let weight = null;
  let bmi = null;

  // 身高：优先使用 fixed_heights.json
  const fixedHeights = readFixedHeights();
  if (fixedHeights[memberId]) {
    height = fixedHeights[memberId];
  }

  // 体重：从周BMI数据中获取（BMI录入数据）
  const scoresDir = getScoresDir();
  if (fs.existsSync(scoresDir)) {
    const files = fs.readdirSync(scoresDir);
    const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'))
      .sort((a, b) => {
        const weekA = parseInt(a.replace('bmi_week_', '').replace('.json.gz', ''));
        const weekB = parseInt(b.replace('bmi_week_', '').replace('.json.gz', ''));
        return weekB - weekA;
      });

    for (const file of bmiFiles) {
      const week = parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''));
      const bmiWeekData = readBMIByWeek(week);
      if (bmiWeekData[memberId]) {
        const memberBMI = bmiWeekData[memberId];
        if (memberBMI.weight) {
          weight = memberBMI.weight;
        }
        // 如果fixed_heights中没有身高，但BMI周数据中有身高，也可以使用
        if (!height && memberBMI.height) {
          height = memberBMI.height;
        }
        break;
      }
    }
  }

  // 计算BMI（只使用上述数据源，不使用体测成绩）
  if (height && weight) {
    const h = parseFloat(height);
    const w = parseFloat(weight);
    if (!isNaN(h) && !isNaN(w) && h > 0 && w > 0) {
      // 处理身高可能是米为单位的情况
      let heightInCm = h;
      if (heightInCm > 0 && heightInCm < 3) {
        heightInCm = heightInCm * 100;
      }
      const heightInMeters = heightInCm / 100;
      bmi = (w / (heightInMeters * heightInMeters)).toFixed(2);
    }
  }
  
  const getZodiac = (birthday) => {
    if (!birthday) return null;
    const parts = birthday.split('-');
    const month = parseInt(parts[1]);
    const day = parseInt(parts[2]);
    
    // 正确的星座日期范围
    const zodiacSigns = [
      { name: '摩羯座', start: [1, 1], end: [1, 19] },
      { name: '水瓶座', start: [1, 20], end: [2, 18] },
      { name: '双鱼座', start: [2, 19], end: [3, 20] },
      { name: '白羊座', start: [3, 21], end: [4, 19] },
      { name: '金牛座', start: [4, 20], end: [5, 20] },
      { name: '双子座', start: [5, 21], end: [6, 21] },
      { name: '巨蟹座', start: [6, 22], end: [7, 22] },
      { name: '狮子座', start: [7, 23], end: [8, 22] },
      { name: '处女座', start: [8, 23], end: [9, 22] },
      { name: '天秤座', start: [9, 23], end: [10, 23] },
      { name: '天蝎座', start: [10, 24], end: [11, 22] },
      { name: '射手座', start: [11, 23], end: [12, 21] },
      { name: '摩羯座', start: [12, 22], end: [12, 31] }
    ];
    
    for (const sign of zodiacSigns) {
      if (month > sign.start[0] || (month === sign.start[0] && day >= sign.start[1])) {
        if (month < sign.end[0] || (month === sign.end[0] && day <= sign.end[1])) {
          return sign.name;
        }
      }
    }
    return '摩羯座';
  };
  
  res.json({
    member: {
      id: member.id,
      name: member.name,
      class: member.class,
      height: height,
      weight: weight,
      mbti: member.mbti,
      birthday: member.birthday || null,
      zodiac: getZodiac(member.birthday),
      bmi: bmi,
      isBackbone: member.isBackbone || false,
      position: member.position || null,
      hobbies: member.hobbies || null,
      hometown: member.hometown || null
    },
    academicScores: memberAcademicScore ? [memberAcademicScore] : [],
    fitnessScores: memberFitnessScore ? [memberFitnessScore] : []
  });
});

// 获取成员上周的二级评分
app.get('/api/member/:memberId/last-week-sub-scores', (req, res) => {
  const { memberId } = req.params;
  const members = getMembers();
  const member = members.find(m => m.id === memberId);
  
  if (!member) {
    return res.status(404).json({ error: '成员未找到' });
  }
  
  try {
    const config = getConfig();
    const currentWeek = config.currentWeek || getCurrentWeek();
    const targetWeek = currentWeek - 1; // 目标周次是上周
    
    if (targetWeek < 1) {
      return res.json(null);
    }
    
    const weekScores = getScoresForWeek(targetWeek);
    const memberScores = weekScores.filter(s => s.memberId === memberId);
    
    if (memberScores.length > 0) {
      // 聚合所有评分记录的subItemScores
      const aggregatedSubScores = {};
      const subScoreCounts = {};
      
      memberScores.forEach(score => {
        if (score.subItemScores) {
          Object.entries(score.subItemScores).forEach(([key, value]) => {
            if (value !== null && value !== undefined) {
              if (!aggregatedSubScores[key]) {
                aggregatedSubScores[key] = 0;
                subScoreCounts[key] = 0;
              }
              aggregatedSubScores[key] += value;
              subScoreCounts[key]++;
            }
          });
        }
      });
      
      // 计算平均值
      const result = {};
      Object.entries(aggregatedSubScores).forEach(([key, total]) => {
        result[key] = Math.round((total / subScoreCounts[key]) * 10) / 10;
      });
      
      return res.json({
        week: targetWeek,
        subItemScores: result
      });
    }
    
    return res.json(null);
  } catch (err) {
    console.error('Error getting sub scores:', err);
    return res.status(500).json({ error: '获取二级评分失败' });
  }
});

// 获取指定评分人对指定成员的详细二级评分（上上周的评分，用于辅助填写）
app.get('/api/evaluator/:evaluatorId/member/:memberId/last-week-scores', (req, res) => {
  const { evaluatorId, memberId } = req.params;
  const members = getMembers();
  const member = members.find(m => m.id === memberId);
  
  if (!member) {
    return res.status(404).json({ error: '成员未找到' });
  }
  
  try {
    const scoresDir = getScoresDir();
    if (!fs.existsSync(scoresDir)) {
      return res.json(null);
    }
    
    const files = fs.readdirSync(scoresDir);
    const scoreFiles = files.filter(file => file.startsWith('scores_week_') && file.endsWith('.json.gz'))
      .sort((a, b) => {
        const weekA = parseInt(a.replace('scores_week_', '').replace('.json.gz', ''));
        const weekB = parseInt(b.replace('scores_week_', '').replace('.json.gz', ''));
        return weekB - weekA;
      });
    
    if (scoreFiles.length === 0) {
      return res.json(null);
    }
    
    // 从最新的周次开始查找该成员且该评分人的评分记录
    for (const file of scoreFiles) {
      const week = parseInt(file.replace('scores_week_', '').replace('.json.gz', ''));
      const weekScores = getScoresForWeek(week);
      
      // 找到该成员且该评分人的评分记录
      const scoreRecord = weekScores.find(s => 
        s.memberId === memberId && s.evaluatorId === evaluatorId
      );
      
      if (scoreRecord && scoreRecord.subItemScores) {
        return res.json({
          week: week,
          evaluatorId: evaluatorId,
          memberId: memberId,
          subItemScores: scoreRecord.subItemScores,
          type: scoreRecord.type || 'peer'
        });
      }
    }
    
    return res.json(null);
  } catch (err) {
    console.error('Error getting evaluator-member scores:', err);
    return res.status(500).json({ error: '获取详细评分失败' });
  }
});

// 获取指定评分人对指定成员的连续两周评分（用于检测连续相似）
app.get('/api/evaluator/:evaluatorId/member/:memberId/consecutive-scores', (req, res) => {
  const { evaluatorId, memberId } = req.params;
  const members = getMembers();
  const member = members.find(m => m.id === memberId);
  
  if (!member) {
    return res.status(404).json({ error: '成员未找到' });
  }
  
  try {
    const scoresDir = getScoresDir();
    if (!fs.existsSync(scoresDir)) {
      return res.json(null);
    }
    
    const files = fs.readdirSync(scoresDir);
    const scoreFiles = files.filter(file => file.startsWith('scores_week_') && file.endsWith('.json.gz'))
      .sort((a, b) => {
        const weekA = parseInt(a.replace('scores_week_', '').replace('.json.gz', ''));
        const weekB = parseInt(b.replace('scores_week_', '').replace('.json.gz', ''));
        return weekB - weekA;
      });
    
    if (scoreFiles.length === 0) {
      return res.json(null);
    }
    
    const consecutiveScores = [];
    
    // 从最新周次开始，查找最近两周该评分人对该成员的评分
    let foundCount = 0;
    for (const file of scoreFiles) {
      if (foundCount >= 2) break;
      
      const week = parseInt(file.replace('scores_week_', '').replace('.json.gz', ''));
      const weekScores = getScoresForWeek(week);
      
      const scoreRecord = weekScores.find(s => 
        s.memberId === memberId && s.evaluatorId === evaluatorId
      );
      
      if (scoreRecord && scoreRecord.subItemScores) {
        consecutiveScores.push({
          week: week,
          subItemScores: scoreRecord.subItemScores
        });
        foundCount++;
      }
    }
    
    if (consecutiveScores.length === 0) {
      return res.json(null);
    }
    
    return res.json({
      evaluatorId: evaluatorId,
      memberId: memberId,
      scores: consecutiveScores
    });
  } catch (err) {
    console.error('Error getting consecutive scores:', err);
    return res.status(500).json({ error: '获取连续评分失败' });
  }
});

app.get('/api/fitness-scores/:memberId', (req, res) => {
  const { memberId } = req.params;
  const fitnessScores = getFitnessScores();
  const memberFitnessScore = fitnessScores.find(s => s.memberId === memberId);
  
  if (!memberFitnessScore) {
    return res.json(null);
  }
  
  res.json(memberFitnessScore);
});

app.get('/api/academic-scores', (req, res) => {
  // 学业成绩按课程名存储、无时间字段，无法可靠按学期过滤，保持全量返回
  res.json(getAcademicScores());
});

app.get('/api/fitness-scores', (req, res) => {
  const fitnessScores = getFitnessScores();
  const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
  if (!semesterId) {
    return res.json(fitnessScores);
  }
  // 按 month 落在学期日期范围过滤（不改数据结构，仅读取时过滤）
  res.json(fitnessScores.map(s => {
    if (!Array.isArray(s.history)) return s;
    return { ...s, history: s.history.filter(h => semesterUtils.monthInSemester(h.month, semesterId)) };
  }));
});

app.post('/api/upload/fitness-scores', uploadScores.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }
    
    const month = req.body.month;
    if (!month) {
      return res.status(400).json({ error: '请选择月份' });
    }
    
    const workbook = xlsx.readFile(req.file.path, {
      type: 'file',
      codepage: 65001 // 强制使用UTF-8编码
    });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    // 使用raw选项确保读取原始数据
    const data = xlsx.utils.sheet_to_json(worksheet, { raw: true, defval: null });
    
    const members = getMembers();
    const fitnessScores = getFitnessScores();
    const items = new Set();
    
    const range = xlsx.utils.decode_range(worksheet['!ref'] || 'A1');
    const allKeys = [];
    const keyMap = {}; // 用于映射：trim后的列名 -> 原始列名
    for (let C = range.s.c; C <= range.e.c; C++) {
      const cell = worksheet[xlsx.utils.encode_cell({ r: 0, c: C })];
      if (cell && cell.v) {
        const originalKey = String(cell.v);
        const trimmedKey = originalKey.trim();
        if (trimmedKey !== '' && trimmedKey !== '序号' && trimmedKey !== '姓名') {
          allKeys.push(trimmedKey);
          keyMap[trimmedKey] = originalKey;
          items.add(trimmedKey);
        }
      }
    }
    
    console.log('========== 体能成绩导入开始 ==========');
    console.log('Excel总行数:', data.length);
    console.log('成员总数:', members.length);
    console.log('列名:', allKeys);
    
    // 打印前5个成员姓名用于调试
    console.log('系统中的前5个成员姓名:', members.slice(0, 5).map(m => m.name));
    
    // 打印Excel中读取到的所有姓名
    const allExcelNames = data.map(row => row['姓名']).filter(n => n);
    console.log('Excel中读取到的姓名:', allExcelNames);
    
    let importedCount = 0;
    const notFoundMembers = [];
    const skippedNames = [];
    const importedNames = [];
    
    data.forEach((row, index) => {
      let name = row['姓名'];
      if (!name) {
        skippedNames.push('(空姓名)');
        return;
      }
      
      // 确保name是字符串
      name = String(name);
      
      let member = members.find(m => m.name === name);
      
      // 如果精确匹配没找到，尝试容错匹配
      if (!member) {
        // 方法1：去除空格后匹配
        member = members.find(m => m.name.replace(/\s/g, '') === name.replace(/\s/g, ''));
        
        // 方法2：尝试部分匹配（包含关系）
        if (!member) {
          const matchingMembers = members.filter(m => 
            name.includes(m.name) || m.name.includes(name)
          );
          if (matchingMembers.length === 1) {
            member = matchingMembers[0];
            console.log(`[容错匹配] Excel姓名 "${name}" 匹配到系统成员 "${member.name}"`);
          }
        }
      }
      
      if (!member) {
        notFoundMembers.push(name);
        return;
      }
      
      const scores = {};
      
      allKeys.forEach(key => {
        // 直接遍历row的所有key，找到trim后匹配的
        let value = null;
        for (const rowKey in row) {
          if (rowKey.trim() === key) {
            value = row[rowKey];
            break;
          }
        }
        
        // 统一身高体重单位
        if (key === '身高') {
          if (value !== null && value !== undefined && value !== '') {
            let h = parseFloat(value);
            if (!isNaN(h)) {
              // 如果小于3，认为是米，转换为厘米
              if (h < 3) {
                h = h * 100;
              }
              scores[key] = Math.round(h);
            } else {
              scores[key] = '';
            }
          } else {
            scores[key] = '';
          }
        } else if (key === '体重') {
          if (value !== null && value !== undefined && value !== '') {
            let w = parseFloat(value);
            if (!isNaN(w)) {
              scores[key] = Math.round(w * 10) / 10; // 保留1位小数
            } else {
              scores[key] = '';
            }
          } else {
            scores[key] = '';
          }
        } else {
          // 其他项目正常处理
          if (value === null || value === undefined) {
            scores[key] = '';
          } else if (typeof value === 'number') {
            scores[key] = value;
          } else if (typeof value === 'string') {
            const trimmed = value.trim();
            scores[key] = trimmed;
          } else {
            scores[key] = String(value);
          }
        }
      });
      
      if (Object.keys(scores).length > 0) {
        let memberRecord = fitnessScores.find(f => f.memberId === member.id);
        if (!memberRecord) {
          memberRecord = {
            memberId: member.id,
            name: name,
            history: []
          };
          fitnessScores.push(memberRecord);
        }
        
        const existingMonthIndex = memberRecord.history.findIndex(h => h.month === month);
        if (existingMonthIndex >= 0) {
          memberRecord.history[existingMonthIndex] = {
            month: month,
            scores: scores,
            timestamp: beijingISO()
          };
        } else {
          memberRecord.history.push({
            month: month,
            scores: scores,
            timestamp: beijingISO()
          });
        }
        
        importedCount++;
        importedNames.push(name);
      }
    });
    
    console.log('========== 导入统计 ==========');
    console.log('导入成功:', importedCount, '人');
    console.log('导入的姓名:', importedNames);
    console.log('未找到的成员:', notFoundMembers);
    console.log('跳过的空姓名:', skippedNames.length, '条');
    console.log('==============================');
    
    writeJSON(FITNESS_SCORES_FILE, fitnessScores);
    invalidateCache();
    
    fs.unlinkSync(req.file.path);
    
    let message = `体能成绩导入成功，导入 ${importedCount} 人`;
    if (notFoundMembers.length > 0) {
      message += `，未找到 ${notFoundMembers.length} 人：${notFoundMembers.join('、')}`;
    }
    if (skippedNames.length > 0) {
      message += `，跳过 ${skippedNames.length} 条空姓名记录`;
    }
    
    res.json({ 
      success: true, 
      message: message,
      items: Array.from(items),
      count: importedCount,
      notFoundMembers: notFoundMembers,
      skippedNames: skippedNames,
      totalRows: data.length
    });

    // 触发管理日报生成（体能成绩）
    dailyReport.generateReport(agentEngine, 'fitness_score', wechatBot, pushManager, {
      month: month,
      count: importedCount,
      notFoundMembers: notFoundMembers.length > 0 ? notFoundMembers : undefined,
      totalRows: data.length
    }).catch(e =>
      console.error('[DailyReport] 体能成绩触发报告生成失败:', e.message)
    );
  } catch (err) {
    console.error('Import error:', err);
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: '导入失败：' + err.message });
  }
});

app.post('/api/upload/rank-scores', uploadScores.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }
    
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1 });
    
    if (data.length < 2) {
      return res.status(400).json({ error: '表格数据不足' });
    }
    
    const members = getMembers();
    const rankScores = getRankScores();
    const headerRow = data[0];
    
    const semesters = [];
    const totalScores = [];
    const totalRanks = [];
    const yearRanks = [];
    
    let i = 1;
    while (i < headerRow.length) {
      const colName = headerRow[i];
      if (colName && colName.includes('平均成绩')) {
        const semesterName = colName.replace('平均成绩', '').trim();
        semesters.push({
          name: semesterName,
          scoreCol: i,
          rankCol: i + 1
        });
        i += 2;
      } else if (colName === '总平均成绩') {
        totalScores.push(i);
        i++;
      } else if (colName === '总成绩排名') {
        totalRanks.push(i);
        i++;
      } else if (colName && colName.includes('排名')) {
        yearRanks.push({
          name: colName,
          col: i
        });
        i++;
      } else {
        i++;
      }
    }
    
    let importedCount = 0;
    
    for (let rowIndex = 1; rowIndex < data.length; rowIndex++) {
      const row = data[rowIndex];
      const name = row[0];
      if (!name) continue;
      
      const member = members.find(m => m.name === name);
      if (!member) continue;
      
      const memberData = {
        memberId: member.id,
        name: name,
        semesterScores: [],
        totalScores: [],
        totalRanks: [],
        yearRanks: []
      };
      
      semesters.forEach(sem => {
        const score = row[sem.scoreCol];
        const rank = row[sem.rankCol];
        if (score !== undefined || rank !== undefined) {
          memberData.semesterScores.push({
            semester: sem.name,
            score: score,
            rank: rank
          });
        }
      });
      
      totalScores.forEach(colIdx => {
        const score = row[colIdx];
        if (score !== undefined) {
          memberData.totalScores.push(score);
        }
      });
      
      totalRanks.forEach(colIdx => {
        const rank = row[colIdx];
        if (rank !== undefined) {
          memberData.totalRanks.push(rank);
        }
      });
      
      yearRanks.forEach(yr => {
        const rank = row[yr.col];
        if (rank !== undefined) {
          memberData.yearRanks.push({
            name: yr.name,
            rank: rank
          });
        }
      });
      
      const existingIndex = rankScores.findIndex(r => r.memberId === member.id);
      if (existingIndex >= 0) {
        // 增量更新：合并学期成绩，添加新学期、覆盖已有学期
        const existing = rankScores[existingIndex];
        memberData.semesterScores.forEach(newSem => {
          const existingSem = existing.semesterScores.find(s => s.semester === newSem.semester);
          if (existingSem) {
            existingSem.score = newSem.score;
            existingSem.rank = newSem.rank;
          } else {
            existing.semesterScores.push(newSem);
          }
        });
        memberData.yearRanks.forEach(newYr => {
          const existingYr = existing.yearRanks.find(y => y.name === newYr.name);
          if (existingYr) {
            existingYr.rank = newYr.rank;
          } else {
            existing.yearRanks.push(newYr);
          }
        });
        if (memberData.totalScores.length > 0) existing.totalScores = memberData.totalScores;
        if (memberData.totalRanks.length > 0) existing.totalRanks = memberData.totalRanks;
      } else {
        rankScores.push(memberData);
      }
      importedCount++;
    }
    
    writeJSON(RANK_SCORES_FILE, rankScores);
    invalidateCache();

    fs.unlinkSync(req.file.path);

    const semestersList = semesters.map(s => s.name);
    res.json({
      success: true,
      message: '成绩排名导入成功',
      count: importedCount,
      semesters: semestersList
    });

    // 触发管理日报生成（学习成绩排名）
    dailyReport.generateReport(agentEngine, 'rank_score', wechatBot, pushManager, {
      count: importedCount,
      semesters: semestersList
    }).catch(e =>
      console.error('[DailyReport] 学习成绩排名触发报告生成失败:', e.message)
    );
  } catch (err) {
    console.error('Import error:', err);
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: '导入失败：' + err.message });
  }
});

app.get('/api/rank-scores', (req, res) => {
  const rankScores = getRankScores();
  const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
  if (!semesterId) {
    return res.json(rankScores);
  }
  // rank 数据的 semesterScores 自带学期标签（如 "2026-春"），按推导标签过滤（不改数据结构）
  const label = semesterUtils.getSemesterRankLabel(semesterId);
  res.json(rankScores.map(r => {
    if (!Array.isArray(r.semesterScores)) return r;
    return { ...r, semesterScores: r.semesterScores.filter(s => s.semester === label) };
  }));
});

app.get('/api/rank-scores/:memberId', (req, res) => {
  const { memberId } = req.params;
  const rankScores = getRankScores();
  const memberRank = rankScores.find(r => r.memberId === memberId);
  
  if (!memberRank) {
    return res.json(null);
  }
  
  const result = { ...memberRank };
  
  // 过滤掉"总"学期，只保留实际学期
  const validSemesterScores = result.semesterScores ? 
    result.semesterScores.filter(s => s.semester !== '总') : [];
  
  if (validSemesterScores && validSemesterScores.length >= 2) {
    const latestSem = validSemesterScores[validSemesterScores.length - 1];
    const prevSem = validSemesterScores[validSemesterScores.length - 2];
    if (latestSem.rank && prevSem.rank) {
      result.latestSemesterRankChange = prevSem.rank - latestSem.rank;
    }
  }
  
  if (result.totalRanks && result.totalRanks.length >= 2) {
    const latestTotal = result.totalRanks[result.totalRanks.length - 1];
    const prevTotal = result.totalRanks[result.totalRanks.length - 2];
    if (latestTotal && prevTotal) {
      result.latestTotalRankChange = prevTotal - latestTotal;
    }
    result.currentTotalRank = latestTotal;
  }
  
  res.json(result);
});

// ====== 每周通报管理 ======

// 上传通报Excel
app.post('/api/weekly-reports/upload', uploadScores.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }

    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

    if (data.length < 3) {
      return res.status(400).json({ error: '表格数据不足，请检查格式' });
    }

    // 第0行：日期范围
    const weekRange = String(data[0][0] || '').trim();
    if (!weekRange) {
      return res.status(400).json({ error: '表头日期范围不能为空，请确认第一行有日期如 2026.6.15—6.21' });
    }

    const members = getMembers();
    const nameToId = {};
    members.forEach(m => { nameToId[m.name] = m.id; });

    // 从姓名/宿舍列提取名字
    function extractNames(raw) {
      if (!raw) return [];
      const text = String(raw).trim();
      // 匹配括号中的名字: "639(张奕波 李仲 李燕泽 毛健宇)" -> ["张奕波","李仲","李燕泽","毛健宇"]
      const parenMatch = text.match(/\(([^)]+)\)/);
      if (parenMatch) {
        const inner = parenMatch[1].trim();
        // 如果括号内是中文名字（用空格或顿号分隔）
        if (/[\u4e00-\u9fa5]/.test(inner)) {
          return inner.split(/[\s、]+/).map(n => n.trim()).filter(w => w && /[\u4e00-\u9fa5]/.test(w));
        }
        return [];
      }
      // 无括号：可能是纯名字或多名字（空格/顿号分隔）
      // 如 "谢伟峰" 或 "倪思衡 郝英博 李仕俊 何佳嵘" 或 "樊宇博、丁丕硕、温思佳"
      if (/[\u4e00-\u9fa5]/.test(text) && !/[/\\]/.test(text)) {
        const parts = text.split(/[\s、]+/).filter(w => w && /[\u4e00-\u9fa5]/.test(w) && w.length >= 2 && w.length <= 5);
        if (parts.length > 0) return parts;
      }
      return [];
    }

    // 模糊匹配名字（一字之差）
    function fuzzyMatchName(rawName, memberList) {
      // 精确匹配
      for (const m of memberList) {
        if (m.name === rawName) return { matched: true, member: m };
      }
      // 一字之差
      if (rawName.length >= 2) {
        for (const m of memberList) {
          if (m.name.length === rawName.length) {
            let diff = 0;
            for (let i = 0; i < rawName.length; i++) {
              if (rawName[i] !== m.name[i]) diff++;
            }
            if (diff === 1) return { matched: true, member: m, fuzzy: true, fuzzyFrom: rawName };
          }
        }
      }
      return { matched: false };
    }

    // 解析扣分值
    function parseScore(raw) {
      if (!raw) return 0;
      const text = String(raw).trim();
      // 匹配数字，包括负数和小数
      const numMatch = text.match(/-?\d+\.?\d*/);
      if (numMatch) {
        return parseFloat(numMatch[0]);
      }
      return 0;
    }

    // 判断是否每人扣分
    function isPerPerson(raw) {
      if (!raw) return false;
      return String(raw).includes('/人');
    }

    const items = [];
    const memberScoreMap = {}; // memberName -> { score, items }
    const fuzzyMatches = []; // 模糊匹配的记录

    for (let i = 2; i < data.length; i++) {
      const row = data[i];
      const date = String(row[0] || '').trim();
      const nameRaw = String(row[1] || '').trim();
      const content = String(row[2] || '').trim();
      const scoreRaw = String(row[3] || '').trim();
      const remark = String(row[4] || '').trim();

      if (!date && !nameRaw && !content && !scoreRaw) continue;

      const names = extractNames(nameRaw);
      if (names.length === 0) continue;

      const scoreVal = parseScore(scoreRaw);
      const perPerson = isPerPerson(scoreRaw);

      // 每人扣分
      const perScore = perPerson ? scoreVal : scoreVal;

      names.forEach(name => {
        // 模糊匹配
        const fm = fuzzyMatchName(name, members);
        const resolvedName = fm.matched ? fm.member.name : name;
        if (fm.matched && fm.fuzzy) {
          fuzzyMatches.push({ original: name, resolved: resolvedName, memberId: fm.member.id });
        }

        if (!memberScoreMap[resolvedName]) {
          memberScoreMap[resolvedName] = { score: 80, items: [] };
        }
        memberScoreMap[resolvedName].score += perScore;
        memberScoreMap[resolvedName].score = Math.round(memberScoreMap[resolvedName].score * 100) / 100;
        memberScoreMap[resolvedName].items.push({
          date, content, score: perScore, remark
        });
      });

      items.push({
        date,
        rawName: nameRaw,
        names,
        content,
        score: scoreVal,
        perPerson,
        remark
      });
    }

    // 生成通报文本
    let reportText = '';
    // 按日期分组
    const dateGroups = {};
    items.forEach(item => {
      if (!dateGroups[item.date]) dateGroups[item.date] = [];
      dateGroups[item.date].push(item);
    });

    const sortedDates = Object.keys(dateGroups).sort();
    for (const date of sortedDates) {
      const group = dateGroups[date];
      for (const item of group) {
        const nameStr = item.names.join('、');
        const scoreStr = item.score < 0 ? `（${item.score}分）` : `（+${item.score}分）`;
        const perStr = item.perPerson ? '/人' : '';
        reportText += `${item.date} ${nameStr} ${item.content} ${item.score}${perStr}分 ${item.remark || ''}\n`;
      }
    }
    reportText += `\n本周期计分：\n`;
    const sortedNames = Object.keys(memberScoreMap).sort((a, b) => memberScoreMap[a].score - memberScoreMap[b].score);
    for (const name of sortedNames) {
      const data = memberScoreMap[name];
      reportText += `  ${name}：${data.score.toFixed(1)}分\n`;
    }

    // 转换为memberId
    const memberScores = {};
    Object.entries(memberScoreMap).forEach(([name, data]) => {
      const memberId = nameToId[name];
      if (memberId) {
        memberScores[memberId] = { memberId, name, score: data.score, items: data.items };
      } else {
        memberScores[name] = { memberId: null, name, score: data.score, items: data.items };
      }
    });

    const report = {
      weekRange,
      uploadTime: beijingISO(),
      items,
      reportText,
      memberScores
    };

    // 保存：相同weekRange覆盖
    const reports = getWeeklyReports();
    const existingIdx = reports.findIndex(r => r.weekRange === weekRange);
    if (existingIdx >= 0) {
      reports[existingIdx] = report;
    } else {
      reports.push(report);
    }
    saveWeeklyReports(reports);
    invalidateCache();

    fs.unlinkSync(req.file.path);

    let msg = `通报导入成功，共 ${items.length} 条记录，涉及 ${Object.keys(memberScoreMap).length} 人`;
    if (fuzzyMatches.length > 0) {
      msg += `，自动纠正 ${fuzzyMatches.length} 个错别名字`;
    }

    res.json({
      success: true,
      message: msg,
      weekRange,
      itemCount: items.length,
      memberCount: Object.keys(memberScoreMap).length,
      reportText,
      memberScores,
      fuzzyMatches: fuzzyMatches.length > 0 ? fuzzyMatches : undefined
    });
  } catch (err) {
    console.error('Weekly report upload error:', err);
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: '导入失败：' + err.message });
  }
});

// 获取所有通报周期列表
app.get('/api/weekly-reports', (req, res) => {
  const reports = getWeeklyReports();
  const summary = reports.map(r => ({
    weekRange: r.weekRange,
    uploadTime: r.uploadTime,
    itemCount: r.items.length,
    memberCount: Object.keys(r.memberScores).length
  }));
  res.json(summary);
});

// 获取指定周期通报详情
app.get('/api/weekly-reports/:weekRange', (req, res) => {
  const { weekRange } = req.params;
  const reports = getWeeklyReports();
  const report = reports.find(r => r.weekRange === decodeURIComponent(weekRange));
  if (!report) {
    return res.status(404).json({ error: '未找到该周期的通报数据' });
  }
  res.json(report);
});

// 删除指定周期通报
app.delete('/api/weekly-reports/:weekRange', (req, res) => {
  const { weekRange } = req.params;
  const reports = getWeeklyReports();
  const decoded = decodeURIComponent(weekRange);
  const idx = reports.findIndex(r => r.weekRange === decoded);
  if (idx < 0) {
    return res.status(404).json({ error: '未找到该周期的通报数据' });
  }
  reports.splice(idx, 1);
  saveWeeklyReports(reports);
  invalidateCache();
  res.json({ success: true, message: '通报已删除' });
});

// 纠正模糊匹配：将某个名字的扣分转移到正确名字
app.put('/api/weekly-reports/:weekRange/correct-member', (req, res) => {
  const { weekRange } = req.params;
  const { fromName, toName, toMemberId } = req.body;
  if (!fromName || !toName) {
    return res.status(400).json({ error: '请提供 fromName 和 toName' });
  }

  const reports = getWeeklyReports();
  const decoded = decodeURIComponent(weekRange);
  const report = reports.find(r => r.weekRange === decoded);
  if (!report) {
    return res.status(404).json({ error: '未找到该周期的通报数据' });
  }

  const fromKey = fromName;
  const fromData = report.memberScores[fromKey];
  if (!fromData) {
    return res.status(400).json({ error: `未找到 "${fromName}" 的数据` });
  }

  // 如果目标和源不同，转移数据
  if (fromName !== toName) {
    if (!report.memberScores[toName]) {
      report.memberScores[toName] = {
        memberId: toMemberId || null,
        name: toName,
        score: 80,
        items: []
      };
    }
    const toData = report.memberScores[toName];
    // 合并 items
    fromData.items.forEach(item => toData.items.push(item));
    // 重新计算分数
    toData.score = Math.round((80 + toData.items.reduce((s, it) => s + it.score, 0)) * 100) / 100;
    if (toMemberId) toData.memberId = toMemberId;
    // 删除旧记录
    delete report.memberScores[fromKey];
  }

  saveWeeklyReports(reports);
  invalidateCache();
  res.json({ success: true, message: `已将 "${fromName}" 纠正为 "${toName}"`, report });
});

// 获取某成员的累计遵章守纪分
app.get('/api/discipline-scores/:memberId', (req, res) => {
  const { memberId } = req.params;
  const reports = getWeeklyReports();
  const members = getMembers();
  const member = members.find(m => m.id === memberId);
  if (!member) {
    return res.status(404).json({ error: '成员不存在' });
  }

  let totalScore = 80;
  const weeklyDetails = [];

  reports.forEach(r => {
    const scoreData = r.memberScores[memberId] || r.memberScores[member.name];
    if (scoreData) {
      // 累计：本周相对于80的变化量
      const delta = scoreData.score - 80;
      totalScore += delta;
      totalScore = Math.round(totalScore * 100) / 100;
      weeklyDetails.push({
        weekRange: r.weekRange,
        weeklyScore: scoreData.score,
        items: scoreData.items
      });
    }
  });

  res.json({
    memberId,
    name: member.name,
    totalScore,
    weeklyDetails
  });
});

// 获取所有成员的累计遵章守纪分
app.get('/api/discipline-scores', (req, res) => {
  const reports = getWeeklyReports();
  const members = getMembers();
  
  const scores = {};
  members.forEach(m => { scores[m.id] = { memberId: m.id, name: m.name, class: m.class, score: 80 }; });
  
  reports.forEach(r => {
    Object.entries(r.memberScores).forEach(([key, data]) => {
      if (!data.name) return;
      // 按姓名匹配
      for (const m of members) {
        if (m.name === data.name && scores[m.id]) {
          const delta = data.score - 80;
          scores[m.id].score += delta;
          scores[m.id].score = Math.round(scores[m.id].score * 100) / 100;
          break;
        }
      }
    });
  });

  res.json(Object.values(scores));
});

app.post('/api/member/update-info', (req, res) => {
  const { memberId, height, weight, mbti, birthday, isBackbone, position, hobbies, hometown } = req.body;
  
  if (!memberId) {
    return res.status(400).json({ error: '成员ID不能为空' });
  }
  
  const members = getMembers();
  const memberIndex = members.findIndex(m => m.id === memberId);
  
  if (memberIndex === -1) {
    return res.status(404).json({ error: '成员未找到' });
  }
  
  if (height !== undefined) members[memberIndex].height = height;
  if (weight !== undefined) members[memberIndex].weight = weight;
  if (mbti !== undefined) members[memberIndex].mbti = mbti ? mbti.toUpperCase() : null;
  if (birthday !== undefined) members[memberIndex].birthday = birthday;
  if (isBackbone !== undefined) members[memberIndex].isBackbone = isBackbone;
  if (position !== undefined) members[memberIndex].position = position;
  if (hobbies !== undefined) members[memberIndex].hobbies = hobbies;
  if (hometown !== undefined) members[memberIndex].hometown = hometown;
  
  writeJSON(MEMBERS_FILE, members);
  cache.members.data = members;
  cache.members.timestamp = Date.now();
  
  res.json({ success: true, message: '信息更新成功' });
});

app.get('/api/scores', (req, res) => {
  const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
  res.json(readAllScores(semesterId));
});

// Current week configuration (Calculated based on Beijing Time, 基于当前学期起点)
function getCurrentWeek() {
  const semester = getCurrentSemester();
  const startDateStr = semester.startDate || '2026-03-02T00:00:00+08:00';
  
  // Parse start date
  const startDate = new Date(startDateStr);
  
  // Get current time in UTC milliseconds
  const nowUtcMs = Date.now();
  
  // Calculate difference in milliseconds (directly in UTC, no need to add offset twice)
  const diffMs = nowUtcMs - startDate.getTime();
  
  // Convert to days
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  
  // Calculate weeks
  const week = Math.floor(diffDays / 7) + 1;
  
  return week > 0 ? week : 1;
};

// Calculate week number for a given date (基于当前学期起点)
function calculateWeek(date) {
  const semester = getCurrentSemester();
  const startDateStr = semester.startDate || '2026-03-02T00:00:00+08:00';
  
  // Parse start date
  const startDate = new Date(startDateStr);
  
  // Calculate difference in milliseconds
  const diffMs = date.getTime() - startDate.getTime();
  
  // Convert to days
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
  
  // Calculate weeks
  const week = Math.floor(diffDays / 7) + 1;
  
  return week > 0 ? week : 1;
};

// Get members already scored by an evaluator this week
app.get('/api/scored-ids/:evaluatorId/:week', (req, res) => {
  const { evaluatorId, week } = req.params;
  const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
  const weekScores = getScoresForWeek(parseInt(week), semesterId);
  const scoredIds = weekScores
    .filter(s => s.evaluatorId === evaluatorId)
    .map(s => s.memberId);
  res.json(scoredIds);
});

// Calculate weights using entropy weight method
app.get('/api/entropy-weights', (req, res) => {
  const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
  const allScores = readAllScores(semesterId);
  
  if (allScores.length === 0) {
    // 如果没有数据，使用默认权重
    return res.json({
      study: 2.0,
      fitness: 2.0,
      literacy: 1.5,
      discipline: 2.0,
      contribution: 1.5,
      management: 1.0
    });
  }
  
  const dimensions = ['study', 'fitness', 'literacy', 'discipline', 'contribution', 'management'];
  
  // 按周次和成员分组，获取每个成员每周的平均分
  const memberWeekScores = {};
  allScores.forEach(score => {
    const key = `${score.memberId}-${score.week}`;
    if (!memberWeekScores[key]) {
      memberWeekScores[key] = {
        memberId: score.memberId,
        week: score.week,
        scores: {}
      };
    }
    dimensions.forEach(dim => {
      if (!memberWeekScores[key].scores[dim]) {
        memberWeekScores[key].scores[dim] = [];
      }
      if (score.scores[dim] !== undefined && score.scores[dim] !== null) {
        memberWeekScores[key].scores[dim].push(score.scores[dim]);
      }
    });
  });
  
  // 计算每个成员每周的平均得分
  const dataMatrix = [];
  Object.values(memberWeekScores).forEach(item => {
    const row = {};
    let hasValidScore = false;
    dimensions.forEach(dim => {
      const scores = item.scores[dim];
      if (scores.length > 0) {
        row[dim] = scores.reduce((a, b) => a + b, 0) / scores.length;
        hasValidScore = true;
      } else {
        row[dim] = 0;
      }
    });
    if (hasValidScore) {
      dataMatrix.push(row);
    }
  });
  
  if (dataMatrix.length < 2) {
    // 如果数据太少，使用默认权重
    return res.json({
      study: 2.0,
      fitness: 2.0,
      literacy: 1.5,
      discipline: 2.0,
      contribution: 1.5,
      management: 1.0
    });
  }
  
  // 熵权法计算
  // 1. 数据标准化（正向指标，越高越好）
  const normalizedMatrix = [];
  const maxValues = {};
  const minValues = {};
  
  dimensions.forEach(dim => {
    maxValues[dim] = Math.max(...dataMatrix.map(row => row[dim]));
    minValues[dim] = Math.min(...dataMatrix.map(row => row[dim]));
  });
  
  dataMatrix.forEach(row => {
    const normalizedRow = {};
    dimensions.forEach(dim => {
      const range = maxValues[dim] - minValues[dim];
      if (range === 0) {
        normalizedRow[dim] = 1; // 所有值相同，标准化为1
      } else {
        normalizedRow[dim] = (row[dim] - minValues[dim]) / range;
      }
    });
    normalizedMatrix.push(normalizedRow);
  });
  
  // 2. 计算比重
  const sumByDim = {};
  dimensions.forEach(dim => {
    sumByDim[dim] = normalizedMatrix.reduce((sum, row) => sum + row[dim], 0);
  });
  
  const proportionMatrix = normalizedMatrix.map(row => {
    const propRow = {};
    dimensions.forEach(dim => {
      propRow[dim] = sumByDim[dim] === 0 ? 1 / normalizedMatrix.length : row[dim] / sumByDim[dim];
    });
    return propRow;
  });
  
  // 3. 计算熵值
  const entropy = {};
  const k = 1 / Math.log(normalizedMatrix.length);
  
  dimensions.forEach(dim => {
    let sum = 0;
    proportionMatrix.forEach(row => {
      const p = row[dim];
      if (p > 0) {
        sum += p * Math.log(p);
      }
    });
    entropy[dim] = -k * sum;
  });
  
  // 4. 计算差异系数
  const diversity = {};
  dimensions.forEach(dim => {
    diversity[dim] = 1 - entropy[dim];
  });
  
  // 5. 计算权重
  const totalDiversity = Object.values(diversity).reduce((sum, d) => sum + d, 0);
  const weights = {};
  dimensions.forEach(dim => {
    weights[dim] = totalDiversity === 0 ? 1 / dimensions.length : diversity[dim] / totalDiversity;
  });
  
  // 归一化权重，使总和为10（便于计算百分制）
  const weightSum = Object.values(weights).reduce((sum, w) => sum + w, 0);
  const normalizedWeights = {};
  dimensions.forEach(dim => {
    normalizedWeights[dim] = (weights[dim] / weightSum) * 10;
  });
  
  res.json(normalizedWeights);
});

// Calculate average scores for radar charts
app.get('/api/stats/:memberId', (req, res) => {
  const { memberId } = req.params;
  const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
  const members = getMembers();
  const targetMember = members.find(m => m.id === memberId);
  
  if (!targetMember) {
    return res.status(404).json({ error: '成员未找到' });
  }

  // Get all members in the same class as the target member
  const classMembers = members.filter(m => m.class === targetMember.class);
  const classMemberCount = classMembers.length;
  
  const scores = readAllScores(semesterId).filter(s => s.memberId === memberId);
  
  // Group by week
  const weeks = [...new Set(scores.map(s => s.week))];
  const stats = weeks.map(week => {
    const weekScores = scores.filter(s => s.week === week);
    
    // Everyone in the same class must vote for this person
    const uniqueEvaluators = new Set(weekScores.map(s => s.evaluatorId));
    const isComplete = uniqueEvaluators.size === classMemberCount;

    const dimensions = ['study', 'management', 'fitness', 'literacy', 'discipline', 'contribution'];
    const averages = {};
    
    dimensions.forEach(dim => {
      const selfScores = weekScores.filter(s => s.type === 'self').map(s => s.scores[dim]);
      const peerScores = weekScores.filter(s => s.type === 'peer').map(s => s.scores[dim]);
      
      const selfAvg = selfScores.length > 0 ? selfScores.reduce((a, b) => a + b, 0) / selfScores.length : null;
      const peerAvg = peerScores.length > 0 ? peerScores.reduce((a, b) => a + b, 0) / peerScores.length : null;
      
      if (selfAvg !== null && peerAvg !== null) {
        averages[dim] = (selfAvg + peerAvg) / 2;
      } else {
        averages[dim] = selfAvg || peerAvg || 0;
      }
    });

    // Add detailed scores for each evaluator
    const details = weekScores.map(s => {
      const evaluator = members.find(m => m.id === s.evaluatorId);
      return {
        name: evaluator ? evaluator.name : '未知',
        type: s.type,
        scores: s.scores,
        subItemScores: s.subItemScores || {}
      };
    });
    
    // Get list of members who haven't scored
    const evaluatedMemberIds = [...uniqueEvaluators];
    const notScoredMembers = classMembers.filter(m => !evaluatedMemberIds.includes(m.id))
      .map(m => m.name);
    
    return { 
      week, 
      averages, 
      details, 
      isComplete, 
      currentVotes: uniqueEvaluators.size, 
      requiredVotes: classMemberCount,
      className: targetMember.class,
      notScoredMembers
    };
  });
  
  res.json(stats);
});

// Post a new score
app.post('/api/scores', (req, res) => {
  const { week, memberId, evaluatorId, type, scores, subItemScores, semesterId } = req.body;
  const weekScores = readScoresByWeek(week, semesterId);
  
  // Validation: Check if this evaluator has already scored this member this week
  const existingScore = weekScores.find(s => 
    s.memberId === memberId && 
    s.evaluatorId === evaluatorId
  );

  if (existingScore) {
    return res.status(400).json({ error: '本周您已对该成员进行过评分' });
  }
  
  // Validation: Check if scores are valid (multiples of 0.5)
  if (subItemScores) {
    for (const [key, value] of Object.entries(subItemScores)) {
      if (typeof value === 'number' && value % 0.5 !== 0) {
        return res.status(400).json({ error: '评分必须是0.5的倍数' });
      }
    }
  }
  
  const newScore = {
    id: uuidv4(),
    week,
    memberId,
    evaluatorId,
    type,
    scores,
    subItemScores: subItemScores || {},
    timestamp: beijingISO()
  };
  
  weekScores.push(newScore);
  writeScoresByWeek(week, weekScores, semesterId);
  
  // Invalidate cache for this week
  invalidateWeekCache(week, semesterId);
  
  // Notify all clients about the new score
  io.emit('scoreUpdated', newScore);
  
  res.status(201).json(newScore);
});

// 获取特定成员在特定周的评分
app.get('/api/scores/:memberId/:week', (req, res) => {
  try {
    const { memberId, week } = req.params;
    const { evaluatorId, semesterId } = req.query;
    const weekNum = parseInt(week);
    const weekScores = readScoresByWeek(weekNum, semesterId ? Number(semesterId) : undefined);
    
    // 查找该成员的评分记录
    let memberScore;
    if (evaluatorId) {
      memberScore = weekScores.find(s => s.memberId === memberId && s.evaluatorId === evaluatorId);
    } else {
      memberScore = weekScores.find(s => s.memberId === memberId);
    }
    
    if (!memberScore) {
      return res.status(404).json({ error: '未找到该评分记录' });
    }
    
    res.json(memberScore);
  } catch (err) {
    console.error('Get member score error:', err);
    res.status(500).json({ error: '获取评分失败' });
  }
});

// 更新评分数据（或创建新的）
app.post('/api/scores/update', (req, res) => {
  try {
    const { week, memberId, evaluatorId, scores, subItemScores, semesterId } = req.body;
    
    // 验证必要参数
    if (!week || !memberId || !evaluatorId) {
      return res.status(400).json({ error: '周数、被评分者ID和评分者ID不能为空' });
    }
    
    const weekScores = readScoresByWeek(week, semesterId);
    
    // 查找该评分记录
    const scoreIndex = weekScores.findIndex(s => s.memberId === memberId && s.evaluatorId === evaluatorId);
    
    // 验证评分值是否为0.5的倍数
    if (subItemScores) {
      for (const [key, value] of Object.entries(subItemScores)) {
        if (typeof value === 'number' && value % 0.5 !== 0) {
          return res.status(400).json({ error: '评分必须是0.5的倍数' });
        }
      }
    }
    
    let scoreData;
    
    if (scoreIndex === -1) {
      // 创建新的评分记录
      scoreData = {
        id: uuidv4(),
        week,
        memberId,
        evaluatorId,
        type: 'peer', // 默认互评
        scores,
        subItemScores: subItemScores || {},
        timestamp: beijingISO()
      };
      weekScores.push(scoreData);
    } else {
      // 更新现有评分数据
      scoreData = {
        ...weekScores[scoreIndex],
        scores,
        subItemScores: subItemScores || {},
        timestamp: beijingISO(),
        updated: true
      };
      weekScores[scoreIndex] = scoreData;
    }
    
    writeScoresByWeek(week, weekScores, semesterId);
    
    // Invalidate cache for this week
    invalidateWeekCache(week, semesterId);
    
    // Notify all clients about the updated score
    io.emit('scoreUpdated', scoreData);
    
    res.json({ success: true, message: scoreIndex === -1 ? '评分创建成功' : '评分更新成功', data: scoreData });
  } catch (err) {
    console.error('Update score error:', err);
    res.status(500).json({ error: '评分更新失败' });
  }
});

// 删除单个评分记录
app.post('/api/scores/delete', (req, res) => {
  try {
    const { week, memberId, evaluatorId, semesterId } = req.body;
    
    // 验证必要参数
    if (!week || !memberId || !evaluatorId) {
      return res.status(400).json({ error: '周数、被评分者ID和评分者ID不能为空' });
    }
    
    const weekScores = readScoresByWeek(week, semesterId);
    
    // 查找并删除该评分记录
    const scoreIndex = weekScores.findIndex(s => s.memberId === memberId && s.evaluatorId === evaluatorId);
    
    if (scoreIndex === -1) {
      return res.status(404).json({ error: '未找到该评分记录' });
    }
    
    weekScores.splice(scoreIndex, 1);
    
    writeScoresByWeek(week, weekScores, semesterId);
    
    // Invalidate cache for this week
    invalidateWeekCache(week, semesterId);
    
    // Notify all clients about the change
    io.emit('scoreDeleted', { week, memberId, evaluatorId });
    
    res.json({ success: true, message: '已删除评分' });
  } catch (err) {
    console.error('Delete score error:', err);
    res.status(500).json({ error: '删除评分失败' });
  }
});

// 删除评分者在特定周的所有评分
app.post('/api/scores/delete-all-evaluator', (req, res) => {
  try {
    const { week, evaluatorId, semesterId } = req.body;
    
    // 验证必要参数
    if (!week || !evaluatorId) {
      return res.status(400).json({ error: '周数和评分者ID不能为空' });
    }
    
    const weekScores = readScoresByWeek(week, semesterId);
    
    // 过滤掉该评分者的所有评分
    const filteredScores = weekScores.filter(s => s.evaluatorId !== evaluatorId);
    
    writeScoresByWeek(week, filteredScores, semesterId);
    
    // Invalidate cache for this week
    invalidateWeekCache(week, semesterId);
    
    // Notify all clients about the change
    io.emit('scoresDeleted', { week, evaluatorId });
    
    res.json({ success: true, message: '已清除评分者的所有评分' });
  } catch (err) {
    console.error('Delete all evaluator scores error:', err);
    res.status(500).json({ error: '清除评分失败' });
  }
});

// ========== 心理气象站 - 关系提名和心情标签API ==========

// 预设心情标签
const MOOD_TAGS = [
  '开心', '满足', '平静', '焦虑', '沮丧', '愤怒', '疲惫', '孤独',
  '兴奋', '自信', '紧张', '放松', '快乐', '悲伤', '烦躁', '温暖'
];

// 提交关系提名和心情标签
app.post('/api/relationship-nominations', (req, res) => {
  try {
    const { evaluatorId, positiveNominations, negativeNominations, moodTag, selfAssessment, copingStyle } = req.body;

    // 验证必要参数
    if (!evaluatorId) {
      return res.status(400).json({ error: '评价者ID不能为空' });
    }

    const nominations = readRelationshipNominations();
    const memberStates = readMemberStates();
    const members = getMembers();

    // 查找该评价者的旧数据
    const existingIndex = nominations.findIndex(n => n.evaluatorId === evaluatorId);
    const oldNomination = existingIndex >= 0 ? nominations[existingIndex] : null;
    
    // 计算连续提交次数
    let consecutiveCount = 1;
    if (oldNomination) {
      // 检查是否是连续提交（间隔不超过14天视为连续）
      const oldTimestamp = new Date(oldNomination.timestamp);
      const now = beijingNow();
      const daysDiff = (now - oldTimestamp) / (1000 * 60 * 60 * 24);
      
      if (daysDiff <= 14) {
        consecutiveCount = oldNomination.consecutiveCount + 1;
      }
    }

    const newNomination = {
      id: uuidv4(),
      evaluatorId,
      positiveNominations: positiveNominations || [],
      negativeNominations: negativeNominations || [],
      moodTag: moodTag || null,
      selfAssessment: selfAssessment || null,
      copingStyle: copingStyle || null,
      consecutiveCount,
      timestamp: beijingISO()
    };

    if (existingIndex >= 0) {
      nominations[existingIndex] = newNomination;
    } else {
      nominations.push(newNomination);
    }

    writeRelationshipNominations(nominations);

    // 计算当前所有成员的提名次数
    const calculatePositiveCount = (memberId) => {
      return nominations.reduce((count, n) => {
        return count + (n.positiveNominations?.includes(memberId) ? 1 : 0);
      }, 0);
    };

    const calculateNegativeCount = (memberId) => {
      return nominations.reduce((count, n) => {
        return count + (n.negativeNominations?.includes(memberId) ? 1 : 0);
      }, 0);
    };

    const negativeMoods = ['焦虑', '沮丧', '愤怒', '疲惫', '孤独', '悲伤', '烦躁'];
    const isNegativeMood = (mood) => negativeMoods.includes(mood);

    // 更新每个成员的连续状态计数
    const config = getConfig();
    members.forEach(member => {
      const positiveCount = calculatePositiveCount(member.id);
      const negativeCount = calculateNegativeCount(member.id);
      const memberNomination = nominations.find(n => n.evaluatorId === member.id);
      const memberMood = memberNomination?.moodTag;
      
      // 获取旧状态
      const oldState = memberStates[member.id] || {
        consecutiveZeroPositive: 0,
        consecutiveHighNegative: 0,
        consecutiveHighPositive: 0,
        consecutiveNegativeMood: 0,
        lastPositiveWeek: 0,
        lastNegativeWeek: 0,
        lastHighPositiveWeek: 0,
        lastNegativeMoodWeek: 0
      };

      // 按周计算连续状态（同一周提交只计数一次）
      const currentWeek = config.currentWeek || 1;
      
      // 当周满足条件则+1（同一周只加一次），不满足则重置为0
      const newState = {
        consecutiveZeroPositive: positiveCount === 0 ? (oldState.lastPositiveWeek !== currentWeek ? oldState.consecutiveZeroPositive + 1 : oldState.consecutiveZeroPositive) : 0,
        consecutiveHighNegative: negativeCount >= 4 ? (oldState.lastNegativeWeek !== currentWeek ? oldState.consecutiveHighNegative + 1 : oldState.consecutiveHighNegative) : 0,
        consecutiveHighPositive: positiveCount >= 5 ? (oldState.lastHighPositiveWeek !== currentWeek ? oldState.consecutiveHighPositive + 1 : oldState.consecutiveHighPositive) : 0,
        consecutiveNegativeMood: memberMood && isNegativeMood(memberMood) ? (oldState.lastNegativeMoodWeek !== currentWeek ? oldState.consecutiveNegativeMood + 1 : oldState.consecutiveNegativeMood) : 0,
        // 更新最后记录的周次
        lastPositiveWeek: positiveCount === 0 ? currentWeek : oldState.lastPositiveWeek,
        lastNegativeWeek: negativeCount >= 4 ? currentWeek : oldState.lastNegativeWeek,
        lastHighPositiveWeek: positiveCount >= 5 ? currentWeek : oldState.lastHighPositiveWeek,
        lastNegativeMoodWeek: (memberMood && isNegativeMood(memberMood)) ? currentWeek : oldState.lastNegativeMoodWeek
      };

      memberStates[member.id] = newState;
    });

    writeMemberStates(memberStates);

    // 通知所有客户端
    io.emit('relationshipNominationUpdated', newNomination);

    res.status(201).json(newNomination);
  } catch (err) {
    console.error('Submit relationship nomination error:', err);
    res.status(500).json({ error: '提交关系提名失败' });
  }
});

// 获取所有关系提名（不再按周）
app.get('/api/relationship-nominations', (req, res) => {
  try {
    const nominations = readRelationshipNominations();
    res.json(nominations);
  } catch (err) {
    console.error('Get relationship nominations error:', err);
    res.status(500).json({ error: '获取关系提名失败' });
  }
});

// ========== 管理员修改心理数据API ==========
// 管理员修改指定成员的心理数据（提名、标签、自评），不触发连续状态更新
app.post('/api/admin/psychological-data/update', (req, res) => {
  try {
    const { evaluatorId, positiveNominations, negativeNominations, moodTag, selfAssessment, updateType } = req.body;

    // updateType: 'nominations' | 'mood' | 'selfAssessment' | 'all'
    // 三者独立修改

    if (!evaluatorId) {
      return res.status(400).json({ error: '评价者ID不能为空' });
    }

    if (!updateType || !['nominations', 'mood', 'selfAssessment', 'all'].includes(updateType)) {
      return res.status(400).json({ error: '无效的更新类型' });
    }

    const nominations = readRelationshipNominations();
    const members = getMembers();
    const member = members.find(m => m.id === evaluatorId);

    if (!member) {
      return res.status(404).json({ error: '成员未找到' });
    }

    // 查找该评价者的数据
    const existingIndex = nominations.findIndex(n => n.evaluatorId === evaluatorId);

    if (existingIndex >= 0) {
      const existing = nominations[existingIndex];

      if (updateType === 'nominations' || updateType === 'all') {
        nominations[existingIndex] = {
          ...existing,
          positiveNominations: positiveNominations !== undefined ? (positiveNominations || []) : existing.positiveNominations,
          negativeNominations: negativeNominations !== undefined ? (negativeNominations || []) : existing.negativeNominations,
          timestamp: beijingISO()
        };
      }

      if (updateType === 'mood' || updateType === 'all') {
        nominations[existingIndex] = {
          ...nominations[existingIndex],
          moodTag: moodTag !== undefined ? moodTag : nominations[existingIndex].moodTag,
          timestamp: beijingISO()
        };
      }

      if (updateType === 'selfAssessment' || updateType === 'all') {
        nominations[existingIndex] = {
          ...nominations[existingIndex],
          selfAssessment: selfAssessment !== undefined ? selfAssessment : nominations[existingIndex].selfAssessment,
          timestamp: beijingISO()
        };
      }
    } else {
      // 如果没有找到现有数据，创建新数据
      if (updateType === 'nominations' || updateType === 'all') {
        const newNomination = {
          id: uuidv4(),
          evaluatorId,
          positiveNominations: positiveNominations || [],
          negativeNominations: negativeNominations || [],
          moodTag: moodTag || null,
          selfAssessment: selfAssessment || null,
          consecutiveCount: null,
          timestamp: beijingISO()
        };
        nominations.push(newNomination);
      } else if (updateType === 'mood') {
        nominations.push({
          id: uuidv4(),
          evaluatorId,
          positiveNominations: [],
          negativeNominations: [],
          moodTag: moodTag,
          selfAssessment: null,
          consecutiveCount: null,
          timestamp: beijingISO()
        });
      } else if (updateType === 'selfAssessment') {
        nominations.push({
          id: uuidv4(),
          evaluatorId,
          positiveNominations: [],
          negativeNominations: [],
          moodTag: null,
          selfAssessment: selfAssessment,
          consecutiveCount: null,
          timestamp: beijingISO()
        });
      }
    }

    writeRelationshipNominations(nominations);

    res.json({
      success: true,
      message: '心理数据更新成功',
      evaluatorId,
      updateType
    });

  } catch (err) {
    console.error('Update psychological data error:', err);
    res.status(500).json({ error: '更新心理数据失败' });
  }
});

// 获取预设心情标签列表
app.get('/api/mood-tags', (req, res) => {
  res.json(MOOD_TAGS);
});

// ========== 心理气象站 - 预警API ==========

// 计算成员的预警状态
const calculateMemberAlertStatus = (memberId) => {
  const members = getMembers();
  const member = members.find(m => m.id === memberId);
  if (!member) return null;

  // 获取所有关系提名数据
  const nominations = readRelationshipNominations();
  const memberStates = readMemberStates();
  
  // 计算正向提名次数
  const calculatePositiveCount = (nominations, memberId) => {
    return nominations.reduce((count, n) => {
      return count + (n.positiveNominations?.includes(memberId) ? 1 : 0);
    }, 0);
  };

  // 计算反向提名次数
  const calculateNegativeCount = (nominations, memberId) => {
    return nominations.reduce((count, n) => {
      return count + (n.negativeNominations?.includes(memberId) ? 1 : 0);
    }, 0);
  };

  const positiveCount = calculatePositiveCount(nominations, memberId);
  const negativeCount = calculateNegativeCount(nominations, memberId);

  // 计算发起负向提名次数
  const initiatedNegativeCount = nominations
    .filter(n => n.evaluatorId === memberId)
    .reduce((count, n) => count + (n.negativeNominations?.length || 0), 0);

  // 获取该成员的连续状态
  const state = memberStates[memberId] || {
    consecutiveZeroPositive: 0,
    consecutiveHighNegative: 0,
    consecutiveHighPositive: 0,
    consecutiveNegativeMood: 0
  };

  // 判断预警等级 - 只有满足条件才返回预警
  let alertLevel = null;
  let alertReason = '';
  let alertText = '';

  // 红码条件（连续2次满足）
  if (
    // 连续2次正向提名次数==0
    state.consecutiveZeroPositive >= 2 ||
    // 连续2次反向提名次数>=4
    state.consecutiveHighNegative >= 2
  ) {
    alertLevel = 'red';
    alertReason = '社交孤立高风险';
    alertText = `社交孤立高风险：${member.name}（${member.mbti || '未知'}）近期小组接纳度持续走低。建议结合【社交地图】查看其所在小团体结构。`;
  }
  // 黄码条件（连续2次负面心情 或 当前发起负向提名≥3）
  else if (
    // 连续2次负面心情
    state.consecutiveNegativeMood >= 2 ||
    // 当前发起负向提名≥3
    initiatedNegativeCount >= 3
  ) {
    alertLevel = 'yellow';
    alertReason = '负面情绪预警';
    alertText = initiatedNegativeCount >= 3
      ? `人际摩擦预警：${member.name}（${member.mbti || '未知'}）近期频繁发起负向社交（${initiatedNegativeCount}次）。建议关注其人际关系动态。`
      : `负面情绪预警：${member.name}（${member.mbti || '未知'}）状态有波动。建议查看【相容性分析】。`;
  }
  // 绿码条件（连续2次正向提名>=5）
  else if (
    // 连续2次正向提名>=5
    state.consecutiveHighPositive >= 2
  ) {
    alertLevel = 'green';
    alertReason = '同伴支持资源';
    alertText = `同伴支持资源：${member.name}（${member.mbti || '未知'}）为班级情绪调节者。建议标记为“朋辈桥梁”角色。`;
  }

  // 如果没有任何预警条件满足，返回null
  if (alertLevel === null) {
    return null;
  }

  return {
    memberId,
    memberName: member.name,
    mbti: member.mbti,
    alertLevel,
    alertReason,
    alertText,
    data: {
      positiveCount,
      negativeCount,
      initiatedNegativeCount,
      consecutiveZeroPositive: state.consecutiveZeroPositive,
      consecutiveHighNegative: state.consecutiveHighNegative,
      consecutiveHighPositive: state.consecutiveHighPositive,
      consecutiveNegativeMood: state.consecutiveNegativeMood
    }
  };
};

// 获取全班预警状态
app.get('/api/psychological-station/alerts', (req, res) => {
  try {
    const members = getMembers();
    
    const alerts = members
      .map(member => calculateMemberAlertStatus(member.id))
      .filter(alert => alert !== null);

    const redCount = alerts.filter(a => a.alertLevel === 'red').length;
    const yellowCount = alerts.filter(a => a.alertLevel === 'yellow').length;
    const greenCount = alerts.filter(a => a.alertLevel === 'green').length;

    res.json({
      summary: {
        red: redCount,
        yellow: yellowCount,
        green: greenCount,
        total: alerts.length
      },
      alerts
    });
  } catch (err) {
    console.error('Get psychological station alerts error:', err);
    res.status(500).json({ error: '获取预警状态失败' });
  }
});

// 获取社交地图数据
app.get('/api/psychological-station/social-map', (req, res) => {
  try {
    const { className } = req.query;

    let members = getMembers();
    // 如果指定了班级，只返回该班级的成员
    if (className) {
      members = members.filter(m => m.class === className);
    }
    const nominations = readRelationshipNominations();

    // 计算每个节点的总提名值（被提名 + 发出的提名）
    const nominationScores = {};
    members.forEach(member => {
      nominationScores[member.id] = {
        receivedPositive: 0,  // 被正向提名次数
        receivedNegative: 0,  // 被负向提名次数
        givenPositive: 0,     // 发出的正向提名次数
        givenNegative: 0,     // 发出的负向提名次数
        totalScore: 0          // 总分：(receivedPositive + givenPositive) - (receivedNegative + givenNegative)
      };
    });

    // 统计提名数据
    nominations.forEach(nomination => {
      // 统计发出的提名
      if (nominationScores[nomination.evaluatorId]) {
        nominationScores[nomination.evaluatorId].givenPositive += (nomination.positiveNominations?.length || 0);
        nominationScores[nomination.evaluatorId].givenNegative += (nomination.negativeNominations?.length || 0);
      }

      // 统计被正向提名
      nomination.positiveNominations?.forEach(targetId => {
        if (nominationScores[targetId]) {
          nominationScores[targetId].receivedPositive++;
        }
      });

      // 统计被负向提名
      nomination.negativeNominations?.forEach(targetId => {
        if (nominationScores[targetId]) {
          nominationScores[targetId].receivedNegative++;
        }
      });
    });

    // 计算总分
    members.forEach(member => {
      const score = nominationScores[member.id];
      score.totalScore = (score.receivedPositive + score.givenPositive) - (score.receivedNegative + score.givenNegative);
    });

    // 构建节点数据
    const nodes = members.map(member => {
      const score = nominationScores[member.id];
      const positiveCount = score.receivedPositive;
      const negativeCount = score.receivedNegative;
      const totalScore = score.totalScore;

      // 获取预警状态
      const alertStatus = calculateMemberAlertStatus(member.id);

      return {
        id: member.id,
        name: member.name,
        mbti: member.mbti,
        size: Math.max(10, positiveCount * 3 + 10),
        type: member.mbti?.startsWith('E') ? 'extrovert' : 'introvert',
        alertLevel: alertStatus?.alertLevel || 'green',
        positiveCount,
        negativeCount,
        totalScore,
        givenPositive: score.givenPositive,
        givenNegative: score.givenNegative
      };
    });

    // 构建连线数据
    const edges = [];
    const edgeMap = new Map();

    nominations.forEach(nomination => {
      const evaluator = members.find(m => m.id === nomination.evaluatorId);
      const evaluatorName = evaluator?.name || '未知';
      
      // 正向提名连线
      nomination.positiveNominations?.forEach(targetId => {
        const target = members.find(m => m.id === targetId);
        const targetName = target?.name || '未知';
        const key1 = `${nomination.evaluatorId}-${targetId}`;
        const key2 = `${targetId}-${nomination.evaluatorId}`;
        
        if (edgeMap.has(key2)) {
          // 双向正向提名
          const existingEdge = edgeMap.get(key2);
          edgeMap.set(key2, { 
            ...existingEdge, 
            type: 'mutual-positive',
            evaluatorName,
            targetName
          });
        } else if (!edgeMap.has(key1)) {
          // 单向正向提名
          edgeMap.set(key1, {
            source: nomination.evaluatorId,
            target: targetId,
            type: 'one-way-positive',
            evaluatorName,
            targetName
          });
        }
      });

      // 反向提名连线
      nomination.negativeNominations?.forEach(targetId => {
        const target = members.find(m => m.id === targetId);
        const targetName = target?.name || '未知';
        const key = `${nomination.evaluatorId}-${targetId}`;
        edgeMap.set(key, {
          source: nomination.evaluatorId,
          target: targetId,
          type: 'negative',
          evaluatorName,
          targetName,
          hasNegativeGravity: true
        });
      });
    });

    res.json({
      nodes,
      edges: Array.from(edgeMap.values())
    });
  } catch (err) {
    console.error('Get social map error:', err);
    res.status(500).json({ error: '获取社交地图失败' });
  }
});

// 相容性分析（AI流式输出）
app.post('/api/psychological-station/compatibility/stream', async (req, res) => {
  try {
    const { memberAId, memberBId } = req.body;

    if (!memberAId || !memberBId) {
      return res.status(400).json({ error: '成员ID不能为空' });
    }

    const members = getMembers();
    const memberA = members.find(m => m.id === memberAId);
    const memberB = members.find(m => m.id === memberBId);

    if (!memberA || !memberB) {
      return res.status(404).json({ error: '成员未找到' });
    }

    // 获取提名数据
    const nominations = readRelationshipNominations();
    const nomA = nominations.find(n => n.evaluatorId === memberAId);
    const nomB = nominations.find(n => n.evaluatorId === memberBId);

    // 检查两人是否互相提名
    const aNominatesB = nomA?.positiveNominations?.includes(memberBId) || false;
    const bNominatesA = nomB?.positiveNominations?.includes(memberAId) || false;
    const aNegativeB = nomA?.negativeNominations?.includes(memberBId) || false;
    const bNegativeA = nomB?.negativeNominations?.includes(memberAId) || false;

    // 获取心理自评数据
    const selfAssessmentA = nomA?.selfAssessment || null;
    const selfAssessmentB = nomB?.selfAssessment || null;

    const prompt = `请对以下两位同学进行相容性分析：

**成员A信息：**
- 姓名：${memberA.name}
- MBTI：${memberA.mbti || '未知'}
- 生日：${memberA.birthday || '未知'}
- 兴趣爱好：${memberA.hobbies || '未填写'}

**成员B信息：**
- 姓名：${memberB.name}
- MBTI：${memberB.mbti || '未知'}
- 生日：${memberB.birthday || '未知'}
- 兴趣爱好：${memberB.hobbies || '未填写'}

**社交关系数据：**
- ${memberA.name}正向提名${memberB.name}：${aNominatesB ? '是' : '否'}
- ${memberB.name}正向提名${memberA.name}：${bNominatesA ? '是' : '否'}
- ${memberA.name}负向提名${memberB.name}：${aNegativeB ? '是' : '否'}
- ${memberB.name}负向提名${memberA.name}：${bNegativeA ? '是' : '否'}

**心理自评数据 - ${memberA.name}：**
${selfAssessmentA ? `睡眠质量：${selfAssessmentA.sleepQuality}/10
情绪状态：${selfAssessmentA.emotionalState}/10
压力感受：${selfAssessmentA.stressLevel}/10
食欲状况：${selfAssessmentA.appetite}/10
室友关系：${selfAssessmentA.dormEnvironment || '未评价'}
应对方式：${selfAssessmentA.copingMethods?.join('、') || '未选择'}` : '无自评数据'}

**心理自评数据 - ${memberB.name}：**
${selfAssessmentB ? `睡眠质量：${selfAssessmentB.sleepQuality}/10
情绪状态：${selfAssessmentB.emotionalState}/10
压力感受：${selfAssessmentB.stressLevel}/10
食欲状况：${selfAssessmentB.appetite}/10
室友关系：${selfAssessmentB.dormEnvironment || '未评价'}
应对方式：${selfAssessmentB.copingMethods?.join('、') || '未选择'}` : '无自评数据'}

请按以下格式生成相容性分析报告（使用Markdown格式）：
# ${memberA.name}与${memberB.name}的相容性分析报告

## 一、性格特征对比
### 1.1 ${memberA.name}的性格特点
### 1.2 ${memberB.name}的性格特点
### 1.3 性格差异与互补性

## 二、MBTI相容性分析
### 2.1 认知方式差异（S/N维度）
### 2.2 决策方式差异（T/F维度）
### 2.3 生活态度差异（J/P维度）
### 2.4 能量来源差异（E/I维度）
### 2.5 综合相容性评估

## 三、社交关系分析
### 3.1 互相提名情况解读
### 3.2 关系模式识别
### 3.3 潜在冲突点预警

## 四、心理状态对比
### 4.1 心理自评对比分析
### 4.2 共同点与差异点
### 4.3 心理互补或冲突可能性

## 五、相处建议
### 5.1 优势互补建议
### 5.2 沟通方式建议
### 5.3 合作场景建议
### 5.4 需要注意的问题

## 六、总结
- 给出综合相容性评分（1-10分）
- 一句话总结两人的关系特点`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

    const apiKeyInfo = getNextAvailableApiKey();
    if (!apiKeyInfo) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务繁忙，请稍后再试' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    const { key, index } = apiKeyInfo;

    try {
      const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一位专业的心理咨询师和人际关系专家，擅长分析人与人之间的相容性和关系模式，提供建设性的相处建议。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        stream: true
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        responseType: 'stream'
      });

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
                }
              } catch (e) {
                // ignore parse errors
              }
            }
          }
        }
      });

      response.data.on('end', () => {
        releaseApiKey(index);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      });

      response.data.on('error', (err) => {
        releaseApiKey(index);
        console.error('Stream error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', content: '流式输出发生错误' })}\n\n`);
        res.end();
      });

    } catch (err) {
      releaseApiKey(index);
      console.error('DeepSeek API Error:', err.response?.data || err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务调用失败，请重试' })}\n\n`);
      res.end();
    }

  } catch (err) {
    console.error('Compatibility analysis stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || '分析失败' });
    }
  }
});

// 获取每周心理工作简报
app.get('/api/psychological-station/weekly-report', (req, res) => {
  try {
    const config = getConfig();
    const currentWeek = config.currentWeek || getCurrentWeek();
    const lastWeek = currentWeek - 1;

    // 获取本周和上周的预警数据
    const getAlertsForWeek = (week) => {
      const members = getMembers();
      return members
        .map(member => calculateMemberAlertStatus(member.id, week))
        .filter(alert => alert !== null);
    };

    const thisWeekAlerts = getAlertsForWeek(currentWeek);
    const lastWeekAlerts = getAlertsForWeek(lastWeek);

    const thisWeekRed = thisWeekAlerts.filter(a => a.alertLevel === 'red').length;
    const lastWeekRed = lastWeekAlerts.filter(a => a.alertLevel === 'red').length;
    const thisWeekYellow = thisWeekAlerts.filter(a => a.alertLevel === 'yellow').length;
    const lastWeekYellow = lastWeekAlerts.filter(a => a.alertLevel === 'yellow').length;

    // 生成待办清单
    const todoList = [];

    // 红码成员优先处理
    const redMembers = thisWeekAlerts.filter(a => a.alertLevel === 'red');
    redMembers.slice(0, 2).forEach(alert => {
      todoList.push({
        priority: 'high',
        title: `关注${alert.memberName}的社交状态`,
        description: alert.alertText
      });
    });

    // 黄码成员
    const yellowMembers = thisWeekAlerts.filter(a => a.alertLevel === 'yellow');
    yellowMembers.slice(0, 1).forEach(alert => {
      todoList.push({
        priority: 'medium',
        title: `了解${alert.memberName}的近期状态`,
        description: alert.alertText
      });
    });

    res.json({
      week: currentWeek,
      lastWeek,
      trends: {
        red: {
          current: thisWeekRed,
          last: lastWeekRed,
          change: thisWeekRed - lastWeekRed
        },
        yellow: {
          current: thisWeekYellow,
          last: lastWeekYellow,
          change: thisWeekYellow - lastWeekYellow
        }
      },
      todoList
    });
  } catch (err) {
    console.error('Get weekly report error:', err);
    res.status(500).json({ error: '获取工作简报失败' });
  }
});

// DeepSeek API Configuration
const DEEPSEEK_API_KEYS = [
  process.env.DEEPSEEK_API_KEY
].filter(Boolean);
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions';

// Initialize AI Agent (after API keys are available)
(async () => {
  await _initAgentEngine();

  if (agentEngine && process.env.WECHAT_BOT_ENABLED !== 'false') {
    wechatBot = new WeChatBotManager({
      engine: agentEngine
    });
  }

  // 单号管家初始化（STEWARD_ENABLED=1 时启用；与 per-member 模式并存，互不影响）
  if (process.env.STEWARD_ENABLED === '1') {
    try {
      const StewardManager = require('./wechat/steward');
      // 引擎选择：DSH_ENGINE=1 → dsh 底座（DeepSeek Harness 子进程 + 工具桥）；
      // 否则用现有 AgentEngine（功能完整，dsh 就绪后无缝切换）
      let stewardEngine = agentEngine;
      if (process.env.DSH_ENGINE === '1') {
        // dsh 子进程 LLM 鉴权走 DEEPSEEK_API_KEY 环境变量（老 Engine 用下方 key 池，
        // 云端未单独配置该变量 → 用池内第一个 key 兜底，保证两种引擎同源）
        if (!process.env.DEEPSEEK_API_KEY) process.env.DEEPSEEK_API_KEY = DEEPSEEK_API_KEYS[0];
        const DshAgentEngine = require('./agent/dsh/DshAgentEngine');
        dshEngine = new DshAgentEngine({});
        const ok = await dshEngine.initialize();
        if (ok) {
          stewardEngine = dshEngine;
          app.set('dshEngine', dshEngine);   // routes 可注入静默系统事件（App 打卡 → 微信 AI 知晓）
          // 超限 runtime 管理器：每个开启超限的会话独立 worker（工作区/home 隔离）
          const { OverdriveManager } = require('./agent/dsh/overdriveManager');
          overdriveManager = new OverdriveManager();
          overdriveManager.startSweep();
          app.set('overdriveManager', overdriveManager);
          console.log('✅ 管家将运行在 dsh 底座上（超限模式管理器已就绪）');
        } else {
          console.log('⚠️ dsh 底座不可用，管家降级到现有 Engine');
        }
      }
      if (stewardEngine) {
        steward = new StewardManager({ engine: stewardEngine, overdrive: overdriveManager });
        // 自动启动（免验证重登；失败等待管理员扫码）
        steward.start().catch(e => console.warn('[Steward] 启动延迟:', e.message));
        console.log('✅ 单号微信管家已初始化（GeweChat 通道）');
      }

      // Agnes AI 生图/生视频异步任务管理器：完成 → 登记媒体 → 激活 AI 发送结果
      if (steward) {
        const { MediaGenManager } = require('./agent/mediaGen');
        mediaGen = new MediaGenManager({
          onComplete: async (job) => {
            if (!steward) return;
            const mediaId = steward.registerGeneratedMedia(
              job.filePath, job.fileName, job.mime, String(job.ctx?.memberId || ''), job.ctx?.chatroomId || '',
              { thumbPath: job.thumbPath || '', duration: job.duration || 0 });
            console.log(`[MediaGen] ${job.type} 任务完成 ${job.jobId} → mediaId ${mediaId}，激活 AI 发送`);
            // 群聊发起 → 激活群 session（AI 收到指令后 class_send_media 发回群里）；
            // 私聊发起 → 激活成员私聊 session（原逻辑）
            const act = job.ctx?.chatroomId
              ? steward.sendProactiveToGroup(String(job.ctx.chatroomId), 'media_generated', {
                  mediaId, fileName: job.fileName, kind: job.type,
                })
              : steward.sendProactiveMessage(String(job.ctx?.memberId || ''), 'media_generated', {
                  mediaId, fileName: job.fileName, kind: job.type,
                });
            await act.catch(e => console.error('[MediaGen] 激活 AI 发送失败:', e.message));
          },
          onError: async (job, err) => {
            if (!steward) return;
            const act = job.ctx?.chatroomId
              ? steward.sendProactiveToGroup(String(job.ctx.chatroomId), 'media_generated_failed', {
                  kind: job.type, error: err.message,
                })
              : steward.sendProactiveMessage(String(job.ctx?.memberId || ''), 'media_generated_failed', {
                  kind: job.type, error: err.message,
                });
            await act.catch(e => console.error('[MediaGen] 失败通知发送失败:', e.message));
          },
        });
        if (mediaGen.enabled) {
          console.log('✅ Agnes AI 生图/生视频已启用（异步任务，后台轮询）');
        } else {
          console.warn('⚠️ Agnes AI 生图/生视频未启用（AGNES_API_KEY 未配置，配置后重启生效）');
        }
      }

      // 豆包人声歌曲异步任务管理器：完成 → 注册媒体（mp3 文件）→ 激活 AI 发歌配话
      if (steward) {
        const { SongGenManager } = require('./agent/songGen');
        songGen = new SongGenManager({
          onComplete: async (job) => {
            if (!steward) return;
            const ctx = job.ctx || {};
            const isGroup = !!ctx.chatroomId;
            const dest = String(ctx.chatroomId || ctx.destId || ctx.memberId || '');
            const songName = job.songName || job.fileName || '歌';
            const cover = job.mode === 'cover';
            // 发送策略：可解码的音频(<60s)先尝试微信语音条；>=60s、mp4 视频本体或
            // 语音条发送失败 → 以文件消息发送（用户原话：短歌语音条，长歌/失败文件）
            let sentAs = 'file';
            const songExt = path.extname(String(job.fileName || job.filePath || '')).toLowerCase();
            let voiceErr = '';
            let voiceMs = 0;
            if (['.mp3', '.wav', '.m4a'].includes(songExt)) {
              try {
                const { tryVoiceSilk } = require('./utils/audioSilk');
                const v = await tryVoiceSilk(job.filePath, path.join(DATA_DIR || __dirname, 'data', 'tts_voice'));
                if (v && v.ok) {
                  voiceMs = v.durationMs || 0;
                  const rr = await steward.sendToMemberVoice(dest, v.path, v.durationMs).catch(() => null);
                  if (rr && rr.success) { sentAs = 'voice'; }
                  else voiceErr = (rr && rr.error) || '语音条发送失败';
                } else {
                  voiceErr = (v && (v.reason || '')) || '转语音条失败';
                }
              } catch (e) { voiceErr = e.message; }
            } else {
              voiceErr = `${songExt || '?'} 格式不走语音条`;
            }
            let mediaId = '';
            if (sentAs === 'file') {
              console.log(`[SongGen] 歌曲发送：${isGroup ? '群' : '私聊'} ${cover ? 'cover' : 'song'} 走文件（${voiceErr || '>=60s 或 mp4'}）`);
              const rf = await steward.sendToMemberSong(dest, job.filePath, job.fileName).catch(() => null);
              if (!rf || !rf.success) {
                // 直发失败（未绑定/离线等）：注册媒体，让 AI 用 class_send_media 兜底发出
                console.warn(`[SongGen] 文件直发失败，注册媒体兜底: ${(rf && rf.error) || ''}`);
                const songCtype2 = songExt === '.mp4' ? 'video/mp4' : 'audio/mpeg';
                mediaId = steward.registerGeneratedMedia(
                  job.filePath, job.fileName, songCtype2,
                  String(ctx.destId || ctx.memberId || ''), String(ctx.chatroomId || ''));
              }
            } else {
              console.log(`[SongGen] 歌曲发送：${isGroup ? '群' : '私聊'} ${cover ? 'cover' : 'song'} 走语音条（${voiceMs}ms）`);
            }
            // 激活 AI：歌已发出（语音条或文件），只需自然配话，不再让 AI 重复发文件
            const evtData = {
              sent: true, sentAs, cover, songName,
              fileName: job.fileName || '',
              ...(mediaId ? { mediaId, needSendFile: true } : {}),
            };
            const act = isGroup
              ? steward.sendProactiveToGroup(String(ctx.chatroomId), 'song_generated', evtData)
              : steward.sendProactiveMessage(String(ctx.destId || ctx.memberId || ''), 'song_generated', evtData);
            const r = await act.catch(e => ({ success: false, error: e.message }));
            if (!r || !r.success) {
              // 激活失败（目标非绑定成员等）：兜底往目标会话注入文字标记，保证链路不断
              console.warn(`[SongGen] 激活 AI 配话失败: ${(r && r.error) || ''}`);
              try {
                const who = isGroup ? '这个群' : '她';
                steward.injectMemberEvent(isGroup ? `group-${ctx.chatroomId}` : String(ctx.destId || ctx.memberId || ''),
                  `你（管家）刚给${who}${cover ? '翻唱了' : '唱了'}一首歌${sentAs === 'voice' ? '（已发语音条）' : '（已发音频文件）'}。她提起或接着聊时自然接住。`);
              } catch {}
            }
          },
          onError: async (job, err) => {
            if (!steward) return;
            const ctx = job.ctx || {};
            const act = ctx.chatroomId
              ? steward.sendProactiveToGroup(String(ctx.chatroomId), 'song_generated_failed', { error: err.message })
              : steward.sendProactiveMessage(String(ctx.destId || ctx.memberId || ''), 'song_generated_failed', { error: err.message });
            await act.catch(e => console.error('[SongGen] 失败通知发送失败:', e.message));
          },
        });
        if (songGen) {
          console.log(songGen.enabled
            ? '✅ 原创唱歌已启用（acedata/Suno persona 同声）'
            : '⚠️ 原创唱歌未启用（ACEDATA_API_KEY 未配置；配置后重启生效）');
          console.log(songGen.coverEnabled
            ? '✅ 翻唱还原原版已启用（clonevoice RVC，Anaxis 音色）'
            : '⚠️ 翻唱原版未启用（CLONEVOICE_TOKEN 未配置；配置后重启生效）');
        } else {
          console.log('⚠️ 歌曲服务未启用');
        }
      }
    } catch (e) {
      console.warn('⚠️ Steward 初始化失败 (可选):', e.message);
    }
  }
})().catch(e => console.warn('Agent init error:', e.message));

// API key management and queue system
const apiKeyStatus = Array(DEEPSEEK_API_KEYS.length).fill(false); // false = available, true = in use
let currentApiKeyIndex = 0;
const requestQueue = [];
let queueIdCounter = 0;

// Get next available API key
const getNextAvailableApiKey = () => {
  for (let i = 0; i < DEEPSEEK_API_KEYS.length; i++) {
    const index = (currentApiKeyIndex + i) % DEEPSEEK_API_KEYS.length;
    if (!apiKeyStatus[index]) {
      apiKeyStatus[index] = true;
      currentApiKeyIndex = (index + 1) % DEEPSEEK_API_KEYS.length;
      return { key: DEEPSEEK_API_KEYS[index], index };
    }
  }
  return null; // No available API keys
};

// Release API key
const releaseApiKey = (index) => {
  if (index >= 0 && index < apiKeyStatus.length) {
    apiKeyStatus[index] = false;
    // Process next request in queue
    processNextInQueue();
  }
};

// Process next request in queue
const processNextInQueue = () => {
  if (requestQueue.length > 0) {
    const nextRequest = requestQueue.shift();
    const { resolve, reject, prompt } = nextRequest;
    callDeepSeekWithQueue(prompt).then(resolve).catch(reject);
  }
};

// Call DeepSeek API with queue management
const callDeepSeekWithQueue = async (prompt) => {
  const apiKeyInfo = getNextAvailableApiKey();
  if (!apiKeyInfo) {
    // No available API keys, add to queue
    return new Promise((resolve, reject) => {
      const queueId = ++queueIdCounter;
      requestQueue.push({ resolve, reject, prompt, queueId });
      // Throw queue status error
      const error = new Error('AI 分析服务繁忙，请稍候再试');
      error.queueStatus = {
        inQueue: true,
        queuePosition: requestQueue.length,
        queueId
      };
      throw error;
    });
  }
  
  const { key, index } = apiKeyInfo;
  try {
    const response = await axios.post(DEEPSEEK_API_URL, {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '你是一个专业的班级管理分析助手，擅长分析学生评分数据并提供建设性意见。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      }
    });
    return response.data.choices[0].message.content;
  } catch (err) {
    console.error('DeepSeek API Error:', err.response?.data || err.message);
    throw new Error('AI 分析服务暂时不可用');
  } finally {
    // Release API key
    releaseApiKey(index);
  }
};

// Get queue status
const getQueueStatus = (queueId = null) => {
  let queuePosition = null;
  if (queueId) {
    queuePosition = requestQueue.findIndex(req => req.queueId === queueId) + 1;
  }
  return {
    queueLength: requestQueue.length,
    availableApiKeys: DEEPSEEK_API_KEYS.length - apiKeyStatus.filter(status => status).length,
    totalApiKeys: DEEPSEEK_API_KEYS.length,
    queuePosition
  };
};

// Generate Word Document from analysis
const generateWordDoc = async (analysis, title) => {
  const doc = new Document({
    sections: [{
      properties: {},
      children: [
        new Paragraph({
          text: title,
          heading: HeadingLevel.HEADING_1,
          alignment: AlignmentType.CENTER,
          spacing: { after: 400 }
        }),
        ...analysis.split('\n').filter(line => line.trim() !== '').map(line => {
          if (line.startsWith('# ')) {
            return new Paragraph({
              text: line.substring(2),
              heading: HeadingLevel.HEADING_2,
              spacing: { before: 200, after: 100 }
            });
          } else if (line.startsWith('## ')) {
            return new Paragraph({
              text: line.substring(3),
              heading: HeadingLevel.HEADING_3,
              spacing: { before: 150, after: 80 }
            });
          } else if (line.startsWith('- ')) {
            return new Paragraph({
              children: [
                new TextRun('• '),
                new TextRun(line.substring(2))
              ],
              indent: { left: 720 },
              spacing: { after: 60 }
            });
          } else {
            return new Paragraph({
              text: line,
              spacing: { after: 80 }
            });
          }
        })
      ]
    }]
  });

  return Packer.toBuffer(doc);
};

// Get all stats data for analysis
const getAllStatsData = () => {
  const members = getMembers();
  const scores = readAllScores();
  const config = getConfig();
  
  return { members, scores, config };
};

// AI Analysis - Individual
app.post('/api/ai/analyze/individual', async (req, res) => {
  try {
    const { memberId, note } = req.body;
    const { members, scores, config } = getAllStatsData();
    const academicScores = getAcademicScores();
    const fitnessScores = getFitnessScores();
    const experiences = readJSON(EXPERIENCES_FILE);
    const fixedHeights = readFixedHeights();
    
    const member = members.find(m => m.id === memberId);
    if (!member) {
      return res.status(404).json({ error: '成员未找到' });
    }
    
    const memberScores = scores.filter(s => s.memberId === memberId);
    const memberAcademic = academicScores.find(a => a.memberId === memberId);
    const memberFitness = fitnessScores.find(f => f.memberId === memberId);
    const memberExperiences = experiences.filter(e => e.memberId === memberId);
    
    // 获取BMI录入数据 - 获取最新有数据的周
    let latestBMIData = null;
    const scoresDir = getScoresDir();
    if (fs.existsSync(scoresDir)) {
      const files = fs.readdirSync(scoresDir);
      const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'));
      const weeks = bmiFiles.map(file => parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''))).sort((a, b) => b - a);
      
      for (const week of weeks) {
        const bmiData = readBMIByWeek(week);
        if (bmiData[memberId] && bmiData[memberId].weight) {
          const height = fixedHeights[memberId] || bmiData[memberId].height;
          if (height) {
            latestBMIData = {
              week,
              height: parseFloat(height),
              weight: parseFloat(bmiData[memberId].weight)
            };
            // 计算BMI
            if (latestBMIData.height > 0 && latestBMIData.weight > 0) {
              const heightInM = latestBMIData.height / 100;
              latestBMIData.bmi = Math.round((latestBMIData.weight / (heightInM * heightInM)) * 10) / 10;
            }
            break;
          }
        }
      }
    }
    
    // 获取最新的体能素质数据（用于其他体能项目）
    let latestFitnessScores = null;
    if (memberFitness && memberFitness.history && memberFitness.history.length > 0) {
      latestFitnessScores = memberFitness.history[0].scores;
    }
    
    // 计算各维度的统计数据
    const dimensionStats = {};
    const dimensions = ['study', 'management', 'fitness', 'literacy', 'discipline', 'contribution'];
    dimensions.forEach(dim => {
      const scoresForDim = memberScores.map(s => s.scores[dim]);
      const sum = scoresForDim.reduce((a, b) => a + b, 0);
      const avg = scoresForDim.length > 0 ? sum / scoresForDim.length : 0;
      const max = scoresForDim.length > 0 ? Math.max(...scoresForDim) : 0;
      const min = scoresForDim.length > 0 ? Math.min(...scoresForDim) : 0;
      
      const sortedScores = [...scoresForDim].sort((a, b) => a - b);
      const mid = Math.floor(sortedScores.length / 2);
      const median = sortedScores.length > 0 ? (sortedScores.length % 2 !== 0 ? sortedScores[mid] : (sortedScores[mid - 1] + sortedScores[mid]) / 2) : 0;
      
      const variance = scoresForDim.length > 0 ? scoresForDim.reduce((acc, score) => acc + Math.pow(score - avg, 2), 0) / scoresForDim.length : 0;
      const stdDev = Math.sqrt(variance);
      
      dimensionStats[dim] = {
        avg: avg.toFixed(2),
        max: max.toFixed(2),
        min: min.toFixed(2),
        median: median.toFixed(2),
        stdDev: stdDev.toFixed(2)
      };
    });
    
    // 按周次分组统计计算平均分
    const weekStats = {};
    memberScores.forEach(score => {
      if (!weekStats[score.week]) {
        weekStats[score.week] = {
          week: score.week,
          totalScores: 0,
          averages: { study: 0, management: 0, fitness: 0, literacy: 0, discipline: 0, contribution: 0 }
        };
      }
      weekStats[score.week].totalScores++;
      dimensions.forEach(dim => {
        weekStats[score.week].averages[dim] += score.scores[dim];
      });
    });
    
    Object.values(weekStats).forEach(week => {
      if (week.totalScores > 0) {
        dimensions.forEach(dim => {
          week.averages[dim] = (week.averages[dim] / week.totalScores).toFixed(2);
        });
      }
    });
    
    // 计算熵权法综合得分
    const entropyWeights = getEntropyWeights();
    const memberWeeklyEntropyScores = [];
    Object.values(weekStats).forEach(week => {
      const dimScores = {};
      dimensions.forEach(dim => {
        dimScores[dim] = parseFloat(week.averages[dim]);
      });
      const entropyScore = calculateEntropyScore(dimScores, entropyWeights);
      memberWeeklyEntropyScores.push({
        week: week.week,
        score: entropyScore.toFixed(2)
      });
    });
    
    const overallDimScores = {};
    dimensions.forEach(dim => {
      overallDimScores[dim] = parseFloat(dimensionStats[dim].avg);
    });
    const overallEntropyScore = calculateEntropyScore(overallDimScores, entropyWeights);
    
    // 计算学习成绩的实际平均分
    let academicAvg = null;
    if (memberAcademic && memberAcademic.scores) {
      const academicScoresList = Object.entries(memberAcademic.scores)
        .filter(([key]) => key !== '序列')
        .map(([key, score]) => parseFloat(score))
        .filter(score => !isNaN(score));
      if (academicScoresList.length > 0) {
        academicAvg = (academicScoresList.reduce((a, b) => a + b, 0) / academicScoresList.length).toFixed(1);
      }
    }
    
    // 构建提示词
    let prompt = `请分析以下班级成员的综合数据，生成一份详细的分析报告。

**重要说明：请使用完整数据进行分析，不要去除任何极端值，包括0分等低分数据。**

成员基本信息：
- 姓名：${member.name}
- 班级：${member.class}
${member.mbti ? `- MBTI性格类型：${member.mbti}` : ''}
${member.birthday ? `- 生日：${member.birthday}` : ''}
${member.hobbies ? `
兴趣爱好：${member.hobbies}` : ''}
${note ? `
用户补充说明（请重点关注以下内容）：
${note}` : ''}

评分数据统计（满分10分）：
- 总评分记录数：${memberScores.length}
- 涉及周次：${[...new Set(memberScores.map(s => s.week))].sort((a, b) => a - b).join(', ') || '无'}
- 熵权法综合得分：${overallEntropyScore.toFixed(2)}分（百分制）

各维度详细统计：
${dimensions.map(dim => `
${dim === 'study' ? '学习成绩' : dim === 'management' ? '管理能力' : dim === 'fitness' ? '体能素质' : dim === 'literacy' ? '人文素养' : dim === 'discipline' ? '遵章守纪' : '班级贡献'}：
- 平均分：${dimensionStats[dim].avg}
- 最高分：${dimensionStats[dim].max}
- 最低分：${dimensionStats[dim].min}
- 中位数：${dimensionStats[dim].median}
- 标准差：${dimensionStats[dim].stdDev}`).join('\n')}

周次综合得分（熵权法）：
${memberWeeklyEntropyScores.map(w => `第${w.week}周：${w.score}分`).join('\n') || '无'}

${memberAcademic && memberAcademic.scores ? `
学习成绩详细数据：
${academicAvg ? `- 平均成绩：${academicAvg}分` : ''}
${Object.entries(memberAcademic.scores).filter(([key]) => key !== '序列').map(([subject, score]) => `- ${subject}：${score}`).join('\n')}` : ''}

${latestBMIData ? `
身高体重BMI数据（BMI数据录入）：
- 身高：${latestBMIData.height}cm
- 体重：${latestBMIData.weight}kg
- BMI：${latestBMIData.bmi}
- 数据周次：第${latestBMIData.week}周` : ''}
${latestFitnessScores ? `
体能素质详细数据（其他项目）：
${Object.entries(latestFitnessScores)
  .filter(([item]) => item !== '身高' && item !== '体重' && item !== 'BMI')
  .map(([item, value]) => `- ${item}：${value}`).join('\n')}` : ''}

${memberExperiences.length > 0 ? `
个人经历：
${memberExperiences.map(exp => {
  let desc = '';
  if (exp.data && exp.data.name) {
    desc = exp.data.name;
    if (exp.data.level) {
      desc += `（${exp.data.level === 'national' ? '国家级' : exp.data.level === 'provincial' ? '省级' : exp.data.level === 'school' ? '校级' : exp.data.level}）`;
    }
    if (exp.data.award) {
      desc += ` - ${exp.data.award}`;
    }
  } else if (exp.description) {
    desc = exp.description;
  } else if (exp.content) {
    desc = exp.content;
  } else {
    desc = '无描述';
  }
  const typeName = exp.type === 'competition' ? '竞赛' : exp.type === 'award' ? '获奖' : exp.type === 'practice' ? '实践' : exp.type || '经历';
  const date = exp.createdAt ? exp.createdAt.substring(0, 10) : (exp.date || '');
  return `- ${typeName}：${desc}${date ? `（${date}）` : ''}`;
}).join('\n')}` : ''}

请按以下格式生成分析报告（使用Markdown格式）：
# ${member.name}同学的综合分析报告
## 一、整体表现概述
## 二、性格与特点分析（结合MBTI和生日）
## 三、评分表现分析（含熵权法综合得分）
## 四、学习成绩分析
## 五、体能素质分析
## 六、个人经历与成长
## 七、进步与不足
## 八、改进建议
## 九、总结展望`;
    
    try {
      const analysis = await callDeepSeekWithQueue(prompt);
      res.json({ analysis });
    } catch (err) {
      if (err.queueStatus) {
        res.status(429).json({ 
          error: 'AI 分析服务繁忙，请稍候再试',
          queueStatus: err.queueStatus 
        });
      } else {
        console.error('Individual analysis error:', err);
        res.status(500).json({ error: err.message || '分析失败' });
      }
    }
  } catch (err) {
    console.error('Individual analysis error:', err);
    res.status(500).json({ error: err.message || '分析失败' });
  }
});

// AI Analysis - All
app.post('/api/ai/analyze/all', async (req, res) => {
  try {
    const { members, scores, config } = getAllStatsData();
    const dimensions = ['study', 'management', 'fitness', 'literacy', 'discipline', 'contribution'];
    const entropyWeights = getEntropyWeights();
    const fitnessScores = readJSON(FITNESS_SCORES_FILE);
    const fixedHeights = readFixedHeights();
    
    // 计算各维度的统计数据
    const dimensionStats = {};
    dimensions.forEach(dim => {
      const scoresForDim = scores.map(s => s.scores[dim]);
      const sum = scoresForDim.reduce((a, b) => a + b, 0);
      const avg = scoresForDim.length > 0 ? sum / scoresForDim.length : 0;
      const max = scoresForDim.length > 0 ? Math.max(...scoresForDim) : 0;
      const min = scoresForDim.length > 0 ? Math.min(...scoresForDim) : 0;
      
      const sortedScores = [...scoresForDim].sort((a, b) => a - b);
      const mid = Math.floor(sortedScores.length / 2);
      const median = sortedScores.length > 0 ? (sortedScores.length % 2 !== 0 ? sortedScores[mid] : (sortedScores[mid - 1] + sortedScores[mid]) / 2) : 0;
      
      const variance = scoresForDim.length > 0 ? scoresForDim.reduce((acc, score) => acc + Math.pow(score - avg, 2), 0) / scoresForDim.length : 0;
      const stdDev = Math.sqrt(variance);
      
      dimensionStats[dim] = {
        avg: avg.toFixed(2),
        max: max.toFixed(2),
        min: min.toFixed(2),
        median: median.toFixed(2),
        stdDev: stdDev.toFixed(2)
      };
    });
    
    // 按班级统计成员数量和平均分
    const classStats = {};
    members.forEach(member => {
      if (!classStats[member.class]) {
        classStats[member.class] = {
          name: member.class,
          memberCount: 0,
          dimensionAverages: { study: 0, management: 0, fitness: 0, literacy: 0, discipline: 0, contribution: 0 },
          scoreCount: 0
        };
      }
      classStats[member.class].memberCount++;
    });
    
    scores.forEach(score => {
      const member = members.find(m => m.id === score.memberId);
      if (member && classStats[member.class]) {
        classStats[member.class].scoreCount++;
        dimensions.forEach(dim => {
          classStats[member.class].dimensionAverages[dim] += score.scores[dim];
        });
      }
    });
    
    Object.values(classStats).forEach(cls => {
      if (cls.scoreCount > 0) {
        dimensions.forEach(dim => {
          cls.dimensionAverages[dim] = (cls.dimensionAverages[dim] / cls.scoreCount).toFixed(2);
        });
      }
    });
    
    // 按周次计算整体平均分和熵权法综合得分
    const weekStats = {};
    scores.forEach(score => {
      if (!weekStats[score.week]) {
        weekStats[score.week] = {
          week: score.week,
          scoreCount: 0,
          dimensionAverages: { study: 0, management: 0, fitness: 0, literacy: 0, discipline: 0, contribution: 0 }
        };
      }
      weekStats[score.week].scoreCount++;
      dimensions.forEach(dim => {
        weekStats[score.week].dimensionAverages[dim] += score.scores[dim];
      });
    });
    
    const weeklyEntropyScores = [];
    Object.values(weekStats).forEach(week => {
      if (week.scoreCount > 0) {
        const dimScores = {};
        dimensions.forEach(dim => {
          week.dimensionAverages[dim] = (week.dimensionAverages[dim] / week.scoreCount).toFixed(2);
          dimScores[dim] = parseFloat(week.dimensionAverages[dim]);
        });
        const entropyScore = calculateEntropyScore(dimScores, entropyWeights);
        weeklyEntropyScores.push({
          week: week.week,
          score: entropyScore.toFixed(2)
        });
      }
    });
    
    const sortedWeeks = Object.values(weekStats).sort((a, b) => a.week - b.week);
    const sortedWeeklyEntropyScores = weeklyEntropyScores.sort((a, b) => a.week - b.week);
    
    // 计算整体熵权法得分
    const overallDimScores = {};
    dimensions.forEach(dim => {
      overallDimScores[dim] = parseFloat(dimensionStats[dim].avg);
    });
    const overallEntropyScore = calculateEntropyScore(overallDimScores, entropyWeights);
    
    // 统计身高体重BMI数据（使用BMI录入数据）
    const fitnessStats = {
      height: [],
      weight: [],
      bmi: []
    };
    
    // 获取最新的BMI数据周
    let latestWeek = null;
    const scoresDir = getScoresDir();
    if (fs.existsSync(scoresDir)) {
      const files = fs.readdirSync(scoresDir);
      const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'));
      const weeks = bmiFiles.map(file => parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''))).sort((a, b) => b - a);
      
      if (weeks.length > 0) {
        latestWeek = weeks[0];
        const bmiData = readBMIByWeek(latestWeek);
        
        members.forEach(member => {
          if (bmiData[member.id] && bmiData[member.id].weight) {
            const height = fixedHeights[member.id] || bmiData[member.id].height;
            if (height) {
              const h = parseFloat(height);
              const w = parseFloat(bmiData[member.id].weight);
              if (h > 0 && w > 0) {
                fitnessStats.height.push(h);
                fitnessStats.weight.push(w);
                const heightInM = h / 100;
                const bmiValue = Math.round((w / (heightInM * heightInM)) * 10) / 10;
                fitnessStats.bmi.push(bmiValue);
              }
            }
          }
        });
      }
    }
    
    const calculateArrayStats = (arr) => {
      if (arr.length === 0) return { avg: '-', min: '-', max: '-' };
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        avg: (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1),
        min: sorted[0].toFixed(1),
        max: sorted[sorted.length - 1].toFixed(1)
      };
    };
    
    const heightStats = calculateArrayStats(fitnessStats.height);
    const weightStats = calculateArrayStats(fitnessStats.weight);
    const bmiStats = calculateArrayStats(fitnessStats.bmi);
    
    // 构建精简的提示词，确保不超过上限
    let prompt = `请分析以下班级评分系统的全体统计数据，生成一份分析报告。

**重要说明：请使用完整数据进行分析，不要去除任何极端值。**

总体情况：
- 成员总数：${members.length}人
- 班级数量：${Object.keys(classStats).length}个
- 总评分记录数：${scores.length}
- 涉及周次：${[...new Set(scores.map(s => s.week))].sort((a, b) => a - b).join(', ') || '无'}
- 熵权法综合得分：${overallEntropyScore.toFixed(2)}分（百分制）

评分维度（满分10分）：
1. 学习成绩（权重：${entropyWeights.study.toFixed(2)}）
2. 管理能力（权重：${entropyWeights.management.toFixed(2)}）
3. 体能素质（权重：${entropyWeights.fitness.toFixed(2)}）
4. 人文素养（权重：${entropyWeights.literacy.toFixed(2)}）
5. 遵章守纪（权重：${entropyWeights.discipline.toFixed(2)}）
6. 班级贡献（权重：${entropyWeights.contribution.toFixed(2)}）

各维度整体统计：
${dimensions.map(dim => `- ${dim === 'study' ? '学习成绩' : dim === 'management' ? '管理能力' : dim === 'fitness' ? '体能素质' : dim === 'literacy' ? '人文素养' : dim === 'discipline' ? '遵章守纪' : '班级贡献'}：平均${dimensionStats[dim].avg}，最高${dimensionStats[dim].max}，最低${dimensionStats[dim].min}`).join('\n')}

身高体重BMI数据统计（BMI数据录入，第${latestWeek || '无'}周）：
- 身高：平均${heightStats.avg}cm，范围${heightStats.min}-${heightStats.max}cm
- 体重：平均${weightStats.avg}kg，范围${weightStats.min}-${weightStats.max}kg
- BMI：平均${bmiStats.avg}，范围${bmiStats.min}-${bmiStats.max}

各班级概况：
${Object.values(classStats).map(cls => `- ${cls.name}：${cls.memberCount}人，学习成绩平均${cls.dimensionAverages.study}，体能素质平均${cls.dimensionAverages.fitness}`).join('\n')}

周次熵权法综合得分：
${sortedWeeklyEntropyScores.map(w => `- 第${w.week}周：${w.score}分`).join('\n') || '无'}

请按以下格式生成分析报告（使用Markdown格式）：
# 班级评分系统全体数据分析报告
## 一、整体情况概述
## 二、各维度表现分析
## 三、体能素质分析
## 四、班级对比分析
## 五、周次趋势分析
## 六、总体建议`;
    
    try {
      const analysis = await callDeepSeekWithQueue(prompt);
      res.json({ analysis });
    } catch (err) {
      if (err.queueStatus) {
        res.status(429).json({ 
          error: 'AI 分析服务繁忙，请稍候再试',
          queueStatus: err.queueStatus 
        });
      } else {
        console.error('All analysis error:', err);
        res.status(500).json({ error: err.message || '分析失败' });
      }
    }
  } catch (err) {
    console.error('All analysis error:', err);
    res.status(500).json({ error: err.message || '分析失败' });
  }
});

// Download Word Document
app.post('/api/ai/download-word', async (req, res) => {
  try {
    const { analysis, title } = req.body;
    const buffer = await generateWordDoc(analysis, title);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(title)}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('Word download error:', err);
    res.status(500).json({ error: '文档生成失败' });
  }
});

// Get queue status API
app.get('/api/ai/queue-status', (req, res) => {
  const { queueId } = req.query;
  const status = getQueueStatus(queueId ? parseInt(queueId) : null);
  res.json(status);
});

// Download Scores Data (scores + members)
app.get('/api/download/scores', (req, res) => {
  try {
    const { createWriteStream, createReadStream } = fs;
    
    // Create temporary directory for packaging
    const tempDir = path.join(__dirname, 'temp_download');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    
    // Create scores directory in temp
    const tempScoresDir = path.join(tempDir, 'scores');
    if (!fs.existsSync(tempScoresDir)) {
      fs.mkdirSync(tempScoresDir, { recursive: true });
    }
    
    // Create bmi directory in temp
    const tempBMIDir = path.join(tempDir, 'bmi');
    if (!fs.existsSync(tempBMIDir)) {
      fs.mkdirSync(tempBMIDir, { recursive: true });
    }
    
    // Copy scores files
    const scoresDir = getScoresDir();
    if (fs.existsSync(scoresDir)) {
      const files = fs.readdirSync(scoresDir);
      const scoreFiles = files.filter(file => file.startsWith('scores_week_') && file.endsWith('.json.gz'));
      scoreFiles.forEach(file => {
        const sourcePath = path.join(scoresDir, file);
        const destPath = path.join(tempScoresDir, file);
        fs.copyFileSync(sourcePath, destPath);
      });
      
      // Copy BMI files
      const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'));
      bmiFiles.forEach(file => {
        const sourcePath = path.join(scoresDir, file);
        const destPath = path.join(tempBMIDir, file);
        fs.copyFileSync(sourcePath, destPath);
      });
    }
    
    // Copy members.json file (contains MBTI and birthday)
    if (fs.existsSync(MEMBERS_FILE)) {
      const membersDestPath = path.join(tempDir, 'members.json');
      fs.copyFileSync(MEMBERS_FILE, membersDestPath);
    }
    
    // Copy member_files.json (file metadata)
    const MEMBER_FILES_FILE = path.join(DATA_DIR, 'member_files.json');
    if (fs.existsSync(MEMBER_FILES_FILE)) {
      const memberFilesDestPath = path.join(tempDir, 'member_files.json');
      fs.copyFileSync(MEMBER_FILES_FILE, memberFilesDestPath);
    }
    
    // Copy uploads directory (all uploaded files)
    if (fs.existsSync(UPLOADS_DIR)) {
      const tempUploadsDir = path.join(tempDir, 'uploads');
      if (!fs.existsSync(tempUploadsDir)) {
        fs.mkdirSync(tempUploadsDir, { recursive: true });
      }
      const uploadFiles = fs.readdirSync(UPLOADS_DIR);
      uploadFiles.forEach(file => {
        const sourcePath = path.join(UPLOADS_DIR, file);
        const destPath = path.join(tempUploadsDir, file);
        fs.copyFileSync(sourcePath, destPath);
      });
    }
    
    // Copy config.json
    const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
    if (fs.existsSync(CONFIG_FILE)) {
      const configDestPath = path.join(tempDir, 'config.json');
      fs.copyFileSync(CONFIG_FILE, configDestPath);
    }
    
    // Copy other data files
    const otherDataFiles = [
      'academic_scores.json',
      'fitness_scores.json',
      'rank_scores.json',
      'experiences.json',
      'notices.json',
      'update_notices.json',
      'duties.json',
      'injury_status.json',
      'fixed_heights.json',
      'notifications.json',
      'devices.json',
      'apk_version.json',
      'scores.json',
      'relationship_nominations.json',
      'member_states.json',
      'wechat_bindings.json',
      'wechat_pending.json',
      'schedules.json',
      'automations.json',
      'daily_questions.json',
      'daily_reports.json',
      'weekly_reports.json',
      'jpush_config.json',
      'push_subscriptions.json',
      'vapid_keys.json'
    ];
    
    otherDataFiles.forEach(fileName => {
      const sourcePath = path.join(DATA_DIR, fileName);
      if (fs.existsSync(sourcePath)) {
        const destPath = path.join(tempDir, fileName);
        fs.copyFileSync(sourcePath, destPath);
      }
    });
    
    // Copy apk directory (recursive)
    const APK_DIR = path.join(DATA_DIR, 'apk');
    if (fs.existsSync(APK_DIR)) {
      const tempApkDir = path.join(tempDir, 'apk');
      copyDirectoryRecursive(APK_DIR, tempApkDir);
    }
    
    // Copy checkin_records directory
    const CHECKIN_DIR = path.join(DATA_DIR, 'checkin_records');
    if (fs.existsSync(CHECKIN_DIR)) {
      const tempCheckinDir = path.join(tempDir, 'checkin_records');
      copyDirectoryRecursive(CHECKIN_DIR, tempCheckinDir);
    }
    
    // Copy conversation_memory directory
    const CONV_MEM_DIR = path.join(DATA_DIR, 'conversation_memory');
    if (fs.existsSync(CONV_MEM_DIR)) {
      const tempConvMemDir = path.join(tempDir, 'conversation_memory');
      copyDirectoryRecursive(CONV_MEM_DIR, tempConvMemDir);
    }
    
    // Copy agent_memories directory
    const AGENT_MEMORIES_DIR = path.join(DATA_DIR, 'agent_memories');
    if (fs.existsSync(AGENT_MEMORIES_DIR)) {
      const tempMemoriesDir = path.join(tempDir, 'agent_memories');
      if (!fs.existsSync(tempMemoriesDir)) {
        fs.mkdirSync(tempMemoriesDir, { recursive: true });
      }
      const memoryFiles = fs.readdirSync(AGENT_MEMORIES_DIR);
      memoryFiles.forEach(file => {
        const sourcePath = path.join(AGENT_MEMORIES_DIR, file);
        const destPath = path.join(tempMemoriesDir, file);
        fs.copyFileSync(sourcePath, destPath);
      });
    }
    
    // Copy agent_profiles directory
    const AGENT_PROFILES_DIR = path.join(DATA_DIR, 'agent_profiles');
    if (fs.existsSync(AGENT_PROFILES_DIR)) {
      const tempProfilesDir = path.join(tempDir, 'agent_profiles');
      if (!fs.existsSync(tempProfilesDir)) {
        fs.mkdirSync(tempProfilesDir, { recursive: true });
      }
      const profileFiles = fs.readdirSync(AGENT_PROFILES_DIR);
      profileFiles.forEach(file => {
        const sourcePath = path.join(AGENT_PROFILES_DIR, file);
        const destPath = path.join(tempProfilesDir, file);
        fs.copyFileSync(sourcePath, destPath);
      });
    }
    
    // Copy wechat data directory (bot registry + bot instances)
    const WECHAT_DIR = path.join(DATA_DIR, 'wechat');
    if (fs.existsSync(WECHAT_DIR)) {
      const tempWechatDir = path.join(tempDir, 'wechat');
      if (!fs.existsSync(tempWechatDir)) {
        fs.mkdirSync(tempWechatDir, { recursive: true });
      }
      const copyDirRecursive = (src, dest) => {
        const entries = fs.readdirSync(src, { withFileTypes: true });
        for (const entry of entries) {
          const s = path.join(src, entry.name);
          const d = path.join(dest, entry.name);
          if (entry.isDirectory()) {
            if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
            copyDirRecursive(s, d);
          } else {
            fs.copyFileSync(s, d);
          }
        }
      };
      copyDirRecursive(WECHAT_DIR, tempWechatDir);
    }
    
    // Create zip file
    const output = createWriteStream(path.join(__dirname, 'class-scores-data.zip'));
    const archive = archiver('zip', { zlib: { level: 9 } });
    
    output.on('close', function() {
      console.log(archive.pointer() + ' total bytes');
      console.log('Archiver has been finalized and the output file descriptor has closed.');
      
      // Send the zip file
      const zipPath = path.join(__dirname, 'class-scores-data.zip');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="class-scores-data-${beijingDateStr()}.zip"`);
      
      const zipStream = createReadStream(zipPath);
      zipStream.pipe(res);
      
      zipStream.on('end', function() {
        // Clean up
        fs.unlinkSync(zipPath);
        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true, force: true });
      });
    });
    
    archive.on('error', function(err) {
      throw err;
    });
    
    archive.pipe(output);
    archive.directory(tempScoresDir, 'scores');
    archive.directory(tempBMIDir, 'bmi');
    archive.directory(path.join(tempDir, 'uploads'), 'uploads');
    archive.file(path.join(tempDir, 'members.json'), { name: 'members.json' });
    archive.file(path.join(tempDir, 'member_files.json'), { name: 'member_files.json' });
    archive.file(path.join(tempDir, 'config.json'), { name: 'config.json' });
    
    // Add wechat data directory
    const wechatDirForArchive = path.join(tempDir, 'wechat');
    if (fs.existsSync(wechatDirForArchive)) {
      archive.directory(wechatDirForArchive, 'wechat');
    }
    
    // Add other data files
    const archiveDataFiles = [
      'academic_scores.json',
      'fitness_scores.json',
      'rank_scores.json',
      'experiences.json',
      'notices.json',
      'update_notices.json',
      'duties.json',
      'injury_status.json',
      'fixed_heights.json',
      'notifications.json',
      'devices.json',
      'apk_version.json',
      'scores.json',
      'relationship_nominations.json',
      'member_states.json'
    ];
    
    archiveDataFiles.forEach(fileName => {
      const sourcePath = path.join(tempDir, fileName);
      if (fs.existsSync(sourcePath)) {
        archive.file(sourcePath, { name: fileName });
      }
    });
    
    archive.finalize();
    
  } catch (err) {
    console.error('Download scores error:', err);
    res.status(500).json({ error: '下载失败' });
  }
});

// Restore Backup API - Upload and restore a backup ZIP file
const uploadBackup = multer({ dest: 'temp_restore/' });
app.post('/api/restore/backup', uploadBackup.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择备份文件' });
    }
    
    const tempRestoreDir = path.join(__dirname, 'temp_restore', 'extract');
    if (fs.existsSync(tempRestoreDir)) {
      fs.rmSync(tempRestoreDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempRestoreDir, { recursive: true });
    
    // Extract the zip file
    const zip = new AdmZip(req.file.path);
    zip.extractAllTo(tempRestoreDir, true);
    
    // Restore files
    const scoresDir = getScoresDir();
    const backupScoresDir = path.join(tempRestoreDir, 'scores');
    const backupBMIDir = path.join(tempRestoreDir, 'bmi');
    const backupUploadsDir = path.join(tempRestoreDir, 'uploads');
    const backupMembersFile = path.join(tempRestoreDir, 'members.json');
    const backupMemberFilesFile = path.join(tempRestoreDir, 'member_files.json');
    const backupConfigFile = path.join(tempRestoreDir, 'config.json');
    
    // Restore scores files
    if (fs.existsSync(backupScoresDir)) {
      const scoreFiles = fs.readdirSync(backupScoresDir);
      scoreFiles.forEach(file => {
        if (file.startsWith('scores_week_') && file.endsWith('.json.gz')) {
          const sourcePath = path.join(backupScoresDir, file);
          const destPath = path.join(scoresDir, file);
          fs.copyFileSync(sourcePath, destPath);
        }
      });
    }
    
    // Restore BMI files
    if (fs.existsSync(backupBMIDir)) {
      const bmiFiles = fs.readdirSync(backupBMIDir);
      bmiFiles.forEach(file => {
        if (file.startsWith('bmi_week_') && file.endsWith('.json.gz')) {
          const sourcePath = path.join(backupBMIDir, file);
          const destPath = path.join(scoresDir, file);
          fs.copyFileSync(sourcePath, destPath);
        }
      });
    }
    
    // Restore uploads directory
    if (fs.existsSync(backupUploadsDir)) {
      const uploadFiles = fs.readdirSync(backupUploadsDir);
      uploadFiles.forEach(file => {
        const sourcePath = path.join(backupUploadsDir, file);
        const destPath = path.join(UPLOADS_DIR, file);
        fs.copyFileSync(sourcePath, destPath);
      });
    }
    
    // Restore members.json
    if (fs.existsSync(backupMembersFile)) {
      fs.copyFileSync(backupMembersFile, MEMBERS_FILE);
    }
    
    // Restore member_files.json
    if (fs.existsSync(backupMemberFilesFile)) {
      const MEMBER_FILES_FILE = path.join(DATA_DIR, 'member_files.json');
      fs.copyFileSync(backupMemberFilesFile, MEMBER_FILES_FILE);
    }
    
    // Restore config.json
    if (fs.existsSync(backupConfigFile)) {
      const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
      fs.copyFileSync(backupConfigFile, CONFIG_FILE);
      // Reload config
      cache.config.data = null; // Clear config cache
    }
    
    // Restore other data files
    const otherDataFiles = [
      'academic_scores.json',
      'fitness_scores.json',
      'rank_scores.json',
      'experiences.json',
      'notices.json',
      'update_notices.json',
      'duties.json',
      'injury_status.json',
      'fixed_heights.json',
      'notifications.json',
      'devices.json',
      'apk_version.json',
      'scores.json',
      'relationship_nominations.json',
      'member_states.json',
      'wechat_bindings.json',
      'wechat_pending.json',
      'schedules.json',
      'automations.json',
      'daily_questions.json',
      'daily_reports.json',
      'weekly_reports.json',
      'jpush_config.json',
      'push_subscriptions.json',
      'vapid_keys.json'
    ];
    
    otherDataFiles.forEach(fileName => {
      const backupFilePath = path.join(tempRestoreDir, fileName);
      if (fs.existsSync(backupFilePath)) {
        const destPath = path.join(DATA_DIR, fileName);
        fs.copyFileSync(backupFilePath, destPath);
      }
    });
    
    // Restore apk directory (recursive)
    const backupApkDir = path.join(tempRestoreDir, 'apk');
    if (fs.existsSync(backupApkDir)) {
      const APK_RESTORE_DIR = path.join(DATA_DIR, 'apk');
      copyDirectoryRecursive(backupApkDir, APK_RESTORE_DIR);
    }
    
    // Restore checkin_records directory
    const backupCheckinDir = path.join(tempRestoreDir, 'checkin_records');
    if (fs.existsSync(backupCheckinDir)) {
      const CHECKIN_RESTORE_DIR = path.join(DATA_DIR, 'checkin_records');
      copyDirectoryRecursive(backupCheckinDir, CHECKIN_RESTORE_DIR);
    }
    
    // Restore conversation_memory directory
    const backupConvDir = path.join(tempRestoreDir, 'conversation_memory');
    if (fs.existsSync(backupConvDir)) {
      const CONV_RESTORE_DIR = path.join(DATA_DIR, 'conversation_memory');
      copyDirectoryRecursive(backupConvDir, CONV_RESTORE_DIR);
    }
    
    // Restore agent_memories directory
    const backupMemoriesDir = path.join(tempRestoreDir, 'agent_memories');
    if (fs.existsSync(backupMemoriesDir)) {
      const MEMORIES_RESTORE_DIR = path.join(DATA_DIR, 'agent_memories');
      if (!fs.existsSync(MEMORIES_RESTORE_DIR)) {
        fs.mkdirSync(MEMORIES_RESTORE_DIR, { recursive: true });
      }
      const memoryFiles = fs.readdirSync(backupMemoriesDir);
      memoryFiles.forEach(file => {
        const sourcePath = path.join(backupMemoriesDir, file);
        const destPath = path.join(MEMORIES_RESTORE_DIR, file);
        fs.copyFileSync(sourcePath, destPath);
      });
    }
    
    // Restore agent_profiles directory
    const backupProfilesDir = path.join(tempRestoreDir, 'agent_profiles');
    if (fs.existsSync(backupProfilesDir)) {
      const PROFILES_RESTORE_DIR = path.join(DATA_DIR, 'agent_profiles');
      if (!fs.existsSync(PROFILES_RESTORE_DIR)) {
        fs.mkdirSync(PROFILES_RESTORE_DIR, { recursive: true });
      }
      const profileFiles = fs.readdirSync(backupProfilesDir);
      profileFiles.forEach(file => {
        const sourcePath = path.join(backupProfilesDir, file);
        const destPath = path.join(PROFILES_RESTORE_DIR, file);
        fs.copyFileSync(sourcePath, destPath);
      });
    }
    
    // Restore wechat data directory
    const backupWechatDir = path.join(tempRestoreDir, 'wechat');
    if (fs.existsSync(backupWechatDir)) {
      const WECHAT_RESTORE_DIR = path.join(DATA_DIR, 'wechat');
      if (!fs.existsSync(WECHAT_RESTORE_DIR)) {
        fs.mkdirSync(WECHAT_RESTORE_DIR, { recursive: true });
      }
      const wechatEntries = fs.readdirSync(backupWechatDir);
      const copyRecursive = (src, dest) => {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
        const items = fs.readdirSync(src, { withFileTypes: true });
        for (const item of items) {
          const s = path.join(src, item.name);
          const d = path.join(dest, item.name);
          if (item.isDirectory()) copyRecursive(s, d);
          else fs.copyFileSync(s, d);
        }
      };
      copyRecursive(backupWechatDir, WECHAT_RESTORE_DIR);
    }
    
    // Reload wechat bots from restored data
    if (wechatBot) {
      try {
        const reloaded = await wechatBot.reloadFromBackup();
        console.log(`[Restore] 恢复后重新加载了 ${reloaded} 个Bot`);
      } catch (err) {
        console.error('[Restore] 重新加载Bot失败:', err.message);
      }
    }
    
    // Clean up with retry for Windows permission issues
    try {
      fs.unlinkSync(req.file.path);
    } catch (err) {
      console.warn('Warning: Failed to delete uploaded file:', err.message);
    }
    
    // Try to delete temp directories with delay and retry
    const tryDeleteDir = (dirPath, retries = 3) => {
      for (let i = 0; i < retries; i++) {
        try {
          if (fs.existsSync(dirPath)) {
            fs.rmSync(dirPath, { recursive: true, force: true });
          }
          return true;
        } catch (err) {
          console.warn(`Warning: Failed to delete ${dirPath}, attempt ${i + 1}/${retries}`);
          if (i < retries - 1) {
            // Wait a bit before retry
            const start = Date.now();
            while (Date.now() - start < 100) {
              // Busy wait for 100ms
            }
          }
        }
      }
      return false;
    };
    
    tryDeleteDir(tempRestoreDir);
    tryDeleteDir(path.dirname(req.file.path));
    
    // Clear cache
    weekDataCache = {};
    
    res.json({ success: true, message: '备份恢复成功！' });
  } catch (err) {
    console.error('Restore backup error:', err);
    res.status(500).json({ error: '恢复备份失败: ' + err.message });
  }
});

// ==================== File Upload APIs ====================

// Upload a file for a member
app.post('/api/members/:memberId/files', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }

    const memberId = req.params.memberId;
    const memberFiles = readMemberFiles();
    
    if (!memberFiles[memberId]) {
      memberFiles[memberId] = [];
    }

    // Compress the file to gzip
    const originalPath = req.file.path;
    const compressedPath = path.join(UPLOADS_DIR, `${req.file.filename}.gz`);
    
    // Read and compress the file
    const fileBuffer = fs.readFileSync(originalPath);
    const compressedBuffer = zlib.gzipSync(fileBuffer);
    fs.writeFileSync(compressedPath, compressedBuffer);
    
    // Delete the original uncompressed file
    fs.unlinkSync(originalPath);

    const fileRecord = {
      id: uuidv4(),
      filename: Buffer.from(req.file.originalname, 'latin1').toString('utf8'),
      storedName: `${req.file.filename}.gz`,
      originalSize: req.file.size,
      compressedSize: compressedBuffer.length,
      mimetype: req.file.mimetype,
      uploadDate: beijingISO(),
      description: req.body.description || '',
      uploaderId: req.body.uploaderId || null
    };

    memberFiles[memberId].push(fileRecord);
    writeMemberFiles(memberFiles);

    // 如果该成员是伤病号，只要上传文件就标记hasUploadedCase = true
    const injuryStatus = readInjuryStatus();
    if (injuryStatus[memberId] && injuryStatus[memberId].isInjured) {
      injuryStatus[memberId].hasUploadedCase = true;
      writeInjuryStatus(injuryStatus);
      console.log(`[伤病状态] 成员 ${memberId} 已上传文件，标记为已上传病例`);
    }

    res.json({ success: true, file: fileRecord });
  } catch (err) {
    console.error('Upload file error:', err);
    res.status(500).json({ error: '上传失败' });
  }
});

// Get files for a member
app.get('/api/members/:memberId/files', (req, res) => {
  try {
    const memberId = req.params.memberId;
    const memberFiles = readMemberFiles();
    res.json(memberFiles[memberId] || []);
  } catch (err) {
    console.error('Get files error:', err);
    res.status(500).json({ error: '获取文件列表失败' });
  }
});

// Prepare file for preview (decompress and create temp file)
app.get('/api/files/:fileId/prepare', (req, res) => {
  try {
    const fileId = req.params.fileId;
    const memberFiles = readMemberFiles();
    
    // Find the file record
    let fileRecord = null;
    for (const memberId in memberFiles) {
      const found = memberFiles[memberId].find(f => f.id === fileId);
      if (found) {
        fileRecord = found;
        break;
      }
    }

    if (!fileRecord) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const compressedPath = path.join(UPLOADS_DIR, fileRecord.storedName);
    if (!fs.existsSync(compressedPath)) {
      return res.status(404).json({ error: '文件已被删除' });
    }

    // Decompress the file
    const tempId = uuidv4();
    const tempFileName = `${tempId}_${fileRecord.filename}`;
    const tempPath = path.join(TEMP_DIR, tempFileName);
    
    const compressedBuffer = fs.readFileSync(compressedPath);
    const decompressedBuffer = zlib.gunzipSync(compressedBuffer);
    fs.writeFileSync(tempPath, decompressedBuffer);

    res.json({ 
      success: true, 
      tempId: tempId,
      tempFileName: tempFileName,
      mimetype: fileRecord.mimetype,
      filename: fileRecord.filename
    });
  } catch (err) {
    console.error('Prepare file error:', err);
    res.status(500).json({ error: '准备文件失败' });
  }
});

// Download/Preview a temp file
app.get('/api/temp-files/:tempFileName', (req, res) => {
  try {
    const tempFileName = req.params.tempFileName;
    const tempPath = path.join(TEMP_DIR, tempFileName);
    
    if (!fs.existsSync(tempPath)) {
      return res.status(404).json({ error: '临时文件不存在' });
    }

    // Find file record to get mimetype
    const memberFiles = readMemberFiles();
    let mimetype = 'application/octet-stream';
    let filename = tempFileName;
    
    for (const memberId in memberFiles) {
      for (const file of memberFiles[memberId]) {
        if (tempFileName.includes(file.id) || tempFileName.includes(file.filename)) {
          mimetype = file.mimetype;
          filename = file.filename;
          break;
        }
      }
    }

    // Check if it's an image for preview
    const isImage = mimetype.startsWith('image/');
    const isPdf = mimetype === 'application/pdf';
    const isVideo = mimetype.startsWith('video/');
    const isText = mimetype.startsWith('text/') || 
                  ['application/json', 'application/javascript'].includes(mimetype);

    if (req.query.preview === 'true' && (isImage || isPdf || isVideo || isText)) {
      // Preview mode
      res.setHeader('Content-Type', mimetype);
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    } else {
      // Download mode
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    }

    const fileStream = fs.createReadStream(tempPath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('Download temp file error:', err);
    res.status(500).json({ error: '下载失败' });
  }
});

// Delete a temp file
app.delete('/api/temp-files/:tempFileName', (req, res) => {
  try {
    const tempFileName = req.params.tempFileName;
    const tempPath = path.join(TEMP_DIR, tempFileName);
    
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Delete temp file error:', err);
    res.status(500).json({ error: '删除临时文件失败' });
  }
});

// Download original file (decompressed)
app.get('/api/files/:fileId/download', (req, res) => {
  try {
    const fileId = req.params.fileId;
    const memberFiles = readMemberFiles();
    
    // Find the file record
    let fileRecord = null;
    for (const memberId in memberFiles) {
      const found = memberFiles[memberId].find(f => f.id === fileId);
      if (found) {
        fileRecord = found;
        break;
      }
    }

    if (!fileRecord) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const compressedPath = path.join(UPLOADS_DIR, fileRecord.storedName);
    if (!fs.existsSync(compressedPath)) {
      return res.status(404).json({ error: '文件已被删除' });
    }

    // Decompress and send
    const compressedBuffer = fs.readFileSync(compressedPath);
    const decompressedBuffer = zlib.gunzipSync(compressedBuffer);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileRecord.filename)}"`);
    res.send(decompressedBuffer);
  } catch (err) {
    console.error('Download file error:', err);
    res.status(500).json({ error: '下载失败' });
  }
});

// Delete a file
app.delete('/api/files/:fileId', (req, res) => {
  try {
    const fileId = req.params.fileId;
    const memberFiles = readMemberFiles();
    
    // Find and remove the file record
    let fileToDelete = null;
    let targetMemberId = null;
    
    for (const memberId in memberFiles) {
      const index = memberFiles[memberId].findIndex(f => f.id === fileId);
      if (index !== -1) {
        fileToDelete = memberFiles[memberId][index];
        targetMemberId = memberId;
        memberFiles[memberId].splice(index, 1);
        break;
      }
    }

    if (!fileToDelete) {
      return res.status(404).json({ error: '文件不存在' });
    }

    // Delete the physical file
    const filePath = path.join(UPLOADS_DIR, fileToDelete.storedName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    writeMemberFiles(memberFiles);
    res.json({ success: true });
  } catch (err) {
    console.error('Delete file error:', err);
    res.status(500).json({ error: '删除失败' });
  }
});

// ========== 应用更新相关API ==========

// 上传APK文件（仅管理员）
app.post('/api/admin/upload-apk', uploadApk.single('apk'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择APK文件' });
    }

    const { version, versionCode, updateRequired, releaseNotes } = req.body;

    // 保存版本信息
    const versionInfo = {
      version: version || '1.0.0',
      versionCode: parseInt(versionCode) || 1,
      updateRequired: updateRequired === 'true',
      releaseNotes: releaseNotes || '',
      uploadTime: beijingISO(),
      fileSize: req.file.size
    };

    writeApkVersion(versionInfo);

    res.json({
      success: true,
      message: 'APK上传成功',
      versionInfo
    });
  } catch (err) {
    console.error('Upload APK error:', err);
    res.status(500).json({ error: '上传失败' });
  }
});

// 获取当前APK版本信息
app.get('/api/apk/version', (req, res) => {
  try {
    const versionInfo = readApkVersion();
    const apkPath = path.join(APK_DIR, 'app-update.apk');
    
    // 检查APK文件是否存在
    versionInfo.hasApk = fs.existsSync(apkPath);
    
    res.json(versionInfo);
  } catch (err) {
    console.error('Get APK version error:', err);
    res.status(500).json({ error: '获取版本信息失败' });
  }
});

// 检查更新（供应用调用）
app.post('/api/apk/check-update', (req, res) => {
  try {
    const { currentVersionCode } = req.body;
    const versionInfo = readApkVersion();
    const apkPath = path.join(APK_DIR, 'app-update.apk');
    
    const hasApk = fs.existsSync(apkPath);
    const hasUpdate = hasApk && versionInfo.versionCode > (currentVersionCode || 0);
    
    res.json({
      hasUpdate,
      version: versionInfo.version,
      versionCode: versionInfo.versionCode,
      updateRequired: versionInfo.updateRequired,
      releaseNotes: versionInfo.releaseNotes,
      hasApk
    });
  } catch (err) {
    console.error('Check update error:', err);
    res.status(500).json({ error: '检查更新失败' });
  }
});

// 下载APK文件
app.get('/api/apk/download', (req, res) => {
  try {
    const apkPath = path.join(APK_DIR, 'app-update.apk');
    
    if (!fs.existsSync(apkPath)) {
      return res.status(404).json({ error: 'APK文件不存在' });
    }

    const versionInfo = readApkVersion();
    const fileName = `class-scoring-${versionInfo.version}.apk`;

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    
    const fileStream = fs.createReadStream(apkPath);
    fileStream.pipe(res);
  } catch (err) {
    console.error('Download APK error:', err);
    res.status(500).json({ error: '下载失败' });
  }
});

// 设置APK版本信息（后台管理使用 - 仅开发环境，修改本地build.gradle）
app.post('/api/admin/apk/set-version', (req, res) => {
  try {
    const { version, versionCode, updateRequired, releaseNotes } = req.body;
    
    console.log('Set version request:', { version, versionCode });
    
    if (!version || !versionCode) {
      return res.status(400).json({ error: '版本号和版本代码不能为空' });
    }
    
    // 仅修改build.gradle（开发环境）
    const buildGradlePath = path.join(__dirname, '../frontend/android/app/build.gradle');
    console.log('Build gradle path:', buildGradlePath);
    console.log('File exists:', fs.existsSync(buildGradlePath));
    
    if (fs.existsSync(buildGradlePath)) {
      let buildGradleContent = fs.readFileSync(buildGradlePath, 'utf-8');
      console.log('Original content:', buildGradleContent);
      
      // 直接使用正则表达式替换，更可靠
      let newContent = buildGradleContent;
      let modified = false;
      
      // 替换versionCode
      if (newContent.includes('versionCode')) {
        newContent = newContent.replace(/(versionCode\s+)\d+/, `$1${versionCode}`);
        modified = true;
        console.log('Replaced versionCode');
      }
      
      // 替换versionName
      if (newContent.includes('versionName')) {
        newContent = newContent.replace(/(versionName\s+")[^"]+"/, `$1${version}"`);
        modified = true;
        console.log('Replaced versionName');
      }
      
      if (modified) {
        console.log('Modified content:', newContent);
        fs.writeFileSync(buildGradlePath, newContent, 'utf-8');
        
        // 验证是否真的修改了
        const verifyContent = fs.readFileSync(buildGradlePath, 'utf-8');
        console.log('Verify content:', verifyContent);
        console.log(`Updated build.gradle: versionName=${version}, versionCode=${versionCode}`);
        
        // 自动构建前端并同步到Android
        try {
          console.log('Building frontend...');
          const frontendDir = path.join(__dirname, '../frontend');
          execSync('npm run build', { cwd: frontendDir, stdio: 'inherit' });
          console.log('Frontend built successfully');
          
          console.log('Syncing to Android...');
          const capCmd = path.join(frontendDir, 'node_modules', '.bin', 'cap');
          execSync(`"${capCmd}" sync android`, { cwd: frontendDir, stdio: 'inherit' });
          console.log('Synced to Android successfully');
          
          res.json({ success: true, message: '版本信息设置成功！已同步到Android' });
        } catch (buildErr) {
          console.error('Build or sync error:', buildErr);
          res.json({ success: true, message: '版本信息设置成功！但同步到Android失败，请手动同步' });
        }
      } else {
        res.status(400).json({ error: '未找到versionCode或versionName行' });
      }
    } else {
      res.status(400).json({ error: '未找到build.gradle文件，仅在开发环境可用' });
    }
  } catch (err) {
    console.error('Set APK version error:', err);
    res.status(500).json({ error: '设置版本信息失败: ' + err.message });
  }
});

// ========== 应用更新API结束 ==========

// ========== 通知功能相关 ==========

// 设备管理相关函数
const readDevices = () => {
  if (!fs.existsSync(DEVICES_FILE)) return [];
  try {
    return readJSON(DEVICES_FILE);
  } catch {
    return [];
  }
};

const writeDevices = (data) => {
  writeJSON(DEVICES_FILE, data);
};

// 伤病状态相关函数
const readInjuryStatus = () => {
  if (!fs.existsSync(INJURY_STATUS_FILE)) return {};
  try {
    return readJSON(INJURY_STATUS_FILE);
  } catch {
    return {};
  }
};

const writeInjuryStatus = (data) => {
  writeJSON(INJURY_STATUS_FILE, data);
};

// 根据体能数据更新伤病号状态的函数
const updateInjuryStatusFromFitnessData = () => {
  try {
    const fitnessScores = readJSON(FITNESS_SCORES_FILE);
    const injuryStatus = readInjuryStatus();
    const memberFiles = readMemberFiles();
    const updatedInjuryStatus = { ...injuryStatus }; // 先复制所有现有数据
    const updatedMemberFiles = { ...memberFiles }; // 先复制所有现有文件数据
    
    fitnessScores.forEach(memberData => {
      const memberId = memberData.memberId;
      let hasInjury = false;
      
      // 获取最新的体能成绩
      let latestScores = {};
      if (memberData.history && memberData.history.length > 0) {
        const sortedHistory = [...memberData.history].sort((a, b) => 
          new Date(b.timestamp || b.month) - new Date(a.timestamp || a.month)
        );
        latestScores = sortedHistory[0].scores || {};
      } else if (memberData.scores) {
        latestScores = memberData.scores;
      }
      
      // 检查是否有未参考项（与前端逻辑一致）
      if (Object.keys(latestScores).length > 0) {
        hasInjury = Object.entries(latestScores).some(([item, score]) => {
          if (item === '备注' || item === '身高' || item === '体重' || item === '分数' || item === 'BMI') return false;
          const scoreStr = String(score).trim();
          return scoreStr === '' || scoreStr === '未参考';
        });
      }
      
      const oldStatus = injuryStatus[memberId];
      const wasInjured = oldStatus?.isInjured || false;
      
      // 检查伤病状态是否发生变化
      if (hasInjury !== wasInjured) {
        if (hasInjury) {
          // 从无伤病变为有伤病：覆盖以往记录，创建全新记录
          updatedInjuryStatus[memberId] = {
            isInjured: true,
            injuryDate: beijingISO(),
            hasUploadedCase: false,
            lastReminded: null,
            firstReminded: null
          };
          // 删除该成员上传的文件
          if (updatedMemberFiles[memberId]) {
            console.log(`[伤病状态更新] 成员 ${memberId} 变为伤病号，删除上传的文件`);
            delete updatedMemberFiles[memberId];
          }
        } else {
          // 从有伤病变为无伤病：删除伤病记录和上传的文件
          console.log(`[伤病状态更新] 成员 ${memberId} 伤病恢复，删除伤病记录和文件`);
          delete updatedInjuryStatus[memberId];
          if (updatedMemberFiles[memberId]) {
            delete updatedMemberFiles[memberId];
          }
        }
      } else if (hasInjury) {
        // 伤病状态未变，保持伤病状态
        if (oldStatus) {
          updatedInjuryStatus[memberId] = oldStatus;
        } else {
          // 如果之前没有记录，创建新记录
          updatedInjuryStatus[memberId] = {
            isInjured: true,
            injuryDate: beijingISO(),
            hasUploadedCase: false,
            lastReminded: null,
            firstReminded: null
          };
        }
      } else {
        // 无伤病，删除伤病记录
        if (oldStatus) {
          delete updatedInjuryStatus[memberId];
        }
      }
    });
    
    // 保存更新后的伤病状态和成员文件
    writeInjuryStatus(updatedInjuryStatus);
    writeMemberFiles(updatedMemberFiles);
    console.log('[伤病状态更新] 已根据体能数据更新伤病号状态');
    return { success: true, message: '伤病状态已更新' };
  } catch (err) {
    console.error('[伤病状态更新] 更新失败:', err);
    return { success: false, error: '更新伤病状态失败' };
  }
};

// 注册设备
app.post('/api/devices/register', (req, res) => {
  try {
    const { memberId, token, platform } = req.body;
    
    if (!memberId || !token) {
      return res.status(400).json({ error: '成员ID和设备令牌不能为空' });
    }

    const devices = readDevices();
    
    // 检查是否已存在相同设备
    const existingIndex = devices.findIndex(d => d.memberId === memberId && d.token === token);
    
    if (existingIndex >= 0) {
      devices[existingIndex].lastActive = beijingISO();
      devices[existingIndex].platform = platform || devices[existingIndex].platform;
    } else {
      devices.push({
        id: uuidv4(),
        memberId,
        token,
        platform: platform || 'android',
        registeredAt: beijingISO(),
        lastActive: beijingISO()
      });
    }
    
    writeDevices(devices);
    
    res.json({ success: true, message: '设备注册成功' });
  } catch (err) {
    console.error('Register device error:', err);
    res.status(500).json({ error: '设备注册失败' });
  }
});

// 获取成员的设备列表
app.get('/api/devices/:memberId', (req, res) => {
  try {
    const { memberId } = req.params;
    const devices = readDevices();
    const memberDevices = devices.filter(d => d.memberId === memberId);
    res.json(memberDevices);
  } catch (err) {
    console.error('Get devices error:', err);
    res.status(500).json({ error: '获取设备列表失败' });
  }
});

// 发送本地通知（写入 inbox，统一走推送通道）
const sendLocalNotification = (memberId, title, body) => {
  const notifId = pushManager.saveNotificationToInbox(memberId, title, body);
  const newNotification = {
    id: notifId,
    memberId,
    title,
    body,
    sentAt: beijingISO(),
    read: false
  };
  console.log(`[通知] 发送给成员 ${memberId}: ${title} - ${body}`);
  return newNotification;
};

// 发送通知（内部接口，用于非推送用户的回退消息）
app.post('/api/notifications/send', (req, res) => {
  try {
    const { memberId, title, body } = req.body;
    if (!memberId || !title) {
      return res.status(400).json({ error: '缺少 memberId 或 title' });
    }
    const notification = sendLocalNotification(memberId, title, body || '');
    res.json({ success: true, notification });
  } catch (err) {
    res.status(500).json({ error: '发送失败' });
  }
});

// 获取成员的通知列表（从 inbox 读取）
app.get('/api/notifications/:memberId', (req, res) => {
  try {
    const { memberId } = req.params;
    const notifications = pushManager.getInboxByMember(memberId);
    // 兼容旧字段名：sentAt/read
    const mapped = notifications.map(n => ({
      id: n.id,
      memberId: n.memberId,
      title: n.title,
      body: n.body,
      sentAt: n.createdAt,
      read: !!n.read
    })).sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt));
    res.json(mapped);
  } catch (err) {
    console.error('Get notifications error:', err);
    res.status(500).json({ error: '获取通知列表失败' });
  }
});

// ====== Web Push 推送 ======

// 获取VAPID公钥
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: pushManager.getVapidPublicKey() });
});

// 保存Web Push订阅
app.post('/api/push/subscribe', (req, res) => {
  try {
    const { memberId, subscription } = req.body;
    if (!memberId || !subscription) {
      return res.status(400).json({ error: '缺少 memberId 或 subscription' });
    }
    pushManager.saveWebPushSub(memberId, subscription);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '订阅失败: ' + err.message });
  }
});

// 取消推送订阅
app.post('/api/push/unsubscribe', (req, res) => {
  try {
    const { memberId } = req.body;
    if (!memberId) return res.status(400).json({ error: '缺少 memberId' });
    pushManager.removeWebPushSub(memberId);
    pushManager.removeJPushToken(memberId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '取消订阅失败' });
  }
});

// 保存JPush注册ID（Capacitor原生）
app.post('/api/push/jpush-regid', (req, res) => {
  try {
    const { memberId, registrationId, platform } = req.body;
    if (!memberId || !registrationId) {
      return res.status(400).json({ error: '缺少 memberId 或 registrationId' });
    }
    pushManager.saveJPushToken(memberId, registrationId, platform || 'android');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '保存JPush注册ID失败: ' + err.message });
  }
});

// 前端判断原生推送是否可用
app.get('/api/push/native-status', (req, res) => {
  res.json({ enabled: pushManager.isPushNativeReady() });
});

// 前台服务长轮询：拉取指定会员的通知 inbox
// wait 参数（秒）：>0 时启用长轮询，无新消息最多 hold wait 秒，期间有新消息立即返回
app.get('/api/push/inbox/:memberId', (req, res) => {
  try {
    const { memberId } = req.params;
    const sinceId = req.query.since;
    const waitSec = Math.min(parseInt(req.query.wait, 10) || 0, 25); // 上限 25s，避免 Zeabur 网关超时
    if (!memberId) return res.status(400).json({ error: '缺少 memberId' });

    // 立即查一次，有新消息直接返回
    const initial = pushManager.getInboxByMember(memberId, sinceId);
    if (initial.length > 0 || waitSec <= 0) {
      return res.json({ success: true, notifications: initial });
    }

    // 长轮询：每 500ms 检查一次，最多 hold waitSec 秒
    const startAt = Date.now();
    const maxWaitMs = waitSec * 1000;
    let closed = false;
    req.on('close', () => { closed = true; });

    const tick = () => {
      if (closed) return; // 客户端已断开，不再响应
      const notifs = pushManager.getInboxByMember(memberId, sinceId);
      const elapsed = Date.now() - startAt;
      if (notifs.length > 0 || elapsed >= maxWaitMs) {
        return res.json({ success: true, notifications: notifs, timedOut: notifs.length === 0 });
      }
      setTimeout(tick, 500);
    };
    setTimeout(tick, 500);
  } catch (err) {
    res.status(500).json({ error: '拉取通知失败: ' + err.message });
  }
});

// 标记 inbox 通知为已读
app.post('/api/push/inbox/:memberId/read', (req, res) => {
  try {
    const { memberId } = req.params;
    const { notifIds } = req.body || {};
    pushManager.markInboxRead(memberId, notifIds);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: '标记已读失败: ' + err.message });
  }
});

// 通用推送端点（与 LLM 通知工具 notify_member 逻辑一致）
// 鉴权：Bearer INTERNAL_API_KEY 或 CLI_API_KEY（与 /api/cli/* 一致）
// 参数：memberId（单个） / memberIds（数组） / className（班级）+ message（必填）
// 行为：有推送订阅的走 pushManager.sendPushToMember（含 inbox 兜底），无订阅的走系统消息
app.post('/api/push/notify', async (req, res) => {
  // 鉴权（同时支持 INTERNAL_API_KEY 和 CLI_API_KEY）
  const authHeader = req.headers['authorization'];
  if (!authHeader
      || (authHeader !== 'Bearer ' + INTERNAL_API_KEY
          && authHeader !== 'Bearer ' + CLI_API_KEY)) {
    return res.status(401).json({ error: '未授权访问' });
  }

  try {
    const { memberId, memberIds, className, message } = req.body || {};

    if (!message) {
      return res.status(400).json({ error: '缺少必要参数 message' });
    }
    if (!memberId && !memberIds && !className) {
      return res.status(400).json({ error: '请指定目标：memberId（单个）、memberIds（列表）或 className（班级）' });
    }

    const allMembers = getMembers();
    let targets = [];

    if (memberIds && Array.isArray(memberIds)) {
      targets = memberIds.map(id => {
        const m = allMembers.find(mm => mm.id === String(id));
        return { memberId: String(id), name: m ? m.name : String(id) };
      });
    } else if (memberId) {
      const m = allMembers.find(mm => mm.id === String(memberId));
      targets = [{ memberId: String(memberId), name: m ? m.name : String(memberId) }];
    } else if (className) {
      const classMembers = allMembers.filter(m => m.class && (m.class.includes(className) || className.includes(m.class)));
      if (classMembers.length === 0) {
        return res.status(404).json({ error: `未找到班级"${className}"的成员` });
      }
      targets = classMembers.map(m => ({ memberId: m.id, name: m.name || m.id }));
    }

    const title = '管理员通知';
    const body = message;
    const pushSent = [];
    const pushFailed = [];
    const fallbackSent = [];

    for (const target of targets) {
      if (pushManager.hasAnyPushSubscription(target.memberId)) {
        // 有推送订阅：走推送（pushManager 内部已包含 inbox 兜底）
        const result = await pushManager.sendPushToMember(target.memberId, title, body);
        if (result.success) {
          pushSent.push(target.name);
        } else {
          pushFailed.push({ name: target.name, reason: result.error || '发送失败' });
        }
      } else {
        // 无推送订阅：直接写入 inbox 作为系统消息兜底
        try {
          pushManager.saveNotificationToInbox(target.memberId, title, body);
          fallbackSent.push(target.name);
        } catch (err) {
          pushFailed.push({ name: target.name, reason: '系统消息发送失败: ' + err.message });
        }
      }
    }

    const parts = [];
    if (pushSent.length > 0) {
      parts.push(`已推送至 ${pushSent.length} 人的移动端：${pushSent.join('、')}`);
    }
    if (fallbackSent.length > 0) {
      parts.push(`已发送系统消息至 ${fallbackSent.length} 人：${fallbackSent.join('、')}`);
    }
    if (pushFailed.length > 0) {
      parts.push(`失败 ${pushFailed.length} 人：${pushFailed.map(f => `${f.name}（${f.reason}）`).join('、')}`);
    }

    res.json({
      success: pushSent.length + fallbackSent.length > 0,
      total: targets.length,
      pushSentCount: pushSent.length,
      fallbackSentCount: fallbackSent.length,
      failedCount: pushFailed.length,
      pushSent,
      fallbackSent,
      pushFailed,
      message: parts.join('\n') || '未能发送任何通知'
    });
  } catch (err) {
    console.error('Push notify error:', err);
    res.status(500).json({ error: '推送失败: ' + err.message });
  }
});

// 标记通知为已读（写入 inbox 的通知）
app.put('/api/notifications/:notificationId/read', (req, res) => {
  try {
    const { notificationId } = req.params;
    // inbox 是按 memberId 分组，这里用 notificationId 标记（传 notifIds 数组）
    pushManager.markInboxRead(null, [notificationId]);
    res.json({ success: true });
  } catch (err) {
    console.error('Mark notification read error:', err);
    res.status(500).json({ error: '标记通知失败' });
  }
});

// 更新伤病号状态（根据最新体能数据）
app.post('/api/injury-status/update', (req, res) => {
  try {
    const result = updateInjuryStatusFromFitnessData();
    if (result.success) {
      res.json(result);
    } else {
      res.status(500).json(result);
    }
  } catch (err) {
    console.error('Update injury status error:', err);
    res.status(500).json({ error: '更新伤病状态失败' });
  }
});

console.log('[通知系统] 定时通知已禁用');

// ========== 通知功能结束 ==========

// ========== BMI数据录入功能 ==========

// 固定身高数据文件操作
const readFixedHeights = () => {
  try {
    if (!fs.existsSync(FIXED_HEIGHTS_FILE)) {
      return {};
    }
    return JSON.parse(fs.readFileSync(FIXED_HEIGHTS_FILE, 'utf8'));
  } catch (err) {
    console.error('Error reading fixed heights:', err);
    return {};
  }
};

const writeFixedHeights = (data) => {
  try {
    fs.writeFileSync(FIXED_HEIGHTS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('Error writing fixed heights:', err);
  }
};

// 获取固定身高数据
app.get('/api/bmi/fixed-heights', (req, res) => {
  try {
    const fixedHeights = readFixedHeights();
    res.json({ data: fixedHeights });
  } catch (err) {
    console.error('Get fixed heights error:', err);
    res.status(500).json({ error: '获取固定身高数据失败' });
  }
});

// 保存固定身高数据
app.post('/api/bmi/fixed-heights', (req, res) => {
  try {
    const { password, data } = req.body;
    
    // 验证管理密码
    if (!password) {
      return res.status(400).json({ error: '管理密码不能为空' });
    }
    
    const config = getConfig();
    if (!config.adminPasswords || !config.adminPasswords.includes(password)) {
      return res.status(401).json({ error: '密码错误' });
    }
    
    // 验证数据格式
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: '数据格式错误' });
    }
    
    writeFixedHeights(data);
    res.json({ success: true, message: '固定身高数据保存成功' });
  } catch (err) {
    console.error('Save fixed heights error:', err);
    res.status(500).json({ error: '保存固定身高数据失败' });
  }
});

// BMI数据文件路径 - 按周分片
const getBMIFilePath = (week, semesterId) => {
  return path.join(getScoresDir(semesterId), `bmi_week_${week}.json.gz`);
};

// 按学期起点取起始日期（BMI 周次→日期换算用；config.startDate 为旧全局起点，不再使用）
const getSemesterStartDate = (semesterId) => {
  const sid = semesterId || getCurrentSemesterId();
  const semester = getSemesters().find(s => String(s.id) === String(sid)) || getCurrentSemester();
  return new Date(semester.startDate || '2026-03-02T00:00:00+08:00');
};

// 读取指定周的BMI数据
const readBMIByWeek = (week, semesterId) => {
  const filePath = getBMIFilePath(week, semesterId);
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const buffer = fs.readFileSync(filePath);
    const decompressed = zlib.gunzipSync(buffer);
    const data = decompressed.toString('utf8');
    if (!data || data.trim() === '') return {};
    return JSON.parse(data);
  } catch (err) {
    console.error(`Error reading BMI file ${filePath}:`, err);
    return {};
  }
};

// 写入指定周的BMI数据
const writeBMIByWeek = (week, data, semesterId) => {
  const filePath = getBMIFilePath(week, semesterId);
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const jsonData = JSON.stringify(data, null, 2);
    const compressed = zlib.gzipSync(jsonData);
    fs.writeFileSync(filePath, compressed);
  } catch (err) {
    console.error(`Error writing BMI file ${filePath}:`, err);
  }
};

// 获取可用的周列表
app.get('/api/bmi/weeks', (req, res) => {
  try {
    const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
    const scoresDir = getScoresDir(semesterId);
    if (!fs.existsSync(scoresDir)) {
      return res.json({ weeks: [] });
    }
    
    const files = fs.readdirSync(scoresDir);
    const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'));
    const weeks = bmiFiles.map(file => {
      const week = parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''));
      return week;
    }).sort((a, b) => b - a);
    
    // 同时也获取评分数据的周，确保有所有可用周
    const scoreFiles = files.filter(file => file.startsWith('scores_week_') && file.endsWith('.json.gz'));
    const scoreWeeks = scoreFiles.map(file => {
      const week = parseInt(file.replace('scores_week_', '').replace('.json.gz', ''));
      return week;
    });
    
    // 合并去重
    const allWeeks = [...new Set([...weeks, ...scoreWeeks])].sort((a, b) => b - a);
    
    res.json({ weeks: allWeeks });
  } catch (err) {
    console.error('Get weeks error:', err);
    res.status(500).json({ error: '获取周列表失败' });
  }
});

// 获取指定周的BMI数据
app.get('/api/bmi/week/:week', (req, res) => {
  try {
    const week = parseInt(req.params.week);
    if (isNaN(week)) {
      return res.status(400).json({ error: '无效的周数' });
    }
    const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
    
    const bmiData = readBMIByWeek(week, semesterId);
    res.json({ week, data: bmiData });
  } catch (err) {
    console.error('Get BMI data error:', err);
    res.status(500).json({ error: '获取BMI数据失败' });
  }
});

// 获取所有周的BMI数据（用于折线图）
app.get('/api/bmi/all', (req, res) => {
  try {
    const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
    const scoresDir = getScoresDir(semesterId);
    if (!fs.existsSync(scoresDir)) {
      return res.json({ data: [] });
    }
    
    const files = fs.readdirSync(scoresDir);
    const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'));
    
    const allData = [];
    const fixedHeights = readFixedHeights();
    const startDate = getSemesterStartDate(semesterId);
    
    bmiFiles.forEach(file => {
      const week = parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''));
      const filePath = path.join(scoresDir, file);
      const buffer = fs.readFileSync(filePath);
      const decompressed = zlib.gunzipSync(buffer);
      const weekData = JSON.parse(decompressed.toString('utf8'));
      
      // 计算该周的时间范围（按学期起点）
      const weekStart = new Date(startDate);
      weekStart.setDate(weekStart.getDate() + (week - 1) * 7);
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(weekEnd.getDate() + 6);
      
      // 格式化为字符串
      const formatDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
      const dateRange = `${formatDate(weekStart)}-${formatDate(weekEnd)}`;
      
      // 将每周的数据转换为数组格式
      Object.entries(weekData).forEach(([memberId, bmi]) => {
        if (bmi && bmi.weight) {
          const height = fixedHeights[memberId] || bmi.height;
          if (height && bmi.weight) {
            const heightInCm = parseFloat(height);
            const weight = parseFloat(bmi.weight);
            if (heightInCm > 0 && weight > 0) {
              const bmiValue = weight / ((heightInCm / 100) * (heightInCm / 100));
              allData.push({
                week,
                weekStart: formatDate(weekStart),
                weekEnd: formatDate(weekEnd),
                dateRange,
                memberId,
                height: heightInCm,
                weight: weight,
                bmi: Math.round(bmiValue * 10) / 10
              });
            }
          }
        }
      });
    });
    
    // 按周和成员ID排序
    allData.sort((a, b) => {
      if (a.week !== b.week) return a.week - b.week;
      return a.memberId.localeCompare(b.memberId);
    });
    
    res.json({ data: allData });
  } catch (err) {
    console.error('Get all BMI data error:', err);
    res.status(500).json({ error: '获取所有BMI数据失败' });
  }
});

// 保存BMI数据（需要验证管理密码）
app.post('/api/bmi/save', (req, res) => {
  try {
    const { password, week, data, semesterId: sid } = req.body;

    // 验证BMI录入专用密码
    if (!password) {
      return res.status(400).json({ error: '密码不能为空' });
    }

    if (password !== '11111111') {
      return res.status(401).json({ error: '密码错误' });
    }

    // 验证周数
    const weekNum = parseInt(week);
    if (isNaN(weekNum)) {
      return res.status(400).json({ error: '无效的周数' });
    }

    // 验证数据格式
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: '数据格式错误' });
    }

    const semesterId = sid ? Number(sid) : undefined;

    // 读取现有数据并合并 - 只保存体重数据
    const existingData = readBMIByWeek(weekNum, semesterId);
    const mergedData = { ...existingData };

    for (const [memberId, memberData] of Object.entries(data)) {
      if (!mergedData[memberId]) {
        mergedData[memberId] = {};
      }
      // 只更新体重，不更新身高
      if (memberData.weight !== undefined) {
        mergedData[memberId].weight = memberData.weight;
      }
    }

    // 保存数据
    writeBMIByWeek(weekNum, mergedData, semesterId);

    // 统计本次实际写入的成员数
    const savedCount = Object.keys(data || {}).length;

    res.json({ success: true, message: 'BMI数据保存成功' });

    // 触发管理日报生成（BMI 单条/批量保存）
    dailyReport.generateReport(agentEngine, 'bmi', wechatBot, pushManager, {
      week: weekNum,
      count: savedCount
    }).catch(e =>
      console.error('[DailyReport] BMI数据触发报告生成失败:', e.message)
    );
  } catch (err) {
    console.error('Save BMI data error:', err);
    res.status(500).json({ error: '保存BMI数据失败' });
  }
});

// 保存BMI数据（后台管理模式，不需要密码验证）
app.post('/api/bmi/save-admin', (req, res) => {
  try {
    const { week, data, semesterId: sid } = req.body;

    // 验证周数
    const weekNum = parseInt(week);
    if (isNaN(weekNum)) {
      return res.status(400).json({ error: '无效的周数' });
    }

    // 验证数据格式
    if (!data || typeof data !== 'object') {
      return res.status(400).json({ error: '数据格式错误' });
    }

    const semesterId = sid ? Number(sid) : undefined;

    // 读取现有数据并合并 - 只保存体重数据
    const existingData = readBMIByWeek(weekNum, semesterId);
    const mergedData = { ...existingData };

    for (const [memberId, memberData] of Object.entries(data)) {
      if (!mergedData[memberId]) {
        mergedData[memberId] = {};
      }
      // 只更新体重，不更新身高
      if (memberData.weight !== undefined) {
        mergedData[memberId].weight = memberData.weight;
      }
    }

    // 保存数据
    writeBMIByWeek(weekNum, mergedData, semesterId);

    // 统计本次实际写入的成员数
    const savedCount = Object.keys(data || {}).length;

    res.json({ success: true, message: 'BMI数据保存成功' });

    // 触发管理日报生成（BMI 后台管理批量保存）
    dailyReport.generateReport(agentEngine, 'bmi', wechatBot, pushManager, {
      week: weekNum,
      count: savedCount
    }).catch(e =>
      console.error('[DailyReport] BMI后台保存触发报告生成失败:', e.message)
    );
  } catch (err) {
    console.error('Save BMI data admin error:', err);
    res.status(500).json({ error: '保存BMI数据失败' });
  }
});

// 下载BMI数据（导出为Excel）
app.get('/api/bmi/download', (req, res) => {
  try {
    const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
    const members = getMembers();
    const fixedHeights = readFixedHeights();
    const scoresDir = getScoresDir(semesterId);
    const allBMIWeeks = [];

    if (fs.existsSync(scoresDir)) {
      const files = fs.readdirSync(scoresDir);
      const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'))
        .sort((a, b) => {
          const weekA = parseInt(a.replace('bmi_week_', '').replace('.json.gz', ''));
          const weekB = parseInt(b.replace('bmi_week_', '').replace('.json.gz', ''));
          return weekA - weekB;
        });

      for (const file of bmiFiles) {
        const week = parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''));
        const weekData = readBMIByWeek(week, semesterId);
        allBMIWeeks.push({ week, data: weekData });
      }
    }
    
    // 准备导出数据
    const exportData = [];
    const weeks = allBMIWeeks.map(w => w.week);
    
    // 添加表头
    const header = ['姓名', '班级'];
    weeks.forEach(week => {
      header.push(`第${week}周-身高(cm)`);
      header.push(`第${week}周-体重(kg)`);
      header.push(`第${week}周-BMI`);
    });
    exportData.push(header);
    
    // 添加成员数据
    members.forEach(member => {
      const row = [member.name, member.class];
      const fixedHeight = fixedHeights[member.id];
      
      weeks.forEach(week => {
        const weekData = allBMIWeeks.find(w => w.week === week);
        const memberBMI = weekData?.data[member.id];
        
        // 使用固定身高
        if (fixedHeight) {
          row.push(fixedHeight);
        } else {
          row.push('');
        }
        
        if (memberBMI?.weight) {
          row.push(memberBMI.weight);
        } else {
          row.push('');
        }
        
        // 使用固定身高计算BMI
        if (fixedHeight && memberBMI?.weight) {
          const h = parseFloat(fixedHeight);
          const w = parseFloat(memberBMI.weight);
          if (!isNaN(h) && !isNaN(w) && h > 0 && w > 0) {
            const heightInMeters = h / 100;
            const bmi = (w / (heightInMeters * heightInMeters)).toFixed(1);
            row.push(bmi);
          } else {
            row.push('');
          }
        } else {
          row.push('');
        }
      });
      exportData.push(row);
    });
    
    // 创建Excel文件
    const worksheet = xlsx.utils.aoa_to_sheet(exportData);
    const workbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(workbook, worksheet, 'BMI数据');
    
    // 临时保存Excel文件
    const tempFilePath = path.join(TEMP_DIR, `bmi_data_${Date.now()}.xlsx`);
    xlsx.writeFile(workbook, tempFilePath);
    
    // 发送文件
    res.download(tempFilePath, `BMI数据-${beijingDateStr()}.xlsx`, (err) => {
      // 删除临时文件
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
      if (err) {
        console.error('Download error:', err);
      }
    });

  } catch (err) {
    console.error('Download BMI data error:', err);
    res.status(500).json({ error: '下载BMI数据失败' });
  }
});

// 获取BMI数据用于展示（不含身高体重）
app.get('/api/bmi/display', (req, res) => {
  try {
    const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
    const members = getMembers();
    const fixedHeights = readFixedHeights();
    const scoresDir = getScoresDir(semesterId);
    const allBMIWeeks = [];

    if (fs.existsSync(scoresDir)) {
      const files = fs.readdirSync(scoresDir);
      const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'))
        .sort((a, b) => {
          const weekA = parseInt(a.replace('bmi_week_', '').replace('.json.gz', ''));
          const weekB = parseInt(b.replace('bmi_week_', '').replace('.json.gz', ''));
          return weekA - weekB;
        });

      for (const file of bmiFiles) {
        const week = parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''));
        const weekData = readBMIByWeek(week, semesterId);
        allBMIWeeks.push({ week, data: weekData });
      }
    }

    // 准备返回数据
    const result = {
      weeks: allBMIWeeks.map(w => {
        // 计算周次的时间区间（按学期起点，config.startDate 为旧全局起点，不再使用）
        const startDate = getSemesterStartDate(semesterId);
        const weekStart = new Date(startDate.getTime() + (w.week - 1) * 7 * 24 * 60 * 60 * 1000);
        const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000 - 1);

        return {
          week: w.week,
          startDate: weekStart.toISOString().split('T')[0],
          endDate: weekEnd.toISOString().split('T')[0]
        };
      }),
      members: members.map(member => {
        const fixedHeight = fixedHeights[member.id];
        const memberBMI = {};

        allBMIWeeks.forEach(w => {
          const memberData = w.data[member.id];
          if (fixedHeight && memberData?.weight) {
            const h = parseFloat(fixedHeight);
            const wgt = parseFloat(memberData.weight);
            if (!isNaN(h) && !isNaN(wgt) && h > 0 && wgt > 0) {
              const heightInMeters = h / 100;
              const bmi = (wgt / (heightInMeters * heightInMeters)).toFixed(1);
              memberBMI[w.week] = parseFloat(bmi);
            }
          }
        });

        return {
          id: member.id,
          name: member.name,
          class: member.class,
          gender: member.class === '陈潇霖班' ? 'female' : (member.gender || 'male'), // 陈潇霖班为女，其他默认为male
          bmi: memberBMI
        };
      })
    };

    res.json(result);

  } catch (err) {
    console.error('Get BMI display data error:', err);
    res.status(500).json({ error: '获取BMI数据失败' });
  }
});

// 上传BMI数据（Excel表格）
app.post('/api/upload/bmi-scores', uploadScores.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: '请选择文件' });
    }
    
    const week = req.body.week;
    if (!week) {
      return res.status(400).json({ error: '请选择周次' });
    }

    const semesterId = req.body.semesterId ? Number(req.body.semesterId) : undefined;

    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = xlsx.utils.sheet_to_json(worksheet, { raw: false, defval: null });

    const members = getMembers();
    const existingBMI = readBMIByWeek(week, semesterId);
    const mergedData = { ...existingBMI };
    
    let importedCount = 0;
    let notFoundNames = [];
    
    // 名字匹配函数，处理空格问题
    const findMember = (name) => {
      if (!name) return null;
      
      const trimmedName = String(name).trim();
      
      // 1. 精确匹配（去空格后）
      let member = members.find(m => m.name.trim() === trimmedName);
      if (member) return member;
      
      // 2. 包含匹配（去掉所有空格）
      const nameNoSpaces = trimmedName.replace(/\s+/g, '');
      member = members.find(m => m.name.replace(/\s+/g, '') === nameNoSpaces);
      if (member) return member;
      
      return null;
    };
    
    data.forEach(row => {
      const name = row['姓名'];
      if (!name) return;
      
      const member = findMember(name);
      if (!member) {
        notFoundNames.push(name);
        return;
      }
      
      const weight = row['体重'] || row['体重(kg)'] || row['体重kg'];
      
      if (weight !== undefined) {
        if (!mergedData[member.id]) {
          mergedData[member.id] = {};
        }
        // 只更新体重
        mergedData[member.id].weight = weight !== null && weight !== undefined ? String(weight).trim() : null;
        importedCount++;
      }
    });
    
    writeBMIByWeek(week, mergedData, semesterId);

    fs.unlinkSync(req.file.path);

    res.json({
      success: true,
      message: `BMI数据导入成功，共导入${importedCount}条数据`,
      count: importedCount,
      week: week,
      semesterId: semesterId,
      notFoundNames: notFoundNames.length > 0 ? notFoundNames : undefined
    });

    // 触发管理日报生成（BMI批量导入）
    dailyReport.generateReport(agentEngine, 'bmi', wechatBot, pushManager, {
      week: week,
      count: importedCount,
      notFoundNames: notFoundNames.length > 0 ? notFoundNames : undefined
    }).catch(e =>
      console.error('[DailyReport] BMI导入触发报告生成失败:', e.message)
    );
  } catch (err) {
    console.error('Import BMI error:', err);
    if (req.file && req.file.path) {
      try { fs.unlinkSync(req.file.path); } catch {}
    }
    res.status(500).json({ error: '导入失败：' + err.message });
  }
});

// ========== BMI数据录入功能结束 ==========

// ========== 周总结功能开始 ==========

// 获取可用的周次列表
app.get('/api/summary/available-weeks', (req, res) => {
  try {
    const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
    const scoresDir = getScoresDir(semesterId);
    if (!fs.existsSync(scoresDir)) {
      return res.json({ weeks: [] });
    }
    const files = fs.readdirSync(scoresDir);
    const scoreFiles = files.filter(file => file.startsWith('scores_week_') && file.endsWith('.json.gz'));
    const weeks = scoreFiles
      .map(file => parseInt(file.replace('scores_week_', '').replace('.json.gz', '')))
      .sort((a, b) => b - a); // 降序排列
    res.json({ weeks });
  } catch (err) {
    console.error('Error getting available weeks:', err);
    res.status(500).json({ error: '获取周次列表失败' });
  }
});

// 计算周数的日期范围
const getWeekDateRange = (week, semesterId) => {
  const semester = getSemesters().find(s => String(s.id) === String(semesterId || getCurrentSemesterId())) || getCurrentSemester();
  const startDate = new Date(semester.startDate || '2026-03-02T00:00:00+08:00');
  const weekStart = new Date(startDate);
  weekStart.setDate(startDate.getDate() + (week - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  
  const formatDate = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };
  
  return {
    startDate: formatDate(weekStart),
    endDate: formatDate(weekEnd)
  };
};

// 获取熵权权重的函数
const getEntropyWeights = (semesterId) => {
  const allScores = readAllScores(semesterId);
  
  if (allScores.length === 0) {
    // 如果没有数据，使用默认权重
    return {
      study: 2.0,
      fitness: 2.0,
      literacy: 1.5,
      discipline: 2.0,
      contribution: 1.5,
      management: 1.0
    };
  }
  
  const dimensions = ['study', 'fitness', 'literacy', 'discipline', 'contribution', 'management'];
  
  // 按周次和成员分组，获取每个成员每周的平均分
  const memberWeekScores = {};
  allScores.forEach(score => {
    const key = `${score.memberId}-${score.week}`;
    if (!memberWeekScores[key]) {
      memberWeekScores[key] = {
        memberId: score.memberId,
        week: score.week,
        scores: {}
      };
    }
    dimensions.forEach(dim => {
      if (!memberWeekScores[key].scores[dim]) {
        memberWeekScores[key].scores[dim] = [];
      }
      if (score.scores[dim] !== undefined && score.scores[dim] !== null) {
        memberWeekScores[key].scores[dim].push(score.scores[dim]);
      }
    });
  });
  
  // 计算每个成员每周的平均得分
  const dataMatrix = [];
  Object.values(memberWeekScores).forEach(item => {
    const row = {};
    let hasValidScore = false;
    dimensions.forEach(dim => {
      const scores = item.scores[dim];
      if (scores.length > 0) {
        row[dim] = scores.reduce((a, b) => a + b, 0) / scores.length;
        hasValidScore = true;
      } else {
        row[dim] = 0;
      }
    });
    if (hasValidScore) {
      dataMatrix.push(row);
    }
  });
  
  if (dataMatrix.length < 2) {
    // 如果数据太少，使用默认权重
    return {
      study: 2.0,
      fitness: 2.0,
      literacy: 1.5,
      discipline: 2.0,
      contribution: 1.5,
      management: 1.0
    };
  }
  
  // 熵权法计算
  // 1. 数据标准化（正向指标，越高越好）
  const normalizedMatrix = [];
  const maxValues = {};
  const minValues = {};
  
  dimensions.forEach(dim => {
    maxValues[dim] = Math.max(...dataMatrix.map(row => row[dim]));
    minValues[dim] = Math.min(...dataMatrix.map(row => row[dim]));
  });
  
  dataMatrix.forEach(row => {
    const normalizedRow = {};
    dimensions.forEach(dim => {
      const range = maxValues[dim] - minValues[dim];
      if (range === 0) {
        normalizedRow[dim] = 1; // 所有值相同，标准化为1
      } else {
        normalizedRow[dim] = (row[dim] - minValues[dim]) / range;
      }
    });
    normalizedMatrix.push(normalizedRow);
  });
  
  // 2. 计算比重
  const sumByDim = {};
  dimensions.forEach(dim => {
    sumByDim[dim] = normalizedMatrix.reduce((sum, row) => sum + row[dim], 0);
  });
  
  const proportionMatrix = normalizedMatrix.map(row => {
    const propRow = {};
    dimensions.forEach(dim => {
      propRow[dim] = sumByDim[dim] === 0 ? 1 / normalizedMatrix.length : row[dim] / sumByDim[dim];
    });
    return propRow;
  });
  
  // 3. 计算熵值
  const entropy = {};
  const k = 1 / Math.log(normalizedMatrix.length);
  
  dimensions.forEach(dim => {
    let sum = 0;
    proportionMatrix.forEach(row => {
      const p = row[dim];
      if (p > 0) {
        sum += p * Math.log(p);
      }
    });
    entropy[dim] = -k * sum;
  });
  
  // 4. 计算差异系数
  const diversity = {};
  dimensions.forEach(dim => {
    diversity[dim] = 1 - entropy[dim];
  });
  
  // 5. 计算权重
  const totalDiversity = Object.values(diversity).reduce((sum, d) => sum + d, 0);
  const weights = {};
  dimensions.forEach(dim => {
    weights[dim] = totalDiversity === 0 ? 1 / dimensions.length : diversity[dim] / totalDiversity;
  });
  
  // 归一化权重，使总和为10（便于计算百分制）
  const weightSum = Object.values(weights).reduce((sum, w) => sum + w, 0);
  const normalizedWeights = {};
  dimensions.forEach(dim => {
    normalizedWeights[dim] = (weights[dim] / weightSum) * 10;
  });
  
  return normalizedWeights;
};

// 使用熵权法计算百分制分数的函数
const calculateEntropyScore = (dimScores, entropyWeights) => {
  const dimensions = ['study', 'fitness', 'literacy', 'discipline', 'contribution', 'management'];
  let totalScore = 0;
  let totalWeight = 0;
  
  dimensions.forEach(dim => {
    const score = dimScores[dim];
    if (score !== undefined && score !== null) {
      totalScore += score * entropyWeights[dim];
      totalWeight += entropyWeights[dim];
    }
  });
  
  return totalWeight > 0 ? Math.round((totalScore / totalWeight) * 10) : 0;
};

// 周总结API
app.get('/api/summary/:week', (req, res) => {
  try {
    const week = parseInt(req.params.week);
    const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
    if (!week || week < 1) {
      return res.status(400).json({ error: '请输入有效的周次' });
    }

    const members = getMembers();
    const classes = [...new Set(members.map(m => m.class))];
    const weekScores = readScoresByWeek(week, semesterId);
    const dateRange = getWeekDateRange(week, semesterId);
    const entropyWeights = getEntropyWeights(semesterId);
    
    // ===== 评分统计 =====
    const memberDimensionAvgScores = {}; // 每个成员各维度的平均分
    const memberEntropyScores = {}; // 每个成员的熵权法百分制分数
    const evaluatorSet = new Set();
    const evaluatedSet = new Set();
    
    // 记录每个评分者评分了哪些人
    const evaluatorEvaluated = {};
    
    weekScores.forEach(score => {
      evaluatorSet.add(score.evaluatorId);
      evaluatedSet.add(score.memberId);
      
      // 记录评分者的评分情况
      if (!evaluatorEvaluated[score.evaluatorId]) {
        evaluatorEvaluated[score.evaluatorId] = new Set();
      }
      evaluatorEvaluated[score.evaluatorId].add(score.memberId);
      
      if (!memberDimensionAvgScores[score.memberId]) {
        memberDimensionAvgScores[score.memberId] = {};
      }
      
      Object.keys(score.scores || {}).forEach(dimKey => {
        const dimScore = score.scores[dimKey];
        if (!memberDimensionAvgScores[score.memberId][dimKey]) {
          memberDimensionAvgScores[score.memberId][dimKey] = [];
        }
        const dimValue = typeof dimScore === 'number' ? dimScore : (dimScore?.total || 0);
        memberDimensionAvgScores[score.memberId][dimKey].push(dimValue);
      });
    });
    
    // ===== 未完成评分的人统计 =====
    // 按班级分组成员
    const membersByClass = {};
    members.forEach(member => {
      if (!membersByClass[member.class]) {
        membersByClass[member.class] = [];
      }
      membersByClass[member.class].push(member);
    });
    
    const incompleteEvaluators = [];
    
    // 检查所有成员，包括完全没有评分的人
    members.forEach(member => {
      const evaluatorId = member.id;
      const evaluator = member;
      const classMembers = membersByClass[evaluator.class] || [];
      const classMemberIds = new Set(classMembers.map(m => m.id));
      const totalClassMembers = classMembers.length;
      
      const evaluated = evaluatorEvaluated[evaluatorId] || new Set();
      // 只统计给同班成员的评分
      let ratedClassMembers = 0;
      evaluated.forEach(memberId => {
        if (classMemberIds.has(memberId)) {
          ratedClassMembers++;
        }
      });
      
      if (ratedClassMembers < totalClassMembers) {
        incompleteEvaluators.push({
          evaluatorName: evaluator.name,
          className: evaluator.class,
          evaluatorId: evaluatorId,
          ratedCount: ratedClassMembers,
          totalCount: totalClassMembers,
          unratedCount: totalClassMembers - ratedClassMembers
        });
      }
    });
    
    // 计算每个成员各维度的平均分和熵权法百分制分数
    const allEntropyScores = [];
    const dimensionAverages = {};
    const dimensions = ['study', 'fitness', 'literacy', 'discipline', 'contribution', 'management'];
    
    dimensions.forEach(dim => {
      dimensionAverages[dim] = [];
    });
    
    Object.keys(memberDimensionAvgScores).forEach(memberId => {
      const dimScores = {};
      let hasValidScore = false;
      
      dimensions.forEach(dim => {
        const scores = memberDimensionAvgScores[memberId][dim];
        if (scores && scores.length > 0) {
          const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
          dimScores[dim] = avgScore;
          dimensionAverages[dim].push(avgScore);
          hasValidScore = true;
        }
      });
      
      if (hasValidScore) {
        const entropyScore = calculateEntropyScore(dimScores, entropyWeights);
        memberEntropyScores[memberId] = entropyScore;
        allEntropyScores.push(entropyScore);
      }
    });
    
    // 计算各维度的总体平均分
    const finalDimensionAverages = {};
    dimensions.forEach(dim => {
      const scores = dimensionAverages[dim].filter(v => v > 0);
      finalDimensionAverages[dim] = scores.length > 0 
        ? scores.reduce((a, b) => a + b, 0) / scores.length 
        : 0;
    });
    
    // 计算总体平均分（熵权法百分制的平均）
    const overallAverage = allEntropyScores.length > 0 
      ? allEntropyScores.reduce((a, b) => a + b, 0) / allEntropyScores.length 
      : 0;
    
    const dimensionLabels = {
      'study': '学习成绩',
      'fitness': '体能素质',
      'literacy': '人文素养',
      'discipline': '遵章守纪',
      'contribution': '班级贡献',
      'management': '管理能力'
    };
    
    const scoreStats = {
      totalScores: weekScores.length,
      overallAverage: overallAverage,
      scoredMembers: evaluatedSet.size,
      totalMembers: members.length,
      incompleteCount: incompleteEvaluators.length,
      incompleteList: incompleteEvaluators,
      dimensionAverages: finalDimensionAverages
    };
    
    // ===== 通报统计 =====
    const notices = readJSON(NOTICES_FILE).filter(n => {
      const noticeDate = new Date(n.time);
      const weekStart = new Date(dateRange.startDate);
      const weekEnd = new Date(dateRange.endDate);
      weekEnd.setHours(23, 59, 59, 999);
      return noticeDate >= weekStart && noticeDate <= weekEnd;
    });
    
    const noticeList = notices.map(n => {
      const member = members.find(m => m.id === n.memberId);
      return {
        memberName: member ? member.name : '未知',
        className: member ? member.class : '未知',
        content: n.content
      };
    });
    
    const noticeStats = {
      totalNotices: notices.length,
      involvedMembers: new Set(notices.map(n => n.memberId)).size,
      noticeList: noticeList
    };
    
    // ===== BMI统计 =====
    const bmiFilePath = getBMIFilePath(week, semesterId);
    let bmiData = [];
    try {
      if (fs.existsSync(bmiFilePath)) {
        const buffer = fs.readFileSync(bmiFilePath);
        const decompressed = zlib.gunzipSync(buffer);
        const parsed = JSON.parse(decompressed.toString('utf8'));
        // 处理不同的BMI数据格式
        if (Array.isArray(parsed)) {
          bmiData = parsed;
        } else if (parsed && parsed.data && Array.isArray(parsed.data)) {
          bmiData = parsed.data;
        } else if (parsed && typeof parsed === 'object') {
          // 格式是 { "101": { "weight": "83" }, ... }
          bmiData = Object.entries(parsed).map(([memberId, data]) => ({
            memberId: memberId,
            weight: parseFloat(data.weight) || 0
          }));
        }
      }
    } catch (e) {
      console.error('Error reading BMI data:', e);
    }
    
    const fixedHeights = readJSON(FIXED_HEIGHTS_FILE);
    const memberBMIs = {};
    bmiData.forEach(item => {
      if (!memberBMIs[item.memberId]) {
        memberBMIs[item.memberId] = [];
      }
      const height = fixedHeights[item.memberId];
      if (height && item.weight) {
        const bmi = parseFloat((item.weight / Math.pow(height / 100, 2)).toFixed(1));
        memberBMIs[item.memberId].push(bmi);
      }
    });
    
    const memberAvgBMI = {};
    Object.keys(memberBMIs).forEach(memberId => {
      const bmis = memberBMIs[memberId];
      if (bmis.length > 0) {
        memberAvgBMI[memberId] = bmis.reduce((a, b) => a + b, 0) / bmis.length;
      }
    });
    
    const allBMIs = Object.values(memberAvgBMI).filter(v => v > 0);
    const overallAvgBMI = allBMIs.length > 0 
      ? allBMIs.reduce((a, b) => a + b, 0) / allBMIs.length 
      : 0;
    
    const failList = [];
    let passCount = 0;
    let totalCount = 0;
    
    Object.keys(memberAvgBMI).forEach(memberId => {
      const member = members.find(m => m.id === memberId);
      if (member) {
        const bmi = memberAvgBMI[memberId];
        totalCount++;
        const isFemale = member.class === '陈潇霖班';
        const isPass = bmi >= 18.5 && bmi <= (isFemale ? 23.9 : 25.9);
        if (isPass) {
          passCount++;
        } else {
          failList.push({
            memberName: member.name,
            className: member.class,
            bmi: bmi
          });
        }
      }
    });
    
    const bmiStats = {
      totalMembers: totalCount,
      overallAverage: overallAvgBMI,
      passCount: passCount,
      failCount: failList.length,
      failList: failList
    };
    
    // ===== 伤病统计 ===== (只在当前周次显示)
    const config = getConfig();
    const currentWeek = config.currentWeek || getCurrentWeek();
    let injuryStats = null;
    
    if (week === currentWeek) {
      const injuryStatus = readJSON(INJURY_STATUS_FILE);
      const injuryList = [];
      
      Object.entries(injuryStatus).forEach(([memberId, status]) => {
        if (status && status.isInjured) {
          const member = members.find(m => m.id === memberId);
          if (member) {
            injuryList.push({
              memberName: member.name,
              className: member.class
            });
          }
        }
      });
      
      injuryStats = {
        injuryCount: injuryList.length,
        injuryList: injuryList
      };
    }
    
    // ===== 亮点与不足统计 =====
    // 1. 综合分最高的5名个人（使用熵权法分数）
    const topScorers = Object.entries(memberEntropyScores)
      .map(([memberId, score]) => {
        const member = members.find(m => m.id === memberId);
        return {
          memberId: memberId,
          memberName: member ? member.name : '未知',
          className: member ? member.class : '未知',
          score: score
        };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    
    // 2. 进步最大的5名个人（对比前一周，使用熵权法分数）
    const mostImproved = [];
    if (week > 1) {
      // 计算前一周的熵权法分数
      const prevWeekScores = readScoresByWeek(week - 1);
      const prevMemberDimensionAvgScores = {};
      
      prevWeekScores.forEach(score => {
        if (!prevMemberDimensionAvgScores[score.memberId]) {
          prevMemberDimensionAvgScores[score.memberId] = {};
        }
        
        Object.keys(score.scores || {}).forEach(dimKey => {
          const dimScore = score.scores[dimKey];
          if (!prevMemberDimensionAvgScores[score.memberId][dimKey]) {
            prevMemberDimensionAvgScores[score.memberId][dimKey] = [];
          }
          const dimValue = typeof dimScore === 'number' ? dimScore : (dimScore?.total || 0);
          prevMemberDimensionAvgScores[score.memberId][dimKey].push(dimValue);
        });
      });
      
      // 计算前一周每个成员的熵权法分数
      const prevMemberEntropyScores = {};
      Object.keys(prevMemberDimensionAvgScores).forEach(memberId => {
        const dimScores = {};
        let hasValidScore = false;
        
        dimensions.forEach(dim => {
          const scores = prevMemberDimensionAvgScores[memberId][dim];
          if (scores && scores.length > 0) {
            const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
            dimScores[dim] = avgScore;
            hasValidScore = true;
          }
        });
        
        if (hasValidScore) {
          const entropyScore = calculateEntropyScore(dimScores, entropyWeights);
          prevMemberEntropyScores[memberId] = entropyScore;
        }
      });
      
      // 计算进步
      const improvements = [];
      Object.keys(memberEntropyScores).forEach(memberId => {
        const currentScore = memberEntropyScores[memberId];
        const prevScore = prevMemberEntropyScores[memberId];
        if (currentScore > 0 && prevScore && prevScore > 0) {
          const improvement = currentScore - prevScore;
          const member = members.find(m => m.id === memberId);
          improvements.push({
            memberId: memberId,
            memberName: member ? member.name : '未知',
            className: member ? member.class : '未知',
            improvement: improvement,
            currentScore: currentScore,
            prevScore: prevScore
          });
        }
      });
      
      // 按进步幅度排序
      improvements.sort((a, b) => b.improvement - a.improvement);
      mostImproved.push(...improvements.slice(0, 5));
    }
    
    // 3. 需要重点关注的5名个人（综合分最低，使用熵权法分数）
    const needAttention = Object.entries(memberEntropyScores)
      .map(([memberId, score]) => {
        const member = members.find(m => m.id === memberId);
        return {
          memberId: memberId,
          memberName: member ? member.name : '未知',
          className: member ? member.class : '未知',
          score: score
        };
      })
      .filter(item => item.score > 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, 5);
    
    const highlights = {
      topScorers: topScorers,
      mostImproved: mostImproved
    };
    
    const weaknesses = {
      needAttention: needAttention
    };
    
    // ===== 构建总结数据 =====
    const summary = {
      dateRange: {
        start: dateRange.startDate,
        end: dateRange.endDate
      },
      scoreStats: scoreStats,
      noticeStats: noticeStats,
      bmiStats: bmiStats,
      highlights: highlights,
      weaknesses: weaknesses
    };
    
    // 只在当前周次添加伤病统计
    if (injuryStats) {
      summary.injuryStats = injuryStats;
    }
    
    res.json(summary);
  } catch (err) {
    console.error('Error generating summary:', err);
    res.status(500).json({ error: '生成周总结失败' });
  }
});

// ========== 周总结功能结束 ==========

// ========== 补评功能开始 ==========

// 获取所有补评周期
app.get('/api/makeup-periods', (req, res) => {
  try {
    const periods = readMakeupPeriods();
    // 过滤出还在有效期内的补评
    const now = beijingNow();
    const activePeriods = periods.filter(p => new Date(p.endTime) > now);
    const allPeriods = periods.map(p => ({
      ...p,
      isActive: new Date(p.endTime) > now
    }));
    res.json({ periods: allPeriods, activePeriods });
  } catch (err) {
    console.error('Get makeup periods error:', err);
    res.status(500).json({ error: '获取补评周期失败' });
  }
});

// 添加补评周期
app.post('/api/makeup-periods', (req, res) => {
  try {
    const { week, endTime, description } = req.body;
    
    // 验证周数
    const weekNum = parseInt(week);
    if (isNaN(weekNum) || weekNum < 1) {
      return res.status(400).json({ error: '请输入有效的周数' });
    }
    
    // 验证结束时间
    if (!endTime) {
      return res.status(400).json({ error: '结束时间不能为空' });
    }
    
    const periods = readMakeupPeriods();
    
    // 检查是否已存在相同周数的补评
    const existingIndex = periods.findIndex(p => p.week === weekNum);
    if (existingIndex >= 0) {
      periods[existingIndex] = {
        ...periods[existingIndex],
        endTime,
        description: description || '',
        createdAt: beijingISO()
      };
    } else {
      periods.push({
        id: uuidv4(),
        week: weekNum,
        endTime,
        description: description || '',
        createdAt: beijingISO()
      });
    }
    
    writeMakeupPeriods(periods);
    res.json({ success: true, message: '补评周期添加成功', periods });
  } catch (err) {
    console.error('Add makeup period error:', err);
    res.status(500).json({ error: '添加补评周期失败' });
  }
});

// 删除补评周期
app.delete('/api/makeup-periods/:id', (req, res) => {
  try {
    const { id } = req.params;
    
    const periods = readMakeupPeriods();
    const filteredPeriods = periods.filter(p => p.id !== id);
    
    if (filteredPeriods.length === periods.length) {
      return res.status(404).json({ error: '补评周期未找到' });
    }
    
    writeMakeupPeriods(filteredPeriods);
    res.json({ success: true, message: '补评周期删除成功', periods: filteredPeriods });
  } catch (err) {
    console.error('Delete makeup period error:', err);
    res.status(500).json({ error: '删除补评周期失败' });
  }
});

// 获取当前可用的评分周次（包括当前周和开放补评的周）
app.get('/api/available-scoring-weeks', (req, res) => {
  try {
    const config = getConfig();
    const semesterId = req.query.semesterId ? Number(req.query.semesterId) : undefined;
    const currentWeek = config.currentWeek || getCurrentWeek();
    const makeupPeriods = readMakeupPeriods();
    const now = beijingNow();
    
    // 过滤出还在有效期内的补评周次
    const activeMakeupWeeks = makeupPeriods
      .filter(p => new Date(p.endTime) > now)
      .map(p => ({
        week: p.week,
        isMakeup: true,
        endTime: p.endTime,
        description: p.description
      }));
    
    // 合并当前周和补评周次
    const availableWeeks = [
      { week: currentWeek, isMakeup: false, description: '当前周' },
      ...activeMakeupWeeks
    ].sort((a, b) => b.week - a.week);
    
    res.json({ 
      currentWeek,
      semesterId: semesterId || getCurrentSemesterId(),
      availableWeeks,
      activeMakeupWeeks
    });
  } catch (err) {
    console.error('Get available scoring weeks error:', err);
    res.status(500).json({ error: '获取可用评分周次失败' });
  }
});

// ========== 补评功能结束 ==========

// ========== 每日打卡反馈 API ==========
app.use('/api/checkin', dailyCheckinRoutes);

// Catch-all route for SPA
if (fs.existsSync(frontendDistPath)) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(frontendDistPath, 'index.html'));
  });
}

// Socket.io connection
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);

  // ==================== AI Agent Socket Events ====================
  if (agentEngine) {
    socket.on('agent:chat', async (data) => {
      try {
        const { memberId, message, sessionId, context } = data;
        if (!message) return socket.emit('agent:error', { error: '缺少必要参数' });

        const effectiveMemberId = memberId || 'admin';
        const effectiveContext = { isAdmin: context?.isAdmin === true };
        console.log(`[Socket] agent:chat memberId=${memberId}, context.isAdmin=${context?.isAdmin}, effectiveContext.isAdmin=${effectiveContext.isAdmin}`);

        const response = await agentEngine.processMessageStream(effectiveMemberId, message, sessionId, effectiveContext, socket);
      } catch (err) {
        console.error('Agent chat error:', err);
        socket.emit('agent:error', { error: err.message || 'Agent 处理失败' });
      }
    });

    socket.on('agent:admin:verify', (data) => {
      try {
        const { password } = data;
        const result = agentEngine.verifyAdmin(password);
        socket.emit('admin:verified', result);
      } catch (err) {
        socket.emit('admin:verified', { success: false, message: err.message });
      }
    });

    socket.on('agent:admin:logout', (data) => {
      const { memberId } = data;
      agentEngine.endAdminSession(memberId);
    });

    socket.on('agent:memory:get', async (data) => {
      try {
        const { memberId } = data;
        const memoryState = await agentEngine.getFullMemoryState(memberId);
        socket.emit('memory:state', memoryState);
      } catch (err) {
        socket.emit('memory:error', { error: err.message });
      }
    });

    socket.on('agent:preferences:update', async (data) => {
      try {
        const { memberId, preferences } = data;
        await agentEngine.updateUserPreferences(memberId, preferences);
        socket.emit('preferences:updated', { success: true });
      } catch (err) {
        socket.emit('preferences:error', { error: err.message });
      }
    });

    socket.on('agent:tools:list', () => {
      const tools = agentEngine.getAvailableTools(false);
      socket.emit('tools:list', tools);
    });

    socket.on('agent:stats', async (data) => {
      try {
        const stats = await agentEngine.getStats(data?.memberId);
        socket.emit('agent:stats:data', stats);
      } catch (err) {
        socket.emit('agent:error', { error: err.message });
      }
    });

    socket.on('agent:form:submit', async (data) => {
      try {
        const { tool, params, memberId, isAdmin, sessionId } = data;

        const result = await agentEngine.toolRegistry.execute(tool, params || {}, {
          memberId,
          isAdmin: !!isAdmin
        });

        if (result.success) {
          socket.emit('agent:form:result', {
            success: true,
            message: tool === 'mood_record'
              ? '💭 心情记录提交成功！感谢你的分享。'
              : tool === 'submit_score'
                ? '📝 评分提交成功！数据已更新。'
                : '✅ 操作成功！',
            data: result.data
          });

          if (sessionId) {
            const content = tool === 'mood_record'
              ? '用户提交了心情记录'
              : tool === 'submit_score'
                ? '用户提交了评分数据'
                : '用户完成了一个操作';
            await agentEngine.memoryManager.addAssistantMessage(sessionId, content, {
              toolsUsed: [tool]
            });
          }
        } else {
          socket.emit('agent:form:result', {
            success: false,
            error: result.error || '提交失败，请重试'
          });
        }
      } catch (err) {
        console.error('Agent form submit error:', err);
        socket.emit('agent:form:result', {
          success: false,
          error: err.message || '提交失败'
        });
      }
    });
  }

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
  });
});

// ==================== Experiences API ====================

// Get all experiences for a member
app.get('/api/experiences/:memberId', (req, res) => {
  const { memberId } = req.params;
  const experiences = readJSON(EXPERIENCES_FILE).filter(e => e.memberId === memberId);
  res.json(experiences);
});

// Add a new experience
app.post('/api/experiences', (req, res) => {
  const { memberId, uploaderId, type, data } = req.body;
  
  if (!memberId || !uploaderId || !type || !data) {
    return res.status(400).json({ error: '缺少必填字段' });
  }
  
  const experiences = readJSON(EXPERIENCES_FILE);
  const newExperience = {
    id: uuidv4(),
    memberId,
    uploaderId,
    type,
    data,
    createdAt: beijingISO()
  };
  
  experiences.push(newExperience);
  writeJSON(EXPERIENCES_FILE, experiences);
  res.json(newExperience);
});

// Delete an experience (only uploader or superadmin can delete)
app.delete('/api/experiences/:id', (req, res) => {
  const { id } = req.params;
  const { uploaderId } = req.body;
  
  const experiences = readJSON(EXPERIENCES_FILE);
  const experienceIndex = experiences.findIndex(e => e.id === id);
  
  if (experienceIndex === -1) {
    return res.status(404).json({ error: '经历未找到' });
  }
  
  const experience = experiences[experienceIndex];
  
  // Check if user is uploader or superadmin
  if (experience.uploaderId !== uploaderId && uploaderId !== 'superadmin') {
    return res.status(403).json({ error: '无权删除此经历' });
  }
  
  experiences.splice(experienceIndex, 1);
  writeJSON(EXPERIENCES_FILE, experiences);
  res.json({ success: true });
});

// 通报相关API
// 获取所有通报
app.get('/api/notices', (req, res) => {
  const notices = readJSON(NOTICES_FILE);
  res.json(notices);
});

// 获取特定成员的通报
app.get('/api/notices/member/:memberId', (req, res) => {
  const { memberId } = req.params;
  const notices = readJSON(NOTICES_FILE);
  const memberNotices = notices.filter(n => n.memberId === memberId);
  res.json(memberNotices);
});

// 添加通报
app.post('/api/notices', (req, res) => {
  const { memberId, content, time, adminId } = req.body;
  
  if (!memberId || !content) {
    return res.status(400).json({ error: '成员ID和通报内容不能为空' });
  }
  
  const notices = readJSON(NOTICES_FILE);
  
  const newNotice = {
    id: uuidv4(),
    memberId,
    content,
    time: time || beijingDateStr(),
    adminId: adminId || 'admin',
    createdAt: beijingISO()
  };
  
  notices.push(newNotice);
  writeJSON(NOTICES_FILE, notices);
  res.json(newNotice);

  // 触发管理日报生成
  dailyReport.generateReport(agentEngine, 'notice', wechatBot, pushManager, {
    noticeId: newNotice.id,
    memberId: memberId,
    content: content,
    time: newNotice.time
  }).catch(e =>
    console.error('[DailyReport] 通报触发报告生成失败:', e.message)
  );
});

// 删除通报（只有管理员可以删除）
app.delete('/api/notices/:id', (req, res) => {
  const { id } = req.params;
  
  const notices = readJSON(NOTICES_FILE);
  const noticeIndex = notices.findIndex(n => n.id === id);
  
  if (noticeIndex === -1) {
    return res.status(404).json({ error: '通报未找到' });
  }
  
  notices.splice(noticeIndex, 1);
  writeJSON(NOTICES_FILE, notices);
  res.json({ success: true });
});

// 公差相关API
// 获取所有公差记录
app.get('/api/duties', (req, res) => {
  const duties = readJSON(DUTIES_FILE);
  res.json(duties);
});

// 获取特定成员的公差记录
app.get('/api/duties/member/:memberId', (req, res) => {
  const { memberId } = req.params;
  const duties = readJSON(DUTIES_FILE);
  const memberDuties = duties.filter(d => d.memberIds.includes(memberId));
  res.json(memberDuties);
});

// 获取所有成员的公差统计（次数和总分）—— 已改为按 count 字段聚合
app.get('/api/duties/stats', (req, res) => {
  const duties = readJSON(DUTIES_FILE);
  const stats = {};
  
  duties.forEach(duty => {
    const cnt = duty.count || 1;
    const sc = (duty.score !== null && duty.score !== undefined) ? (parseFloat(duty.score) || 0) : 0;
    duty.memberIds.forEach(memberId => {
      if (!stats[memberId]) {
        stats[memberId] = { count: 0, totalScore: 0 };
      }
      stats[memberId].count += cnt;
      stats[memberId].totalScore += sc;
    });
  });
  
  res.json(stats);
});

// 添加公差记录
app.post('/api/duties', (req, res) => {
  const { memberIds, content, time, score, class: className, monitorId } = req.body;
  
  if (!memberIds || !Array.isArray(memberIds) || memberIds.length === 0 || !content || !time || !className) {
    return res.status(400).json({ error: '请完整填写公差信息' });
  }
  
  const duties = readJSON(DUTIES_FILE);
  
  const newDuty = {
    id: uuidv4(),
    memberIds,
    content,
    time,
    score: score || null,
    class: className,
    monitorId: monitorId || 'monitor',
    createdAt: beijingISO()
  };
  
  duties.push(newDuty);
  writeJSON(DUTIES_FILE, duties);
  
  // Notify all clients about the new duty
  io.emit('dutyAdded', newDuty);
  
  res.json(newDuty);
});

// 删除公差记录（只有班长或管理员可以删除）
app.delete('/api/duties/:id', (req, res) => {
  const { id } = req.params;
  const { monitorId } = req.body;
  
  const duties = readJSON(DUTIES_FILE);
  const dutyIndex = duties.findIndex(d => d.id === id);
  
  if (dutyIndex === -1) {
    return res.status(404).json({ error: '公差记录未找到' });
  }
  
  const duty = duties[dutyIndex];
  
  // Check if user is monitor or admin
  if (duty.monitorId !== monitorId && monitorId !== 'admin' && monitorId !== 'superadmin') {
    return res.status(403).json({ error: '无权删除此公差记录' });
  }
  
  duties.splice(dutyIndex, 1);
  writeJSON(DUTIES_FILE, duties);
  
  // Notify all clients about the deleted duty
  io.emit('dutyDeleted', { id: duty.id, memberIds: duty.memberIds });
  
  res.json({ success: true });
});

// 更新公告相关API
// 获取公告信息
app.get('/api/update-notices', (req, res) => {
  try {
    const notices = readJSON(UPDATE_NOTICES_FILE);
    // readJSON 在文件不存在时返回 []，但 update_notices 应该是对象
    if (Array.isArray(notices)) {
      return res.json({ updateNotice: '', downloadLink: '', contact: '' });
    }
    res.json(notices);
  } catch (error) {
    res.status(500).json({ error: '获取公告失败' });
  }
});

// 更新公告信息
app.post('/api/update-notices', (req, res) => {
  try {
    const { updateNotice, downloadLink, contact } = req.body;
    
    const notices = {
      updateNotice: updateNotice || '',
      downloadLink: downloadLink || '',
      contact: contact || ''
    };
    
    writeJSON(UPDATE_NOTICES_FILE, notices);
    res.json({ success: true, notices });
  } catch (error) {
    res.status(500).json({ error: '更新公告失败' });
  }
});

const os = require('os');

const getLocalIPs = () => {
  const ips = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push({ name, address: iface.address });
      }
    }
  }
  return ips;
};

// ========== 心理咨询功能 - DeepSeek Reasoner 流式输出 ==========
app.post('/api/psychological-counseling', async (req, res) => {
  const { memberId, additionalNotes } = req.body;

  if (!memberId) {
    return res.status(400).json({ error: '成员ID不能为空' });
  }

  try {
    const members = getMembers();
    const member = members.find(m => m.id === memberId);

    if (!member) {
      return res.status(404).json({ error: '成员未找到' });
    }

    // 收集成员数据
    const nominations = readRelationshipNominations();
    const memberStates = readMemberStates();

    // 获取该成员的提名数据
    const memberNomination = nominations.find(n => n.evaluatorId === memberId);
    const positiveNominations = memberNomination?.positiveNominations || [];
    const negativeNominations = memberNomination?.negativeNominations || [];
    const moodTag = memberNomination?.moodTag || null;

    // 计算被提名次数
    const timesNominatedPositive = nominations.filter(n =>
      n.positiveNominations?.includes(memberId)
    ).length;
    const timesNominatedNegative = nominations.filter(n =>
      n.negativeNominations?.includes(memberId)
    ).length;

    // 获取学习成绩统计
    let academicStats = null;
    try {
      if (fs.existsSync(ACADEMIC_SCORES_FILE)) {
        const academicData = readJSON(ACADEMIC_SCORES_FILE);
        const memberAcademic = Array.isArray(academicData) 
          ? academicData.find(item => item.memberId === memberId)
          : academicData[memberId];
        if (memberAcademic && memberAcademic.scores) {
          // 过滤出有效的分数（数字类型且不是序列号）
          const scores = Object.entries(memberAcademic.scores)
            .filter(([key, value]) => typeof value === 'number' && key !== '序列')
            .map(([, value]) => value);
          if (scores.length > 0) {
            academicStats = {
              average: (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1),
              highest: Math.max(...scores).toFixed(1),
              lowest: Math.min(...scores).toFixed(1),
              subjectCount: scores.length
            };
          }
        }
      }
    } catch (e) {
      console.error('Read academic scores error:', e);
    }

    // 获取完整体能成绩
    let fitnessRecords = null;
    try {
      // 读取固定身高数据
      const fixedHeights = readJSON(FIXED_HEIGHTS_FILE) || {};

      // 获取最新周次的BMI数据
      const scoresDir = getScoresDir();
      let latestBMIData = null;
      if (fs.existsSync(scoresDir)) {
        const files = fs.readdirSync(scoresDir);
        const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'));
        const weeks = bmiFiles.map(file => parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''))).sort((a, b) => b - a);

        for (const week of weeks) {
          const bmiData = readBMIByWeek(week);
          if (bmiData[memberId] && bmiData[memberId].weight) {
            const height = fixedHeights[memberId] || bmiData[memberId].height;
            if (height) {
              latestBMIData = {
                week,
                height: parseFloat(height),
                weight: parseFloat(bmiData[memberId].weight),
                bmi: bmiData[memberId].bmi ? parseFloat(bmiData[memberId].bmi) : null
              };
              break;
            }
          }
        }
      }

      // 如果有BMI数据，读取完整体测成绩
      if (latestBMIData && fs.existsSync(FITNESS_SCORES_FILE)) {
        const fitnessData = readJSON(FITNESS_SCORES_FILE);
        const memberFitness = Array.isArray(fitnessData)
          ? fitnessData.find(item => item.memberId === memberId)
          : fitnessData[memberId];

        if (memberFitness && memberFitness.history && memberFitness.history.length > 0) {
          // 按时间排序，取最新记录
          const sortedHistory = [...memberFitness.history].sort((a, b) =>
            new Date(b.timestamp) - new Date(a.timestamp)
          );
          const latestRecord = sortedHistory[0];

          // 保留完整的所有体测成绩
          fitnessRecords = {
            height: latestBMIData.height,
            weight: latestBMIData.weight,
            bmi: latestBMIData.bmi ? latestBMIData.bmi.toFixed(1) : null,
            week: latestBMIData.week,
            timestamp: latestRecord.timestamp,
            scores: latestRecord.scores
          };
        }
      }
    } catch (e) {
      console.error('Read fitness scores error:', e);
    }

    // 获取星座
    const getZodiac = (birthday) => {
      if (!birthday) return null;
      const date = new Date(birthday);
      const month = date.getMonth() + 1;
      const day = date.getDate();

      const zodiacSigns = [
        { name: '摩羯座', start: [1, 1], end: [1, 19] },
        { name: '水瓶座', start: [1, 20], end: [2, 18] },
        { name: '双鱼座', start: [2, 19], end: [3, 20] },
        { name: '白羊座', start: [3, 21], end: [4, 19] },
        { name: '金牛座', start: [4, 20], end: [5, 20] },
        { name: '双子座', start: [5, 21], end: [6, 21] },
        { name: '巨蟹座', start: [6, 22], end: [7, 22] },
        { name: '狮子座', start: [7, 23], end: [8, 22] },
        { name: '处女座', start: [8, 23], end: [9, 22] },
        { name: '天秤座', start: [9, 23], end: [10, 23] },
        { name: '天蝎座', start: [10, 24], end: [11, 22] },
        { name: '射手座', start: [11, 23], end: [12, 21] },
        { name: '摩羯座', start: [12, 22], end: [12, 31] }
      ];

      for (const sign of zodiacSigns) {
        if ((month === sign.start[0] && day >= sign.start[1]) ||
            (month === sign.end[0] && day <= sign.end[1])) {
          return sign.name;
        }
      }
      return null;
    };

    // 构建发送给AI的数据摘要
    const counselingData = {
      basicInfo: {
        name: member.name,
        mbti: member.mbti || '未知',
        zodiac: getZodiac(member.birthday) || '未知',
        hobbies: member.hobbies || '未填写'
      },
      academicStats,
      fitnessRecords,
      socialData: {
        positiveNominationsMade: positiveNominations.length,
        negativeNominationsMade: negativeNominations.length,
        timesNominatedPositive,
        timesNominatedNegative,
        currentMood: moodTag || '无记录'
      },
      selfAssessment: memberNomination?.selfAssessment || null,
      consecutiveStates: memberStates[memberId] || {
        consecutiveZeroPositive: 0,
        consecutiveHighNegative: 0,
        consecutiveHighPositive: 0,
        consecutiveNegativeMood: 0
      },
      additionalNotes: additionalNotes || '无'
    };

    // 设置SSE响应头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // 发送开始标记
    res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

    // 构建提示词
    const systemPrompt = `你是一位专业的心理咨询师和青少年心理专家，擅长分析青少年的心理状态并提供科学的干预建议。
请根据提供的成员数据，生成一份完整的心理咨询报告。

【重点分析内容】
本次报告需要特别重点分析以下三个方面：
1. **关系提名数据**：分析正向提名和负向提名的情况，包括发起次数和被提名次数
2. **心情标签**：分析当前心情状态和历史变化趋势
3. **心理自评数据**：详细分析睡眠质量、情绪状态、压力感受、食欲状况、室友关系和应对方式

【报告格式要求】
# 📋 心理咨询报告

## 一、关系提名分析 ⭐⭐⭐（重点）
### 1.1 正向提名分析
- 分析成员发起的正向提名次数和内容
- 分析被正向提名的次数和提名者关系
- 评估社交认可度和人际关系质量

### 1.2 负向提名分析
- 分析成员发起的负向提名次数和内容
- 分析被负向提名的次数和提名者关系
- 识别潜在的社交冲突或关系问题

### 1.3 提名综合解读
- 综合正向和负向提名数据
- 评估该成员在班级中的社交地位
- 识别社交模式和建议

## 二、心情标签分析 ⭐⭐⭐（重点）
### 2.1 当前心情状态
- 分析当前心情标签的含义
- 与历史心情数据对比
- 识别心情变化趋势

### 2.2 连续状态追踪
- 分析连续状态指标（连续零正向、连续高等）
- 识别心理风险信号
- 评估稳定性或波动性

## 三、心理自评分析 ⭐⭐⭐（重点）
### 3.1 自评数据分析
- 【睡眠质量】：详细分析评分（1-10分)，低于5分需重点关注
- 【情绪状态】：详细分析评分（1-10分)，低于5分需重点关注
- 【压力感受】：详细分析评分（1-10分)，高于7分需重点关注
- 【食欲状况】：详细分析评分（1-10分）
- 【室友关系】：分析关系质量评价
- 【应对方式】：解读选择的应对策略

### 3.2 自评综合解读
- 综合各项自评指标
- 识别主要压力源和应对资源
- 评估整体心理健康状态

## 四、基础信息与学业体能（参考）

### 4.1 基本信息
- 简要总结基本信息（MBTI、星座、兴趣爱好）

### 4.2 学业表现（参考）
- 根据学业数据进行分析

### 4.3 体能状况（参考）
- 根据体能数据进行分析

## 五、综合评估与风险识别
- 综合各方面数据进行整体评估
- 识别主要优势和潜在风险点
- 判断心理状态等级（良好/需关注/预警）

## 六、详细干预建议
### 6.1 即时干预措施（本周可执行）
- 提供3-5条具体可行的即时建议

### 6.2 中期干预计划（1-3个月）
- 制定中期改善目标和方法

### 6.3 针对性建议
- 如果有补充说明中的重点分析方面，在此重点展开

## 七、资源与支持
- 推荐可利用的资源和支持系统
- 建议关注的重点指标

【注意事项】
1. 语言要温暖，专业、有同理心
2. 避免过度诊断，使用"可能"、"倾向"等谨慎表述
3. 建议要具体、可操作
4. 关注积极因素，以鼓励为主
5. 如发现风险信号，明确指出并给出应对方案
6. 特别关注自评数据中的低分项（如睡眠<5、情绪<5、压力>7等）
7. ⭐重点关注提名数据、自评数据中的异常信号`;

    const userPrompt = `请为以下成员生成心理咨询报告：

**成员数据：**
\`\`\`json
${JSON.stringify(counselingData, null, 2)}
\`\`\`

${additionalNotes ? `\n**用户补充说明（重点关注）：**\n${additionalNotes}` : ''}

请按照要求格式生成完整的心理咨询报告。`;

    // 调用DeepSeek API（使用deepseek-reasoner模型）
    const apiKeyInfo = getNextAvailableApiKey();
    if (!apiKeyInfo) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务繁忙，请稍后再试' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    const { key, index } = apiKeyInfo;

    try {
      const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-reasoner',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.7,
        stream: true
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        responseType: 'stream'
      });

      // 流式传输数据
      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
                }
                // reasoning内容（思考过程）
                const reasoning = parsed.choices?.[0]?.delta?.reasoning_content || '';
                if (reasoning) {
                  res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoning })}\n\n`);
                }
              } catch (e) {
                // 忽略解析错误
              }
            }
          }
        }
      });

      response.data.on('end', () => {
        releaseApiKey(index);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      });

      response.data.on('error', (err) => {
        releaseApiKey(index);
        console.error('Stream error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', content: '流式输出发生错误' })}\n\n`);
        res.end();
      });

    } catch (err) {
      releaseApiKey(index);
      console.error('DeepSeek API Error:', err.response?.data || err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务调用失败，请重试' })}\n\n`);
      res.end();
    }

  } catch (err) {
    console.error('Psychological counseling error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: '心理咨询服务出错' });
    }
  }
});

// 心理咨询追加提问（支持上下文）
app.post('/api/psychological-counseling/followup', async (req, res) => {
  try {
    const { memberId, question, conversationHistory } = req.body;

    if (!memberId || !question) {
      return res.status(400).json({ error: '成员ID和问题不能为空' });
    }

    const members = getMembers();
    const member = members.find(m => m.id === memberId);

    if (!member) {
      return res.status(404).json({ error: '成员未找到' });
    }

    // 构建对话历史
    const messages = [
      {
        role: 'system',
        content: `你是一位专业的心理咨询师和青少年心理专家，擅长分析青少年的心理状态并提供科学的干预建议。
请根据用户的问题和之前的分析报告，提供针对性的回答。
- 保持专业、温暖、有同理心的语气
- 回答要具体、可操作
- 如果涉及心理健康风险，明确指出并给出应对方案`
      },
      ...(conversationHistory || []),
      { role: 'user', content: question }
    ];

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

    const apiKeyInfo = getNextAvailableApiKey();
    if (!apiKeyInfo) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务繁忙，请稍后再试' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    const { key, index } = apiKeyInfo;

    try {
      const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-chat',
        messages,
        temperature: 0.7,
        stream: true
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        responseType: 'stream'
      });

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
                }
                const reasoning = parsed.choices?.[0]?.delta?.reasoning_content || '';
                if (reasoning) {
                  res.write(`data: ${JSON.stringify({ type: 'reasoning', content: reasoning })}\n\n`);
                }
              } catch (e) {}
            }
          }
        }
      });

      response.data.on('end', () => {
        releaseApiKey(index);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      });

      response.data.on('error', (err) => {
        releaseApiKey(index);
        console.error('Follow-up stream error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', content: '流式输出发生错误' })}\n\n`);
        res.end();
      });

    } catch (err) {
      releaseApiKey(index);
      console.error('DeepSeek API Error:', err.response?.data || err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务调用失败，请重试' })}\n\n`);
      res.end();
    }

  } catch (err) {
    console.error('Follow-up error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: '追加提问服务出错' });
    }
  }
});

// ========== 公网访问API - 外部程序获取成员学习成绩 ==========
// 服务器地址：见部署配置
// 端口：3001

app.get('/api/public/member/:memberName/academic', async (req, res) => {
  try {
    const { memberName } = req.params;

    if (!memberName) {
      return res.status(400).json({ error: '成员姓名不能为空' });
    }

    const members = getMembers();
    // 使用姓名查询成员
    const member = members.find(m => m.name === memberName);

    if (!member) {
      return res.status(404).json({ error: '成员未找到，请检查姓名是否正确' });
    }

    const memberId = member.id;

    // 获取学业数据（课程成绩）
    const academicData = readAcademicScores();
    const memberAcademicData = Array.isArray(academicData)
      ? academicData.find(item => item.memberId === memberId)
      : academicData[memberId];

    // 计算平均成绩和总分
    let averageScore = null;
    let totalScore = null;
    let courseCount = 0;

    if (memberAcademicData?.scores) {
      const scores = Object.entries(memberAcademicData.scores)
        .filter(([key, value]) => key !== '序列' && typeof value === 'number');

      if (scores.length > 0) {
        courseCount = scores.length;
        const sum = scores.reduce((acc, [, value]) => acc + value, 0);
        totalScore = sum;
        averageScore = (sum / scores.length).toFixed(2);
      }
    }

    res.json({
      success: true,
      member: {
        name: member.name,
        class: member.class
      },
      courseScores: memberAcademicData?.scores || {},
      averageScore,
      totalScore,
      courseCount,
      gradeRankings: memberAcademicData?.rankings || {}
    });

  } catch (err) {
    console.error('Public academic API error:', err);
    res.status(500).json({ error: '获取学业数据失败' });
  }
});

const PORT = process.env.PORT || 3001;

// ==================== AI Agent REST API ====================
if (agentEngine) {
  app.get('/api/agent/health', (req, res) => {
    res.json({ status: 'ok', agent: 'active' });
  });

  app.post('/api/agent/chat', async (req, res) => {
    try {
      const { memberId, message, sessionId, isAdmin } = req.body;
      if (!message) return res.status(400).json({ error: '缺少必要参数' });
      const response = await agentEngine.processMessage(memberId || 'admin', message, sessionId, { isAdmin: !!isAdmin });
      res.json(response);
    } catch (err) {
      console.error('Agent REST chat error:', err);
      res.status(500).json({ error: err.message || 'Agent 处理失败' });
    }
  });

  app.post('/api/agent/admin/verify', (req, res) => {
    try {
      const { password } = req.body;
      const result = agentEngine.verifyAdmin(password);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agent/memory/:memberId', async (req, res) => {
    try {
      const memoryState = await agentEngine.getFullMemoryState(req.params.memberId);
      res.json(memoryState);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/agent/preferences/:memberId', async (req, res) => {
    try {
      await agentEngine.updateUserPreferences(req.params.memberId, req.body);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agent/tools', (req, res) => {
    const isAdmin = req.query.admin === 'true';
    res.json(agentEngine.getAvailableTools(isAdmin));
  });

  app.get('/api/agent/stats', async (req, res) => {
    try {
      const stats = await agentEngine.getStats(req.query.memberId);
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ========== AI 流式分析 API ==========

// AI Analysis - Single Member (Streaming)
app.post('/api/ai/analyze/member/stream', async (req, res) => {
  try {
    const { memberId } = req.body;

    if (!memberId) {
      return res.status(400).json({ error: '成员ID不能为空' });
    }

    const members = getMembers();
    const member = members.find(m => m.id === memberId);

    if (!member) {
      return res.status(404).json({ error: '成员未找到' });
    }

    const scoresDir = getScoresDir();
    const files = fs.readdirSync(scoresDir);
    const scoreFiles = files.filter(file => file.startsWith('scores_week_') && file.endsWith('.json.gz'));
    const weeks = scoreFiles.map(file => parseInt(file.replace('scores_week_', '').replace('.json.gz', ''))).sort((a, b) => b - a);
    
    const memberScores = { weeklyScores: {} };
    for (const week of weeks) {
      const weekScores = getScoresForWeek(week);
      for (const entry of weekScores) {
        if (entry.memberId === memberId) {
          memberScores.weeklyScores[week] = {
            study: entry.scores?.study || 0,
            management: entry.scores?.management || 0,
            fitness: entry.scores?.fitness || 0,
            literacy: entry.scores?.literacy || 0,
            discipline: entry.scores?.discipline || 0,
            contribution: entry.scores?.contribution || 0
          };
          break;
        }
      }
    }
    
    const experiences = readJSON(EXPERIENCES_FILE);
    const memberExps = experiences.filter(e => e.memberId === memberId);

    const dimensions = ['study', 'management', 'fitness', 'literacy', 'discipline', 'contribution'];
    const entropyWeights = getEntropyWeights();

    const dimensionScores = {};
    for (const dim of dimensions) {
      const weekScores = Object.values(memberScores.weeklyScores).map(w => w[dim] || 0);
      dimensionScores[dim] = weekScores.length > 0 ? weekScores.reduce((a, b) => a + b, 0) / weekScores.length : 0;
    }

    const totalScore = Object.entries(dimensionScores).reduce((sum, [dim, score]) => {
      return sum + score * entropyWeights[dim];
    }, 0);

    const experienceText = memberExps.length > 0 ? memberExps.map(exp => {
      let desc = '无描述';
      if (exp.description) {
        desc = exp.description;
      } else if (exp.content) {
        desc = exp.content;
      }
      const typeName = exp.type === 'competition' ? '竞赛' : exp.type === 'award' ? '获奖' : exp.type === 'practice' ? '实践' : exp.type || '经历';
      const date = exp.createdAt ? exp.createdAt.substring(0, 10) : (exp.date || '');
      return `- ${typeName}：${desc}${date ? `（${date}）` : ''}`;
    }).join('\n') : '无';

    // 获取完整学习数据
    let academicDataText = '无学习数据';
    let memberAcademic = null;
    try {
      if (fs.existsSync(ACADEMIC_SCORES_FILE)) {
        const academicData = readJSON(ACADEMIC_SCORES_FILE);
        memberAcademic = Array.isArray(academicData) 
          ? academicData.find(item => item.memberId === memberId)
          : academicData[memberId];
        
        if (memberAcademic && memberAcademic.scores) {
          const courseScores = Object.entries(memberAcademic.scores)
            .filter(([key, value]) => typeof value === 'number' && key !== '序列')
            .map(([key, value]) => `- ${key}：${value}分`)
            .join('\n');
          
          if (courseScores) {
            academicDataText = courseScores;
          }
        }
      }
    } catch (e) {
      console.error('Read academic scores error:', e);
    }

    // 获取最新的体能数据（BMI和体测）
    let fitnessDataText = '无体能数据';
    try {
      const fixedHeights = readJSON(FIXED_HEIGHTS_FILE) || {};
      let latestBMIData = null;
      
      const scoresDir = getScoresDir();
      if (fs.existsSync(scoresDir)) {
        const files = fs.readdirSync(scoresDir);
        const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'));
        const weeks = bmiFiles.map(file => parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''))).sort((a, b) => b - a);

        for (const week of weeks) {
          const bmiData = readBMIByWeek(week);
          if (bmiData[memberId] && bmiData[memberId].weight) {
            const height = fixedHeights[memberId] || bmiData[memberId].height;
            if (height) {
              latestBMIData = {
                week,
                height: parseFloat(height),
                weight: parseFloat(bmiData[memberId].weight),
                bmi: bmiData[memberId].bmi ? parseFloat(bmiData[memberId].bmi) : null
              };
              break;
            }
          }
        }
      }

      // 获取最新体测成绩
      let fitnessRecordsText = '';
      if (fs.existsSync(FITNESS_SCORES_FILE)) {
        const fitnessData = readJSON(FITNESS_SCORES_FILE);
        const memberFitness = Array.isArray(fitnessData)
          ? fitnessData.find(item => item.memberId === memberId)
          : fitnessData[memberId];

        if (memberFitness && memberFitness.history && memberFitness.history.length > 0) {
          const sortedHistory = [...memberFitness.history].sort((a, b) =>
            new Date(b.timestamp) - new Date(a.timestamp)
          );
          const latestRecord = sortedHistory[0];
          
          fitnessRecordsText = Object.entries(latestRecord.scores)
            .filter(([key, value]) => value)
            .map(([key, value]) => `- ${key}：${value}`)
            .join('\n');
        }
      }

      if (latestBMIData || fitnessRecordsText) {
        const bmiPart = latestBMIData ? `身高：${latestBMIData.height}cm
体重：${latestBMIData.weight}kg
BMI：${latestBMIData.bmi || '未知'}
数据来源：第${latestBMIData.week}周` : '';
        fitnessDataText = (bmiPart && fitnessRecordsText) ? `${bmiPart}

体测成绩：
${fitnessRecordsText}` : bmiPart || fitnessRecordsText;
      }
    } catch (e) {
      console.error('Read fitness scores error:', e);
    }

    // 获取心理自评数据
    const nominations = readRelationshipNominations();
    const memberNomination = nominations.find(n => n.evaluatorId === memberId);
    const positiveNominations = memberNomination?.positiveNominations || [];
    const negativeNominations = memberNomination?.negativeNominations || [];
    const moodTag = memberNomination?.moodTag || '无';
    const timesNominatedPositive = nominations.filter(n => n.positiveNominations?.includes(memberId)).length;
    const timesNominatedNegative = nominations.filter(n => n.negativeNominations?.includes(memberId)).length;

    const selfAssessmentText = memberNomination?.selfAssessment ? 
      `睡眠质量：${memberNomination.selfAssessment.sleepQuality}/10
情绪状态：${memberNomination.selfAssessment.emotionalState}/10
压力感受：${memberNomination.selfAssessment.stressLevel}/10
食欲状况：${memberNomination.selfAssessment.appetite}/10
室友关系：${memberNomination.selfAssessment.dormEnvironment || '未评价'}
应对方式：${memberNomination.selfAssessment.copingMethods?.join('、') || '未选择'}` : 
      '无';

    const prompt = `请为以下同学生成综合分析报告：

**基本信息：**
- 姓名：${member.name}
- MBTI：${member.mbti || '未知'}
- 生日：${member.birthday || '未知'}

**各维度得分（满分100）：**
${dimensions.map(dim => `- ${dim === 'study' ? '学习成绩' : dim === 'management' ? '管理能力' : dim === 'fitness' ? '体能素质' : dim === 'literacy' ? '人文素养' : dim === 'discipline' ? '遵章守纪' : '班级贡献'}：${dimensionScores[dim].toFixed(1)}分（熵权权重：${entropyWeights[dim].toFixed(2)}）`).join('\n')}

**熵权法综合得分：${totalScore.toFixed(2)}分**

**详细评分数据（按周次）：**
${Object.entries(memberScores.weeklyScores).map(([week, scores]) => {
  return `第${week}周：
- 学习成绩：${scores.study}
- 管理能力：${scores.management}
- 体能素质：${scores.fitness}
- 人文素养：${scores.literacy}
- 遵章守纪：${scores.discipline}
- 班级贡献：${scores.contribution}`;
}).join('\n\n')}

**学习数据（来自教务系统）：**
${academicDataText || '无学习数据'}

**体能数据（身高体重BMI+体测）：**
${fitnessDataText || '无体能数据'}

**社交关系数据：**
正向提名：发起${positiveNominations.length}次，被提名${timesNominatedPositive}次
负向提名：发起${negativeNominations.length}次，被提名${timesNominatedNegative}次
当前心情标签：${moodTag}

**心理自评数据：**
${selfAssessmentText}

**个人经历：**
${experienceText}

请按以下格式生成分析报告（使用Markdown格式）：
# ${member.name}同学的综合分析报告
## 一、整体表现概述
## 二、性格与特点分析（结合MBTI和生日）
## 三、评分表现分析（含熵权法综合得分）
## 四、学习成绩分析（结合教务系统数据）
## 五、体能素质分析（结合体能测试数据）
## 六、社交关系分析（结合关系提名数据）
## 七、心理状态评估（结合心理自评数据）
## 八、个人经历与成长
## 九、改进建议
## 十、总结展望`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

    const apiKeyInfo = getNextAvailableApiKey();
    if (!apiKeyInfo) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务繁忙，请稍后再试' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    const { key, index } = apiKeyInfo;

    try {
      const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一个专业的班级管理分析助手，擅长分析学生评分数据并提供建设性意见。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        stream: true
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        responseType: 'stream'
      });

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
                }
              } catch (e) {
                // ignore parse errors
              }
            }
          }
        }
      });

      response.data.on('end', () => {
        releaseApiKey(index);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      });

      response.data.on('error', (err) => {
        releaseApiKey(index);
        console.error('Stream error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', content: '流式输出发生错误' })}\n\n`);
        res.end();
      });

    } catch (err) {
      releaseApiKey(index);
      console.error('DeepSeek API Error:', err.response?.data || err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务调用失败，请重试' })}\n\n`);
      res.end();
    }

  } catch (err) {
    console.error('Individual analysis stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || '分析失败' });
    }
  }
});

// AI Analysis - All Members (Streaming)
app.post('/api/ai/analyze/all/stream', async (req, res) => {
  try {
    const { members, scores, config } = getAllStatsData();
    const dimensions = ['study', 'management', 'fitness', 'literacy', 'discipline', 'contribution'];
    const entropyWeights = getEntropyWeights();

    const dimensionStats = {};
    for (const dim of dimensions) {
      const memberScores = {};
      for (const entry of scores) {
        if (entry.memberId && entry.scores && entry.scores[dim] !== undefined) {
          if (!memberScores[entry.memberId]) {
            memberScores[entry.memberId] = [];
          }
          memberScores[entry.memberId].push(entry.scores[dim]);
        }
      }
      
      const allScores = Object.values(memberScores).map(s => {
        if (s.length > 0) {
          return s.reduce((a, b) => a + b, 0) / s.length;
        }
        return 0;
      }).filter(s => typeof s === 'number');

      dimensionStats[dim] = {
        avg: allScores.length > 0 ? (allScores.reduce((a, b) => a + b, 0) / allScores.length).toFixed(2) : 0,
        max: allScores.length > 0 ? Math.max(...allScores).toFixed(2) : 0,
        min: allScores.length > 0 ? Math.min(...allScores).toFixed(2) : 0
      };
    }

    const fixedHeights = readJSON(FIXED_HEIGHTS_FILE) || {};
    const heights = Object.values(fixedHeights).filter(h => typeof h === 'number');
    const heightStats = {
      avg: heights.length > 0 ? (heights.reduce((a, b) => a + b, 0) / heights.length).toFixed(1) : 0,
      min: heights.length > 0 ? Math.min(...heights) : 0,
      max: heights.length > 0 ? Math.max(...heights) : 0
    };

    const scoresDir = getScoresDir();
    const weights = [];
    const bmis = [];
    let latestWeek = null;

    if (fs.existsSync(scoresDir)) {
        const files = fs.readdirSync(scoresDir);
        const bmiFiles = files.filter(file => file.startsWith('bmi_week_') && file.endsWith('.json.gz'));
        const weeks = bmiFiles.map(file => parseInt(file.replace('bmi_week_', '').replace('.json.gz', ''))).sort((a, b) => b - a);

        if (weeks.length > 0) {
          latestWeek = weeks[0];
          const bmiData = readBMIByWeek(latestWeek);
          for (const member of members) {
            if (bmiData[member.id] && bmiData[member.id].weight) {
              weights.push(parseFloat(bmiData[member.id].weight));
              if (bmiData[member.id].bmi) {
                bmis.push(parseFloat(bmiData[member.id].bmi));
              }
            }
          }
        }
      }

    const weightStats = {
      avg: weights.length > 0 ? (weights.reduce((a, b) => a + b, 0) / weights.length).toFixed(1) : 0,
      min: weights.length > 0 ? Math.min(...weights).toFixed(1) : 0,
      max: weights.length > 0 ? Math.max(...weights).toFixed(1) : 0
    };

    const bmiStats = {
      avg: bmis.length > 0 ? (bmis.reduce((a, b) => a + b, 0) / bmis.length).toFixed(1) : 0,
      min: bmis.length > 0 ? Math.min(...bmis).toFixed(1) : 0,
      max: bmis.length > 0 ? Math.max(...bmis).toFixed(1) : 0
    };

    const classStats = {};
    for (const member of members) {
      const cls = member.class || '未知';
      if (!classStats[cls]) {
        classStats[cls] = { name: cls, memberCount: 0 };
      }
      classStats[cls].memberCount++;
    }

    const weeklyEntropyScores = {};
    for (const [memberId, memberData] of Object.entries(scores)) {
      const weekly = memberData.weeklyScores || {};
      for (const [week, weekScores] of Object.entries(weekly)) {
        if (!weeklyEntropyScores[week]) {
          weeklyEntropyScores[week] = { total: 0, count: 0 };
        }
        const weekTotal = Object.entries(weekScores).reduce((sum, [dim, score]) => {
          return sum + (score || 0) * entropyWeights[dim];
        }, 0);
        weeklyEntropyScores[week].total += weekTotal;
        weeklyEntropyScores[week].count++;
      }
    }

    const sortedWeeklyEntropyScores = Object.entries(weeklyEntropyScores)
      .map(([week, data]) => ({ week, score: (data.total / data.count).toFixed(2) }))
      .sort((a, b) => parseInt(a.week) - parseInt(b.week));

    // 获取全体学习数据
    let academicDataText = '无学习数据';
    try {
      if (fs.existsSync(ACADEMIC_SCORES_FILE)) {
        const academicData = readJSON(ACADEMIC_SCORES_FILE);
        const subjectScores = {};
        
        if (Array.isArray(academicData)) {
          for (const memberAcademic of academicData) {
            if (memberAcademic && memberAcademic.scores) {
              Object.entries(memberAcademic.scores).forEach(([key, value]) => {
                if (typeof value === 'number' && key !== '序列') {
                  if (!subjectScores[key]) {
                    subjectScores[key] = [];
                  }
                  subjectScores[key].push(value);
                }
              });
            }
          }
        }
        
        if (Object.keys(subjectScores).length > 0) {
          academicDataText = Object.entries(subjectScores)
            .map(([subject, scores]) => {
              const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
              return `- ${subject}：平均${avg}分（${scores.length}人）`;
            })
            .join('\n');
        }
      }
    } catch (e) {
      console.error('Read all academic scores error:', e);
    }

    // 获取心理自评统计数据
    const nominations = readRelationshipNominations();
    let selfAssessmentStats = null;
    try {
      const selfAssessments = nominations
        .filter(n => n.selfAssessment)
        .map(n => n.selfAssessment);
      
      if (selfAssessments.length > 0) {
        const sleepAvg = (selfAssessments.reduce((sum, sa) => sum + (sa.sleepQuality || 0), 0) / selfAssessments.length).toFixed(1);
        const emotionAvg = (selfAssessments.reduce((sum, sa) => sum + (sa.emotionalState || 0), 0) / selfAssessments.length).toFixed(1);
        const stressAvg = (selfAssessments.reduce((sum, sa) => sum + (sa.stressLevel || 0), 0) / selfAssessments.length).toFixed(1);
        const appetiteAvg = (selfAssessments.reduce((sum, sa) => sum + (sa.appetite || 0), 0) / selfAssessments.length).toFixed(1);
        
        selfAssessmentStats = {
          sleepAvg,
          emotionAvg,
          stressAvg,
          appetiteAvg,
          count: selfAssessments.length
        };
      }
    } catch (e) {
      console.error('Read self assessment stats error:', e);
    }

    // 获取全体体测数据
    let fitnessDataText = '无体测数据';
    try {
      if (fs.existsSync(FITNESS_SCORES_FILE)) {
        const fitnessData = readJSON(FITNESS_SCORES_FILE);
        const itemScores = {};
        
        const memberFitnesses = Array.isArray(fitnessData) ? fitnessData : Object.values(fitnessData);
        
        for (const memberFitness of memberFitnesses) {
          if (memberFitness && memberFitness.history && memberFitness.history.length > 0) {
            const sortedHistory = [...memberFitness.history].sort((a, b) =>
              new Date(b.timestamp) - new Date(a.timestamp)
            );
            const latestRecord = sortedHistory[0];
            
            if (latestRecord && latestRecord.scores) {
              Object.entries(latestRecord.scores).forEach(([key, value]) => {
                if (value) {
                  if (!itemScores[key]) {
                    itemScores[key] = [];
                  }
                  
                  if (typeof value === 'string') {
                    if ((key.includes('3000') || key.includes('米'))) {
                      const timeMatch = value.match(/(\d+)′(\d+)/);
                      if (timeMatch) {
                        const seconds = parseInt(timeMatch[1]) * 60 + parseInt(timeMatch[2]);
                        itemScores[key].push(3000 - seconds);
                      } else if (/^\d+$/.test(value)) {
                        itemScores[key].push(parseInt(value));
                      }
                    } else if ((key.includes('仰卧') || key.includes('卷腹') || key.includes('引体') || key.includes('曲臂') || key.includes('悬垂'))) {
                      const numMatch = value.match(/^(\d+)/);
                      if (numMatch) {
                        itemScores[key].push(parseInt(numMatch[1]));
                      }
                    } else if (key.includes('蛇形')) {
                      const numMatch = value.match(/^(\d+\.?\d*)/);
                      if (numMatch) {
                        itemScores[key].push(parseFloat(numMatch[1]));
                      }
                    }
                  } else if (typeof value === 'number') {
                    itemScores[key].push(value);
                  }
                }
              });
            }
          }
        }
        
        if (Object.keys(itemScores).length > 0) {
          fitnessDataText = Object.entries(itemScores)
            .map(([item, scores]) => {
              const avg = (scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1);
              return `- ${item}：平均${avg}分（${scores.length}人）`;
            })
            .join('\n');
        }
      }
    } catch (e) {
      console.error('Read all fitness scores error:', e);
    }
    
    // 收集完整评分数据
    const memberWeeklyScores = {};
    for (const entry of scores) {
      if (entry.memberId && entry.week && entry.scores) {
        if (!memberWeeklyScores[entry.memberId]) {
          memberWeeklyScores[entry.memberId] = {};
        }
        memberWeeklyScores[entry.memberId][entry.week] = entry.scores;
      }
    }
    
    // 计算每个成员的熵权法综合得分（最新周次）
    const memberEntropyScores = {};
    for (const [memberId, weekly] of Object.entries(memberWeeklyScores)) {
      const weeks = Object.keys(weekly).sort((a, b) => parseInt(b) - parseInt(a));
      if (weeks.length > 0) {
        const latestWeek = weeks[0];
        const latestScores = weekly[latestWeek];
        const totalScore = Object.entries(latestScores).reduce((sum, [dim, score]) => {
          return sum + score * entropyWeights[dim];
        }, 0);
        memberEntropyScores[memberId] = {
          name: members.find(m => m.id === memberId)?.name || memberId,
          totalScore: totalScore.toFixed(2)
        };
      }
    }
    
    const prompt = `请生成班级评分系统的全体数据分析报告：

**数据概览：**
- 总成员数：${members.length}人
- 数据维度：学习成绩、管理能力、体能素质、人文素养、遵章守纪、班级贡献

**熵权法权重：**
1. 学习成绩（权重：${entropyWeights.study.toFixed(2)}）
2. 管理能力（权重：${entropyWeights.management.toFixed(2)}）
3. 体能素质（权重：${entropyWeights.fitness.toFixed(2)}）
4. 人文素养（权重：${entropyWeights.literacy.toFixed(2)}）
5. 遵章守纪（权重：${entropyWeights.discipline.toFixed(2)}）
6. 班级贡献（权重：${entropyWeights.contribution.toFixed(2)}）

各维度整体统计：
${dimensions.map(dim => `- ${dim === 'study' ? '学习成绩' : dim === 'management' ? '管理能力' : dim === 'fitness' ? '体能素质' : dim === 'literacy' ? '人文素养' : dim === 'discipline' ? '遵章守纪' : '班级贡献'}：平均${dimensionStats[dim].avg}，最高${dimensionStats[dim].max}，最低${dimensionStats[dim].min}`).join('\n')}

成员熵权法综合得分（最新周次）：
${Object.entries(memberEntropyScores).map(([memberId, data]) => `- ${data.name}：${data.totalScore}分`).join('\n')}

详细评分数据（按成员）：
${Object.entries(memberWeeklyScores).map(([memberId, weekly]) => {
  const member = members.find(m => m.id === memberId);
  const memberName = member?.name || memberId;
  const weeklyData = Object.entries(weekly).map(([week, scores]) => {
    return `第${week}周：
- 学习成绩：${scores.study}
- 管理能力：${scores.management}
- 体能素质：${scores.fitness}
- 人文素养：${scores.literacy}
- 遵章守纪：${scores.discipline}
- 班级贡献：${scores.contribution}`;
  }).join('\n\n');
  return `${memberName}:\n${weeklyData}`;
}).join('\n\n')}

学习数据（来自教务系统）：
${academicDataText}

身高体重BMI数据统计（BMI数据录入，第${latestWeek || '无'}周）：
- 身高：平均${heightStats.avg}cm，范围${heightStats.min}-${heightStats.max}cm
- 体重：平均${weightStats.avg}kg，范围${weightStats.min}-${weightStats.max}kg
- BMI：平均${bmiStats.avg}，范围${bmiStats.min}-${bmiStats.max}

体测数据统计：
${fitnessDataText}

心理自评数据统计：
${selfAssessmentStats ? `平均睡眠质量：${selfAssessmentStats.sleepAvg}/10
平均情绪状态：${selfAssessmentStats.emotionAvg}/10
平均压力感受：${selfAssessmentStats.stressAvg}/10
平均食欲状况：${selfAssessmentStats.appetiteAvg}/10
已有${selfAssessmentStats.count}人完成自评` : '无心理自评数据'}

各班级概况：
${Object.values(classStats).map(cls => `- ${cls.name}：${cls.memberCount}人`).join('\n')}

周次熵权法综合得分：
${sortedWeeklyEntropyScores.map(w => `- 第${w.week}周：${w.score}分`).join('\n') || '无'}

请按以下格式生成分析报告（使用Markdown格式）：
# 班级评分系统全体数据分析报告
## 一、整体情况概述
## 二、各维度表现分析
## 三、学习成绩分析（结合教务系统数据）
## 四、体能素质分析（结合身高体重BMI数据）
## 五、心理状态分析（结合心理自评数据）
## 六、班级对比分析
## 七、周次趋势分析
## 八、总体建议`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write(`data: ${JSON.stringify({ type: 'start' })}\n\n`);

    const apiKeyInfo = getNextAvailableApiKey();
    if (!apiKeyInfo) {
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务繁忙，请稍后再试' })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    const { key, index } = apiKeyInfo;

    try {
      const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: '你是一个专业的班级管理分析助手，擅长分析学生评分数据并提供建设性意见。' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        stream: true
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${key}`
        },
        responseType: 'stream'
      });

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n').filter(line => line.trim() !== '');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
            } else {
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content || '';
                if (content) {
                  res.write(`data: ${JSON.stringify({ type: 'content', content })}\n\n`);
                }
              } catch (e) {
                // ignore parse errors
              }
            }
          }
        }
      });

      response.data.on('end', () => {
        releaseApiKey(index);
        res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
        res.end();
      });

      response.data.on('error', (err) => {
        releaseApiKey(index);
        console.error('Stream error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', content: '流式输出发生错误' })}\n\n`);
        res.end();
      });

    } catch (err) {
      releaseApiKey(index);
      console.error('DeepSeek API Error:', err.response?.data || err.message);
      res.write(`data: ${JSON.stringify({ type: 'error', content: 'AI服务调用失败，请重试' })}\n\n`);
      res.end();
    }

  } catch (err) {
    console.error('All analysis stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || '分析失败' });
    }
  }
});

// ==================== WeChat Bot API ====================
app.get('/api/wechat/status', (req, res) => {
  if (!wechatBot) return res.json({ enabled: false });
  const { memberId } = req.query;
  if (memberId) {
    const status = wechatBot.getBotStatus(memberId);
    if (!status) return res.json({ enabled: true, found: false });
    return res.json({ enabled: true, found: true, ...status });
  }
  res.json(wechatBot.getStatus());
});

app.post('/api/wechat/create-bot', express.json(), async (req, res) => {
  if (!wechatBot) return res.status(400).json({ error: 'WeChat not initialized' });
  const { memberId, password } = req.body;
  if (!memberId || !password) return res.status(400).json({ error: '缺少参数' });
  try {
    const result = await wechatBot.createMemberBot(memberId, password);
    res.json(result);
  } catch (err) {
    if (err.message === 'PASSWORD_NOT_SET') {
      return res.status(400).json({ error: 'PASSWORD_NOT_SET', message: '该成员尚未设置密码' });
    }
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wechat/stop-bot', express.json(), async (req, res) => {
  if (!wechatBot) return res.status(400).json({ error: 'WeChat not initialized' });
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: '缺少参数 memberId' });
  try {
    await wechatBot.stopBot(memberId);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wechat/create-admin-bot', express.json(), async (req, res) => {
  if (!wechatBot) return res.status(400).json({ error: 'WeChat not initialized' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: '缺少密码' });
  try {
    const result = await wechatBot.createAdminBot(password);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/wechat/send', express.json(), async (req, res) => {
  if (!wechatBot) return res.status(400).json({ error: 'WeChat bot not initialized' });

  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== 'Bearer ' + INTERNAL_API_KEY) {
    return res.status(401).json({ error: '未授权访问' });
  }

  const { memberId, text } = req.body;
  if (!memberId || !text) return res.status(400).json({ error: '缺少 memberId 或 text' });
  const result = await wechatBot.sendToMember(memberId, text);
  res.json(result);
});

// ==================== 单号微信管家 API（GeweChat/iPad 协议） ====================
// 与 per-member 模式并存；STEWARD_ENABLED=1 时启用

// 管家状态
app.get('/api/wechat/steward/status', (req, res) => {
  if (!steward) return res.json({ enabled: false, mode: 'steward' });
  res.json(steward.getStatus());
});

// 获取登录二维码（管理员小号扫码；qrcode 为可直接 <img> 渲染的 data URL）
// type=login：微信扫码登录；type=verification：跨省/新设备验证码
//（iPad 模式=人脸识别 App 扫，Mac 模式=滑块验证 App 扫，3 分钟内完成）
app.get('/api/wechat/steward/qrcode', async (req, res) => {
  if (!steward) return res.status(400).json({ error: '管家未初始化' });
  const qr = steward.getQrcode();
  if (!qr) return res.status(404).json({ error: '二维码未生成（可能已登录或未启动）' });
  let dataUrl = null;
  try {
    const QRCode = require('qrcode');
    dataUrl = await QRCode.toDataURL(qr.qrUrl || qr.qrData, { width: 320, margin: 2 });
  } catch (e) { /* 生成失败时返回原始内容，前端可自行渲染 */ }
  const type = qr.type || 'login';
  res.json({
    qrcode: dataUrl || qr.qrUrl || qr.qrData,
    qrUrl: qr.qrUrl,
    type,
    hint: type === 'verification'
      ? '设备验证：请用 iPad 人脸识别 App（iOS）或 Mac 滑块验证 App（Android）扫此码，3 分钟内完成'
      : '登录：请用管家小号的微信扫此码，并在手机上确认登录',
    appId: qr.appId,
    timestamp: qr.timestamp,
  });
});

// GeweChat 拉图端点：图表产物公网暴露（postImage 的 imgUrl 指向这里；
// 文件名为时间戳+随机字节，仅 basename 引用防目录穿越）
app.get('/api/wechat/steward/media/:file', (req, res) => {
  const { MEDIA_DIR } = require('./wechat/geweChannel');
  const file = path.basename(decodeURIComponent(req.params.file));
  const fp = path.join(MEDIA_DIR, file);
  if (!fs.existsSync(fp) || !fs.statSync(fp).isFile()) {
    return res.status(404).json({ error: 'not found' });
  }
  const mimeByExt = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.mp4': 'video/mp4' };
  res.setHeader('Content-Type', mimeByExt[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  fs.createReadStream(fp).pipe(res);
});

// ---- clonevoice（深度音频）开放平台 RVC 翻唱回调：落盘 + 管理查询（联调用）----
// 回调地址固定为含随机 secret 的 URL，防外部误写；按 orderId 幂等覆盖落盘。
const CV_NTF_SECRET = process.env.CV_NTF_SECRET || 'ntf-4d1c9e7b2f8a';
app.post(`/api/cv/notify/${CV_NTF_SECRET}`, express.json({ limit: '1mb' }), (req, res) => {
  try {
    const orderId = String((req.body && (req.body.orderId || req.body.state)) || 'unknown').trim() || 'unknown';
    const dir = getDataPath('cv_cb');
    fs.mkdirSync(dir, { recursive: true });
    const fp = path.join(dir, String(orderId).replace(/[^\w\-.]/g, '_') + '.json');
    fs.writeFileSync(fp, JSON.stringify(req.body || {}, null, 2));
    console.log('[CV] clonevoice 回调落盘 orderId=', orderId);
    // 推进 songGen cover 任务（下载 coverUrl → 注册媒体 → 激活 AI 发歌）
    if (songGen && typeof songGen.handleCallback === 'function') {
      songGen.handleCallback(String(orderId), req.body || {}).catch((e) => {
        console.error(`[CV] handleCallback 异常 orderId=${orderId}:`, e.message);
      });
    }
  } catch (e) {
    console.error('[CV] clonevoice 回调落盘失败:', e.message);
  }
  res.status(200).json({ code: 200, msg: 'ok' });
});
// 管理查询：GET /api/cv/result?orderId=xxx（Bearer INTERNAL/CLI_API_KEY）
app.get('/api/cv/result', (req, res) => {
  const authHeader = req.headers.authorization || '';
  if (authHeader !== 'Bearer ' + INTERNAL_API_KEY && authHeader !== 'Bearer ' + CLI_API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const orderId = String(req.query.orderId || '').trim();
  const fp = path.join(getDataPath('cv_cb'), String(orderId).replace(/[^\w\-.]/g, '_') + '.json');
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'no callback yet', orderId });
  res.json(JSON.parse(fs.readFileSync(fp, 'utf8')));
});

// 启动管家（触发扫码登录流程）
app.post('/api/wechat/steward/start', express.json(), async (req, res) => {
  if (!steward) return res.status(400).json({ error: '管家未初始化' });
  const result = await steward.start();
  res.json(result);
});

// 绑定表（管理员查看）
app.get('/api/wechat/steward/bindings', (req, res) => {
  if (!steward) return res.status(400).json({ error: '管家未初始化' });
  res.json({ bindings: steward.getBindings() });
});

// 解绑成员（换号/退学清理）
app.post('/api/wechat/steward/unbind', express.json(), (req, res) => {
  if (!steward) return res.status(400).json({ error: '管家未初始化' });
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: '缺少 memberId' });
  steward.unbindMember(memberId);
  res.json({ success: true });
});

// GeweChat 回调入口（消息/好友申请/掉线通知；Token 鉴权）
// 体解析不挑 Content-Type：GeWe 云端回调的 Content-Type 不保证是 application/json。
// 用 express.json() 时 text/plain（或不带）会被直接跳过 → req.body 为空 → 取不到
// TypeName 被静默 return，而路由仍回 200 —— 表现为「控制台显示回调响应 200，AI 却
// 毫无反应」，极难排查。这里改 raw 全量接收 + 手动 JSON.parse，解析失败必须留日志。
// 注意顺序：全局 express.json() 若已解析过会置 req._body，raw 会自动跳过，两条路径不冲突。
app.post('/api/wechat/steward/callback', express.raw({ type: () => true, limit: '4mb' }), (req, res) => {
  if (!steward) return res.status(400).json({ error: '管家未初始化' });
  let payload = req.body;
  if (Buffer.isBuffer(payload)) {
    const raw = payload.toString('utf8').trim();
    if (!raw) return res.json({ success: true, note: 'empty body' });
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      console.warn(`[Steward] 回调体不是 JSON（ct=${req.headers['content-type'] || '-'}, ${raw.length}B）: ${raw.slice(0, 200)}`);
      return res.status(400).json({ error: '回调体不是 JSON' });
    }
  } else if (typeof payload === 'string') {
    // GeWe 偶发双编码：body 本身是 JSON 字符串
    try { payload = JSON.parse(payload); } catch { /* 保持原样 */ }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    console.warn(`[Steward] 回调体类型异常（${typeof payload}），已忽略`);
    return res.json({ success: true, note: 'non-object body' });
  }
  try {
    steward.handleChannelCallback(payload);
    res.json({ success: true });
  } catch (e) {
    console.warn(`[Steward] 回调处理失败: ${e.message}`);
    res.status(401).json({ error: e.message });
  }
});

// ==================== Agent CLI 兜底网关（cli_gateway 工具的后端实现） ====================
// 设计：固定业务工具为主（一次往返直达业务 API）+ CLI 兜底（长尾场景直接文件操作）。
// 权限隔离 = 路径白名单（safeDataPath 仅 data/）+ 路径分级 + 身份隔离 + 管理员密码闸 + 审计日志。

// 路径分级（.bak 后缀先剥离，继承原文件级别）：
//   own       本人文件（个人目录下以自己学号命名）/ temp 草稿 → 免密读写删
//   public    班级公开数据（members/notices/duties 等）→ 读免密，改需管理员密码
//   shared    共享敏感（scores/experiences/他人个人文件等，含他人数据）→ 读写删均需管理员密码
//   code      数据目录内 .js 代码文件 → 禁写禁删（防任意代码执行），读需密码
//   writeOnly config.json（含密码散列）→ 禁读禁删，凭密码可写
//   blocked   wechat/（微信凭据）、apk/（分发二进制）、系统管理文件 → 永久禁止
function classifyGatewayPath(relPath, callerId) {
  const p = String(relPath || '').toLowerCase().replace(/\\/g, '/').replace(/\.bak$/, '');
  if (p === 'wechat' || p.startsWith('wechat/') || p === 'apk' || p.startsWith('apk/')) {
    return { level: 'blocked', reason: '系统目录（微信凭据/应用分发）' };
  }
  if (['notification_inbox.json', 'devices.json', 'agent_cli_audit.jsonl', '.seed.lock'].includes(p)) {
    return { level: 'blocked', reason: '系统管理文件' };
  }
  if (p === 'config.json') {
    return { level: 'writeOnly', reason: '系统配置（含密码散列，禁读；凭管理员密码可写）' };
  }
  if (p.endsWith('.js')) {
    return { level: 'code', reason: '数据目录内代码文件（禁写，防任意代码执行）' };
  }
  if (p === 'temp' || p.startsWith('temp/')) {
    return { level: 'own', reason: '临时草稿目录' };
  }
  // 个人数据目录：checkin_records/612.json、conversation_memory/612_xxx.json 等
  const PERSONAL_DIRS = ['checkin_records', 'conversation_memory', 'agent_memories', 'agent_profiles'];
  const parts = p.split('/');
  if (parts.length >= 2 && PERSONAL_DIRS.includes(parts[0])) {
    const m = parts[1].match(/^(\d{2,4})/);
    if (m) {
      return String(m[1]) === String(callerId)
        ? { level: 'own', reason: '本人数据' }
        : { level: 'shared', reason: `他人个人数据（${m[1]}）` };
    }
    return { level: 'shared', reason: '个人数据目录（文件未以学号命名）' };
  }
  const PUBLIC_FILES = ['members.json', 'injury_status.json', 'notices.json', 'update_notices.json',
    'duties.json', 'fixed_heights.json', 'makeup_periods.json', 'member_files.json'];
  if (PUBLIC_FILES.includes(p)) {
    return { level: 'public', reason: '班级公开数据' };
  }
  return { level: 'shared', reason: '共享数据（含他人数据）' };
}

// 权限矩阵：command × level → 0=免密 1=需管理员密码 9=永久拒绝
const GATEWAY_NEED = {
  own:       { list: 0, read: 0, write: 0, delete: 0 },
  public:    { list: 0, read: 0, write: 1, delete: 1 },
  shared:    { list: 0, read: 1, write: 1, delete: 1 },
  code:      { list: 0, read: 1, write: 9, delete: 9 },
  writeOnly: { list: 0, read: 9, write: 1, delete: 9 },
  blocked:   { list: 9, read: 9, write: 9, delete: 9 },
};

// 审计日志：JSONL 追加（agent 自身被禁止读写该文件），超限裁剪
function appendAgentCliAudit(entry) {
  try {
    const file = path.join(DATA_DIR, 'agent_cli_audit.jsonl');
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch {}
    lines.push(JSON.stringify(entry));
    if (lines.length > 1000) lines = lines.slice(-500); // 双限：1000 行触发裁剪至 500
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
  } catch (e) { console.warn('[AgentCli] 审计写入失败:', e.message); }
}

// ==================== dsh 工具桥内部端点（权限三闸之闸3） ====================
// dsh runtime 子进程的工具插件通过 HTTP 回环调用；X-Internal-Auth 鉴权（闸2）
// 端点内完成：memberId 权限隔离 + 管理员密码校验（闸3）

// send_web_image 的 SSRF 防护：拒绝内网地址（私网段/环回/链路本地）
function _isPrivateNetworkUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal') return true;
    if (/^\[::1\]$/.test(host) || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return true;
    const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      if (a === 127 || a === 10 || a === 0) return true;                       // 环回/A/本网
      if (a === 172 && b >= 16 && b <= 31) return true;                        // B
      if (a === 192 && b === 168) return true;                                 // C
      if (a === 169 && b === 254) return true;                                 // 链路本地（云元数据）
    }
    return false;
  } catch {
    return true;   // 解析失败按内网拒绝（宁枉勿纵）
  }
}

// 多值参数归一化：JSON 数组 / 逗号分隔字符串（中英文逗号）/ 单值 → string[]（去空）
// send_sticker 的 sticker、send_message 的 mediaId、send_web_image 的 imageUrl
// 均可传单个或多个（AI 一次发多张图/多个表情包）
function _toList(v) {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(x => String(x).trim()).filter(Boolean);
    } catch { /* 不是 JSON 数组 → 按逗号分隔处理 */ }
  }
  return s.split(/[,，]/).map(x => x.trim()).filter(Boolean);
}

// 群聊复合 callerId（g:{chatroomId}:{memberId}，群 session 工具调用用）：
// 解析出实际操作者 memberId 与群 id；非该格式返回 null
function _parseGroupCaller(callerId) {
  const s = String(callerId || '');
  if (!s.startsWith('g:')) return null;
  const rest = s.slice(2);
  const idx = rest.lastIndexOf(':');
  if (idx <= 0 || idx >= rest.length - 1) return null;
  const chatroomId = rest.slice(0, idx);
  const memberId = rest.slice(idx + 1);
  if (!chatroomId.endsWith('@chatroom') || !memberId) return null;
  return { chatroomId, memberId };
}

// 参考图：mediaId（img-xxx，来自上下文她发来的图片）→ Agnes 可用的图片源
// 返回 { dataUri, url, b64 }（至少一个非 null）；都失败 → null + 日志。
// 通道约定（Agnes 官方 + 社区实测）：
//   生图    接受 Data URI / 公网 URL → dataUri 优先，url 兜底
//   生视频  reference 模式要公网 URL 或裸 base64（带 data: 前缀会 Incorrect padding）→ url 优先，b64 兜底
// 之前静默降级文生导致「传了参考图却没参考」，这里失败必留日志。
function _resolveRefImageSource(mediaId) {
  if (!steward || !mediaId) { console.warn('[MediaGen] 参考图解析失败：mediaId 为空'); return null; }
  let m = steward.getMedia ? steward.getMedia(String(mediaId)) : null;
  if (!m) {
    console.warn(`[MediaGen] 参考图解析失败：媒体不存在或已过期 ${mediaId}`);
    return null;
  }
  if (m.kind !== 'image' && !/^image\//.test(String(m.mime || ''))) {
    console.warn(`[MediaGen] 参考图解析失败：非图片附件 ${mediaId} (kind=${m.kind}, mime=${m.mime})`);
    return null;
  }
  // 图片可能是 lazy 登记（仅 CDN 直链）或本地文件已被磁盘 GC 清理 → 本地 path 可用就用，
  // 否则直接退回 CDN 直链（Agnes 可拉取公网图）。保持同步（此处不能 await）。
  const cdnUrl = m && /^https?:\/\//i.test(String(m.cdnUrl || '')) ? String(m.cdnUrl).trim() : '';
  const out = { dataUri: null, url: null, b64: null };
  if (m.path && fs.existsSync(m.path)) {
    try {
      const buf = fs.readFileSync(m.path);
      if (buf && buf.length > 0) {
        const ext = path.extname(m.path).replace('.', '').toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }[ext] || m.mime || 'image/png';
        out.b64 = buf.toString('base64');
        out.dataUri = `data:${mime};base64,${out.b64}`;
      } else {
        console.warn(`[MediaGen] 参考图文件为空 ${mediaId}: ${m.path}`);
      }
    } catch (e) {
      console.warn(`[MediaGen] 参考图文件读取失败 ${mediaId}: ${e.message}`);
    }
    try { out.url = steward.channel._toMediaUrl(m.path); }
    catch (e) { console.warn(`[MediaGen] 参考图 URL 生成失败 ${mediaId}: ${e.message}`); }
  } else if (cdnUrl) {
    out.url = cdnUrl;   // 本地不可用但 CDN 直链有效 → 直接给 Agnes 拉取
    console.log(`[MediaGen] 参考图使用 CDN 直链 ${mediaId}`);
  }
  if (!out.dataUri && !out.url) return null;
  return out;
}

// CSV 单行解析（状态机：引号包裹字段可含逗号，"" 转义为引号）——send_file 生成 xlsx 用
function parseCsvLine(line) {
  const cells = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

// 转发落上下文：send_message 转发成功后，向接收方的 dsh session 注入静默系统事件
// （随她下一条消息送入），让接收方的 AI 知道「我转达过这条消息」——否则她事后
// 问起时 AI 完全不知情。匿名时不告知 AI 发送者身份（防说漏嘴）。
function _noteRelayToContext(targetMemberId, anonymous, sender, text, medias) {
  try {
    if (!dshEngine || !dshEngine.available) return false;
    const mediaDesc = (medias && medias.length > 0)
      ? `，附 ${medias.length} 个附件（${medias.map(m => m.kind === 'image' ? '图片' : `文件 ${m.fileName}`).join('、')}）`
      : '';
    const body = text ? `：「${text}」` : '（无文字，仅附件）';
    const event = anonymous
      ? `你刚才给当前成员匿名转达了一条消息${body}${mediaDesc}。发送者要求匿名——无论她怎么问都不能透露是谁发的。她之后提起时你知道是你转达的；她不提就别主动说。`
      : `你刚才给当前成员转达了一条消息（来自 ${sender.name}（学号 ${sender.id}））${body}${mediaDesc}。这是你作为管家的正常转达；她之后提起时你知道来龙去脉，她不提就别主动说。`;
    return dshEngine.injectSystemEvent(String(targetMemberId), event);
  } catch {
    return false; // 注入失败不影响转发本身
  }
}

// 内部二次 dispatch（审批流自动执行用）：HTTP 回环自身端点，复用全部闸逻辑
async function _dispatchAgentTool(action, params) {
  const port = process.env.PORT || 3001;
  const res = await fetch(`http://127.0.0.1:${port}/api/internal/agent-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': CLI_API_KEY },
    body: JSON.stringify({ action, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `内部执行失败 ${res.status}`);
  return json;
}

app.post('/api/internal/agent-tool', express.json(), async (req, res) => {
  const authHeader = req.headers['x-internal-auth'];
  if (!authHeader || authHeader !== CLI_API_KEY) {
    return res.status(401).json({ error: '未授权访问' });
  }
  const { action, ...params } = req.body || {};
  if (!action) return res.status(400).json({ error: '缺少 action' });

  try {
    const members = getMembers();
    const findMember = (id) => members.find(m => String(m.id) === String(id));

    // 管理员密码校验（config.adminPasswords bcrypt 比对）
    const verifyAdminPwd = (password) => {
      if (!password) return false;
      const bcrypt = require('bcryptjs');
      try {
        const config = readConfig();
        return (config.adminPasswords || []).some(hash => bcrypt.compareSync(password, hash));
      } catch { return false; }
    };

    // 系统管理员（callerId 命中即视为通过密码闸；DSH_ADMIN_IDS 可扩展）
    const ADMIN_MEMBER_IDS = (process.env.DSH_ADMIN_IDS || '612').split(',').map(s => s.trim()).filter(Boolean);
    // 管理员上下文（微信「管理员登录 名称 管理员密码」注册，形如 admin-张三）：
    // 登录时已验过管理员密码，callerId 命中即具备管理员权限（免密敏感操作）
    const { isAdminContextId } = require('./data/adminContexts');
    const isAdminCaller = (callerId) => {
      if (!callerId) return false;
      if (ADMIN_MEMBER_IDS.includes(String(callerId))) return true;
      return isAdminContextId(String(callerId));
    };
    // 密码或管理员身份任一通过
    const verifyAdmin = (password, callerId) => verifyAdminPwd(password) || isAdminCaller(callerId);

    // 审批流存储（转发到管理员的待批请求）
    const PENDING_APPROVALS_FILE = path.join(DATA_DIR, 'pending_approvals.json');
    const readApprovals = () => { try { return readJSON(PENDING_APPROVALS_FILE) || []; } catch { return []; } };
    const writeApprovals = (list) => writeJSON(PENDING_APPROVALS_FILE, list);
    // 审批通过后可自动执行的白名单 action（内部二次 dispatch）
    const APPROVABLE_ACTIONS = ['submit_schedule', 'notify_all', 'submit_notice'];

    // 群聊 callerId 统一收口：发送类工具保留复合格式（群路由需要）；
    // 其余工具——普通成员群内一律隐私闸拒绝（引导私聊），管理员归一化为
    // 实际操作者放行（群内管理操作等同私聊权限）。
    // 白名单含：路由工具 + 公共/娱乐类（搜索/表情清单/生图/生视频/媒体发送）+
    // 班级公开数据查询（无密码闸，群里查询无隐私泄露）；个人敏感操作保持拒绝。
    const GROUP_ROUTED_ACTIONS = new Set([
      'send_sticker', 'send_web_image', 'send_local_image', 'send_message', 'group_coverage', 'submit_schedule', 'read_file', 'send_file',
      'web_search', 'fetch_url', 'send_workspace_file', 'save_attachment', 'query_stickers', 'generate_image', 'generate_video', 'send_media', 'media_list',
      'my_groups', 'talk_to_group', 'talk_to_member', 'shared_registry', 'video_understand', 'post_moment',
      'query_scores', 'query_academic', 'query_fitness', 'query_members', 'query_rank',
      'query_duties', 'query_notices', 'query_injured', 'query_makeup',
    ]);
    // 普通模式（guest-* 用户 / 普通模式群）可用动作：纯聊天娱乐+内容消费，不碰任何班级数据。
    // 安全：不提供任何普通用户名单查询动作——AI 只能由用户口述精确姓名触发匹配，防反向枚举。
    const ORDINARY_ALLOWED_ACTIONS = new Set([
      'send_sticker', 'web_search', 'send_web_image', 'generate_image', 'generate_video',
      'send_media', 'media_list', 'read_file', 'send_file', 'query_stickers', 'video_understand',
      'create_automation', 'list_automations', 'delete_automation', 'toggle_automation',
    ]);
    const gcEntry = _parseGroupCaller(params.callerId);
    if (gcEntry && !GROUP_ROUTED_ACTIONS.has(action)) {
      if (!isAdminCaller(gcEntry.memberId)) {
        return res.status(403).json({ error: '群聊里这个操作请私聊我处理呀（群里不动个人数据）' });
      }
      params.callerId = gcEntry.memberId;   // 管理员：以实际操作者身份继续
    }

    // 普通会话判定：私聊 guest-*（普通模式用户）或普通模式群（群里任何人都算普通上下文）
    const ordinaryMod = require('./data/ordinaryUsers');
    const gcO = _parseGroupCaller(params.callerId);
    const gcOrdinary = !!gcO && steward?.groups?.[gcO.chatroomId]?.mode === 'ordinary';
    const ordinarySession = ordinaryMod.isOrdinaryContextId(params.callerId)
      || (!!gcO && (gcOrdinary || ordinaryMod.isOrdinaryContextId(gcO.memberId)));
    // 普通模式会话处于超限时额外放行的动作：工作区文件收发/附件落盘/截图发送/读链接
    //（原生工作区能力，仍不含任何班级数据动作）
    const OVERDRIVE_ORDINARY_EXTRAS = new Set(['send_workspace_file', 'save_attachment', 'send_local_image', 'fetch_url', 'shared_registry']);
    const ovMod = require('./utils/overdriveState');
    const ovOn = gcO
      ? !!(steward && ovMod.isEnabled('group', gcO.chatroomId))
      : ordinaryMod.isOrdinaryContextId(params.callerId) && ovMod.isEnabled('dm', String(params.callerId));
    // 平台数据动作对普通会话一律 403（switch 前拦截，不进任何平台 case；超限普通会话除外）
    if (ordinarySession && !ORDINARY_ALLOWED_ACTIONS.has(action)
      && !(ovOn && OVERDRIVE_ORDINARY_EXTRAS.has(action))) {
      return res.status(403).json({ error: '我现在是普通模式，不查班级/平台数据、不录不批、不做平台群操作——这类操作我帮你做不了呀' });
    }
    // 已知会话身份（成员 / 管理员上下文 / 普通模式用户）——普通白名单 case 的 callerId 校验统一用它。
    // 普通模式群（gcOrdinary）额外放行任意群内身份（含未绑定 wxid 临时身份）：群内人人可 @AI 娱乐，
    // 平台/敏感动作仍会被 ordinarySession 的 ORDINARY_ALLOWED_ACTIONS 白名单拦截，无越权风险。
    const isKnownCaller = (c) => !!c && (!!findMember(String(c)) || isAdminCaller(String(c)) || ordinaryMod.isOrdinaryContextId(String(c)) || (gcOrdinary && !!String(c)));
    // 跨会话发送目标解析：学号 → 平台成员；否则精确普通昵称 → 普通模式用户（guest-x）。
    // 安全：普通用户名单对 AI 不可见，只能用户口述精确姓名做全等匹配；错误提示不泄露名单存在性。
    const resolveRelayTarget = (key) => {
      if (key === undefined || key === null || String(key).trim() === '') return null;
      const k = String(key).trim();
      const member = findMember(k);
      if (member) return { kind: 'member', id: String(member.id), name: member.name };
      if (ordinaryMod.exists(k)) return { kind: 'guest', id: ordinaryMod.contextIdOf(k), name: k };
      return null;
    };

    // 朋友圈素材解析：mediaId（她发来的图片/视频附件，私聊或所在群）→ 本地文件 → 公网 URL；
    // 已是 http(s) 直链原样返回。无权限/文件失效 → null。
    const resolveSnsMedia = async (ref, effCaller, gc) => {
      const r = String(ref || '').trim();
      if (/^https?:\/\//i.test(r)) return r;
      if (!steward || !steward.getMedia) return null;
      const m = steward.getMedia(r);
      if (!m) return null;
      const allowed = isAdminCaller(String(effCaller))
        || String(m.fromMember) === String(effCaller)
        || (gc && m.fromGroup === gc.chatroomId);
      if (!allowed) return null;
      let full = m;
      if (!full.path || !fs.existsSync(full.path)) {
        full = steward.ensureMediaContent ? await steward.ensureMediaContent(r) : null;
      }
      if (!full || !full.path || !fs.existsSync(full.path)) return null;
      try { return await steward.channel._toMediaUrl(full.path); } catch { return null; }
    };

    switch (action) {
      // ---------- 查询类 ----------
      // 班级公开数据（六维评分/学习成绩/体测/名册/伤病）：任何成员可查，无需密码
      // 个人敏感数据（经历/心情/打卡明细）：仅本人，查他人需管理员密码
      case 'query_scores': {
        const { memberId, week } = params;
        const target = findMember(memberId);
        if (!target) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        const semesterId = getCurrentSemesterId();
        const weekNum = week || getCurrentWeek(semesterId);
        const weekScores = readScoresByWeek(weekNum, semesterId);
        const records = weekScores.filter(s => String(s.memberId) === String(memberId));
        return res.json({ week: weekNum, semesterId, count: records.length, records });
      }

      case 'query_academic': {
        // 学习成绩（班级公开数据）
        const { memberId } = params;
        if (!findMember(memberId)) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        const academicScores = readJSON(ACADEMIC_SCORES_FILE);
        const record = academicScores.find(a => String(a.memberId) === String(memberId));
        if (!record) return res.json({ memberId: String(memberId), found: false, message: '该成员暂无学习成绩数据' });
        const entries = Object.entries(record.scores || {});
        return res.json({ memberId: String(memberId), name: record.name, count: entries.length, scores: record.scores });
      }

      case 'query_fitness': {
        // 体测成绩（班级公开数据，含身高/体重/BMI/3000米/力量等）
        const { memberId } = params;
        if (!findMember(memberId)) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        const fitnessScores = readJSON(FITNESS_SCORES_FILE);
        const record = fitnessScores.find(f => String(f.memberId) === String(memberId));
        if (!record) return res.json({ memberId: String(memberId), found: false, message: '该成员暂无体测数据' });
        const history = (record.history || []).slice().sort((a, b) => String(b.month).localeCompare(String(a.month)));
        return res.json({
          memberId: String(memberId), name: record.name,
          latestMonth: history[0]?.month || null,
          latest: history[0]?.scores || null,
          historyCount: history.length,
          history: history.slice(0, 3).map(h => ({ month: h.month, scores: h.scores })),
        });
      }

      case 'query_members': {
        const { class: className } = params;
        let list = members.map(m => ({
          id: m.id, name: m.name, class: m.class, position: m.position || null,
        }));
        if (className) list = list.filter(m => m.class === className);
        return res.json({ count: list.length, members: list });
      }

      case 'query_schedule': {
        const { memberId, date } = params;
        if (!findMember(memberId)) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        const scheduleStore = require('./data/scheduleStore');
        const day = date || beijingISO().substring(0, 10);
        const items = scheduleStore.getSchedulesByDate(day, memberId) || [];
        return res.json({ date: day, count: items.length, items });
      }

      case 'query_injured': {
        // 伤病号名单（班级公开信息，全员可查）
        const injuryStatus = readInjuryStatus();
        const injured = Object.entries(injuryStatus)
          .filter(([, v]) => v?.isInjured)
          .map(([id, v]) => {
            const m = findMember(id);
            return { memberId: id, name: m?.name || null, class: m?.class || null, injuryDate: v.injuryDate || null };
          });
        let list = injured;
        if (params.class) list = list.filter(i => i.class === params.class);
        return res.json({ count: list.length, injured: list });
      }

      case 'query_experiences': {
        // 查成员经历记录（闸3：只能查自己的）
        const { memberId, password } = params;
        const target = findMember(memberId);
        if (!target) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        if (params.callerId && String(params.callerId) !== String(memberId) && !verifyAdmin(password, params.callerId)) {
          return res.status(403).json({ error: '查询他人经历需要管理员密码' });
        }
        const experiences = readJSON(EXPERIENCES_FILE).filter(e => String(e.memberId) === String(memberId));
        return res.json({ count: experiences.length, experiences: experiences.slice(-20) });
      }

      case 'query_bmi': {
        const { memberId } = params;
        if (!findMember(memberId)) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        const semesterId = getCurrentSemesterId();
        const weekNum = getCurrentWeek(semesterId);
        // 直接读取该学期最新一期 BMI 数据（按周文件倒序找最近存在的）
        let bmiData = null, actualWeek = null;
        for (let w = weekNum; w >= 1 && !bmiData; w--) {
          const bmiPath = getScoresDir(semesterId) + `/bmi_week_${w}.json.gz`;
          if (fs.existsSync(bmiPath)) {
            try {
              bmiData = JSON.parse(zlib.gunzipSync(fs.readFileSync(bmiPath)).toString('utf8'));
              actualWeek = w;
            } catch {}
          }
        }
        const fixed = readFixedHeights();
        const record = (bmiData && bmiData[memberId]) || null;
        return res.json({ week: actualWeek, semesterId, height: fixed ? fixed[memberId] : null, record });
      }

      // ---------- 写入类（敏感：强制管理员密码） ----------
      case 'submit_score': {
        const { memberId, evaluatorId, type, week, scores, password } = params;
        if (!verifyAdmin(password, params.callerId)) {
          return res.status(403).json({ error: '管理员密码错误（敏感操作必需）' });
        }
        if (!findMember(memberId) || !findMember(evaluatorId)) {
          return res.status(404).json({ error: '成员不存在' });
        }
        if (type !== 'self' && type !== 'peer') {
          return res.status(400).json({ error: 'type 必须是 self 或 peer' });
        }
        let scoresObj;
        try { scoresObj = typeof scores === 'string' ? JSON.parse(scores) : scores; } catch {
          return res.status(400).json({ error: 'scores 不是合法 JSON' });
        }
        for (const v of Object.values(scoresObj)) {
          if (typeof v !== 'number' || v % 0.5 !== 0) {
            return res.status(400).json({ error: '评分必须是0.5的倍数' });
          }
        }
        const semesterId = getCurrentSemesterId();
        const weekNum = week || getCurrentWeek(semesterId);
        const weekScores = readScoresByWeek(weekNum, semesterId);
        const existing = weekScores.find(s => String(s.memberId) === String(memberId) && String(s.evaluatorId) === String(evaluatorId));
        if (existing) {
          return res.status(400).json({ error: `第${weekNum}周 ${evaluatorId} 已对 ${memberId} 评过分` });
        }
        const newScore = {
          id: uuidv4(), week: weekNum, memberId: String(memberId), evaluatorId: String(evaluatorId),
          type, scores: scoresObj, subItemScores: {}, timestamp: beijingISO(),
        };
        weekScores.push(newScore);
        writeScoresByWeek(weekNum, weekScores, semesterId);
        invalidateWeekCache(weekNum, semesterId);
        io.emit('scoreUpdated', newScore);
        return res.json({ success: true, record: newScore });
      }

      case 'submit_experience': {
        // 填写经历（数据立体化·对话录入通道）：仅限本人，无需密码
        const { memberId, type, data, title } = params;
        if (!findMember(memberId)) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        // 闸3：只能给自己填（uploader = caller）
        if (params.callerId && String(params.callerId) !== String(memberId)) {
          return res.status(403).json({ error: '只能填写自己的经历（替他人录入需走管理员导入）' });
        }
        if (!type || !data) return res.status(400).json({ error: '缺少 type 或 data' });
        const experiences = readJSON(EXPERIENCES_FILE);
        const newExperience = {
          id: uuidv4(),
          memberId: String(memberId),
          uploaderId: String(params.callerId || memberId),
          type,
          data,
          ...(title ? { title } : {}),
          createdAt: beijingISO(),
        };
        experiences.push(newExperience);
        writeJSON(EXPERIENCES_FILE, experiences);
        return res.json({ success: true, record: newExperience });
      }

      case 'submit_schedule': {
        // 创建日程/公差/值日安排：仅给自己创建无需密码；涉及他人需管理员密码（L2 班务提案语义）。
        // 三种独立类型：个人日程（私聊，只提醒自己）/ 全员公共日程（私聊 isGlobal，提醒全员+开启的群）
        // / 群日程（群聊创建，只在该群提醒，不推全员）。
        const { title, description, dueAt, targetMemberIds, password, callerId } = params;
        let { isGlobal } = params;
        // 群 session（callerId=g:群id:学号）：仅管理员可增；创建的是群日程——只在该群提醒，
        // 不强制全员公共（群日程是独立类型，与全员公共日程分开）
        const gcSched = _parseGroupCaller(callerId);
        const effCallerSched = gcSched ? gcSched.memberId : callerId;
        if (gcSched) {
          if (!isAdminCaller(effCallerSched)) {
            return res.status(403).json({ error: '群里只有管理员能安排日程（个人日程私聊我安排呀）' });
          }
          isGlobal = false;
        }
        if (!title || !dueAt) return res.status(400).json({ error: '缺少 title 或 dueAt' });
        // 兼容数组 / 逗号分隔字符串 / 单值
        let targets = [];
        if (Array.isArray(targetMemberIds)) targets = targetMemberIds.map(String);
        else if (typeof targetMemberIds === 'string' && targetMemberIds.trim()) {
          targets = targetMemberIds.split(/[,，\s]+/).filter(Boolean).map(String);
        } else if (targetMemberIds != null) targets = [String(targetMemberIds)];
        // 无 callerId（身份不明）或涉及他人/全员 → 敏感（系统管理员 callerId 直通）
        const involvesOthers = !effCallerSched || !!isGlobal || targets.some(t => t !== String(effCallerSched));
        if (involvesOthers && !verifyAdmin(password, effCallerSched)) {
          return res.status(403).json({ error: '安排涉及他人的公差/日程需要管理员密码' });
        }
        for (const t of targets) {
          if (!findMember(t)) return res.status(404).json({ error: `成员 ${t} 不存在` });
        }
        const scheduleStore = require('./data/scheduleStore');
        const schedule = scheduleStore.createSchedule({
          title,
          description: description || '',
          dueAt,                                  // 北京时间解析（scheduleStore 内部）
          createdBy: String(effCallerSched || 'agent'),
          targetMemberIds: targets,
          isGlobal: !!isGlobal,
          repeat: params.repeat,                  // 'daily'=每天同一时刻重复定时；'none'/空=一次性
          scope: gcSched ? 'group' : (isGlobal ? 'global' : 'personal'),
          groupChatroomId: gcSched ? gcSched.chatroomId : '',
        });
        return res.json({ success: true, schedule });
      }

      case 'cli_gateway': {
        // 通用文件操作兜底：固定工具不覆盖的长尾场景（权限 = 路径分级 + 身份隔离 + 密码闸 + 审计）
        const { callerId, command, path: rawPath, content, mode, password } = params;
        // 真实成员或管理员上下文（admin-名称）；管理员上下文对 level-1 路径凭 isAdminCaller 免密
        if (!findMember(callerId) && !isAdminCaller(callerId)) {
          return res.status(403).json({ error: 'callerId 无效（必须是真实学号或已注册的管理员上下文）' });
        }
        if (!['list', 'read', 'write', 'delete'].includes(command)) {
          return res.status(400).json({ error: 'command 必须是 list/read/write/delete' });
        }
        // 路径规范化：容忍模型传 "data/xxx"、"\x"、“./xxx”、“.”（根目录）
        let rel = String(rawPath || '').trim().replace(/\\/g, '/')
          .replace(/^data\//i, '').replace(/^\.\//, '').replace(/^\/+/, '');
        if (rel === '.' || rel === 'data') rel = '';
        const full = rel ? safeDataPath(rel) : DATA_DIR;
        if (!full) return res.status(400).json({ error: '非法路径：只能操作 data/ 内的相对路径' });

        const { level, reason } = classifyGatewayPath(rel, String(callerId));
        const need = GATEWAY_NEED[level][command];
        const audit = (ok, extra = {}) => appendAgentCliAudit({
          ts: beijingISO(), callerId: String(callerId), command, path: rel,
          level, ...(mode ? { mode } : {}), ok, ...extra,
        });

        if (need === 9) {
          audit(false, { denied: reason });
          return res.status(403).json({ error: `路径被禁止（${reason}）` });
        }
        if (need === 1 && !verifyAdmin(password, callerId)) {
          audit(false, { denied: '需要管理员密码' });
          return res.status(403).json({ error: `该操作需要管理员密码（${reason}）` });
        }

        // ---- list：列目录（仅结构，最多 500 条，不深入 wechat/apk）----
        if (command === 'list') {
          if (!fs.existsSync(full)) return res.status(404).json({ error: '目录不存在' });
          if (!fs.statSync(full).isDirectory()) return res.status(400).json({ error: '不是目录，请用 read' });
          const items = [];
          const walk = (dir, base, depth) => {
            for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
              if (items.length >= 500) break;
              const r = base ? `${base}/${it.name}` : it.name;
              if (it.isDirectory()) {
                items.push({ path: r, type: 'dir' });
                if (depth < 1 && !['wechat', 'apk'].includes(it.name.toLowerCase())) {
                  walk(path.join(dir, it.name), r, depth + 1);
                }
              } else {
                let size = 0;
                try { size = fs.statSync(path.join(dir, it.name)).size; } catch {}
                items.push({ path: r, type: 'file', size });
              }
            }
          };
          walk(full, rel, 0);
          audit(true);
          return res.json({ base: rel || '.', count: items.length, truncated: items.length >= 500, items });
        }

        // ---- read：读文件（.json.gz 自动解压；JSON 大数组自动截断防上下文爆炸；二进制拒绝）----
        if (command === 'read') {
          if (!fs.existsSync(full)) return res.status(404).json({ error: '文件不存在' });
          const stat = fs.statSync(full);
          if (stat.isDirectory()) return res.status(400).json({ error: '是目录，请用 list' });
          if (stat.size > 20 * 1024 * 1024) return res.status(413).json({ error: '文件过大（>20MB）' });
          let buf = fs.readFileSync(full);
          if (full.endsWith('.json.gz') || full.endsWith('.gz')) {
            try { buf = zlib.gunzipSync(buf); } catch (e) { return res.status(400).json({ error: 'gunzip 失败: ' + e.message }); }
          }
          const ext = path.extname(full.replace(/\.gz$/, '')).toLowerCase();
          const isText = ['.json', '.txt', '.md', '.csv', '.log', ''].includes(ext);
          if (!isText) {
            audit(true, { binary: true });
            return res.json({ path: rel, size: stat.size, encoding: 'binary', content: null,
              hint: '二进制文件不支持文本读取（图片请走图片输入通道）' });
          }
          const text = buf.toString('utf8');
          if (ext === '.json') {
            let parsed = null;
            try { parsed = JSON.parse(text); } catch {}
            if (parsed !== null) {
              const out = JSON.stringify(parsed);
              if (out.length > 512 * 1024) {
                audit(true, { truncated: true });
                if (Array.isArray(parsed)) {
                  return res.json({ path: rel, count: parsed.length, truncated: true, preview: parsed.slice(0, 20) });
                }
                return res.json({ path: rel, truncated: true, keys: Object.keys(parsed), preview: out.substring(0, 512 * 1024) });
              }
              audit(true);
              return res.json({ path: rel, size: stat.size, encoding: 'json', content: parsed });
            }
          }
          const MAX_TEXT = 256 * 1024;
          const truncated = text.length > MAX_TEXT;
          audit(true, { truncated });
          return res.json({ path: rel, size: stat.size, encoding: 'utf8', truncated,
            content: truncated ? text.substring(0, MAX_TEXT) + '\n…[truncated]' : text });
        }

        // ---- write：写文件（JSON 合法性闸 + merge 深合并复用 mergeJSON + .bak 备份 + .json.gz 自动压缩）----
        if (command === 'write') {
          if (content == null || typeof content !== 'string' || !content.trim()) {
            return res.status(400).json({ error: '缺少 content（write 必须提供字符串内容）' });
          }
          if (mode && !['overwrite', 'merge', 'append'].includes(mode)) {
            return res.status(400).json({ error: 'mode 必须是 overwrite/merge/append' });
          }
          const writeMode = mode || 'overwrite';
          const isJson = /\.json(\.gz)?$/.test(full);
          if (isJson) {
            try { JSON.parse(content); } catch {
              return res.status(400).json({ error: 'JSON 文件写入的内容不是合法 JSON' });
            }
          }
          let finalContent = content;
          if ((writeMode === 'merge' || writeMode === 'append') && fs.existsSync(full)) {
            try {
              let origBuf = fs.readFileSync(full);
              if (full.endsWith('.json.gz')) origBuf = zlib.gunzipSync(origBuf);
              const origText = origBuf.toString('utf8');
              if (isJson) {
                const origJson = JSON.parse(origText);
                const patch = JSON.parse(content);
                if (writeMode === 'merge') {
                  finalContent = mergeJSON(origJson, patch);
                } else {
                  if (!Array.isArray(origJson)) return res.status(400).json({ error: 'append 模式仅支持数组 JSON' });
                  finalContent = [...origJson, ...(Array.isArray(patch) ? patch : [patch])];
                }
              } else if (writeMode === 'append') {
                finalContent = origText + (origText.endsWith('\n') ? '' : '\n') + content;
              } else {
                return res.status(400).json({ error: 'merge 模式仅支持 JSON 文件' });
              }
            } catch (e) {
              return res.status(400).json({ error: '原文件解析失败: ' + e.message });
            }
          }
          let buf = typeof finalContent === 'string'
            ? Buffer.from(finalContent, 'utf8')
            : Buffer.from(JSON.stringify(finalContent, null, 2), 'utf8');
          fs.mkdirSync(path.dirname(full), { recursive: true });
          if (fs.existsSync(full)) {
            try { fs.copyFileSync(full, full + '.bak'); } catch {}
          }
          if (full.endsWith('.json.gz')) buf = zlib.gzipSync(buf);
          fs.writeFileSync(full, buf);
          const stat = fs.statSync(full);
          audit(true, { size: stat.size });
          return res.json({ success: true, path: rel, mode: writeMode, size: stat.size });
        }

        // ---- delete：删文件（先备份 .bak；不删目录）----
        if (command === 'delete') {
          if (!fs.existsSync(full)) return res.status(404).json({ error: '文件不存在' });
          const stat = fs.statSync(full);
          if (stat.isDirectory()) return res.status(400).json({ error: '不能删除目录' });
          try { fs.copyFileSync(full, full + '.bak'); } catch {}
          fs.unlinkSync(full);
          audit(true);
          return res.json({ success: true, path: rel, backup: rel + '.bak' });
        }
        return res.status(400).json({ error: `未知 command: ${command}` });
      }

      case 'notify_member': {
        const { memberId, text, password } = params;
        // 群 session：按实际操作者校验管理员身份
        const gcNm = _parseGroupCaller(params.callerId);
        if (!verifyAdmin(password, gcNm ? gcNm.memberId : params.callerId)) {
          return res.status(403).json({ error: '管理员密码错误（敏感操作必需）' });
        }
        if (!steward) {
          return res.status(400).json({ error: '微信管家未启用' });
        }
        const result = await steward.sendToMember(memberId, text);
        return res.json(result);
      }

      // ---------- 新增查询类（班级公开数据） ----------

      case 'query_rank': {
        // 学业排名（班级公开：各学期成绩排名/年级排名）
        const { memberId } = params;
        if (!findMember(memberId)) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        const rankScores = readJSON(RANK_SCORES_FILE);
        const record = rankScores.find(r => String(r.memberId) === String(memberId));
        if (!record) return res.json({ memberId: String(memberId), found: false, message: '该成员暂无排名数据' });
        return res.json({ memberId: String(memberId), name: record.name, semesterScores: record.semesterScores, yearRanks: record.yearRanks });
      }

      case 'query_duties': {
        // 值日安排（班级公开：日期/内容/参与者）
        const { memberId, date } = params;
        const duties = readJSON(DUTIES_FILE);
        let list = duties;
        if (date) list = list.filter(d => String(d.time).startsWith(String(date)));
        if (memberId) list = list.filter(d => (d.memberIds || []).map(String).includes(String(memberId)));
        return res.json({ count: list.length, duties: list.slice(-20).reverse() });
      }

      case 'query_notices': {
        // 通知公告（班级公开）
        const notices = readJSON(NOTICES_FILE);
        return res.json({ count: notices.length, notices: notices.slice(-10).reverse() });
      }

      case 'query_makeup': {
        // 补测周期（班级公开：第几周截止）
        const periods = readJSON(MAKEUP_PERIODS_FILE);
        const now = beijingISO();
        const list = periods.map(p => ({ ...p, expired: p.endTime < now }));
        return res.json({ count: list.length, periods: list.reverse() });
      }

      case 'query_checkin': {
        // 打卡记录（个人敏感：本人免密，他人需管理员密码）
        const { memberId, password } = params;
        if (!findMember(memberId)) return res.status(404).json({ error: `成员 ${memberId} 不存在` });
        if (params.callerId && String(params.callerId) !== String(memberId) && !verifyAdmin(password, params.callerId)) {
          return res.status(403).json({ error: '查询他人打卡需要管理员密码' });
        }
        const checkinStore = require('./data/checkin_records/store');
        const records = checkinStore.readRecords(String(memberId));
        return res.json({ memberId: String(memberId), count: records.length, records: records.slice(-14) });
      }

      case 'submit_checkin': {
        // 每日一问回答落库（AI 会话内回答路径；记录格式与 /api/checkin/feedback 一致）
        const { callerId, memberId, text, mood, tags } = params;
        // 成员或已注册管理员上下文（admin-名称，回答落库供 hasAnsweredToday 判重）
        if (!callerId || (!findMember(callerId) && !isAdminContextId(callerId))) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const target = memberId ? String(memberId) : String(callerId);
        if (String(callerId) !== target) {
          return res.status(403).json({ error: '只能记录自己的每日一问回答' });
        }
        if (!text || !String(text).trim()) return res.status(400).json({ error: '缺少 text（回答内容）' });
        const checkinStore = require('./data/checkin_records/store');
        const t = String(text).trim();
        // 轻量异常信号（与 /api/checkin/feedback 同规则）：伤病词 / 人际风险 / 连续情绪低迷
        const anomalySignals = [];
        if (/伤|疼|痛|病|复发|扭|拉伤|骨折/i.test(t)) anomalySignals.push('injury');
        if (/孤立|针对|排挤|欺负|冷落|没人理|被骂/i.test(t)) anomalySignals.push('social_risk');
        const recentMoods = checkinStore.getRecentMoods(target, 7).map(m => m.mood);
        if (recentMoods.filter(m => ['😤', '😢', '😰', '😞'].includes(m)).length >= 3) {
          anomalySignals.push('consecutive_negative_mood');
        }
        const record = {
          memberId: target, type: 'question',
          mood: mood ? String(mood) : null,
          tags: Array.isArray(tags) ? tags.map(String) : [],
          text: t,
          feedback: '', feedbackTier: t.length > 20 ? 'insight' : 'connection',
          anomalyDetected: anomalySignals.length > 0,
          anomalySignals,
          actions: anomalySignals.length > 0 ? ['auto_notified_admin'] : [],
          source: 'wechat_agent', timestamp: beijingISO(),
        };
        checkinStore.writeRecord(target, record);
        // 异常信号 → 通知系统管理员（微信管家直发）
        if (anomalySignals.length > 0 && steward) {
          const member = findMember(target);
          const name = member ? `${member.name}（${member.class}）` : target;
          const signalTexts = {
            injury: '每日一问回答中检测到伤病情信号，请核实',
            social_risk: '每日一问回答中检测到人际冲突信号，请关注',
            consecutive_negative_mood: '连续多日情绪低迷，建议关注',
          };
          const detail = anomalySignals.map(s => signalTexts[s] || s).join('；');
          for (const adminId of ADMIN_MEMBER_IDS) {
            if (findMember(adminId)) {
              steward.sendToMember(String(adminId), `【异常预警】${name}：${detail}`).catch(() => {});
            }
          }
        }
        return res.json({ success: true, recorded: true, ...(anomalySignals.length > 0 ? { anomalySignals } : {}) });
      }

      case 'set_prefs': {
        // 主动消息功能开关（仅本人，无需密码）：不传 prefs = 查询；支持 all 批量
        const { callerId, prefs } = params;
        // 成员或已注册管理员上下文（admin-名称，管理员上下文同样收推送可开关）
        if (!callerId || (!findMember(callerId) && !isAdminContextId(callerId))) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const prefsStore = require('./data/proactivePrefs');
        if (prefs === undefined || prefs === null || prefs === '') {
          const current = prefsStore.getPrefs(callerId);
          return res.json({ success: true, prefs: current, features: prefsStore.FEATURES, labels: prefsStore.FEATURE_LABELS });
        }
        let patch;
        try { patch = typeof prefs === 'string' ? JSON.parse(prefs) : prefs; }
        catch { return res.status(400).json({ error: 'prefs 必须是合法 JSON 对象字符串' }); }
        if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
          return res.status(400).json({ error: 'prefs 必须是 JSON 对象，如 {"daily_question": false} 或 {"all": false}' });
        }
        // 批量：all → 展开为全部功能
        if ('all' in patch) {
          const v = !!patch.all;
          patch = Object.fromEntries(prefsStore.FEATURES.map(f => [f, v]));
        }
        const bad = Object.keys(patch).filter(k => !prefsStore.FEATURES.includes(k));
        if (bad.length > 0) {
          return res.status(400).json({ error: `未知功能: ${bad.join(',')}（可选: ${prefsStore.FEATURES.join('/')}/all）` });
        }
        const updated = prefsStore.setPrefs(callerId, patch);
        return res.json({ success: true, prefs: updated, labels: prefsStore.FEATURE_LABELS });
      }

      // ---------- 通信类 ----------

      case 'send_message': {
        // 成员互发消息（全量开放）：A 通过管家转发给 B，消息带发送者身份（防伪造）。
        // mediaId：转发她发来的图片/文件（媒体库 7 天有效，只能转发自己的附件）。
        // anonymous：发送者选择匿名 → 对方只看到「有人托我转达」，不显示署名。
        // 群 session（callerId=g:群id:学号）：群内触发但转发仍走私聊（附件/内容不刷群）。
        const { callerId, targetMemberId, text, mediaId, anonymous } = params;
        const gcMsg = _parseGroupCaller(callerId);
        const effCallerMsg = gcMsg ? gcMsg.memberId : callerId;
        if (!effCallerMsg || !findMember(effCallerMsg)) return res.status(403).json({ error: 'callerId 无效' });
        const hasText = !!String(text || '').trim();
        const hasMedia = mediaId !== undefined && mediaId !== null && String(mediaId) !== '';
        if (!hasText && !hasMedia) return res.status(400).json({ error: '缺少 text 或 mediaId' });
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        const sender = findMember(effCallerMsg);
        // 自然口吻：不再加「XX 托我转达」系统前缀——文本由发送方 AI 组织
        //（人设要求自然带来源，如「A 让我跟你说…」）；来源记忆仍注入接收方上下文
        // （_noteRelayToContext），她问起时接收方 AI 能答。anonymous 时不注入来源。

        // 多目标（一次转发给多人）：目标 = 学号或精确普通昵称，逗号分隔/数组。
        // mediaId 支持多个——一次转发多张图/多个文件；文件类优先 CDN 直转。
        const targetKeys = _toList(targetMemberId);
        if (targetKeys.length === 0) return res.status(400).json({ error: '缺少 targetMemberId' });
        if (targetKeys.length > 20) return res.status(400).json({ error: '一次最多发给 20 个目标' });
        const tgtList = targetKeys.map(k => ({ k, t: resolveRelayTarget(k) }));
        const missOne = tgtList.find(x => !x.t);
        if (missOne) {
          return res.status(404).json({ error: `找不到目标「${missOne.k}」：学号核对一下；普通模式用户请给精确昵称（名单不对外显示，给不对发不了）` });
        }
        if (tgtList.some(x => x.t.id === String(effCallerMsg))) {
          return res.status(400).json({ error: '不能给自己发转发消息' });
        }
        // 附件归属按发送者校验一次（目标共享同一批附件）
        let medias = [];
        let mediaNote = '';
        if (hasMedia) {
          const ids = _toList(mediaId);
          if (ids.length === 0) return res.status(400).json({ error: 'mediaId 为空' });
          if (ids.length > 9) return res.status(400).json({ error: '一次最多转发 9 个附件' });
          for (const id of ids) {
            const media = steward.getMedia ? steward.getMedia(String(id)) : null;
            if (!media) return res.status(404).json({ error: `附件 ${id} 不存在或已过期（7 天内有效）` });
            const own = String(media.fromMember) === String(effCallerMsg)
              || isAdminCaller(effCallerMsg)
              || (gcMsg && media.fromGroup === gcMsg.chatroomId);
            if (!own) return res.status(403).json({ error: '只能转发自己发来的附件（群里收到的附件在群里让我转）' });
            medias.push({ media, id });
          }
          mediaNote = hasText ? '' : (medias.length > 1
            ? `（${medias.length} 个附件）`
            : (medias[0].media.kind === 'image' ? '（一张图片）' : `（文件 ${medias[0].media.fileName}）`));
        }
        const sendToTarget = async (tid) => {
          if (hasText || mediaNote) {
            const rr = await steward.sendToMember(tid, hasText ? String(text).trim() : mediaNote);
            if (!rr?.success) throw new Error(rr?.error || '发送失败');
          }
          for (const { media, id } of medias) {
            let sent = false;
            if (media.kind === 'file' && media.rawXml && steward.forwardFileTo) {
              const fwd = await steward.forwardFileTo(tid, media.rawXml);
              sent = !!fwd?.success;
              if (!sent) console.warn(`[AgentTool] CDN 直转失败，降级本地发送: ${fwd?.error}`);
            }
            if (!sent) {
              // video：此前可能是 lazy 登记（仅 CDN 直链，未落盘）→ 这里按需下载回填 path
              const needContent = !media.path && (media.kind === 'file' || media.kind === 'video')
                && typeof steward.ensureMediaContent === 'function';
              const full = needContent ? await steward.ensureMediaContent(String(id)) : media;
              if (!full?.path) throw new Error('附件内容获取失败（CDN 已过期？请让她重发）');
              const r = media.kind === 'image'
                ? await steward.sendToMemberImage(tid, full.path)
                : await steward.sendToMemberFile(tid, full.path, full.fileName);
              if (!r?.success) throw new Error(r?.error || '附件发送失败');
            }
          }
        };
        try {
          const sentTargets = [];
          for (const { t } of tgtList) {
            // 先注入、后发送：接收方 B 可能「收到就秒回」，若在全部发送完成后才注入，
            // B 那一轮已消费空的 pending 队列，事件永远追不上（竞态丢上下文）。
            // 注入是同步入队、先于任何网络发送完成 → B 收到消息时事件必已就绪。
            const injected = _noteRelayToContext(t.id, anonymous, anonymous ? null : { name: sender.name, id: String(effCallerMsg) },
              String(text || '').trim(), medias.map(x => x.media));
            try {
              await sendToTarget(t.id);
            } catch (e) {
              // 发送失败：回滚刚注入的事件，避免「以为转过、其实没到」的假上下文
              if (injected && dshEngine && dshEngine.uninjectSystemEvent) dshEngine.uninjectSystemEvent(String(t.id));
              throw e;
            }
            sentTargets.push({ to: t.id, name: t.name });
          }
          return res.json({
            success: true, targets: sentTargets, anonymous: !!anonymous,
            ...(hasMedia ? { media: medias.map(x => x.media.kind) } : {}),
          });
        } catch (e) {
          return res.status(500).json({ error: e.message });
        }
      }

      case 'create_automation': {
        // 定时任务（到点唤醒 AI 执行预设指令，三种 cadence：once/weekly/interval）。
        // 给自己（成员/管理员上下文/普通模式 guest）随时可建；给他人建需管理员。
        const { callerId, name, prompt, onceAt, weekdays, time, everyHours, cadence, runFor, password } = params;
        const gcCa = _parseGroupCaller(callerId);
        const effCallerCa = gcCa ? gcCa.memberId : callerId;
        if (!effCallerCa || !isKnownCaller(effCallerCa)) return res.status(403).json({ error: 'callerId 无效' });
        const guestCa = ordinaryMod.isOrdinaryContextId(effCallerCa);
        if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: '缺少 prompt（到点执行的指令）' });
        let owner = String(effCallerCa);
        if (runFor !== undefined && runFor !== null && String(runFor).trim() !== '') {
          if (guestCa || !verifyAdmin(password, effCallerCa)) {
            return res.status(403).json({ error: '给别人设定时任务需要管理员权限' });
          }
          const t = resolveRelayTarget(String(runFor).trim());
          if (!t) return res.status(404).json({ error: '找不到目标：学号或已注册普通昵称（精确）' });
          owner = t.id;
        }
        const automationStore = require('./data/automationStore');
        try {
          const auto = automationStore.createAutomation({
            name: name || '定时任务', prompt: String(prompt).trim(),
            createdBy: String(effCallerCa), runFor: owner,
            cadence, onceAt, weekdays, time, everyHours,
          });
          return res.json({ success: true, automation: auto });
        } catch (e) {
          return res.status(400).json({ error: e.message });
        }
      }
      case 'list_automations': {
        const { callerId } = params;
        const gcLa = _parseGroupCaller(callerId);
        const effCallerLa = gcLa ? gcLa.memberId : callerId;
        if (!effCallerLa || !isKnownCaller(effCallerLa)) return res.status(403).json({ error: 'callerId 无效' });
        const automationStore = require('./data/automationStore');
        const list = automationStore.read().filter(a => String(a.runFor || a.createdBy) === String(effCallerLa));
        return res.json({ success: true, automations: list });
      }
      case 'delete_automation': {
        const { callerId, automationId } = params;
        const gcDa = _parseGroupCaller(callerId);
        const effCallerDa = gcDa ? gcDa.memberId : callerId;
        if (!effCallerDa || !isKnownCaller(effCallerDa)) return res.status(403).json({ error: 'callerId 无效' });
        const automationStore = require('./data/automationStore');
        const ok = automationStore.deleteAutomation(String(automationId || ''), String(effCallerDa));
        if (!ok) return res.status(404).json({ error: '任务不存在或无权删除' });
        return res.json({ success: true });
      }
      case 'toggle_automation': {
        const { callerId, automationId, enabled } = params;
        const gcTa = _parseGroupCaller(callerId);
        const effCallerTa = gcTa ? gcTa.memberId : callerId;
        if (!effCallerTa || !isKnownCaller(effCallerTa)) return res.status(403).json({ error: 'callerId 无效' });
        const automationStore = require('./data/automationStore');
        const ok = automationStore.toggleEnabled(String(automationId || ''), String(effCallerTa), enabled !== false);
        if (!ok) return res.status(404).json({ error: '任务不存在或无权操作' });
        return res.json({ success: true, enabled: enabled !== false });
      }

      case 'group_coverage': {
        // 群成员 ↔ 平台绑定覆盖率（管理员/群 session 用）：谁在群里、谁已绑定、谁还没绑
        const { callerId, chatroomId } = params;
        const gc = _parseGroupCaller(callerId);
        const effCaller = gc ? gc.memberId : callerId;
        if (!verifyAdmin(null, effCaller)) return res.status(403).json({ error: '仅管理员可查群成员覆盖情况' });
        const roomId = String(chatroomId || (gc ? gc.chatroomId : ''));
        if (!roomId.endsWith('@chatroom')) return res.status(400).json({ error: '缺少 chatroomId（群 session 自动携带；其他场景传入群 id）' });
        if (!steward || typeof steward.groupCoverage !== 'function') {
          return res.status(400).json({ error: '微信管家未启用' });
        }
        try {
          const cov = await steward.groupCoverage(roomId);
          return res.json({ success: true, ...cov });
        } catch (e) {
          return res.status(500).json({ error: `群成员查询失败: ${e.message}` });
        }
      }

      case 'media_list': {
        // 会话可用媒体清单（AI 找回历史附件编号作 refImage / 转发用——上下文滚动后编号易丢）。
        // 私聊 caller → 自己发来的；群 caller → 群内附件；管理员上下文 → 全量（仅摘要，无内容）。
        const { callerId } = params;
        const gcMl = _parseGroupCaller(callerId);
        const effCallerMl = gcMl ? gcMl.memberId : callerId;
        if (!effCallerMl || !isKnownCaller(effCallerMl)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!steward || !steward.listMedia) return res.status(400).json({ error: '微信管家未启用' });
        const list = gcMl
          ? steward.listMedia({ chatroomId: gcMl.chatroomId })
          : isAdminCaller(effCallerMl)
            ? steward.listMedia({})
            : steward.listMedia({ memberId: effCallerMl });
        return res.json({ success: true, count: list.length, media: list });
      }

      case 'read_file': {
        // 按需读取附件内容（表格→文本；收到文件时不自动解析，AI 按需调）。
        // 权限：本人附件 / 管理员 / 群 caller 读取群内出现的附件（群里大家可见）。
        const { callerId, mediaId } = params;
        const gcRead = _parseGroupCaller(callerId);
        const effCallerRead = gcRead ? gcRead.memberId : callerId;
        if (!effCallerRead || !isKnownCaller(effCallerRead)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        const media = steward.getMedia ? steward.getMedia(String(mediaId || '')) : null;
        if (!media) return res.status(404).json({ error: `附件 ${mediaId} 不存在或已过期（7 天内有效）` });
        const allowed = isAdminCaller(effCallerRead)
          || String(media.fromMember) === String(effCallerRead)
          || (gcRead && media.fromGroup === gcRead.chatroomId);
        if (!allowed) {
          return res.status(403).json({ error: '只能读取自己发来的附件（群里收到的附件在群里让我读）' });
        }
        // lazy 入库的文件：此时才从微信 CDN 下载（回填 path，后续读取复用）
        let content = null;
        if (media.kind === 'file') {
          const full = await steward.ensureMediaContent(String(mediaId));
          content = full && steward.parseFileForConversation
            ? steward.parseFileForConversation(full.path) : null;
        }
        return res.json({
          success: true, mediaId: String(mediaId), fileName: media.fileName, kind: media.kind,
          content: content || null,
          ...(content ? {} : { note: '该文件没有可提取的文本内容（如 PDF/图片/二进制），请让她换文本/表格类文件，或描述内容' }),
        });
      }

      case 'send_file': {
        // 生成并发送文件——只产手机能直接打开的格式：表格/数据类 → Excel(.xlsx)；
        // 文字/总结/报告类 → Word(.docx)（md/txt/csv/json 作为"内容格式"统一转成成品）。
        // content 语义：xlsx 传 CSV（首行表头）或 JSON；docx 传 md/纯文字。
        // 目的地：群 caller → 群；targetMemberId → 指定成员；否则 → 自己
        const { callerId, fileName, content, targetMemberId } = params;
        const gcFile = _parseGroupCaller(callerId);
        const effCallerFile = gcFile ? gcFile.memberId : callerId;
        if (!effCallerFile || !isKnownCaller(effCallerFile)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!fileName || !String(fileName).trim()) return res.status(400).json({ error: '缺少 fileName' });
        if (!content || !String(content).trim()) return res.status(400).json({ error: '缺少 content（文件内容）' });
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        const safeName = path.basename(String(fileName).trim()).replace(/[\\/:*?"<>|]/g, '_');
        const extIn = (safeName.split('.').pop() || '').toLowerCase();
        // 内容格式 → 成品扩展名：表格类（csv/json/xls/xlsx）→ xlsx；文字类（md/txt/doc/docx）→ docx
        const outExt = ['xlsx', 'xls', 'csv', 'json'].includes(extIn) ? 'xlsx'
          : ['docx', 'doc', 'md', 'markdown', 'txt'].includes(extIn) ? 'docx' : null;
        if (!outExt) {
          return res.status(400).json({ error: `文件名请带 .xlsx（表格）或 .docx（Word 文字）扩展名（收到：${extIn || '无扩展名'}），手机才能直接打开` });
        }
        const baseName = safeName.replace(/\.[^.]+$/, '') || '文件';
        const outName = `${baseName}.${outExt}`;
        const raw = String(content);
        if (raw.length > 2 * 1024 * 1024) return res.status(400).json({ error: '内容过大（上限 2MB）' });
        const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
        fs.mkdirSync(UPLOADS_DIR, { recursive: true });
        const filePath = path.join(UPLOADS_DIR, `agent_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.${outExt}`);
        try {
          if (outExt === 'xlsx') {
            const XLSX = require('xlsx');
            let ws;
            const trimmed = raw.trim();
            if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
              // JSON：数组套数组 → aoa；对象数组/单对象 → json_to_sheet
              const parsed = JSON.parse(raw);
              const arr = Array.isArray(parsed) ? parsed : [parsed];
              ws = arr.every(r => Array.isArray(r))
                ? XLSX.utils.aoa_to_sheet(arr)
                : XLSX.utils.json_to_sheet(arr);
            } else {
              // CSV → 行数组（状态机解析：引号包裹字段可含逗号，"" 转义）
              ws = XLSX.utils.aoa_to_sheet(raw.split(/\r?\n/).filter(l => l.trim()).map(parseCsvLine));
            }
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
            XLSX.writeFile(wb, filePath);
          } else {
            // md/纯文字 → Word(.docx)（手机可直接打开；md/txt 原样会打不开）
            const buf = await markdownToDocx(raw);
            fs.writeFileSync(filePath, buf);
          }
        } catch (e) {
          return res.status(400).json({ error: `文件生成失败: ${e.message}` });
        }
        const note = extIn !== outExt
          ? `已转成 ${outExt === 'xlsx' ? 'Excel(.xlsx)' : 'Word(.docx)'} 发出（手机可直接打开）`
          : '';
        // 目的地
        if (targetMemberId !== undefined && targetMemberId !== null && String(targetMemberId) !== '') {
          const sfTarget = resolveRelayTarget(targetMemberId);
          if (!sfTarget) return res.status(404).json({ error: '找不到这个发送目标：学号或已注册普通昵称（精确）' });
          const r = await steward.sendToMemberFile(sfTarget.id, filePath, outName);
          if (!r?.success) return res.status(500).json({ error: r?.error || '文件发送失败' });
          return res.json({ success: true, to: sfTarget.id, fileName: outName, ...(note ? { note } : {}) });
        }
        if (gcFile) {
          const r = await steward.sendToMemberFile(gcFile.chatroomId, filePath, outName);
          if (!r?.success) return res.status(500).json({ error: r?.error || '文件发送失败' });
          return res.json({ success: true, to: gcFile.chatroomId, fileName: outName, ...(note ? { note } : {}) });
        }
        const r = await steward.sendToMemberFile(String(effCallerFile), filePath, outName);
        if (!r?.success) return res.status(500).json({ error: r?.error || '文件发送失败' });
        return res.json({ success: true, to: String(effCallerFile), fileName: outName, ...(note ? { note } : {}) });
      }

      case 'generate_image': {
        // AI 生图（Agnes agnes-image-2.1-flash，异步任务）：
        // 工具只提交任务立即返回——AI 先回话告诉她正在画，完成后系统激活 AI 发送结果。
        // refImage：可选，从上下文她发来的图片附件编号（img-xxx）作参考图（图生图/多图合成）。
        const { callerId, prompt, size, refImage } = params;
        const gcImg = _parseGroupCaller(callerId);
        const effCallerImg = gcImg ? gcImg.memberId : callerId;
        if (!effCallerImg || !isKnownCaller(effCallerImg)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!mediaGen) return res.status(400).json({ error: '生图功能未初始化' });
        if (!mediaGen.enabled) return res.status(400).json({ error: '生图功能未启用（后端未配置 AGNES_API_KEY）' });
        if (!String(prompt || '').trim()) return res.status(400).json({ error: '缺少 prompt（画面描述）' });
        const imgSize = /^\d{2,5}x\d{2,5}$/.test(String(size || '')) ? String(size) : '1024x1024';   // 尺寸可选（如 1024x1024）
        // 参考图（可多张，逗号分隔）：解析成图片源（Data URI 优先）数组；上限 5 张
        const refList = _toList(refImage);
        const refImages = refList.map(id => _resolveRefImageSource(id))
          .filter(Boolean).slice(0, 5)
          .map(src => src.dataUri || src.url);
        console.log(`[MediaGen] 生图任务 caller=${effCallerImg}：refImage=${JSON.stringify(refImage)} 解析 ${refImages.length}/${refList.length} 张参考图`);
        const job = mediaGen.submit('image', {
          prompt: String(prompt).trim().substring(0, 2000),
          size: imgSize,
          ...(refImages.length > 0 ? { refImages } : {}),
        }, { memberId: effCallerImg, callerId, chatroomId: gcImg ? gcImg.chatroomId : '' });
        return res.json({ success: true, jobId: job.jobId, status: 'submitted', type: 'image',
          refImages: refImages.length, note: '任务已提交（预计 10-60 秒完成），完成后我会把结果发给你' });
      }

      case 'generate_video': {
        // AI 生视频（Agnes agnes-video-v2.0，异步任务，1-5 分钟）——同上异步语义。
        // refImage：可选，上下文她发来的图片作首帧参考（图生视频）。
        const { callerId, prompt, seconds, refImage } = params;
        const gcVid = _parseGroupCaller(callerId);
        const effCallerVid = gcVid ? gcVid.memberId : callerId;
        if (!effCallerVid || !isKnownCaller(effCallerVid)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!mediaGen) return res.status(400).json({ error: '生视频功能未初始化' });
        if (!mediaGen.enabled) return res.status(400).json({ error: '生视频功能未启用（后端未配置 AGNES_API_KEY）' });
        if (!String(prompt || '').trim()) return res.status(400).json({ error: '缺少 prompt（视频内容描述）' });
        const secs = [3, 5, 10, 18].includes(Number(seconds)) ? Number(seconds) : 5;
        const refRaw = String(refImage || '').trim();
        const refSrc = refRaw ? _resolveRefImageSource(refRaw) : null;
        // 视频 reference 模式要公网 URL 或裸 base64（官方要求可达 URL 优先；data: 前缀不被接受）
        const refImageUrl = refSrc ? (refSrc.url || refSrc.b64) : null;
        console.log(`[MediaGen] 生视频任务 caller=${effCallerVid}：refImage=${JSON.stringify(refRaw)} → ${refImageUrl ? '已解析参考图' : '未解析（纯文生）'}`);
        const job = mediaGen.submit('video', {
          prompt: String(prompt).trim().substring(0, 2000),
          seconds: secs,
          ...(refImageUrl ? { refImage: refImageUrl } : {}),
        }, { memberId: effCallerVid, callerId, chatroomId: gcVid ? gcVid.chatroomId : '' });
        return res.json({ success: true, jobId: job.jobId, status: 'submitted', type: 'video',
          refImage: !!refImageUrl, note: '任务已提交（预计 1-5 分钟完成），完成后我会把结果发给你' });
      }

      case 'send_media': {
        // 发送本地媒体附件（AI 生成结果 / 已入库媒体）到当前对话：
        // 自己（memberId）或群（g:群id:学号）；图片走图片消息，其余走文件消息。
        const { callerId, mediaId } = params;
        const gcSendM = _parseGroupCaller(callerId);
        const effCallerM = gcSendM ? gcSendM.memberId : callerId;
        if (!effCallerM || !isKnownCaller(effCallerM)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        if (!mediaId) return res.status(400).json({ error: '缺少 mediaId' });
        const media = steward.getMedia ? steward.getMedia(String(mediaId)) : null;
        if (!media) return res.status(404).json({ error: `附件 ${mediaId} 不存在或已过期（7 天内有效）` });
        const ownM = String(media.fromMember) === String(effCallerM)
          || isAdminCaller(effCallerM)
          || (gcSendM && media.fromGroup === gcSendM.chatroomId);
        if (!ownM) return res.status(403).json({ error: '没有权限发送该附件' });
        if (!media.path) return res.status(500).json({ error: '附件内容不可用' });
        const targetM = gcSendM ? gcSendM.chatroomId : String(effCallerM);
        // 视频（video/* 且有缩略图）→ 微信视频卡片消息；图片 → 图片消息；其余 → 文件消息
        const isVideoM = media.kind === 'file' && /^video\//.test(String(media.mime || '')) && !!media.thumbPath;
        const sentM = media.kind === 'image'
          ? await steward.sendToMemberImage(targetM, media.path)
          : isVideoM
            ? await steward.sendToMemberVideo(targetM, media.path, media.thumbPath, media.duration)
            : await steward.sendToMemberFile(targetM, media.path, media.fileName || '附件');
        if (!sentM?.success) return res.status(500).json({ error: sentM?.error || '附件发送失败' });
        return res.json({ success: true, to: targetM, kind: media.kind, fileName: media.fileName });
      }

      case 'my_groups': {
        // 当前成员所在群列表（AI 想跨会话发群前先查）——只含 TA 加入的群。
        const { callerId } = params;
        const gcMg = _parseGroupCaller(callerId);
        const effCallerMg = gcMg ? gcMg.memberId : callerId;
        if (!effCallerMg || (!findMember(effCallerMg) && !isAdminContextId(effCallerMg))) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!steward || !steward.listMemberGroups) return res.status(400).json({ error: '微信管家未启用' });
        const groups = await steward.listMemberGroups(effCallerMg);
        return res.json({ success: true, groups });
      }

      case 'talk_to_group': {
        // AI 自主往「当前成员所在群」发消息（跨会话投递：私聊人格 → 群）。
        // 消息像管家在群里说话一样发给群成员，并注入群 session 上下文（群 AI 下轮知道）。
        // 边界：目标必须是成员所在群；内容公开安全（个人敏感不主动入群，人设约束）。
        const { callerId, chatroomId, text, sticker, mediaId } = params;
        const gcTg = _parseGroupCaller(callerId);
        // 群内：仅管理员可（代表放行）；普通成员拒绝——想发言就在群里 @AI
        if (gcTg && !isAdminCaller(gcTg.memberId)) {
          return res.status(403).json({ error: '想让我在群里说话，就在群里 @Anaxis 说呀' });
        }
        const effCallerTg = gcTg ? gcTg.memberId : callerId;
        if (!effCallerTg || (!findMember(effCallerTg) && !isAdminContextId(effCallerTg))) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!steward || !steward.listMemberGroups) return res.status(400).json({ error: '微信管家未启用' });
        if (!chatroomId) return res.status(400).json({ error: '缺少目标群 chatroomId（先用 class_my_groups 查所在群）' });
        if (!text && !sticker && !mediaId) return res.status(400).json({ error: 'text / sticker / mediaId 至少传一个' });
        const group = (await steward.listMemberGroups(effCallerTg)).find(g => g.chatroomId === String(chatroomId));
        if (!group) return res.status(403).json({ error: '只能发到你（或你代表的人）所在的群（用 class_my_groups 查当前所在群）' });

        // 发送内容：先逐句文本（换行拆段，像真人说话），再表情，再媒体附件
        const descParts = [];
        const textSegs = String(text || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
        for (const seg of textSegs) {
          const r = await steward.sendToGroup(String(chatroomId), seg);
          if (!r?.success) return res.status(500).json({ error: r?.error || `文本发送失败: ${seg}` });
          descParts.push(seg);
        }
        if (sticker) {
          const stIds = _toList(sticker);
          for (const sid of stIds) {
            const r = await steward.sendToGroupSticker(String(chatroomId), sid);
            if (!r?.success) return res.status(500).json({ error: r?.error || '表情发送失败' });
          }
          descParts.push(stIds.length > 1 ? `${stIds.length} 张表情` : '一张表情包');
        }
        if (mediaId) {
          const mId = String(mediaId).trim();
          const media = steward.getMedia ? steward.getMedia(mId) : null;
          if (!media || !media.path) return res.status(404).json({ error: `附件 ${mId} 不存在或已过期（7 天内有效）` });
          const ownTg = String(media.fromMember) === String(effCallerTg) || isAdminCaller(effCallerTg);
          if (!ownTg) return res.status(403).json({ error: '只能发自己生成的媒体附件' });
          const isVideoTg = media.kind === 'file' && /^video\//.test(String(media.mime || '')) && !!media.thumbPath;
          const sentTg = media.kind === 'image'
            ? await steward.sendToMemberImage(String(chatroomId), media.path)
            : isVideoTg
              ? await steward.sendToMemberVideo(String(chatroomId), media.path, media.thumbPath, media.duration)
              : await steward.sendToMemberFile(String(chatroomId), media.path, media.fileName || '附件');
          if (!sentTg?.success) return res.status(500).json({ error: sentTg?.error || '媒体发送失败' });
          descParts.push(media.kind === 'image' ? '一张图' : `文件 ${media.fileName}`);
        }
        const desc = descParts.join('，');
        // 注入群 session 上下文：群 AI 知道自己（管家）在群里主动说过这段（独立人格延续）
        try {
          const who = gcTg ? `（${steward.memberName(effCallerTg)} 学号 ${effCallerTg} 在群里）` : `（${steward.memberName(effCallerTg)} 学号 ${effCallerTg} 正在私聊你）`;
          steward.injectMemberEvent(`group-${chatroomId}`,
            `你（管家）之前主动往这个群发过：「${desc}」${who}。群里有人接着这个话题 @ 你时自然接住，像你自己说过的一样接，别解释成「私聊转来的」。`);
        } catch {}
        return res.json({ success: true, group: group.chatroomId, sent: descParts });
      }

      case 'talk_to_member': {
        // AI 自然口吻私聊某成员（跨会话投递 / 用户间传话）：替代机械「托我转达」。
        // 消息以管家口吻直接发给她，并注入她的 session 上下文（她的 AI 知道这事）。
        // anonymous=true → 她的 AI 不被告知来源，绝不透露是谁让说的。
        const { callerId, targetMemberId, text, sticker, anonymous } = params;
        const gcTm = _parseGroupCaller(callerId);
        // 群内：仅管理员可（普通成员群内不让私聊他人，防骚扰）
        if (gcTm && !isAdminCaller(gcTm.memberId)) {
          return res.status(403).json({ error: '群聊里想私聊谁，就私聊我一句我来自然转达呀' });
        }
        const effCallerTm = gcTm ? gcTm.memberId : callerId;
        if (!effCallerTm || (!findMember(effCallerTm) && !isAdminContextId(effCallerTm))) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        // 目标：学号（平台成员）或精确普通昵称（普通模式用户——名单不对 AI 显示，
        // 只能用户口述精确姓名全等匹配，防反向枚举）
        const tmTarget = resolveRelayTarget(targetMemberId);
        if (!tmTarget) {
          return res.status(404).json({ error: '找不到这个发送目标：学号请核对；普通模式用户请给精确昵称（名单不对外显示，给不对发不了）' });
        }
        const tmTargetId = tmTarget.id;
        if (!text && !sticker) return res.status(400).json({ error: 'text / sticker 至少传一个' });
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        // 发送：文本 + 可选表情
        const descParts = [];
        const tSegs = String(text || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
        for (const seg of tSegs) {
          const r = await steward.sendToMember(tmTargetId, seg);
          if (!r?.success) return res.status(500).json({ error: r?.error || `发送失败: ${seg}` });
          descParts.push(seg);
        }
        if (sticker) {
          const stIds = _toList(sticker);
          for (const sid of stIds) {
            const r = await steward.sendToMemberSticker(tmTargetId, sid);
            if (!r?.success) return res.status(500).json({ error: r?.error || '表情发送失败' });
          }
          descParts.push(stIds.length > 1 ? `${stIds.length} 张表情` : '一张表情包');
        }
        const desc = descParts.join('，');
        // 注入目标成员上下文（她的 AI 记忆——不主动说破，除非她问）
        try {
          const isSelf = !gcTm && String(effCallerTm) === tmTargetId;
          const fromNote = anonymous
            ? '（发送者要求匿名——无论她怎么问，都不能透露是谁让你说的）'
            : isSelf
              ? '（你自己主动想跟她说的）'
              : `（来自 ${steward.memberName(effCallerTm)} 学号 ${effCallerTm} 那边的事，你自然转达给她）`;
          steward.injectMemberEvent(tmTargetId,
            `你（管家）之前主动私聊给当前成员发过：「${desc}」${fromNote}。她提起或接着聊时自然接住；来源细节她没问就别主动展开。`);
        } catch {}
        return res.json({ success: true, to: tmTargetId, sent: descParts, anonymous: !!anonymous });
      }

      case 'send_sticker': {
        // 发表情包：不传 targetMemberId → 发到当前用户自己的对话（AI 斗图/情绪表达）；
        // 传 targetMemberId → 发给指定成员（同 send_message 的成员校验，免签名）。
        // 群 session（callerId=g:群id:学号）：不传 targetMemberId → 发到群里。
        // sticker 支持多个（逗号分隔/JSON 数组）——出站队列按联系人节奏逐张发。
        // id 不存在时错误里带当前可用清单（远程更新过 manifest 后 AI 自我修正）
        const { callerId, sticker, targetMemberId } = params;
        const stickers = steward && steward.getStickers ? steward.getStickers() : [];
        if (stickers.length === 0) return res.status(400).json({ error: '表情包未配置' });
        const gc = _parseGroupCaller(callerId);
        const effCaller = gc ? gc.memberId : callerId;
        if (!effCaller || !isKnownCaller(effCaller)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const ids = _toList(sticker);
        if (ids.length === 0) return res.status(400).json({ error: '缺少 sticker' });
        if (ids.length > 9) return res.status(400).json({ error: '一次最多发 9 张表情包' });
        const invalid = ids.filter(id => !stickers.some(s => s.id === id));
        if (invalid.length > 0) {
          // 自愈：清单可能被远程更新过（CLI 增删），把当前可用表情（id+文字+场景）一并返回
          const available = stickers.map(s => `${s.id}(${s.text}${s.use ? '，' + s.use : ''})`).join('、');
          return res.status(400).json({ error: `未知表情包 ${invalid.join(',')}（当前可用: ${available || '无'}）` });
        }
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        // 目的地：显式 targetMemberId → 私发成员；群 caller → 发回群；否则 → 发给自己
        if (targetMemberId !== undefined && targetMemberId !== null && String(targetMemberId) !== '') {
          const stTarget = resolveRelayTarget(targetMemberId);
          if (!stTarget) return res.status(404).json({ error: '找不到这个发送目标：学号或已注册普通昵称（精确）' });
          for (const id of ids) {
            const result = await steward.sendToMemberSticker(stTarget.id, String(id));
            if (!result?.success) return res.status(500).json({ error: result?.error || '发送失败' });
          }
          return res.json({ success: true, to: stTarget.id, sticker: ids.join(',') });
        }
        if (gc) {
          for (const id of ids) {
            const result = await steward.sendToGroupSticker(gc.chatroomId, String(id));
            if (!result?.success) return res.status(500).json({ error: result?.error || '发送失败' });
          }
          return res.json({ success: true, to: gc.chatroomId, sticker: ids.join(',') });
        }
        for (const id of ids) {
          const result = await steward.sendToMemberSticker(String(effCaller), String(id));
          if (!result?.success) return res.status(500).json({ error: result?.error || '发送失败' });
        }
        return res.json({ success: true, to: String(effCaller), sticker: ids.join(',') });
      }

      case 'send_voice': {
        // 统一「发语音 / 发歌曲」工具。
        // mode=speech（默认）：text 用复刻音色念出来，转微信语音条（silk）发出（60s 超长自动截断保护）；
        // mode=song（原创唱歌）：text/lyrics 生成一首原创歌（Suno persona 同声），异步后台生成；
        // mode=cover（翻唱还原原版）：把一首已有歌（sourceUrl：原版 mp3/短视频）的人声换成
        //   Anaxis 专属音色（clonevoice RVC），旋律+伴奏保持原曲——异步提交，平台回调后完成。
        // 完成后均激活 AI 把 mp3（文件消息）发回当前对话并配话（system 事件 song_generated）。
        // 目的地规则与 send_sticker 一致：targetMemberId → 私发成员；群 caller → 发回群；否则发给自己。
        const { callerId, text, mode, lyrics, style, title, duration, songName, singer, sourceUrl, tune, targetMemberId } = params;
        const gcVc = _parseGroupCaller(callerId);
        const effCallerVc = gcVc ? gcVc.memberId : callerId;
        if (!effCallerVc || !isKnownCaller(effCallerVc)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        const voiceMode = String(mode || 'speech').toLowerCase();
        if (voiceMode !== 'speech' && voiceMode !== 'song' && voiceMode !== 'cover') {
          return res.status(400).json({ error: 'mode 只能是 speech（发语音）、song（原创唱歌）或 cover（翻唱原版）' });
        }
        // 目的地：显式 targetMemberId → 私发；群 caller → 发回群；否则 → 发给自己
        let destId;
        if (targetMemberId !== undefined && targetMemberId !== null && String(targetMemberId) !== '') {
          const t = resolveRelayTarget(targetMemberId);
          if (!t) return res.status(404).json({ error: '找不到这个发送目标：学号或已注册普通昵称（精确）' });
          destId = t.id;
        } else if (gcVc) {
          destId = gcVc.chatroomId;
        } else {
          destId = String(effCallerVc);
        }

        if (voiceMode === 'speech') {
          const t = String(text || '').trim();
          if (!t) return res.status(400).json({ error: '缺少 text（要念的话）' });
          const { synthesizeVoice } = require('./utils/doubaoVoice');
          const out = await synthesizeVoice(t, { outDir: path.join(DATA_DIR || __dirname, 'data', 'tts_voice') });
          const rr = await steward.sendToMemberVoice(destId, out.path, out.durationMs);
          if (!rr?.success) return res.status(500).json({ error: rr?.error || '语音发送失败' });
          return res.json({ success: true, kind: 'speech', to: destId, durationMs: out.durationMs });
        }

        if (voiceMode === 'cover') {
          // ---- cover：clonevoice RVC 翻唱还原原版（异步，回调完成） ----
          if (!songGen) return res.status(400).json({ error: '歌曲生成未初始化（稍后再试）' });
          const cvUrl = String(sourceUrl || '').trim();
          if (!cvUrl) {
            return res.status(400).json({ error: '翻唱需要 sourceUrl（原版歌曲 mp3 直链，或 bilibili/抖音等视频链接）' });
          }
          // 版权边界：仅公版/传统/已获授权歌曲可翻唱（人设侧约束），此处不校验内容
          const jobOpts = {
            mode: 'cover',
            sourceUrl: cvUrl,
            songName: String(songName || '').trim() || undefined,
            singerName: String(singer || '').trim() || undefined,
          };
          if (tune !== undefined && tune !== null && String(tune).trim() !== '') {
            jobOpts.tune = Math.round(Number(tune));
          }
          let job;
          try {
            job = songGen.submit(jobOpts, {
              memberId: effCallerVc,
              callerId: String(callerId),
              chatroomId: gcVc ? String(destId) : '',
              destId: gcVc ? '' : String(destId),
            });
          } catch (e) {
            return res.status(400).json({ error: String(e.message) });
          }
          console.log(`[SongGen] cover 翻唱提交 caller=${effCallerVc} dest=${destId} job=${job.jobId} url=${cvUrl.slice(0, 80)}`);
          return res.json({ success: true, kind: 'cover', to: destId, jobId: job.jobId, status: 'submitted',
            note: '翻唱处理中，完成后我会把 mp3 发给你（别提任务话术）' });
        }

        // ---- song：异步提交（songGen 后台走 acedata/Suno persona——用豆包复刻音色样本克隆的
        // persona 演唱原创歌，说话唱歌同声；完成激活 AI 发 mp3 文件配话） ----
        // 参数对齐官方 /suno/audios generate（custom）：text→lyric_prompt（自动配词），
        // lyrics→lyric（完整歌词）；style 直接透传官方 style 描述；title/duration 可选透传
        const songText = String(text || '').trim();
        const songLyrics = String(lyrics || '').trim();
        if (!songText && !songLyrics) {
          return res.status(400).json({ error: '歌曲需要 text（主题描述）或 lyrics（歌词），至少给一个' });
        }
        if (!songGen) return res.status(400).json({ error: '歌曲生成未初始化（稍后再试）' });
        // 任务上下文：memberId=发起成员；chatroomId=群（song 给群里唱）；destId=私聊目标
        let job;
        try {
          job = songGen.submit({
            lyric: songLyrics || undefined,
            lyric_prompt: songText || undefined,
            style: String(style || '').trim() || undefined,
            title: String(title || '').trim() || undefined,
            duration: duration === undefined || duration === null || String(duration).trim() === ''
              ? undefined
              : Math.round(Number(duration)),
          }, {
            memberId: effCallerVc,
            callerId: String(callerId),
            chatroomId: gcVc ? String(destId) : '',
            destId: gcVc ? '' : String(destId),
          });
        } catch (e) {
          // 未配置 ACEDATA_API_KEY / 提交失败：交给 AI 如实转述（含配置引导）
          return res.status(400).json({ error: String(e.message) });
        }
        console.log(`[SongGen] 歌曲提交 caller=${effCallerVc} dest=${destId} job=${job.jobId}`);
        return res.json({ success: true, kind: 'song', to: destId, jobId: job.jobId, status: 'submitted',
          note: '歌曲生成中，完成后我会把 mp3 发给你（别提任务话术）' });
      }

      case 'query_stickers': {
        // 当前表情包清单（动态：data/stickers/manifest.json 的实时快照）。
        // steward-bridge 启动时拉一次生成工具描述；AI 拿到「未知表情包」错误后也可知当前可用项
        const list = steward && steward.getStickers ? steward.getStickers() : [];
        return res.json({ success: true, stickers: list });
      }

      case 'web_search': {
        // 网页搜索：文本 + 图片一次返回。
        // 文本第一引擎 = DeepSeek 官方联网（utils/dsSearch.js，语义甄别+结论 answer，
        //   质量显著高于本地爬虫）；官方失败/超时/无来源 → 降级本地 Bing→DDG 爬虫。
        // 图片 = DeepSeek 官方不返回图片直链，始终走 Bing→DDG（imageSearch）。
        // AI 流程：web_search 拿到 answer/images → 直接采用 answer 或挑图 send_web_image。
        const { callerId, query, count } = params;
        // 群 session（callerId=g:群id:学号）：按实际操作者校验
        const gcSearch = _parseGroupCaller(callerId);
        const effCallerSearch = gcSearch ? gcSearch.memberId : callerId;
        if (!effCallerSearch || !isKnownCaller(effCallerSearch)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const q = String(query || '').trim();
        if (!q) return res.status(400).json({ error: '缺少 query' });
        const n = Math.min(Math.max(parseInt(count, 10) || 5, 1), 8);
        // 图片与官方搜索并行（任一失败不拖垮另一路）；官方失败后串行补本地文本兜底
        const dsKey = process.env.DEEPSEEK_API_KEY || (Array.isArray(DEEPSEEK_API_KEYS) && DEEPSEEK_API_KEYS.length > 0 ? DEEPSEEK_API_KEYS[0] : '');
        const imgP = imageSearch(q, n).then((list) => list).catch(() => []);
        const dsP = deepseekSearch(q, { apiKey: dsKey })
          .then((ds) => ({ ds }))
          .catch((err) => ({ err: err.message }));
        const [dsOut, images] = await Promise.all([dsP, imgP]);
        let results = [], answer;
        let engine = 'deepseek', why = '';
        if (dsOut.ds && Array.isArray(dsOut.ds.sources) && dsOut.ds.sources.length > 0) {
          results = dsOut.ds.sources.slice(0, n).map((s) => ({
            title: s.title || '',
            url: s.url,
            snippet: s.snippet || '',
          }));
          answer = dsOut.ds.answer;
        } else {
          engine = 'bing';
          why = dsOut.err || '官方搜索无来源';
          try {
            results = await webSearch(q, n);
          } catch (e) {
            why = `${why}；本地兜底也失败: ${e.message}`;
          }
        }
        if (results.length === 0 && images.length === 0) {
          return res.json({ success: false, results: [], images: [], error: `搜索无结果（${why}）` });
        }
        return res.json({ success: true, query: q, engine, answer, results, images });
      }

      case 'fetch_url': {
        // 读链接正文（转 markdown）+ 抽页面图片直链。内核复用 dsh 官方
        // web-fetch-http provider（SSRF 防护：私网拒绝/同源跳转限制/100k 体上限）。
        // 模型流程：学生发链接/文章 → fetch_url 读正文 → 可挑 images 配图发出。
        const { callerId, url } = params;
        const gcF = _parseGroupCaller(callerId);
        const effCallerF = gcF ? gcF.memberId : callerId;
        if (!effCallerF || !isKnownCaller(effCallerF)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const u = String(url || '').trim();
        if (!u) return res.status(400).json({ error: '缺少 url' });
        if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'url 必须是 http/https 链接' });
        try {
          const f = await fetchUrl(u);
          return res.json({ success: true, url: f.url, statusCode: f.statusCode, markdown: f.markdown, images: f.images, truncated: f.truncated });
        } catch (e) {
          return res.json({ success: false, error: e.message });
        }
      }

      case 'video_understand': {
        // 视频内容理解：微信视频（mediaId）或视频号直链（videoUrl）→ VL 多模态模型总结。
        // 模型主动调用：她发的视频在上下文中带 mediaId/视频链接，她问视频内容时才看
        // （视频理解有成本，不自动触发）。未配置 VL_BASE_URL/VL_API_KEY 时返回明确提示。
        const { callerId, mediaId, videoUrl, question } = params;
        const gcV = _parseGroupCaller(callerId);
        const effV = gcV ? gcV.memberId : callerId;
        if (!effV || !isKnownCaller(effV)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        let url = String(videoUrl || '').trim();
        if (!/^https?:\/\//i.test(url)) {
          // mediaId → 优先 CDN 直链（下载时登记的 cdnvideourl/downloadCdn 直链，时效长于
          // 本地 24h 清理——本地文件过期/下载超时后仍可读）；CDN 不可用再走本地文件。
          const m = steward.getMedia ? steward.getMedia(String(mediaId || '')) : null;
          if (!m) return res.status(404).json({ error: `附件 ${mediaId} 不存在或已过期（7 天内有效）` });
          // 权限校验（CDN 直链与本地文件路径共用）：仅本人附件 / 所在群附件 / 管理员
          const allowed = isAdminCaller(effV)
            || String(m.fromMember) === String(effV)
            || (gcV && m.fromGroup === gcV.chatroomId);
          if (!allowed) {
            return res.status(403).json({ error: '只能理解自己发来的视频（群里收到的视频在群里让我看）' });
          }
          if (m && /^https?:\/\//i.test(String(m.cdnUrl || ''))) {
            url = String(m.cdnUrl).trim();
          } else {
            let full = m;
            if (!full.path || !fs.existsSync(full.path)) {
              if (!steward.ensureMediaContent) return res.status(400).json({ error: '视频文件暂不可用' });
              full = await steward.ensureMediaContent(String(mediaId));
            }
            if (!full || !full.path || !fs.existsSync(full.path)) {
              return res.status(404).json({ error: '视频文件读取失败' });
            }
            try {
              url = await steward.channel._toMediaUrl(full.path);
            } catch (e) {
              return res.status(400).json({ error: '无法生成视频公网地址：' + e.message });
            }
          }
        }
        const VL_BASE = String(process.env.VL_BASE_URL || 'https://api.siliconflow.cn/v1').trim();
        const VL_KEY = String(process.env.VL_API_KEY || '').trim();
        if (!VL_BASE || !VL_KEY) {
          return res.json({ success: false, error: '视频理解未配置：需要 VL_API_KEY（默认硅基流动 + Qwen3-VL-30B-A3B，OpenAI 兼容）' });
        }
        // CDN 直链可能已过期（微信签名 URL 数天～数周）：VL 调用失败时若走的是 CDN，
        // 降级为本地文件再试一次（ensureMediaContent 会从 rawXml 换新直链后落盘，再经
        // _toMediaUrl 公网暴露）——避免「旧链 403 直接判死」。
        const callVl = async (u) => {
          const r = await axios.post(`${VL_BASE.replace(/\/+$/, '')}/chat/completions`, {
            model: String(process.env.VL_MODEL || 'Qwen/Qwen3-VL-30B-A3B-Instruct').trim(),
            messages: [{
              role: 'user',
              content: [
                { type: 'video_url', video_url: { url: u, max_duration: 180 } },
                { type: 'text', text: String(question || '').trim()
                  || '请描述这条视频的内容：画面里有什么、谁在做什么、有无文字/语音信息。微信小视频通常几秒到几分钟，按实际内容客观描述；画面解析不了就明说看不到。' },
              ],
            }],
          }, {
            headers: { Authorization: `Bearer ${VL_KEY}` },
            timeout: 120000,
          });
          return String(r.data?.choices?.[0]?.message?.content || '').trim();
        };
        try {
          let text = '';
          try {
            text = await callVl(url);
          } catch (e) {
            const usedCdn = /^https?:\/\//i.test(url);
            const usedMediaId = !String(videoUrl || '').trim() && mediaId;
            if (usedCdn && usedMediaId && steward.ensureMediaContent) {
              console.log('[agent-tool] 视频理解 CDN 直链失败，降级本地重试:', e.message);
              const full = await steward.ensureMediaContent(String(mediaId));
              if (full && full.path && fs.existsSync(full.path)) {
                url = await steward.channel._toMediaUrl(full.path);
                try { text = await callVl(url); } catch (e2) {
                  return res.json({ success: false, error: '视频理解失败（CDN 与本地均不可用）：' + (e2.response?.data?.error?.message || e2.message) });
                }
              } else {
                return res.json({ success: false, error: '视频理解失败（CDN 过期且无法重新下载）：' + (e.response?.data?.error?.message || e.message) });
              }
            } else {
              return res.json({ success: false, error: '视频理解失败：' + (e.response?.data?.error?.message || e.message) });
            }
          }
          if (!text) {
            return res.json({ success: false, error: '视频理解无返回（视频可能过长或无法解码）' });
          }
          return res.json({ success: true, summary: text });
        } catch (e) {
          console.error('[agent-tool] 视频理解失败:', e.message);
          return res.json({ success: false, error: '视频理解失败：' + (e.response?.data?.error?.message || e.message) });
        }
      }

      case 'post_moment': {
        // 发朋友圈（管理员专属）：把私聊/群聊收到的图片、视频、公众号链接等素材发布为朋友圈。
        // 素材来源：上下文里的附件 mediaId（img-xxx/file-xxx，本人或所在群）或公网 URL。
        // 权限：仅系统管理员 / 管理员上下文。发布属公开行为：AI 应先用文案与她确认再发。
        const { callerId, type, content, mediaRefs, videoRef, coverRef, linkUrl, title, description, thumbUrl, privacy, allowWxIds, disableWxIds } = params;
        const gcM = _parseGroupCaller(callerId);
        const effM = gcM ? gcM.memberId : callerId;
        if (!effM || !isKnownCaller(effM)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!isAdminCaller(effM)) {
          return res.status(403).json({ error: '发朋友圈需要管理员权限（管理员登录后使用，或让系统管理员来处理）' });
        }
        if (!steward || !steward.channel || !steward.channel.snsSendText) {
          return res.status(400).json({ error: '微信管家未启用' });
        }
        const t = String(type || '').toLowerCase();
        // 可见范围统一整理（默认全员可见；privacy=true 仅自己可见）
        const scope = {
          privacy: !!privacy,
          allowWxIds: (Array.isArray(allowWxIds) ? allowWxIds : String(allowWxIds || '').split(',').filter(Boolean)).map(String),
          disableWxIds: (Array.isArray(disableWxIds) ? disableWxIds : String(disableWxIds || '').split(',').filter(Boolean)).map(String),
        };
        try {
          if (t === 'text') {
            const text = String(content || '').trim();
            if (!text) return res.status(400).json({ error: '文字朋友圈需要 content' });
            const r = await steward.channel.snsSendText(text, scope);
            return res.json({ success: true, type: 'text', momentId: r?.id ?? null, result: r });
          }
          if (t === 'image') {
            const refs = (Array.isArray(mediaRefs) ? mediaRefs : String(mediaRefs || '').split(/[,\n]/))
              .map(s => String(s).trim()).filter(Boolean);
            if (refs.length === 0) return res.status(400).json({ error: '图片朋友圈需要 mediaRefs（她发来的图片 mediaId 或图片 URL，1-9 张）' });
            if (refs.length > 9) return res.status(400).json({ error: '图片朋友圈最多 9 张' });
            const urls = [];
            for (const ref of refs) {
              const u = await resolveSnsMedia(ref, effM, gcM);
              if (!u) return res.status(400).json({ error: `素材 ${ref} 无法解析（附件过期/非本人非本群素材/不是可访问的图片 URL）` });
              urls.push(u);
            }
            const imgInfos = await steward.channel.snsUploadImages(urls);
            const r = await steward.channel.snsSendImages(content, imgInfos, scope);
            return res.json({ success: true, type: 'image', count: imgInfos.length, momentId: r?.id ?? null });
          }
          if (t === 'video') {
            const vUrl = await resolveSnsMedia(videoRef, effM, gcM);
            if (!vUrl) return res.status(400).json({ error: '视频朋友圈需要 videoRef（她发来的视频 mediaId 或视频 URL）' });
            const cUrl = await resolveSnsMedia(coverRef || thumbUrl, effM, gcM);
            if (!cUrl) return res.status(400).json({ error: '视频朋友圈需要封面图（coverRef/thumbUrl：封面 mediaId 或图片 URL）' });
            const videoInfo = await steward.channel.snsUploadVideo(cUrl, vUrl);
            const r = await steward.channel.snsSendVideo(content, videoInfo, scope);
            return res.json({ success: true, type: 'video', momentId: r?.id ?? null });
          }
          if (t === 'link') {
            const u = String(linkUrl || '').trim();
            if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: '链接朋友圈需要 linkUrl' });
            let tt = String(title || '').trim();
            let dd = String(description || '').trim();
            let th = (await resolveSnsMedia(thumbUrl, effM, gcM)) || '';
            // 缺标题/缩略图 → 抓页面兜底（fetchUrl：取 markdown 首行作标题、第一张图为封面）
            if (!tt || !th) {
              let page = null;
              try { page = await fetchUrl(u); } catch {}
              if (!tt && page && page.markdown) {
                tt = String(page.markdown).replace(/^#+\s*/, '').split('\n')[0].slice(0, 100);
              }
              if (!tt) tt = '分享';
              if (!th && page && Array.isArray(page.images) && page.images.length) th = page.images[0];
            }
            if (!th) return res.status(400).json({ error: '链接朋友圈需要缩略图（thumbUrl 或页面里有可用图）；可先 web_search 找一张图' });
            const r = await steward.channel.snsSendUrl({ content, linkUrl: u, title: tt, description: dd, thumbUrl: th }, scope);
            return res.json({ success: true, type: 'link', title: tt, momentId: r?.id ?? null });
          }
          return res.status(400).json({ error: 'type 必须是 text / image / video / link 之一' });
        } catch (e) {
          console.error('[agent-tool] 发朋友圈失败:', e.message);
          return res.json({ success: false, error: '发朋友圈失败：' + e.message });
        }
      }

      case 'send_web_image': {
        // 发网络图片给微信用户：下载 URL → data/uploads/ → 出站图片队列。
        // URL 主要来自 web_search 的 image 字段（AI 传入）；做协议+私网防护。
        // imageUrl 支持多个（逗号分隔/JSON 数组）——一次发多张网络图。
        const { callerId, imageUrl, targetMemberId } = params;
        const gc = _parseGroupCaller(callerId);
        const effCaller = gc ? gc.memberId : callerId;
        if (!effCaller || !isKnownCaller(effCaller)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const urls = _toList(imageUrl);
        if (urls.length === 0) return res.status(400).json({ error: '缺少 imageUrl' });
        if (urls.length > 9) return res.status(400).json({ error: '一次最多发 9 张图片' });
        const badUrl = urls.find(u => !/^https?:\/\//i.test(u));
        if (badUrl) return res.status(400).json({ error: `imageUrl 必须是 http/https 链接: ${badUrl}` });
        const privateUrl = urls.find(u => _isPrivateNetworkUrl(u));
        if (privateUrl) return res.status(400).json({ error: '不允许访问内网地址' });
        // 目的地：显式 targetMemberId → 私发成员；群 caller → 发回群；否则 → 发给自己
        let targetId;
        if (targetMemberId !== undefined && targetMemberId !== null && String(targetMemberId) !== '') {
          const wiTarget = resolveRelayTarget(targetMemberId);
          if (!wiTarget) return res.status(404).json({ error: '找不到这个发送目标：学号或已注册普通昵称（精确）' });
          targetId = wiTarget.id;
        } else {
          targetId = gc ? gc.chatroomId : String(effCaller);
        }
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        // 逐张下载（10MB 上限；content-type 必须 image/*）并发送
        const sent = [];
        for (const url of urls) {
          let buf, contentType;
          try {
            const dl = await axios.get(url, {
              responseType: 'arraybuffer',
              timeout: 20000,
              headers: { 'User-Agent': 'Mozilla/5.0 (ClassSteward/1.0)' },
              maxContentLength: 10 * 1024 * 1024,
            });
            buf = dl.data;
            contentType = String(dl.headers['content-type'] || '');
          } catch (e) {
            return res.status(400).json({ error: `图片下载失败: ${e.message}（已发 ${sent.length} 张）` });
          }
          if (!contentType.startsWith('image/')) {
            return res.status(400).json({ error: `链接不是图片（content-type: ${contentType || '未知'}）：${url}` });
          }
          const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[contentType.split(';')[0].trim()] || 'jpg';
          fs.mkdirSync(UPLOADS_DIR, { recursive: true });
          const fileName = `web-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          const filePath = path.join(UPLOADS_DIR, fileName);
          fs.writeFileSync(filePath, Buffer.from(buf));
          const result = await steward.sendToMemberImage(targetId, filePath);
          if (!result?.success) return res.status(500).json({ error: result?.error || '图片发送失败' });
          sent.push(fileName);
        }
        return res.json({ success: true, to: targetId, files: sent });
      }

      case 'send_workspace_file': {
        // 把"工作区里生成的文件"发到微信（报告/脚本/下载成果）。路径白名单：
        // 主引擎共享工作区 agent/dsh/workspace ∪ 超限会话自己的专属工作区
        // data/overdrive/workspaces/{scopeKey}（仅该会话处于超限时授予自己的那份，
        // 杜绝跨工作区读取/读取服务器任意文件）。
        const { callerId, path: wsPath, targetMemberId } = params;
        const gcWs = _parseGroupCaller(callerId);
        const effCallerWs = gcWs ? gcWs.memberId : callerId;
        if (!effCallerWs || !isKnownCaller(effCallerWs)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!String(wsPath || '').trim()) return res.status(400).json({ error: '缺少 path（工作区文件绝对路径）' });
        const ovWs = require('./utils/overdriveState');
        const wsRoots = [NORMAL_WS_ROOT];
        if (gcWs) {
          if (ovWs.isEnabled('group', gcWs.chatroomId)) wsRoots.push(path.resolve(overdriveWorkspaceRoot(gcWs.chatroomId)));
        } else if (ovWs.isEnabled('dm', String(effCallerWs))) {
          wsRoots.push(path.resolve(overdriveWorkspaceRoot(String(effCallerWs))));
        }
        const absWs = path.resolve(String(wsPath).trim());
        const insideWs = wsRoots.some(root => absWs === root || absWs.startsWith(root + path.sep));
        if (!insideWs) {
          return res.status(400).json({ error: 'path 必须在自己的工作区内（普通工作区或本超限会话专属工作区）' });
        }
        let wsStat = null;
        try { wsStat = fs.statSync(absWs); } catch { /* 不存在 */ }
        if (!wsStat || !wsStat.isFile()) return res.status(404).json({ error: `文件不存在: ${path.basename(absWs)}` });
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        // 目的地：显式 targetMemberId → 私发成员；群 caller → 发回群；否则 → 发给自己
        let targetWs;
        if (targetMemberId !== undefined && targetMemberId !== null && String(targetMemberId) !== '') {
          const wiWs = resolveRelayTarget(targetMemberId);
          if (!wiWs) return res.status(404).json({ error: '找不到这个发送目标：学号或已注册普通昵称（精确）' });
          targetWs = wiWs.id;
        } else {
          targetWs = gcWs ? gcWs.chatroomId : String(effCallerWs);
        }
        const outName = path.basename(absWs);
        const rWs = await steward.sendToMemberFile(targetWs, absWs, outName);
        if (!rWs?.success) return res.status(500).json({ error: rWs?.error || '文件发送失败' });
        return res.json({ success: true, to: targetWs, fileName: outName });
      }

      case 'save_attachment': {
        // 超限收文件落盘：把她发来的媒体附件（mediaId）拷贝到"该超限会话自己的工作区
        // inbox/" 供 fs/终端处理，返回落盘绝对路径。仅超限会话可用（后端复核状态；
        // 群 caller → 该群超限工作区；私聊 caller → 该成员超限工作区）。
        const { callerId, mediaId } = params;
        const gcSv = _parseGroupCaller(callerId);
        const effCallerSv = gcSv ? gcSv.memberId : callerId;
        if (!effCallerSv || !isKnownCaller(effCallerSv)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        if (!String(mediaId || '').trim()) return res.status(400).json({ error: '缺少 mediaId' });
        const ovSv = require('./utils/overdriveState');
        const svScopeKey = gcSv ? gcSv.chatroomId : String(effCallerSv);
        const svKind = gcSv ? 'group' : 'dm';
        if (!ovSv.isEnabled(svKind, svScopeKey)) {
          return res.status(403).json({ error: '该会话未开启超限，无法落盘工作区（打开超限后再发文件）' });
        }
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        const mediaSv = steward.getMedia ? steward.getMedia(String(mediaId)) : null;
        if (!mediaSv) return res.status(404).json({ error: `附件 ${mediaId} 不存在或已过期（7 天内有效）` });
        const ownSv = String(mediaSv.fromMember) === String(effCallerSv)
          || isAdminCaller(effCallerSv)
          || (gcSv && mediaSv.fromGroup === gcSv.chatroomId);
        if (!ownSv) return res.status(403).json({ error: '没有权限落盘该附件' });
        const fullSv = (mediaSv.path && fs.existsSync(mediaSv.path))
          ? mediaSv
          : (typeof steward.ensureMediaContent === 'function' ? await steward.ensureMediaContent(String(mediaId)) : null);
        if (!fullSv || !fullSv.path || !fs.existsSync(fullSv.path)) {
          return res.status(500).json({ error: '附件内容不可用（下载失败或已过期）' });
        }
        const inboxDir = path.join(overdriveWorkspaceRoot(svScopeKey), 'inbox');
        fs.mkdirSync(inboxDir, { recursive: true });
        const rawName = path.basename(String(fullSv.fileName || `attachment-${Date.now()}`))
          .replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120).trim() || `attachment-${Date.now()}`;
        const ext = path.extname(rawName).toLowerCase();
        const base = ext ? rawName.slice(0, -ext.length) : rawName;
        let targetSv = path.join(inboxDir, rawName);
        let n = 1;
        while (fs.existsSync(targetSv)) {
          targetSv = path.join(inboxDir, `${base}(${n})${ext}`);
          n++;
        }
        try {
          fs.copyFileSync(fullSv.path, targetSv);
        } catch (e) {
          return res.status(500).json({ error: `落盘失败: ${e.message}` });
        }
        return res.json({ success: true, path: targetSv, fileName: path.basename(targetSv), mediaId: String(mediaId) });
      }

      case 'shared_registry': {
        // 共享环境清单（超限会话专属）：所有超限会话共享同一目录
        // data/overdrive/shared-cache/（系统环境基本都在其中且已加入 PATH）。
        // 本会话 AI 装了东西后 op=note 记一笔（装了什么/怎么用/命令示例），
        // op=list 读全量清单——跨会话共享工具知识，避免重复安装。
        // 仅超限会话可用（后端复核状态；群 caller → 群超限；私聊 caller → 会话超限）。
        const { callerId, op, title, entry } = params;
        const gcRg = _parseGroupCaller(callerId);
        const effCallerRg = gcRg ? gcRg.memberId : callerId;
        if (!effCallerRg || !isKnownCaller(effCallerRg)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const ovRg = require('./utils/overdriveState');
        const rgScopeKey = gcRg ? gcRg.chatroomId : String(effCallerRg);
        const rgKind = gcRg ? 'group' : 'dm';
        if (!ovRg.isEnabled(rgKind, rgScopeKey)) {
          return res.status(403).json({ error: '共享环境清单仅超限会话可用（先开启超限）' });
        }
        const rgCacheDir = path.join(DATA_DIR, 'overdrive', 'shared-cache');
        const rgManifest = path.join(rgCacheDir, 'SHARED.md');
        if (op === 'list') {
          let content = '';
          try { content = fs.existsSync(rgManifest) ? fs.readFileSync(rgManifest, 'utf8') : ''; } catch {}
          return res.json({
            dir: rgCacheDir,
            note: '所有系统环境基本都在本目录中且已加入 PATH——共享 bin/ 里的全局 CLI 工具可直接用命令名调用，不用写全路径。',
            content,
          });
        }
        if (op === 'note') {
          if (!String(title || '').trim()) return res.status(400).json({ error: '缺少 title（要记录的工具/项目名）' });
          if (!String(entry || '').trim()) return res.status(400).json({ error: '缺少 entry（介绍内容）' });
          try { fs.mkdirSync(rgCacheDir, { recursive: true }); } catch {}
          const whoRg = (findMember(String(effCallerRg))?.name) || effCallerRg;
          const nowRg = beijingNow().toISOString().slice(0, 16).replace('T', ' ');
          const line = `## [${nowRg}] ${whoRg}: ${String(title).trim()}\n${String(entry).trim()}\n`;
          let all = '';
          try { all = fs.existsSync(rgManifest) ? fs.readFileSync(rgManifest, 'utf8') : ''; } catch {}
          all = `${all.trim() ? all.trim() + '\n' : ''}${line}`;
          // 容量控制：清单膨胀时保留最近条目（防无限增长）
          const allLines = all.split('\n');
          if (allLines.length > 600) {
            all = ['# 共享环境清单（过长已截断，保留最近条目）\n', ...allLines.slice(-500)].join('\n');
          }
          try { fs.writeFileSync(rgManifest, all); } catch (e) {
            return res.status(500).json({ error: `写入清单失败: ${e.message}` });
          }
          return res.json({
            success: true, title: String(title).trim(), dir: rgCacheDir,
            total: all.split('\n').filter((l) => l.startsWith('## [')).length,
          });
        }
        return res.status(400).json({ error: 'op 必须是 list 或 note' });
      }

      case 'send_local_image': {
        // 把本地图片（浏览器截图等）发给微信用户：读 workspace 截图目录里的文件
        // → 走 sendToMemberImage 出站管线 → 成功即删（临时截图不留垃圾）。
        // 用途：登录二维码/页面快照/验证码等「浏览器里截的图」直接给她看。
        // 安全：路径白名单（普通共享截图目录 ∪ 超限会话自己的截图目录）+ 图片扩展名。
        const { callerId, path: shotPath, targetMemberId } = params;
        const gcShot = _parseGroupCaller(callerId);
        const effCallerShot = gcShot ? gcShot.memberId : callerId;
        if (!effCallerShot || !isKnownCaller(effCallerShot)) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const SHOT_ROOT = path.resolve(path.join(__dirname, 'agent', 'dsh', 'workspace', '.dsh', 'playwright'));
        const shotRoots = [SHOT_ROOT];
        const ovShot = require('./utils/overdriveState');
        if (gcShot) {
          if (ovShot.isEnabled('group', gcShot.chatroomId)) {
            shotRoots.push(path.resolve(overdriveWorkspaceRoot(gcShot.chatroomId), '.dsh', 'playwright'));
          }
        } else if (ovShot.isEnabled('dm', String(effCallerShot))) {
          shotRoots.push(path.resolve(overdriveWorkspaceRoot(String(effCallerShot)), '.dsh', 'playwright'));
        }
        const absShot = path.resolve(String(shotPath || '').trim());
        const insideShot = shotRoots.some(root => absShot === root || absShot.startsWith(root + path.sep));
        if (!insideShot) {
          return res.status(400).json({ error: 'path 必须在浏览器截图目录内' });
        }
        if (!/\.(png|jpe?g|gif|webp)$/i.test(absShot)) {
          return res.status(400).json({ error: '只支持 png/jpg/gif/webp 图片' });
        }
        if (!fs.existsSync(absShot)) {
          return res.status(400).json({ error: `截图文件不存在: ${path.basename(absShot)}` });
        }
        // 目的地：显式 targetMemberId → 私发成员；群 caller → 发回群；否则 → 发给自己
        let targetShot;
        if (targetMemberId !== undefined && targetMemberId !== null && String(targetMemberId) !== '') {
          const wiShot = resolveRelayTarget(targetMemberId);
          if (!wiShot) return res.status(404).json({ error: '找不到这个发送目标：学号或已注册普通昵称（精确）' });
          targetShot = wiShot.id;
        } else {
          targetShot = gcShot ? gcShot.chatroomId : String(effCallerShot);
        }
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        const result = await steward.sendToMemberImage(targetShot, absShot);
        if (!result?.success) return res.status(500).json({ error: result?.error || '截图发送失败' });
        // 发送成功后截图保留 1 天（可回看/重发）；顺带清理各截图目录里 24 小时前的残留（幂等防累积）
        const nowShot = Date.now();
        for (const root of shotRoots) {
          try {
            if (fs.existsSync(root)) {
              for (const f of fs.readdirSync(root)) {
                const fp = path.join(root, f);
                const st = fs.statSync(fp);
                if (st.isFile() && nowShot - st.mtimeMs > 24 * 3600 * 1000) fs.unlinkSync(fp);
              }
            }
          } catch { /* 清理失败不阻塞发送结果 */ }
        }
        return res.json({ success: true, to: targetShot, sent: path.basename(absShot) });
      }

      case 'notify_all': {
        // 全员广播（敏感：管理员密码或系统管理员 callerId）
        const { callerId, text, password } = params;
        // 群 session：按实际操作者校验管理员身份
        const gcNotify = _parseGroupCaller(callerId);
        const effCallerNotify = gcNotify ? gcNotify.memberId : callerId;
        if (!verifyAdmin(password, effCallerNotify)) {
          return res.status(403).json({ error: '全员广播需要管理员密码' });
        }
        if (!text || !String(text).trim()) return res.status(400).json({ error: '缺少 text' });
        if (!steward) return res.status(400).json({ error: '微信管家未启用' });
        const sender = effCallerNotify ? findMember(effCallerNotify) : null;
        const prefix = sender ? `【${sender.name} 广播】\n` : '【广播】\n';
        // 全员入队：出站队列按 per-contact 限流自动交错发送（129 人约 6 分钟发完）
        const targets = members.filter(m => m.id);
        let queued = 0;
        for (const m of targets) {
          const r = await steward.sendToMember(String(m.id), prefix + String(text).trim());
          if (r?.success || r?.error === `成员 ${m.id} 未绑定微信号`) queued++; // 未绑定的跳过不算失败
        }
        return res.json({ success: true, total: targets.length, queued });
      }

      case 'submit_notice': {
        // 发布公告（敏感：写入 notices.json + 可选全员推送）
        const { callerId, title, content, password, broadcast } = params;
        // 群 session：按实际操作者校验管理员身份；公告落库署名也用实际操作者
        const gcNotice = _parseGroupCaller(callerId);
        const effCallerNotice = gcNotice ? gcNotice.memberId : callerId;
        if (!verifyAdmin(password, effCallerNotice)) {
          return res.status(403).json({ error: '发布公告需要管理员密码' });
        }
        if (!title) return res.status(400).json({ error: '缺少 title' });
        const notices = readJSON(NOTICES_FILE);
        const notice = {
          id: uuidv4(), title: String(title), content: String(content || ''),
          createdBy: effCallerNotice ? String(effCallerNotice) : 'agent', createdAt: beijingISO(),
        };
        notices.push(notice);
        writeJSON(NOTICES_FILE, notices);
        let broadcastResult = null;
        if (broadcast && steward) {
          const targets = members.filter(m => m.id);
          let queued = 0;
          for (const m of targets) {
            const r = await steward.sendToMember(String(m.id), `【公告】${title}\n${String(content || '').trim()}`);
            if (r?.success || r?.error === `成员 ${m.id} 未绑定微信号`) queued++;
          }
          broadcastResult = { total: targets.length, queued };
        }
        return res.json({ success: true, notice, ...(broadcastResult ? { broadcast: broadcastResult } : {}) });
      }

      // ---------- 管理员审批流（请求转发到管理员的 AI 会话） ----------

      case 'request_admin': {
        // 任何成员可调：把需要管理员批准的请求转发到管理员微信（周祎宸）
        // 注意：白名单操作参数名是 pendingAction（不能叫 action——会与请求体顶层 action 冲突）
        const { callerId, summary, pendingAction: pa, actionParams } = params;
        if (!callerId || !findMember(callerId)) return res.status(403).json({ error: 'callerId 无效' });
        if (!summary || !String(summary).trim()) return res.status(400).json({ error: '缺少 summary（要请求什么事）' });
        // 白名单校验（批准后自动执行的操作）
        let pendingAction = null;
        if (pa) {
          if (!APPROVABLE_ACTIONS.includes(pa)) {
            return res.status(400).json({ error: `pendingAction 必须是 ${APPROVABLE_ACTIONS.join('/')} 或不传（仅转发文本）` });
          }
          // actionParams 若传了字符串则解析为对象
          let parsedParams = actionParams || {};
          if (typeof parsedParams === 'string') {
            try { parsedParams = JSON.parse(parsedParams); }
            catch { return res.status(400).json({ error: 'actionParams 必须是合法 JSON 字符串' }); }
          }
          pendingAction = { action: pa, params: parsedParams };
        }
        const approvals = readApprovals();
        const approval = {
          id: uuidv4().substring(0, 8),
          requesterId: String(callerId), requesterName: findMember(callerId).name,
          summary: String(summary).trim(),
          ...(pendingAction ? { pendingAction } : {}),
          status: 'pending', createdAt: beijingISO(),
        };
        approvals.push(approval);
        writeApprovals(approvals);
        // 转发到管理员（第一个系统管理员）
        if (!steward) return res.json({ success: true, approvalId: approval.id, forwarded: false, note: '管家未启用，请求已存档' });
        const admin = ADMIN_MEMBER_IDS.find(id => findMember(id));
        if (!admin) return res.json({ success: true, approvalId: approval.id, forwarded: false, note: '未配置管理员，请求已存档' });
        const r = await steward.sendToMember(admin,
          `【审批请求 ${approval.id}】${findMember(callerId).name}（${callerId}）：${String(summary).trim()}\n回复「批准 ${approval.id}」或「拒绝 ${approval.id}」` +
          (pendingAction ? '（批准后将自动执行）' : ''));
        return res.json({ success: true, approvalId: approval.id, forwarded: !!r?.success, admin });
      }

      case 'approve_request': {
        // 仅系统管理员 callerId 可调：批准待批请求（白名单 action 自动执行）
        const { callerId, approvalId, note } = params;
        // 群 session：按实际操作者校验管理员身份
        const gcApprove = _parseGroupCaller(callerId);
        const effCallerApprove = gcApprove ? gcApprove.memberId : callerId;
        if (!isAdminCaller(effCallerApprove)) {
          return res.status(403).json({ error: '只有管理员可以批准请求' });
        }
        const approvals = readApprovals();
        const idx = approvals.findIndex(a => a.id === String(approvalId) && a.status === 'pending');
        if (idx === -1) return res.status(404).json({ error: `待批请求 ${approvalId} 不存在或已处理` });
        const approval = approvals[idx];
        approval.status = 'approved';
        approval.decidedAt = beijingISO();
        approval.decidedBy = String(effCallerApprove);
        approval.note = note ? String(note) : '';
        let executed = null;
        // 白名单 action 自动执行（内部递归 dispatch）
        if (approval.pendingAction?.action) {
          try {
            const inner = await _dispatchAgentTool(approval.pendingAction.action, {
              ...approval.pendingAction.params,
              callerId: String(effCallerApprove),   // 以管理员身份执行（免密码闸）
            });
            executed = inner;
          } catch (e) {
            executed = { error: e.message };
          }
        }
        approvals[idx] = approval;
        writeApprovals(approvals);
        // 通知请求者结果
        if (steward) {
          await steward.sendToMember(approval.requesterId,
            `你的请求已获管理员批准：${approval.summary}` +
            (executed?.error ? `（执行失败：${executed.error}）` : executed?.success ? '（已执行）' : '') +
            (approval.note ? `\n管理员备注：${approval.note}` : '')).catch(() => {});
        }
        return res.json({ success: true, approval, executed });
      }

      case 'reject_request': {
        // 仅系统管理员 callerId 可调：拒绝待批请求
        const { callerId, approvalId, reason } = params;
        // 群 session：按实际操作者校验管理员身份
        const gcReject = _parseGroupCaller(callerId);
        const effCallerReject = gcReject ? gcReject.memberId : callerId;
        if (!isAdminCaller(effCallerReject)) {
          return res.status(403).json({ error: '只有管理员可以拒绝请求' });
        }
        const approvals = readApprovals();
        const idx = approvals.findIndex(a => a.id === String(approvalId) && a.status === 'pending');
        if (idx === -1) return res.status(404).json({ error: `待批请求 ${approvalId} 不存在或已处理` });
        const approval = approvals[idx];
        approval.status = 'rejected';
        approval.decidedAt = beijingISO();
        approval.decidedBy = String(effCallerReject);
        approval.reason = reason ? String(reason) : '';
        approvals[idx] = approval;
        writeApprovals(approvals);
        if (steward) {
          await steward.sendToMember(approval.requesterId,
            `你的请求被管理员拒绝：${approval.summary}` +
            (approval.reason ? `\n理由：${approval.reason}` : '')).catch(() => {});
        }
        return res.json({ success: true, approval });
      }

      case 'query_pending_approvals': {
        // 查看待批请求（本人自己的请求；管理员/管理员上下文可查全部）
        const { callerId } = params;
        if (!callerId || (!findMember(callerId) && !isAdminCaller(callerId))) {
          return res.status(403).json({ error: 'callerId 无效' });
        }
        const approvals = readApprovals();
        const list = isAdminCaller(callerId)
          ? approvals
          : approvals.filter(a => a.requesterId === String(callerId));
        return res.json({ count: list.length, approvals: list.filter(a => a.status === 'pending').reverse() });
      }

      // ---------- 日程管理 ----------

      case 'delete_schedule': {
        // 删除日程：本人创建或仅涉及本人免密；否则需管理员（含系统管理员直通）
        const { callerId, scheduleId, password } = params;
        if (!callerId || !findMember(callerId)) return res.status(403).json({ error: 'callerId 无效' });
        const scheduleStore = require('./data/scheduleStore');
        const schedules = scheduleStore.readSchedules();
        const idx = schedules.findIndex(s => s.id === String(scheduleId));
        if (idx === -1) return res.status(404).json({ error: `日程 ${scheduleId} 不存在` });
        const sc = schedules[idx];
        const isOwner = sc.createdBy === String(callerId);
        const onlySelf = (sc.targetMemberIds || []).length === 0 || (sc.targetMemberIds || []).every(t => t === String(callerId));
        if (!isOwner && !onlySelf && !verifyAdmin(password, callerId)) {
          return res.status(403).json({ error: '删除他人创建/涉及他人的日程需要管理员密码' });
        }
        schedules.splice(idx, 1);
        scheduleStore.writeSchedules(schedules);
        return res.json({ success: true, deleted: { id: sc.id, title: sc.title } });
      }

      default:
        return res.status(400).json({ error: `未知 action: ${action}` });
    }
  } catch (e) {
    console.error('[AgentTool] 工具桥错误:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========== 管理日报 API ==========
app.get('/api/admin/reports', (req, res) => {
  const reports = dailyReport.readReports();
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const start = (page - 1) * limit;
  res.json({
    reports: reports.slice(start, start + limit),
    total: reports.length,
    page,
    totalPages: Math.ceil(reports.length / limit)
  });
});

app.get('/api/admin/reports/:id', (req, res) => {
  const reports = dailyReport.readReports();
  const report = reports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: '报告不存在' });
  res.json(report);
});

app.post('/api/admin/reports/generate', async (req, res) => {
  try {
    if (!agentEngine) return res.status(503).json({ error: 'LLM 服务未初始化' });
    const report = await dailyReport.generateReport(agentEngine, 'manual', wechatBot, pushManager);
    if (!report) {
      const yesterday = beijingNow();
      yesterday.setDate(yesterday.getDate() - 1);
      const yd = yesterday.toISOString().substring(0, 10);
      return res.json({ noData: true, message: `昨日（${yd}）无新增学员活动数据`, date: yd });
    }
    res.json(report);
  } catch (e) {
    console.error('[DailyReport] 手动生成失败:', e.message);
    res.status(500).json({ error: '报告生成失败: ' + e.message });
  }
});

app.delete('/api/admin/reports/:id', (req, res) => {
  const reports = dailyReport.readReports();
  const idx = reports.findIndex(r => r.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: '报告不存在' });
  reports.splice(idx, 1);
  dailyReport.writeReports(reports);
  res.json({ success: true });
});

// ==================== 远程数据管理 CLI API ====================
// 使用 CLI_API_KEY 鉴权，供 backend/cli.js 远程调用
const cliAuth = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || authHeader !== 'Bearer ' + CLI_API_KEY) {
    return res.status(401).json({ error: '未授权访问' });
  }
  next();
};

// 安全解析相对路径，防止路径穿越
const safeDataPath = (relPath) => {
  if (!relPath || typeof relPath !== 'string') return null;
  const cleaned = path.normalize(relPath).replace(/^([/\\])+/, '');
  if (cleaned.includes('..')) return null;
  const full = path.join(DATA_DIR, cleaned);
  if (full !== DATA_DIR && !full.startsWith(DATA_DIR + path.sep)) return null;
  return full;
};

/** 超限会话专属工作区根（与 OverdriveManager.workspaceRoot 同一计算：卷内 overdrive/workspaces/{key}） */
const overdriveWorkspaceRoot = (scopeKey) => {
  const safe = String(scopeKey || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(DATA_DIR, 'overdrive', 'workspaces', safe);
};

/** 共享主引擎工作区根（普通会话模型生成文件的落点） */
const NORMAL_WS_ROOT = path.resolve(path.join(__dirname, 'agent', 'dsh', 'workspace'));

// dsh 会话诊断（只读）：返回稳定 id 会话日志的构成分析 + dry-run 修复报告（含原始尾部
// 与内容块分布）。容器 shell 不可用时远程查看 400/空转现场：
//   node cli.js api GET "/api/cli/dsh-session?session=612"
app.get('/api/cli/dsh-session', cliAuth, (req, res) => {
  try {
    const raw = String(req.query.session || '').trim();
    if (!raw) return res.status(400).json({ error: '缺少 session 参数（如 612 / member-612 / group-xxx@chatroom）' });
    let logicalId = raw;
    if (!/^(member-|group-|admin-|guest-)/i.test(logicalId) && /^\d+$/.test(logicalId)) logicalId = `member-${logicalId}`;
    const { analyzeSessionLog, repairSessionLog, sanitizeSessionLog } = require('./agent/dsh/sessionLogRepair');
    const opts = {};
    if (req.query.full === '1') opts.tailTruncate = 0;          // 完整不截断
    const tl = parseInt(req.query.tail, 10);
    if (Number.isFinite(tl)) opts.tailLen = tl;                  // 返回尾部行数
    const analyze = analyzeSessionLog(logicalId, opts);
    const repair = repairSessionLog(logicalId, { dryRun: true });
    const action = String(req.query.action || '').trim();
    let sanitize = null;
    if (action === 'sanitize') {
      // 清洗孤立代理（lone surrogate）：不传 apply=1 只做 dry-run 报告
      const apply = req.query.apply === '1';
      sanitize = sanitizeSessionLog(logicalId, { dryRun: !apply });
    }
    res.json({ logicalId, analyze, repair, sanitize });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 列出数据目录文件
app.get('/api/cli/list', cliAuth, (req, res) => {
  try {
    const sub = req.query.dir || '';
    const target = sub ? safeDataPath(sub) : DATA_DIR;
    if (!target) return res.status(400).json({ error: '非法路径' });
    if (!fs.existsSync(target)) return res.status(404).json({ error: '目录不存在' });
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return res.status(400).json({ error: '不是目录' });

    const walk = (dir, base = '') => {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      const result = [];
      for (const it of items) {
        const rel = base ? `${base}/${it.name}` : it.name;
        if (it.isDirectory()) {
          if (base.split('/').length < 2) {
            result.push(...walk(path.join(dir, it.name), rel));
          } else {
            result.push({ path: rel, type: 'dir', size: 0 });
          }
        } else {
          try {
            const s = fs.statSync(path.join(dir, it.name));
            result.push({ path: rel, type: 'file', size: s.size, mtime: s.mtimeMs });
          } catch {
            result.push({ path: rel, type: 'file', size: 0, mtime: 0 });
          }
        }
      }
      return result;
    };

    const files = walk(target, sub);
    res.json({ base: sub || '.', count: files.length, files });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 读取文件内容
app.get('/api/cli/read', cliAuth, (req, res) => {
  try {
    const rel = req.query.path;
    const full = safeDataPath(rel);
    if (!full) return res.status(400).json({ error: '非法路径' });
    if (!fs.existsSync(full)) return res.status(404).json({ error: '文件不存在' });
    const stat = fs.statSync(full);
    if (stat.isDirectory()) return res.status(400).json({ error: '是目录不是文件' });

    if (stat.size > 20 * 1024 * 1024) {
      return res.status(413).json({ error: '文件过大（>20MB）' });
    }

    const buf = fs.readFileSync(full);
    const ext = path.extname(full).toLowerCase();
    const isText = ['.json', '.txt', '.js', '.md', '.csv', '.log', ''].includes(ext) ||
                   full.endsWith('.example');

    if (full.endsWith('.json.gz')) {
      try {
        const decompressed = zlib.gunzipSync(buf);
        return res.json({
          path: rel, size: stat.size, encoding: 'gzip-json',
          content: JSON.parse(decompressed.toString('utf8'))
        });
      } catch (e) {
        return res.json({ path: rel, size: stat.size, encoding: 'utf8', content: buf.toString('utf8'), error: 'gunzip failed: ' + e.message });
      }
    }

    if (isText) {
      const text = buf.toString('utf8');
      if (ext === '.json') {
        try {
          return res.json({ path: rel, size: stat.size, encoding: 'json', content: JSON.parse(text) });
        } catch {
          return res.json({ path: rel, size: stat.size, encoding: 'utf8', content: text });
        }
      }
      return res.json({ path: rel, size: stat.size, encoding: 'utf8', content: text });
    } else {
      return res.json({ path: rel, size: stat.size, encoding: 'base64', content: buf.toString('base64') });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// JSON 深合并工具：对象递归合并，数组按 id/memberId/month 去重合并，基础类型数组 union
const _mergeKeyFields = ['id', 'memberId', 'month', 'key', 'adminId'];
function mergeJSON(orig, patch) {
  // 都是数组：按去重字段合并
  if (Array.isArray(orig) && Array.isArray(patch)) {
    // 元素都是基础类型 → union 去重
    if (orig.length && typeof orig[0] !== 'object' && typeof patch[0] !== 'object') {
      const set = new Set(orig);
      for (const x of patch) set.add(x);
      return Array.from(set);
    }
    // 元素是对象：找去重字段
    const sample = orig.find(it => it && typeof it === 'object') ||
                   patch.find(it => it && typeof it === 'object') || {};
    const keyField = _mergeKeyFields.find(k => sample[k] !== undefined);
    if (!keyField) return [...orig, ...patch]; // 无去重字段，直接 concat
    const map = new Map();
    for (const it of orig) {
      if (it && typeof it === 'object' && it[keyField] !== undefined) {
        map.set(it[keyField], it);
      } else {
        map.set(Symbol(), it); // 无 key 的元素保留位置
      }
    }
    for (const it of patch) {
      if (!it || typeof it !== 'object' || it[keyField] === undefined) {
        map.set(Symbol(), it); // 新增无 key 元素
        continue;
      }
      const k = it[keyField];
      if (map.has(k) && typeof map.get(k) === 'object') {
        map.set(k, mergeJSON(map.get(k), it)); // 递归深合并
      } else {
        map.set(k, it);
      }
    }
    // 保留原顺序：先原元素(按出现顺序)，再新元素
    const result = [];
    const seen = new Set();
    for (const it of orig) {
      if (it && typeof it === 'object' && it[keyField] !== undefined) {
        if (!seen.has(it[keyField])) {
          result.push(map.get(it[keyField]));
          seen.add(it[keyField]);
        }
      } else {
        result.push(it);
      }
    }
    for (const it of patch) {
      if (it && typeof it === 'object' && it[keyField] !== undefined && !seen.has(it[keyField])) {
        result.push(map.get(it[keyField]));
        seen.add(it[keyField]);
      }
    }
    return result;
  }
  // 都是对象：递归合并字段
  if (orig && typeof orig === 'object' && !Array.isArray(orig) &&
      patch && typeof patch === 'object' && !Array.isArray(patch)) {
    const result = { ...orig };
    for (const k of Object.keys(patch)) {
      if (k in result && result[k] && typeof result[k] === 'object' &&
          patch[k] && typeof patch[k] === 'object') {
        result[k] = mergeJSON(result[k], patch[k]);
      } else {
        result[k] = patch[k];
      }
    }
    return result;
  }
  // 基础类型：patch 覆盖
  return patch;
}

// 写入文件内容（覆盖 / merge / append 三种模式）
app.post('/api/cli/write', cliAuth, (req, res) => {
  try {
    const { path: rel, content, encoding, mode } = req.body || {};
    const full = safeDataPath(rel);
    if (!full) return res.status(400).json({ error: '非法路径' });

    let finalContent = content;
    let isJson = full.endsWith('.json') || full.endsWith('.json.gz');

    // merge / append 模式需要读原文件
    if ((mode === 'merge' || mode === 'append') && fs.existsSync(full)) {
      try {
        let origBuf = fs.readFileSync(full);
        if (full.endsWith('.json.gz')) origBuf = zlib.gunzipSync(origBuf);
        const origText = origBuf.toString('utf8');

        if (isJson) {
          const origJson = JSON.parse(origText);
          if (mode === 'merge') {
            // patch 必须是对象或数组
            const patchJson = typeof content === 'string' ? JSON.parse(content) : content;
            finalContent = mergeJSON(origJson, patchJson);
          } else { // append
            if (Array.isArray(origJson)) {
              const patchArr = typeof content === 'string' ? JSON.parse(content) :
                               Array.isArray(content) ? content : [content];
              finalContent = [...origJson, ...patchArr];
            } else {
              return res.status(400).json({ error: 'append 模式仅支持数组或文本文件' });
            }
          }
        } else {
          // 文本 append
          if (mode === 'append') {
            finalContent = origText + (origText.endsWith('\n') ? '' : '\n') + content;
          } else {
            return res.status(400).json({ error: 'merge 模式仅支持 JSON 文件' });
          }
        }
      } catch (e) {
        return res.status(400).json({ error: '原文件解析失败: ' + e.message });
      }
    }

    let buf;
    if (encoding === 'base64' && !mode) {
      buf = Buffer.from(content, 'base64');
    } else if (typeof finalContent === 'string') {
      buf = Buffer.from(finalContent, 'utf8');
    } else {
      buf = Buffer.from(JSON.stringify(finalContent, null, 2), 'utf8');
    }

    fs.mkdirSync(path.dirname(full), { recursive: true });

    // .json.gz 自动 gzip（除非显式 base64）
    if (full.endsWith('.json.gz') && encoding !== 'base64') {
      buf = zlib.gzipSync(buf);
    }

    // 备份原文件
    if (fs.existsSync(full)) {
      try { fs.copyFileSync(full, full + '.bak'); } catch {}
    }

    fs.writeFileSync(full, buf);
    const stat = fs.statSync(full);
    res.json({ success: true, path: rel, size: stat.size, mtime: stat.mtimeMs, mode: mode || 'overwrite' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除文件
app.delete('/api/cli/delete', cliAuth, (req, res) => {
  try {
    const rel = req.query.path;
    const full = safeDataPath(rel);
    if (!full) return res.status(400).json({ error: '非法路径' });
    if (!fs.existsSync(full)) return res.status(404).json({ error: '文件不存在' });

    const stat = fs.statSync(full);
    if (stat.isDirectory()) return res.status(400).json({ error: '不能删除目录' });

    try { fs.copyFileSync(full, full + '.bak'); } catch {}
    fs.unlinkSync(full);
    res.json({ success: true, path: rel, backup: rel + '.bak' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 移动/重命名数据目录内文件或目录（维护用：会话日志/记忆迁移等）。目录整棵
// move（同卷 fs.renameSync 原子完成）；目标已存在时拒绝，绝不覆盖。
app.post('/api/cli/move', cliAuth, (req, res) => {
  try {
    const from = req.body && req.body.from;
    const to = req.body && req.body.to;
    if (!from || !to) return res.status(400).json({ error: '需要 from 与 to' });
    const src = safeDataPath(from);
    const dst = safeDataPath(to);
    if (!src || !dst) return res.status(400).json({ error: '非法路径' });
    if (!fs.existsSync(src)) return res.status(404).json({ error: '源不存在' });
    if (fs.existsSync(dst)) return res.status(409).json({ error: '目标已存在（不会覆盖）' });
    if (!fs.existsSync(path.dirname(dst))) return res.status(400).json({ error: '目标父目录不存在' });
    fs.renameSync(src, dst);
    res.json({ success: true, from, to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 上传二进制文件（multipart）
const cliUpload = multer({ dest: TEMP_DIR });
app.post('/api/cli/upload', cliAuth, cliUpload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '请选择文件' });
    const rel = req.body.path || req.file.originalname;
    const full = safeDataPath(rel);
    if (!full) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: '非法路径' });
    }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.copyFileSync(req.file.path, full);
    fs.unlinkSync(req.file.path);
    const stat = fs.statSync(full);
    res.json({ success: true, path: rel, size: stat.size, mtime: stat.mtimeMs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 测试 API key 是否有效
app.get('/api/cli/ping', cliAuth, (req, res) => {
  res.json({
    ok: true,
    time: beijingISO(),
    dataDir: DATA_DIR,
    files: fs.existsSync(DATA_DIR) ? fs.readdirSync(DATA_DIR).length : 0
  });
});

server.listen(PORT, '0.0.0.0', () => {
  pushManager.initPushManager();
  pushScheduler.start(pushManager, () => wechatBot, () => agentEngine, () => steward);
  updateInjuryStatusFromFitnessData();

  // 启动时清理 inbox 过期通知（保留 3 天 + 最多 500 条）
  try {
    const inboxData = readJSON(pushManager.NOTIFICATION_INBOX_FILE);
    if (Array.isArray(inboxData) && inboxData.length > 0) {
      const before = inboxData.length;
      const cleaned = pushManager.cleanupInbox(inboxData);
      if (cleaned.length < before) {
        writeJSON(pushManager.NOTIFICATION_INBOX_FILE, cleaned);
        console.log(`[Inbox] 启动清理: ${before} → ${cleaned.length} 条`);
      }
    }
  } catch (e) {
    console.error('[Inbox] 启动清理失败:', e.message);
  }

  const ips = getLocalIPs();
  console.log(`\n🚀 后端服务器已启动:`);
  console.log(`   - 本地访问: http://localhost:${PORT}`);
  console.log(`   - 局域网访问 (请在手机尝试以下地址):`);
  ips.forEach(ip => {
    console.log(`     👉 http://${ip.address}:5173  (${ip.name})`);
  });
  console.log(`\n⚠️  提示: 如果手机无法打开，请确保电脑网络设为"专用(Private)"，并运行 tools/open_firewall.ps1\n`);

  // CLI 远程数据管理密钥提示
  if (process.env.CLI_API_KEY) {
    console.log(`🔐 远程数据管理 CLI 已启用 (CLI_API_KEY 来自环境变量)`);
  } else {
    console.log(`🔐 远程数据管理 CLI 已启用 (使用动态 INTERNAL_API_KEY，建议设置 CLI_API_KEY 环境变量以便远程使用)`);
    console.log(`   本会话 CLI Key: ${CLI_API_KEY}`);
  }

  scheduleRoutes.installRoutes(app);
  automationRoutes.installRoutes(app);
});

// Graceful shutdown handling
// 关机必须先优雅关闭 dsh 引擎：await 关闭子进程，让当前 turn 的会话日志
// （session.jsonl.zstd）落完盘。硬杀子进程会截断日志 → 下次启动 resume 恢复
// 出异常状态 → 会话空转（自动部署/重启时曾触发该故障）。
const gracefulShutdown = async (signal) => {
  console.log(`\nReceived ${signal}. Ensuring data is saved...`);

  // Actually, in our case, we're using synchronous fs.writeFileSync on every score submission,
  // so data is always up-to-date on disk. This is just an extra safety check/log.
  const scores = readJSON(SCORES_FILE);
  const members = readJSON(MEMBERS_FILE);

  writeJSON(SCORES_FILE, scores);
  writeJSON(MEMBERS_FILE, members);

  // 超限 worker 优雅关停（忙碌中的轮次跳过——dsh 引擎独立子进程随宿主退出回收）
  try {
    if (overdriveManager && typeof overdriveManager.closeAll === 'function') {
      await Promise.race([
        Promise.resolve(overdriveManager.closeAll()).catch(() => {}),
        new Promise(r => setTimeout(r, 3000)),
      ]);
    }
  } catch (e) {
    console.warn('超限 worker 关停异常（忽略，继续退出）:', e.message);
  }

  // dsh 引擎优雅关闭（最多等 8s，防关机被卡死；极端关不掉也有空转自恢复兜底）
  try {
    if (dshEngine && typeof dshEngine.close === 'function') {
      await Promise.race([
        Promise.resolve(dshEngine.close()).catch(() => {}),
        new Promise(r => setTimeout(r, 8000)),
      ]);
      console.log('dsh 引擎已关闭（会话日志已落盘）');
    }
  } catch (e) {
    console.warn('dsh 引擎关闭异常（忽略，继续退出）:', e.message);
  }

  console.log('Data verified and saved. Shutting down...');
  process.exit(0);
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  gracefulShutdown('Uncaught Exception');
});

