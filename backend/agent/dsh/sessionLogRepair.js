/**
 * dsh 会话日志修复工具（手动 / 自动复用）
 *
 * 背景：dsh 会话日志 session.jsonl.zstd 是「zstd 帧拼接」容器 —— 每批事件一个独立
 * 帧、带校验和，追加式写入。部署切换硬杀进程时只可能截断最后一帧；若被杀瞬间
 * 一个回合（turn）只写了一部分（无 turn/end 收尾），或帧被截成撕裂帧，下次
 * resume 恢复出的历史就含「不闭合的回合/工具序列」，DeepSeek API 直接
 * HTTP 400 INVALID_REQUEST 拒绝，表现为零输出空转。
 *
 * 本工具做的事（修复式完整恢复，区别于「隔离 + 摘要」的降级）：
 *   1. 帧层：解析出所有完整 zstd 帧，撕裂的最后一帧丢弃；
 *   2. 行层：解出明文 JSONL，找到最后一个完整闭合的回合边界（type:"turn/end"），
 *      坏行（JSON 不可解析）出现后不再信任后续行；
 *   3. 重写：header 独立一帧 + 保留事件拼一帧（与 dsh 写入格式一致），
 *      原文件先 rename 备份（.pre-repair-时间戳）；
 *   4. 这样日志以闭合回合收尾，resume 即能完整恢复之前的全部上下文。
 *
 * 布局与 dsh-session-persistence-jsonl 保持一致：
 *   {HOME}/sessions/{projectKey}/{encodeSegment(id)}/session.jsonl.zstd
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ZSTD_MAGIC = 4247762216; // 28 b5 2f fd
const ZSTD_CHECKSUM_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
// dsh HOME（与 DshAgentEngine.HOME_DIR 相同：项目内 home 目录）
const HOME_DIR = path.join(__dirname, 'home');

/** 与 dsh-session-persistence-jsonl 的 encodeSegment 完全一致（session id → 安全路径段） */
function encodeSegment(raw) {
  raw = String(raw);
  if (raw.length === 0) return raw;
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/**
 * 结构扫描 zstd 帧（不解压 block）：返回完整帧区间列表 + 可选撕裂尾起点。
 * 参照 dsh-session-persistence-jsonl 的 scanZstdFrames。
 */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  const torn = () => ({ frames, tornStart: offset });
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return torn();
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return torn();
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error('corrupt Zstandard session log: reserved frame-header bit');
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return torn();
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return torn();
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error('corrupt Zstandard session log: reserved block type');
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return torn();
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return torn();
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames, tornStart: undefined };
}

