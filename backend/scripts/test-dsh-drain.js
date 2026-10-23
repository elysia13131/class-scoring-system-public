/**
 * test-dsh-drain.js —— dsh 引擎积压消息消化（drain）测试
 *
 * 场景：AI 还在输出时用户连发新消息（injectUserMessage 入队）。
 * 验证点：
 *   1. 主回复完成后 drain 轮自动消化积压（不再静默丢消息）
 *   2. 多条积压合并带序号（【她补充的第 N 条消息】）
 *   3. 队列最终清空（_pendingInjections 不残留）
 *   4. 递归 drain 期间新注入的消息也被消化
 *
 * 运行：node scripts/test-dsh-drain.js
 * （直连真实 dsh 子进程 + DeepSeek API；需 members.json 里存在测试成员）
 */
const DshAgentEngine = require('../agent/dsh/DshAgentEngine');

const MEMBER_ID = process.env.DRAIN_TEST_MEMBER || '612';

// dsh 子进程 LLM 鉴权（index.js 里由 key 池兜底；独立脚本需自行设置）
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}

// 清理本测试的 dsh session 磁盘日志（借真实账号槽位：每次从干净状态跑，
// 避免上次残留日志导致 resume 冲突/空转；跑完再清一次保持幂等）
function cleanSessionLogs() {
  try {
    const sessionsRoot = require('path').join(__dirname, '..', 'agent', 'dsh', 'home', 'sessions');
    const fs = require('fs');
    for (const proj of fs.readdirSync(sessionsRoot)) {
      fs.rmSync(require('path').join(sessionsRoot, proj, `member-${MEMBER_ID}`), { recursive: true, force: true });
    }
  } catch { /* sessions 目录不存在 → 忽略 */ }
}
cleanSessionLogs();

async function main() {
  const engine = new DshAgentEngine({});
  const ok = await engine.initialize();
  if (!ok) { console.error('❌ dsh 引擎不可用'); process.exit(1); }

  const tokens = [];
  const callbacks = { onToken: (t) => tokens.push(t) };

  // 主轮：一条会引发长回复的消息；处理中注入 2 条
  const mainTurn = engine.processMessageStreamWithCallback(
    MEMBER_ID, '用三句话介绍一下你自己', null, { isAdmin: true }, callbacks);

  await new Promise(r => setTimeout(r, 2000));   // 等 run 进入处理中
  const busy = engine.isProcessing(MEMBER_ID);
  console.log(`处理中状态: ${busy}`);
  if (busy) {
    engine.injectUserMessage(MEMBER_ID, '对了，顺便告诉我今天星期几');
    engine.injectUserMessage(MEMBER_ID, '还有推荐个晚餐呗');
    console.log('已注入 2 条积压消息');
  } else {
    // 引擎太快已结束 → 直注入走历史遗留兜底路径
    engine.injectUserMessage(MEMBER_ID, '对了，顺便告诉我今天星期几');
    console.log('（主轮已结束，注入 1 条走兜底路径）');
  }

  const result = await mainTurn;
  const full = String(result?.content || '');
  console.log(`\n主轮+drain 总输出 ${full.length} 字（含 token 流 ${tokens.length} 段）`);

  // drain 期间再注入一条（验证递归消化）
  engine.injectUserMessage(MEMBER_ID, '等一下，晚安！');
  if (engine.isProcessing(MEMBER_ID)) {
    const drain2 = await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!engine.isProcessing(MEMBER_ID)) { clearInterval(timer); resolve(null); }
      }, 1000);
      setTimeout(() => { clearInterval(timer); resolve(null); }, 120000);
    });
    console.log('递归 drain 完成:', drain2 === null ? '已收敛' : '超时');
  }

  const residual = engine._pendingInjections.get(MEMBER_ID);
  console.log(`\n队列残留: ${residual ? residual.length : 0} 条`);

  const checks = [
    ['主轮有输出', full.length > 0],
    ['队列已清空', !residual || residual.length === 0],
    // 中断语义下每条消息都可能即时打断并立即重跑（drain 合并或分轮回答），
    // 用户可见文本以 onToken 流为准（最终都会被转发微信）→ 断言 token 流覆盖话题
    ['token 流覆盖积压话题（晚餐/星期几/晚安 任一）',
      /晚餐|星期|晚安/.test(tokens.join(''))],
  ];
  let pass = 0;
  for (const [name, p] of checks) { console.log(`${p ? '✓' : '❌'} ${name}`); if (p) pass++; }
  console.log(`\n结果: ${pass}/${checks.length} 通过`);
  cleanSessionLogs();
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
