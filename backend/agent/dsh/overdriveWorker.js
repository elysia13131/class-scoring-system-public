/**
 * overdriveWorker —— 超限会话专用 dsh 引擎子进程入口（Phase2）
 *
 * 由 overdriveManager 以子进程方式拉起；进程启动前 Manager 注入
 * DSH_ENGINE_WORKSPACE / DSH_ENGINE_HOME_DIR（超限专属工作区与 home），
 * 使本进程的 dsh runtime 拥有独立工作区/会话/浏览器，与主引擎互不共享。
 *
 * 通信：stdin/stdout 各一行一个 JSON（NDJSON）。帧带 op 请求 id：
 *   req  { id, op:'ping' }                          → { id, kind:'ack', ok:true }
 *   req  { id, op:'process', payload }               → 零或多条流式帧 + 终结帧：
 *        { id, kind:'text', text }        （模型输出，逐行转发，可立即发微信）
 *        { id, kind:'done', ok:true, content }
 *        { id, kind:'error', ok:false, error }
 *   req  { id, op:'inject', payload:{type,member,text} }  → { id, kind:'ack', ok:true }
 *        type='user'（模型忙时的新消息注入 → 引擎 drain 消化）
 *        type='event'（静默系统事件，随下一条 prompt 前缀消费）
 *   req  { id, op:'shutdown' }                       → { id, kind:'ack', ok:true } 后退出
 *
 * 图片透传：payload.images[{ data: base64, mimeType }]（NDJSON 单帧可承载；
 * 大图由 Manager 侧裁剪/跳过）。群消息附带 recent/recentFiles（与主引擎同构）。
 */

const readline = require('readline');

if (!process.env.DSH_ENGINE_WORKSPACE || !process.env.DSH_ENGINE_HOME_DIR) {
  console.error('[OverdriveWorker] 缺少 DSH_ENGINE_WORKSPACE/DSH_ENGINE_HOME_DIR，拒绝启动');
  process.exit(1);
}

let engine = null;
let engineStarting = null;

function sendFrame(frame) {
  process.stdout.write(JSON.stringify(frame) + '\n');
}

async function ensureEngine() {
  if (engine) return engine;
  if (!engineStarting) {
    engineStarting = (async () => {
      const DshAgentEngine = require('./DshAgentEngine');
      const inst = new DshAgentEngine({});
      const ok = await inst.initialize();
      if (!ok) throw new Error(`超限引擎初始化失败（home=${process.env.DSH_ENGINE_HOME_DIR}）`);
      engine = inst;
      return inst;
    })().catch((e) => { engineStarting = null; throw e; });
  }
  return engineStarting;
}

/**
 * 以流式回调跑引擎一轮，把模型输出按行转发为 {kind:'text'} 帧，结束时发 done/error。
 * @returns {Promise<void>}（帧已发出；本函数不写终结帧以外的任何返回）
 */
async function streamEngineTurn(id, run) {
  let buf = '';
  const flush = () => {
    const t = buf.trim();
    buf = '';
    if (t) sendFrame({ id, kind: 'text', text: t });
  };
  const callbacks = {
    onToken: (token) => {
      buf += String(token || '');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) sendFrame({ id, kind: 'text', text: line });
      }
    },
    onToolCall: () => flush(),       // 工具调用前先把手头的半句说完（她不用干等）
    onToolResult: () => {},
    onError: () => flush(),
    onDone: () => flush(),
  };
  // 心跳：长工具调用期间没有 token 输出，靠它让 Manager 的「静默看门狗」知道我们还活着
  const beatTimer = setInterval(() => {
    try { sendFrame({ id, kind: 'beat' }); } catch { /* 忽略 */ }
  }, 30000);
  if (beatTimer.unref) beatTimer.unref();
  try {
    const result = await run(callbacks);
    flush();
    sendFrame({ id, kind: 'done', ok: true, content: String((result && result.content) || '') });
  } finally {
    clearInterval(beatTimer);
  }
}

