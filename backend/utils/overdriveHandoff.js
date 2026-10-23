/**
 * overdriveHandoff —— 超限⇄普通 模式切换时的 AI 上下文交接（冷启动缓解）
 *
 * 超限 runtime 使用独立的 home/会话/记忆（见 DshAgentEngine._memoryFile 的
 * _overdrive 后缀），与普通模式上下文互相独立、互不串味。切换模式后目标会话
 * 是"冷启动"的——为了不让 AI 失忆，切换时对源模式"上次切换以来新增"的对话做
 * 一次 **AI 摘要**，再作为引擎系统事件注入目标会话，下一条消息即被模型感知。
 *
 * 增量去重（游标）：
 *   每个会话 × 每个源模式记一个游标 = 上次成功交接时该模式记忆的总轮数。
 *   再次从同一模式切换时，只总结「游标之后新增」的轮次（最多 HANDOFF_CAP 轮），
 *   不与上次已注入的摘要重复；总结失败不推进游标，下次重试同一段。
 *   记忆滚动裁掉旧轮导致 total < 游标时，游标归零重算（旧轮已不在记忆，无法再补）。
 *
 * 本模块职责：
 *   1. memoryFileFor(engineMember, mode)：取某会话在指定模式下的记忆文件路径
 *   2. readRecentTurns(engineMember, mode, n)：读最近 n 轮（兼容保留）
 *   3. aiSummarizeTurns(turnsText)：DeepSeek 官方 chat 补全生成一段中文要点摘要
 *   4. handoffText(engineMember, fromMode)：生成「【切换前…对话摘要（新增）】…」
 *      注入文本（无新增/无记忆/API 失败 → 返回空串，调用方静默跳过，不阻塞切换）
 */

const fs = require('fs');
const path = require('path');
const { getDataPath } = require('./dataPath');

/** 每次交接最多总结多少轮"新增"对话（可 DSH_HANDOFF_ROUNDS 覆盖） */
const HANDOFF_CAP = Math.max(10, Number(process.env.DSH_HANDOFF_ROUNDS || 40));

/** 每个会话在某个模式下的记忆文件名（与 DshAgentEngine._memoryFile 保持一致） */
function memoryFileFor(engineMember, mode) {
  const suffix = mode === 'overdrive' ? '_dsh_overdrive.json' : '_dsh.json';
  return path.join(getDataPath('conversation_memory'), `${engineMember}${suffix}`);
}

/** 读某会话在指定模式下的完整记忆轮次数组（无文件/损坏 → null） */
function _turnsArray(engineMember, mode) {
  try {
    const file = memoryFileFor(engineMember, mode);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const turns = Array.isArray(data.turns) ? data.turns : [];
    return turns.length > 0 ? turns : null;
  } catch {
    return null;
  }
}

/** 轮次数组 → 压缩文本（截断过长单轮，防摘要请求体膨胀） */
function _formatTurns(turns) {
  return turns.map((t) => {
    const who = t.kind && t.kind !== 'user' ? `[你主动] ${String(t.text || '').slice(0, 120)}` : `她：${String(t.text || '').slice(0, 300)}`;
    const reply = String(t.reply || '').replace(/\s+/g, ' ').slice(0, 200);
    return `${who}\n你：${reply}`;
  }).join('\n');
}

/** 读某会话最近 n 轮记忆 → 压缩文本（兼容旧调用方；无文件/为空 → null） */
function readRecentTurns(engineMember, mode, n = 40) {
  const turns = _turnsArray(engineMember, mode);
  if (!turns) return null;
  return _formatTurns(turns.slice(-Math.max(1, n)));
}

// ---------- 游标（增量去重） ----------

const CURSOR_FILE = getDataPath('overdrive-handoff-cursors.json');

