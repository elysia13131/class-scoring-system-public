/**
 * test-dsh-interleave.js —— dsh harness 原生 agent loop 交错能力验证
 *
 * 验证「和我一样的行为」在一次 session.run 内闭环：
 *   文本流（先发消息）→ tool/call（调用工具）→ 工具执行 → tool/result
 *   （结果回填模型）→ 模型继续输出 → turn/end
 *
 * 判定：
 *   1. 事件序列完整：preTool 文本 → toolCall → toolResult → postTool 文本
 *   2. 工具调用前的文本非空（模型先说话再动手）
 *   3. 工具结果后的文本非空（拿到结果继续回复，不是哑巴执行）
 *
 * 运行：node scripts/test-dsh-interleave.js
 */
const path = require('path');
const fs = require('fs');
const DshAgentEngine = require('../agent/dsh/DshAgentEngine');

const MEMBER_ID = process.env.INTERLEAVE_TEST_MEMBER || '611';

// dsh 子进程 LLM 鉴权（index.js 里由 key 池兜底；独立脚本需自行设置）
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}
// 桥接鉴权：插件工具回调 X-Internal-Auth 走本进程 CLI_API_KEY
// （生产中引擎与后端同进程共享；独立脚本需与目标后端一致，否则 401 未授权）
if (!process.env.CLI_API_KEY) {
  process.env.CLI_API_KEY = 'test-cli-key-2609';
}

// 清理本测试的 dsh session 磁盘日志（幂等）
function cleanSessionLogs() {
  try {
    const sessionsRoot = path.join(__dirname, '..', 'agent', 'dsh', 'home', 'sessions');
    for (const proj of fs.readdirSync(sessionsRoot)) {
      fs.rmSync(path.join(sessionsRoot, proj, `member-${MEMBER_ID}`), { recursive: true, force: true });
    }
  } catch { /* sessions 目录不存在 → 忽略 */ }
}
cleanSessionLogs();

async function main() {
  const engine = new DshAgentEngine({});
  const ok = await engine.initialize();
  if (!ok) { console.error('❌ dsh 引擎不可用'); process.exit(1); }

  // 事件流水（按到达顺序记录，还原 harness 循环轨迹）
  const events = [];
  const callbacks = {
    onToken: (t) => {
      const last = events[events.length - 1];
      if (last && last.type === 'text') last.text += t;
      else events.push({ type: 'text', text: String(t) });
    },
    onToolCall: (c) => events.push({ type: 'toolCall', name: c.name }),
    onToolResult: (r) => events.push({ type: 'toolResult', callId: r.callId, isError: r.isError }),
  };

  const result = await engine.processMessageStreamWithCallback(
    MEMBER_ID,
    '帮我查一下 612 这周的六维评分，查到之后用你自己的话跟我讲讲。',
    null, { isAdmin: true }, callbacks);

  console.log('\n===== 事件流水（harness 循环轨迹） =====');
  for (const e of events) {
    if (e.type === 'text') console.log(`[文本 ${String(e.text).trim().length} 字] ${String(e.text).trim().replace(/\n/g, '⏎').substring(0, 80)}`);
    else if (e.type === 'toolCall') console.log(`[调用工具] ${e.name}`);
    else console.log(`[工具结果] callId=${String(e.callId).substring(0, 18)} error=${e.isError}`);
  }

  // 判定：文本 → 工具 → 文本 的完整交错
  const firstToolIdx = events.findIndex(e => e.type === 'toolCall');
  const firstTextIdx = events.findIndex(e => e.type === 'text');
  const postToolText = events.slice(firstToolIdx + 1).find(e => e.type === 'text');
  const toolCount = events.filter(e => e.type === 'toolCall').length;

  const checks = [
    ['发生了工具调用', firstToolIdx !== -1],
    ['工具调用前有文本（先发消息）', firstTextIdx !== -1 && firstTextIdx < firstToolIdx],
    ['工具结果后有续写（继续循环输出）', !!postToolText && String(postToolText.text).trim().length > 0],
    ['最终回复非空', String(result?.content || '').trim().length > 0],
  ];
  let pass = 0;
  console.log('\n===== 判定 =====');
  for (const [name, p] of checks) { console.log(`${p ? '✓' : '❌'} ${name}`); if (p) pass++; }
  console.log(`\n结果: ${pass}/${checks.length} 通过（工具调用 ${toolCount} 次）`);
  cleanSessionLogs();
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch(e => { console.error('测试异常:', e.message); cleanSessionLogs(); process.exit(1); });
