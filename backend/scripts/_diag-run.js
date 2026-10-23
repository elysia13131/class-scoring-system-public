/**
 * _diag-run.js —— 诊断：打印 run 期间全部 session 事件与错误
 */
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}
const DshAgentEngine = require('../agent/dsh/DshAgentEngine');

async function main() {
  const engine = new DshAgentEngine({});
  const ok = await engine.initialize();
  if (!ok) { console.error('engine unavailable'); process.exit(1); }
  const events = [];
  try {
    const result = await engine.processMessageStreamWithCallback(
      '999', '用一句话回答：1+1等于几？不要调用任何工具。', 'diag-session-1', {},
      {
        onToken: (t) => events.push(['token', t]),
        onToolCall: (c) => events.push(['tool', c.name]),
        onError: (e) => events.push(['error', JSON.stringify(e)]),
      });
    console.log('result.content =', JSON.stringify(result.content));
    console.log('events count =', events.length);
    console.log('first 10 events:', JSON.stringify(events.slice(0, 10)).substring(0, 500));
    // 底层直查：harness.run 的 RunResult 原始字段
    const r2 = await engine.harness.run('再回答一次：2+2等于几', { sessionId: 'diag-session-2' });
    console.log('harness.run keys:', Object.keys(r2));
    console.log('harness.run finalResponse:', JSON.stringify(r2.finalResponse));
    console.log('harness.run events:', (r2.events || []).length);
    const types = (r2.events || []).map(e => e.type);
    console.log('event types:', JSON.stringify([...new Set(types)]));
  } finally {
    await engine.close().catch(() => {});
  }
}
main().catch(e => { console.error('DIAG FAIL:', e); process.exit(1); });