async function runProcess(id, payload) {
  const eng = await ensureEngine();
  const pending = Array.isArray(payload.pending) ? payload.pending : [];
  const { kind } = payload;

  if (kind === 'group') {
    const { sessionId, senderLabel, senderMemberId, text, recent, images, recentFiles, options } = payload;
    const memberKey = String(sessionId || `group-${senderMemberId}`);
    for (const ev of pending) eng.injectSystemEvent(memberKey, ev);
    const imgs = Array.isArray(images) ? images
      .filter(i => i && i.data)
      .map(i => ({ data: Buffer.from(String(i.data), 'base64'), mimeType: i.mimeType || 'image/jpeg' })) : [];
    await streamEngineTurn(id, (callbacks) => eng.processGroupMessage(
      memberKey, senderLabel, String(senderMemberId), text, callbacks,
      Array.isArray(recent) ? recent : [], imgs,
      Array.isArray(recentFiles) ? recentFiles : [],
      options || {}));
    return;
  }

  if (kind === 'proactive') {
    // 超限中的主动消息（每日一问/日程提醒/定时任务/绑定欢迎…）：
    // 事件指令进超限会话上下文，AI 输出行级转发；回复由 Manager 侧发微信。
    const { memberId, proactiveKind, proactivePayload } = payload;
    // 兜底：payload 缺 memberId 时用 Manager 注入的会话归属（防 member-undefined）
    const memberKey = String(memberId ?? process.env.DSH_OVERDRIVE_SCOPE_KEY ?? '');
    for (const ev of pending) eng.injectSystemEvent(memberKey, ev);
    await streamEngineTurn(id, (callbacks) =>
      eng.processProactiveMessage(memberKey, proactiveKind, proactivePayload || {}, callbacks));
    return;
  }

  // kind === 'dm'（默认）
  const { memberId, text, sessionId, options } = payload;
  // 兜底：payload 缺 memberId 时用 Manager 注入的会话归属（防 member-undefined）
  const memberKey = String(memberId ?? process.env.DSH_OVERDRIVE_SCOPE_KEY ?? '');
  for (const ev of pending) eng.injectSystemEvent(memberKey, ev);
  const imgs = Array.isArray(payload.images) ? payload.images
    .filter(i => i && i.data)
    .map(i => ({ data: Buffer.from(String(i.data), 'base64'), mimeType: i.mimeType || 'image/jpeg' })) : [];
  await streamEngineTurn(id, (callbacks) => eng.processMessageStreamWithCallback(
    memberKey, text, sessionId || null,
    { isAdmin: !!(options && options.isAdmin), images: imgs }, callbacks));
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', async (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // 非法帧忽略
  }
  try {
    if (req.op === 'ping') return sendFrame({ id: req.id, kind: 'ack', ok: true });
    if (req.op === 'process') return await runProcess(req.id, req.payload || {});
    if (req.op === 'inject') {
      const eng = await ensureEngine();
      const { type, member, text: evText } = (req.payload || {});
      if (!member || !evText) return sendFrame({ id: req.id, kind: 'ack', ok: false, error: 'inject 缺 member/text' });
      if (type === 'event') {
        sendFrame({ id: req.id, kind: 'ack', ok: true, accepted: eng.injectSystemEvent(String(member), String(evText)) });
      } else {
        sendFrame({ id: req.id, kind: 'ack', ok: true, accepted: eng.injectUserMessage(String(member), String(evText)) });
      }
      return;
    }
    if (req.op === 'shutdown') {
      if (engine && typeof engine.close === 'function') await engine.close();
      sendFrame({ id: req.id, kind: 'ack', ok: true });
      return process.exit(0);
    }
    sendFrame({ id: req.id, kind: 'error', ok: false, error: `未知 op: ${req.op}` });
  } catch (e) {
    sendFrame({ id: req.id, kind: 'error', ok: false, error: (e && e.message) || String(e) });
  }
});
process.on('SIGTERM', () => process.exit(0));
console.error('[OverdriveWorker] ready');