/** 定位某 logicalId（如 member-612）的会话日志文件，跨 projectKey 目录扫描 */
function findLogPath(logicalId, homeDir = HOME_DIR) {
  const seg = encodeSegment(String(logicalId));
  const root = path.join(homeDir, 'sessions');
  if (!fs.existsSync(root)) return null;
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const dir = path.join(root, proj.name, seg);
    const file = path.join(dir, 'session.jsonl.zstd');
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** 从解码行列表里提取顶层 type 序列（诊断/测试用），最多 lastN 行 */
function typeSequence(lines, from = 0, to = lines.length) {
  const out = [];
  for (let i = from; i < to && out.length < 60; i++) {
    try {
      const v = JSON.parse(lines[i]);
      out.push(v && typeof v === 'object' && !Array.isArray(v) ? String(v.type ?? '?') : '?');
    } catch {
      out.push('<bad-json>');
    }
  }
  return out;
}

/**
 * 修复一个会话日志。
 * @param {string} logicalId - 外部逻辑 id（member-612 / group-xxx@chatroom / admin-x）
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - 只分析报告，不写文件
 * @param {string} [opts.homeDir] - 覆盖 HOME（测试用）
 * @returns 结果对象（见 report 字段）
 */
function repairSessionLog(logicalId, opts = {}) {
  const report = { ok: false, id: String(logicalId) };
  try {
    const file = findLogPath(logicalId, opts.homeDir);
    if (!file) return { ...report, reason: 'no-log', message: '未找到会话日志（该 id 无磁盘会话）' };
    report.path = file;
    const buffer = fs.readFileSync(file);
    report.bytes = buffer.length;

    // 帧层
    let frames, tornStart;
    try {
      ({ frames, tornStart } = scanZstdFrames(buffer));
    } catch (e) {
      return { ...report, reason: 'corrupt-frames', message: `帧结构损坏：${e.message}` };
    }
    report.frames = frames.length;
    report.tornStart = tornStart; // 撕裂尾起点（若存在）
    if (frames.length === 0) return { ...report, reason: 'no-frames', message: '无完整帧（日志可能整体损坏）' };

    // 解出所有完整帧明文
    const parts = [];
    for (const f of frames) {
      try {
        parts.push(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end)));
      } catch (e) {
        return { ...report, reason: 'decode-error', message: `帧 ${f.start} 解压失败：${e.message}` };
      }
    }
    const text = Buffer.concat(parts).toString('utf8');
    // 每帧以 \n 结尾；split 后去掉末尾空串
    const allLines = text.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
    report.lines = allLines.length;
    if (allLines.length === 0) return { ...report, reason: 'empty', message: '日志内容为空' };

    // header 校验
    let header = null;
    try {
      header = JSON.parse(allLines[0]);
    } catch {}
    if (!header || typeof header !== 'object' || header.type !== 'session') {
      return { ...report, reason: 'bad-header', message: '首行不是合法 session header' };
    }
    report.headerId = header.id;

    // 行层：找坏行 + 最后一个闭合 turn/end
    let firstBadLine = -1;
    let lastClosedLine = -1; // 存 line index（含 header 的 0-based）
    for (let i = 1; i < allLines.length; i++) {
      let v = null;
      try {
        v = JSON.parse(allLines[i]);
      } catch {
        firstBadLine = i;
        break; // 坏行之后的不可信
      }
      if (v && typeof v === 'object' && !Array.isArray(v) && v.type === 'turn/end') lastClosedLine = i;
    }
    report.firstBadLine = firstBadLine;
    report.lastClosedLine = lastClosedLine;

    // 语义检查：日志是否已「闭合收尾」——最后一个有效事件就是 turn/end
    const lastLineIdx = allLines.length - 1;
    const cleanTail = firstBadLine === -1 && tornStart === undefined && lastClosedLine === lastLineIdx;
    if (cleanTail) {
      return {
        ...report,
        ok: true,
        reason: 'already-closed',
        message: '日志本身以完整回合收尾，无需修复（若仍 400，问题不在日志尾部）',
        tailTypes: typeSequence(allLines, Math.max(1, allLines.length - 8)),
      };
    }

    // 需要修复：保留 [header .. lastClosedLine]，其后全部丢弃
    const keepEnd = lastClosedLine;
    if (keepEnd < 1) {
      // 连一个闭合回合都没有（可能 header 后立刻被截断）
      return {
        ...report,
        reason: 'no-closed-turn',
        message: '日志中找不到任何完整闭合回合（turn/end），无法安全截尾——建议按隔离处理',
        tailTypes: typeSequence(allLines, 0),
      };
    }
    const removedLines = allLines.length - 1 - keepEnd; // 被丢弃的事件行数（不含 header）
    report.removedLines = removedLines;

    if (opts.dryRun) {
      return {
        ...report,
        ok: true,
        reason: 'would-repair',
        message: `（dry-run）将截掉尾部 ${removedLines} 行，保留到第 ${keepEnd} 行（${lastClosedLine === lastLineIdx ? '闭合 turn' : ''}）`,
        tailTypes: typeSequence(allLines, Math.max(1, keepEnd - 4), keepEnd + 1),
        removedPreview: typeSequence(allLines, keepEnd + 1),
      };
    }

    // 写回：原文件备份 → 原子写入新文件
    const backup = `${file}.pre-repair-${Date.now()}`;
    fs.renameSync(file, backup);
    const headerJson = `${allLines[0]}\n`;
    const bodyJson = keepEnd >= 1 ? `${allLines.slice(1, keepEnd + 1).join('\n')}\n` : '';
    const content = Buffer.concat([
      zlib.zstdCompressSync(Buffer.from(headerJson, 'utf8'), ZSTD_CHECKSUM_OPTS),
      bodyJson ? zlib.zstdCompressSync(Buffer.from(bodyJson, 'utf8'), ZSTD_CHECKSUM_OPTS) : Buffer.alloc(0),
    ]);
    const tmp = `${file}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    report.backup = backup;
    report.repairedBytes = content.length;
    return {
      ...report,
      ok: true,
      reason: 'repaired',
      message: `已截尾修复：删除尾部 ${removedLines} 行（未闭合回合），原文件备份为 ${path.basename(backup)}`,
      tailTypes: typeSequence(allLines, Math.max(1, keepEnd - 4), keepEnd + 1),
    };
  } catch (e) {
    return { ...report, reason: 'error', message: e.message };
  }
}

/**
 * 会话历史诊断分析（400/空转定位用）：解出日志后统计——
 *   事件类型分布、轮数（turn/start、turn/end）、历史工具调用名、
 *   图片引用提示数、sha256 内容寻址引用数、附件对象文件缺失数。
 * 用于区分 resume 400 的三类成因：附件对象缺失 / 历史 image 引用 /
 * 工具 schema 演进不匹配。仅诊断，不写文件。
 */
function analyzeSessionLog(logicalId, opts = {}) {
  const report = { id: String(logicalId) };
  try {
    const file = findLogPath(logicalId, opts.homeDir);
    if (!file) return { ...report, ok: false, reason: 'no-log' };
    report.path = file;
    const buffer = fs.readFileSync(file);
    let frames, tornStart;
    try { ({ frames, tornStart } = scanZstdFrames(buffer)); } catch (e) { return { ...report, reason: `frames: ${e.message}` }; }
    report.bytes = buffer.length;
    report.frames = frames.length;
    report.tornStart = tornStart != null;
    const parts = [];
    for (const f of frames) {
      try { parts.push(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end))); } catch (e) { return { ...report, reason: `decode: ${e.message}` }; }
    }
    const text = Buffer.concat(parts).toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    report.lines = lines.length;
    const eventTypes = {};
    const toolCalls = {};
    const shaRefs = [];
    let imageHints = 0;
    for (const ln of lines) {
      if (!ln || ln[0] !== '{') continue;
      let v = null;
      try { v = JSON.parse(ln); } catch { continue; }
      if (!v || typeof v !== 'object') continue;
      const t = v.type;
      if (t) eventTypes[t] = (eventTypes[t] || 0) + 1;
      if (t === 'tool/call') {
        const nm = (v.data && (v.data.name || v.argsName)) || v.name;
        if (typeof nm === 'string' && nm) toolCalls[nm] = (toolCalls[nm] || 0) + 1;
        else {
          // 兜底：从整行文本提取 name
          const m = ln.match(/"name":"([^"]{1,60})"/);
          if (m) toolCalls[m[1]] = (toolCalls[m[1]] || 0) + 1;
        }
      }
      // 文本级信号（JSON 序列化后的字面量）
      imageHints += (ln.match(/"type":"image"|"image_url"|data:image\/|"mimeType":"image\//g) || []).length;
      const sh = ln.match(/"sha256":"([0-9a-f]{8,64})"/g) || [];
      for (const s of sh) {
        const val = s.match(/"sha256":"([0-9a-f]{8,64})"/)[1];
        if (!shaRefs.includes(val)) shaRefs.push(val);
      }
    }
    report.eventTypes = eventTypes;
    report.toolCalls = toolCalls;
    report.imageHints = imageHints;
    report.sha256Refs = shaRefs.length;
    // 附件对象存在性（DSH_HOME/attachments/v1/objects/{前2位}/{sha256}）
    let missing = 0;
    const objRoot = path.join(opts.homeDir || HOME_DIR, 'attachments', 'v1', 'objects');
    for (const h of shaRefs) {
      if (!fs.existsSync(path.join(objRoot, h.slice(0, 2), h))) missing++;
    }
    report.missingObjects = missing;
    report.sha256Sample = shaRefs.slice(0, 3);
    // 内容块类型分布 + 原始尾部（人工读 400/空转现场用：user/message 是调模型前
    // 落盘的，直接含被拒请求里真正发出去的消息/附件块）
    const partTypes = {};
    for (const ln of lines) {
      if (!ln || ln[0] !== '{') continue;
      let v = null;
      try { v = JSON.parse(ln); } catch { continue; }
      if (!v || !Array.isArray(v.content)) continue;
      for (const p of v.content) {
        if (!p || typeof p !== 'object') continue;
        const pt = String(p.type || '?');
        partTypes[pt] = (partTypes[pt] || 0) + 1;
        if (p.attachment || p.attachmentId || p.fileId || p.data) partTypes[`${pt}+payload`] = (partTypes[`${pt}+payload`] || 0) + 1;
      }
    }
    report.partTypes = partTypes;
    // 尾部原始行（诊断人工读现场）：默认 8 行、每行截 900；可经 opts 调大/不截
    const tailLen = Number.isFinite(opts.tailLen) ? Math.max(1, Math.min(200, opts.tailLen)) : 8;
    const truncate = Number.isFinite(opts.tailTruncate) ? Math.max(0, opts.tailTruncate) : 900;
    report.rawTail = lines.slice(-tailLen).map((l) =>
      (truncate > 0 && l.length > truncate) ? `${l.slice(0, truncate)}…(截断)` : l);
    report.ok = true;
    return report;
  } catch (e) {
    return { ...report, reason: e.message };
  }
}

/** 递归清洗字符串字段中的孤立代理（lone surrogate）为 U+FFFD，保留成对 emoji */
function sanitizeLoneSurrogates(value) {
  if (typeof value === 'string') {
    let out = '';
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const nx = value.charCodeAt(i + 1);
        if (nx >= 0xdc00 && nx <= 0xdfff) {
          out += value[i] + value[i + 1];
          i++;
        } else {
          out += '\uFFFD'; // 孤立高位 → 替换符
        }
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        out += '\uFFFD'; // 孤立低位 → 替换符
      } else {
        out += value[i];
      }
    }
    return out;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const arr = value.map((v) => {
      const nv = sanitizeLoneSurrogates(v);
      if (nv !== v) changed = true;
      return nv;
    });
    return changed ? arr : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const obj = {};
    for (const k of Object.keys(value)) {
      const nv = sanitizeLoneSurrogates(value[k]);
      if (nv !== value[k]) changed = true;
      obj[k] = nv;
    }
    return changed ? obj : value;
  }
  return value;
}

/** 递归统计对象中的孤立代理字符数（在解码后的值上统计，准确） */
function countLoneSurrogates(value) {
  if (typeof value === 'string') {
    let n = 0;
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        const nx = value.charCodeAt(i + 1);
        if (!(nx >= 0xdc00 && nx <= 0xdfff)) n++;
      } else if (c >= 0xdc00 && c <= 0xdfff) n++;
    }
    return n;
  }
  if (Array.isArray(value)) return value.reduce((s, v) => s + countLoneSurrogates(v), 0);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((s, k) => s + countLoneSurrogates(value[k]), 0);
  }
  return 0;
}

/**
 * 清洗一个会话日志中的孤立代理（lone surrogate）。
 * 根因：_appendMemory/_memorySummary 用 substring 按 UTF-16 截断，把 emoji 代理对
 * 切半成孤立代理 → 注入 dsh 会话 → DeepSeek 服务端解析 JSON 报 hex-escape 400，
 * 且每次 resume 恢复该历史都会复现。本函数直接把磁盘日志里的孤立代理替换为 U+FFFD，
 * 一行一帧地重写，结构与 repairSessionLog 一致；原文件先备份。
 * @param {string} logicalId
 * @param {object} [opts] - { dryRun, homeDir }
 * @returns 报告（含替换的孤立代理数 / 是否改动）
 */
function sanitizeSessionLog(logicalId, opts = {}) {
  const report = { ok: false, id: String(logicalId) };
  try {
    const file = findLogPath(logicalId, opts.homeDir);
    if (!file) return { ...report, reason: 'no-log', message: '未找到会话日志' };
    report.path = file;
    const buffer = fs.readFileSync(file);
    report.bytes = buffer.length;
    let frames, tornStart;
    try { ({ frames, tornStart } = scanZstdFrames(buffer)); } catch (e) { return { ...report, reason: `frames: ${e.message}` }; }
    report.frames = frames.length;
    report.tornStart = tornStart;
    const parts = [];
    for (const f of frames) {
      try { parts.push(zlib.zstdDecompressSync(buffer.subarray(f.start, f.end))); } catch (e) { return { ...report, reason: `decode: ${e.message}` }; }
    }
    const text = Buffer.concat(parts).toString('utf8');
    const allLines = text.split('\n');
    if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();
    report.lines = allLines.length;

    // 逐行 JSON.parse → 清洗字符串字段 → 若变化重新 stringify
    let cleanedLines = 0;
    let loneCount = 0;
    const outLines = allLines.map((ln) => {
      if (!ln || ln[0] !== '{') return ln;
      let v;
      try { v = JSON.parse(ln); } catch { return ln; }
      const before = countLoneSurrogates(v);
      const nv = sanitizeLoneSurrogates(v);
      if (nv === v) return ln;
      cleanedLines++;
      loneCount += before;
      return JSON.stringify(nv);
    });
    report.cleanedLines = cleanedLines;
    report.loneSurrogates = loneCount;
    if (cleanedLines === 0) {
      return { ...report, ok: true, reason: 'clean', message: '未发现孤立代理，无需清洗' };
    }
    if (opts.dryRun) {
      return { ...report, ok: true, reason: 'would-sanitize', message: `（dry-run）将清洗 ${cleanedLines} 行、共 ${loneCount} 个孤立代理` };
    }
    // 写回：备份原文件 → 原子写入（header 独立一帧 + 其余合并一帧，与 repairSessionLog 一致）
    const backup = `${file}.pre-sanitize-${Date.now()}`;
    fs.renameSync(file, backup);
    const headerJson = outLines[0] ? `${outLines[0]}\n` : '';
    const bodyJson = outLines.length > 1 ? `${outLines.slice(1).join('\n')}\n` : '';
    const content = Buffer.concat([
      headerJson ? zlib.zstdCompressSync(Buffer.from(headerJson, 'utf8'), ZSTD_CHECKSUM_OPTS) : Buffer.alloc(0),
      bodyJson ? zlib.zstdCompressSync(Buffer.from(bodyJson, 'utf8'), ZSTD_CHECKSUM_OPTS) : Buffer.alloc(0),
    ]);
    const tmp = `${file}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
    report.backup = backup;
    report.repairedBytes = content.length;
    return { ...report, ok: true, reason: 'sanitized', message: `已清洗 ${cleanedLines} 行、共 ${loneCount} 个孤立代理（替换为 U+FFFD），原文件备份为 ${path.basename(backup)}` };
  } catch (e) {
    return { ...report, reason: 'error', message: e.message };
  }
}

module.exports = {
  HOME_DIR,
  encodeSegment,
  scanZstdFrames,
  findLogPath,
  repairSessionLog,
  analyzeSessionLog,
  sanitizeSessionLog,
};
