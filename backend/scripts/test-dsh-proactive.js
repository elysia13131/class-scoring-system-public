/**
 * test-dsh-proactive.js —— AI 主动消息 + 每日一问/日程通知迁移 + 绑定认证测试
 *
 * 前置：后端已运行且 CLI_API_KEY 一致（如 CLI_API_KEY=dsh-test-internal-key-2026 node index.js）
 * 验证：
 *  A. submit_checkin action：身份校验 / 仅本人 / 落库格式（source=wechat_agent）/ 异常信号
 *  B. DshAgentEngine：_buildProactiveDirective 三类指令 / injectSystemEvent 静默前缀（一次性）/ 系统事件框架标签
 *  C. Steward：sendProactiveMessage 流式发微信（mock 引擎+通道）/ 绑定防爆破锁定 / 人设同步
 */
const fs = require('fs');
const path = require('path');

const KEY = process.env.CLI_API_KEY || 'dsh-test-internal-key-2026';
process.env.CLI_API_KEY = KEY;
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`;

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? '✓' : '❌'} ${name}${detail !== undefined ? ' → ' + detail : ''}`);
}

async function call(action, params) {
  const res = await fetch(`${BACKEND}/api/internal/agent-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': KEY },
    body: JSON.stringify({ action, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------- A. submit_checkin（需后端运行） ----------
async function testSubmitCheckin() {
  console.log('\n=== A. submit_checkin（每日一问回答落库） ===');
  let r = await call('submit_checkin', { memberId: '612', text: '测试回答' });
  check('无 callerId → 403', r.status === 403, r.json.error);
  r = await call('submit_checkin', { callerId: '612', memberId: '601', text: '测试' });
  check('记录他人回答 → 403', r.status === 403, r.json.error);
  r = await call('submit_checkin', { callerId: '612', text: '' });
  check('空 text → 400', r.status === 400, r.json.error);

  // 正常提交（自己的，含伤病词 → anomalySignals）
  r = await call('submit_checkin', { callerId: '612', text: '今天膝盖有点疼，训练不太顺利', mood: '😞' });
  check('本人提交 → 200', r.status === 200 && r.json.recorded, JSON.stringify(r.json).substring(0, 80));
  check('伤病词 → injury 信号', (r.json.anomalySignals || []).includes('injury'), JSON.stringify(r.json.anomalySignals));

  // 落库验证（source=wechat_agent，type=question）
  const recFile = path.join(__dirname, '..', 'data', 'checkin_records', '612.json');
  let recOk = false, rec = null;
  try {
    const arr = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    rec = [...arr].reverse().find(x => x.source === 'wechat_agent' && x.type === 'question');
    recOk = !!rec;
  } catch (e) {}
  check('记录已落库（source=wechat_agent）', recOk, rec ? rec.text.substring(0, 30) : '未找到');
  check('mood 已记录', recOk && rec.mood === '😞', rec ? rec.mood : '');

  // 清理测试记录
  try {
    const arr = JSON.parse(fs.readFileSync(recFile, 'utf8'));
    const kept = arr.filter(x => !(x.source === 'wechat_agent' && (x.text || '').includes('测试') || (x.text || '').includes('膝盖有点疼，训练不太顺利')));
    fs.writeFileSync(recFile, JSON.stringify(kept, null, 2));
  } catch (e) {}
}

// ---------- B. DshAgentEngine（无需 harness） ----------
async function testEngine() {
  console.log('\n=== B. DshAgentEngine（主动消息指令 / 静默事件注入） ===');
  const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
  const engine = new DshAgentEngine({});

  // 1. 三类主动消息指令
  const dq = engine._buildProactiveDirective('daily_question', { question: '今天训练状态怎么样？' });
  check('daily_question 指令含问题原文', dq.includes('今天训练状态怎么样？'), dq.substring(0, 40));
  const sn = engine._buildProactiveDirective('schedule_notify', { title: '打扫器材室', description: '周五前完成', dueAt: '2026-09-04 10:00' });
  check('schedule_notify 指令含标题/说明/时间', sn.includes('打扫器材室') && sn.includes('周五前完成') && sn.includes('2026-09-04 10:00'));
  const bw = engine._buildProactiveDirective('bind_welcome', {});
  check('bind_welcome 指令存在', bw.includes('绑定'));
  check('未知类型 → null', engine._buildProactiveDirective('bogus', {}) === null);

  // 2. injectSystemEvent：随下一条消息前缀送入（一次性消费）
  engine.injectSystemEvent('612', '成员刚在 App 完成了每日一问回答（已存档）。今天不需要再发每日一问。');
  check('injectSystemEvent 返回 true', engine.injectSystemEvent('612', '第二条事件') === true);
  let prompt = await engine._buildPrompt('612', {}, '今天怎么样', false);
  check('事件拼入下一条 prompt', prompt.includes('【系统事件】成员刚在 App 完成了每日一问回答') && prompt.includes('【系统事件】第二条事件'));
  check('用户消息框架保留', prompt.includes('用户消息：今天怎么样'));
  check('事件一次性消费', !engine._pendingEvents.has('612') || engine._pendingEvents.get('612').length === 0);
  const prompt2 = await engine._buildPrompt('612', {}, '再聊聊', false);
  check('第二条 prompt 不再含旧事件', !prompt2.includes('刚在 App 完成了每日一问回答'));

  // 3. 主动消息框架：系统事件标签（非用户消息）
  const prompt3 = await engine._buildPrompt('612', { proactive: 'daily_question' }, dq, false);
  check('主动消息用系统事件框架', prompt3.includes('系统事件（非成员发言，按其中指令行动）') && !prompt3.includes('用户消息'));

  // 4. processProactiveMessage 未知类型报错
  let threw = false;
  try { await engine.processProactiveMessage('612', 'bogus', {}); } catch (e) { threw = true; }
  check('processProactiveMessage 未知类型 → throw', threw);

  // 5. 人设同步（personas → workspace）
  engine._syncPersona();
  const srcP = fs.readFileSync(path.join(__dirname, '..', 'agent', 'dsh', 'personas', 'AGENTS.anaxis.md'), 'utf8');
  const dstP = fs.readFileSync(path.join(__dirname, '..', 'agent', 'dsh', 'workspace', 'AGENTS.md'), 'utf8');
  check('workspace/AGENTS.md = personas/anaxis（含每日一问规则+管理员规则）',
    srcP === dstP && dstP.includes('class_submit_checkin') && dstP.includes('周祎宸'),
    dstP.includes('class_submit_checkin') ? '已同步' : '内容不符');
}

// ---------- C. Steward（mock 引擎+通道） ----------
async function testSteward() {
  console.log('\n=== C. Steward（主动消息发送 / 绑定防爆破） ===');
  const StewardManager = require('../wechat/steward');

  const sentLog = [];
  const mockChannel = {
    online: true,
    onMessage() {}, onFriendship() {},
    async sendText(wxid, text) { sentLog.push({ wxid, text }); return true; },
    async sendImage() {},
    getStatus: () => ({ online: true }),
    start: async () => ({ success: true }),
    stop: async () => {},
  };
  const mockEngine = {
    isProcessing: () => false,
    // 模拟 dsh 引擎的主动消息：两行流式输出 + onDone flush 末行（与真实引擎回调契约一致）
    async processProactiveMessage(memberId, kind, payload, callbacks) {
      check('引擎收到正确 kind/payload', kind === 'daily_question' && payload.question === '今天训练状态怎么样？',
        `${kind} / ${payload.question}`);
      callbacks.onToken('今天的每日一问：\n');
      callbacks.onToken(payload.question + '\n');
      callbacks.onToken('等你回复～');
      callbacks.onDone?.({ content: 'ok' });
      return { content: 'ok' };
    },
  };

  const steward = new StewardManager({ engine: mockEngine, channel: mockChannel });
  steward.bindings = { wx_test_612: '612' };
  steward._rebuildReverse();

  // 未绑定成员
  let r = await steward.sendProactiveMessage('601', 'daily_question', { question: 'x' });
  check('未绑定成员 → success:false', r.success === false && /未绑定/.test(r.error), r.error);

  // 旧引擎（无 processProactiveMessage）
  const oldSteward = new StewardManager({ engine: { isProcessing: () => false }, channel: mockChannel });
  oldSteward.bindings = { wx_test_601: '601' };
  oldSteward._rebuildReverse();
  r = await oldSteward.sendProactiveMessage('601', 'daily_question', {});
  check('旧引擎 → 不支持主动消息', r.success === false && /不支持/.test(r.error), r.error);

  // 正常主动消息：流式分条 → 出站队列 → mock 通道（等限流节奏发完）
  const sendPromise = steward.sendProactiveMessage('612', 'daily_question', { question: '今天训练状态怎么样？' });
  const sendResult = await sendPromise;
  check('主动消息返回 success', sendResult.success === true);
  // 出站队列按 2.5s+抖动发 3 条（第 3 条无换行、onDone flush），最长 ≈ 3×(2.5+2)s
  await new Promise(resolve => setTimeout(resolve, 14000));
  check('微信收到 3 行分条消息', sentLog.filter(s => s.wxid === 'wx_test_612').length === 3,
    JSON.stringify(sentLog.map(s => s.text)));
  check('消息含问题原文', sentLog.some(s => s.text.includes('今天训练状态怎么样？')));

  // 绑定防爆破：5 次失败 → 锁定
  for (let i = 0; i < 5; i++) steward._recordBindFail('wx_evil');
  const fail = steward._bindFails.get('wx_evil');
  check('5 次失败后锁定 30 分钟', fail && fail.lockedUntil > Date.now(),
    fail ? `剩余 ${Math.ceil((fail.lockedUntil - Date.now()) / 60000)} 分钟` : '无状态');
  steward._bindFails.delete('wx_evil');

  // 清理 mock 绑定（不落盘：bindings 改动未 save，直接退出即可）
}

async function main() {
  await testEngine();
  await testSteward();
  // API 测试需后端在线；离线时跳过并提示
  try {
    const ping = await fetch(`${BACKEND}/api/internal/agent-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': KEY },
      body: JSON.stringify({ action: 'bogus_ping' }),
      signal: AbortSignal.timeout(3000),
    });
    if (ping.status === 400) await testSubmitCheckin();   // 后端在线（未知 action → 400）
    else throw new Error('offline');
  } catch (e) {
    console.log('\n（后端未运行，跳过 A 组 API 测试）');
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n========== 结果：${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('测试脚本异常:', e.message); process.exit(1); });