function _readCursors() {
  try {
    if (!fs.existsSync(CURSOR_FILE)) return {};
    return JSON.parse(fs.readFileSync(CURSOR_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function _writeCursors(cursors) {
  try {
    fs.mkdirSync(path.dirname(CURSOR_FILE), { recursive: true });
    fs.writeFileSync(CURSOR_FILE, JSON.stringify(cursors, null, 2));
  } catch (e) {
    console.warn('[overdriveHandoff] 游标落盘失败（下次可能重复总结）:', e.message);
  }
}

/**
 * 计算"待交接的新增轮次"文本（纯同步，便于测试）：
 * @returns {{text: string|null, total: number, fresh: number}} text=待总结文本
 *   （无新增返回 text:null）；此函数不推进游标（由 handoffText 成功后推进）。
 */
function computeHandoffPayload(engineMember, fromMode, cap = HANDOFF_CAP) {
  const turns = _turnsArray(engineMember, fromMode);
  if (!turns) return { text: null, total: 0, fresh: 0 };
  const total = turns.length;
  const cursors = _readCursors();
  const ckey = `${engineMember}|${fromMode}`;
  const seen = cursors[ckey] && Number.isFinite(cursors[ckey].seen) ? cursors[ckey].seen : 0;
  // 记忆滚动裁掉旧轮（total < seen）→ 归零重算；否则从上次已总结处继续
  const start = seen <= total ? seen : 0;
  const fresh = turns.slice(start);
  if (fresh.length === 0) return { text: null, total, fresh: 0 };
  const payload = fresh.slice(-Math.max(1, cap));
  return { text: _formatTurns(payload), total, fresh: fresh.length };
}

/**
 * AI 摘要：把一段对话压缩成中文要点（第三人称、聚焦话题/情绪/未完成事项/关键数据），
 * 供切换后的"新上下文"模型快速接续。失败（无 key/网络/超时）返回 null。
 */
async function aiSummarizeTurns(turnsText) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey || !turnsText) return null;
  const model = process.env.DEEPSEEK_HANDOFF_MODEL || 'deepseek-chat';
  const sys = [
    '你是班级管家 AI「灵枢」的上下文交接助手。用户在与她的微信会话之间切换运行模式，',
    '新模式的会话是全新的、看不到旧上下文。请把下面这段最近对话压缩成一段简洁中文交接摘要（200-400 字），供新模式下的她快速接续。',
    '要求：',
    '- 用第三人称（"她/用户"）叙事，不出现"我"；',
    '- 覆盖：正在聊的话题、她的情绪/状态、你答应过但还没做完的事、任何需要记住的关键信息（人名/日期/数字/文件）；',
    '- 只提炼事实，不评价、不编造；没有实质内容的纯寒暄可略过；',
    '- 输出为一段话，不要分点、不要引号包裹。',
  ].join('');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 700,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: turnsText },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    const content = json?.choices?.[0]?.message?.content;
    if (!content) return null;
    const clean = String(content).replace(/\s+/g, ' ').trim().slice(0, 600);
    return clean || null;
  } catch {
    return null;
  }
}

/**
 * 一步交接：源模式 → 「【切换前…对话摘要（新增）】…」。
 * 只总结上次成功交接以来的新增轮次（游标去重）；成功才推进游标。
 * 无新增/无记忆/API 失败返回空串（调用方静默跳过）。
 */
async function handoffText(engineMember, fromMode) {
  const { text: payloadText, total } = computeHandoffPayload(engineMember, fromMode, HANDOFF_CAP);
  if (!payloadText) return '';
  const summary = await aiSummarizeTurns(payloadText);
  if (!summary) return '';   // 失败不推进游标 → 下次切换重试同一段
  const cursors = _readCursors();
  cursors[`${engineMember}|${fromMode}`] = { seen: total, at: Date.now() };
  _writeCursors(cursors);
  const label = fromMode === 'overdrive' ? '超限模式' : '普通模式';
  return `【切换前${label}对话摘要】（这是自上次从${label}离开以来新增的对话要点，旧内容你此前已收到过；自然接续即可，不必复述）\n${summary}`;
}

module.exports = {
  HANDOFF_CAP,
  memoryFileFor,
  readRecentTurns,
  aiSummarizeTurns,
  handoffText,
  computeHandoffPayload,
};
