/**
 * test-dsh-interrupt.js —— 中断式插队验证
 *
 * 场景：AI 正在一次性长输出（最终回复流）时用户来新消息。
 * 预期（新模式）：injectUserMessage → wire interrupt（agent.cancel 取消在产
 * 生成）→ 本轮收尾 → _drainPendingInjections 用新消息立即重跑下一轮。
 * 验证点：
 *   1. AI 长输出被中断（不会把 500 字全写完）
 *   2. 注入的新话题在 drain 轮立刻得到回答（输出包含「星期」）
 *   3. 处理状态最终收敛、队列清空
 *
 * 运行：node scripts/test-dsh-interrupt.js
 * （直连真实 dsh 子进程 + DeepSeek API；需 home 里存在 dsh runtime）
 */
const DshAgentEngine = require('../agent/dsh/DshAgentEngine');

const MEMBER_ID = process.env.INTERRUPT_TEST_MEMBER || '612';

if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}

function cleanSessionLogs() {
  try {
    const path = require('path');
    const fs = require('fs');
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

  let tokens = '';
  let injected = false;
  const callbacks = {
    onToken: (t) => {
      tokens += t;
      // 见到第一个 token（AI 已开口、正在流式长输出）就注入新消息
      if (!injected && tokens.length > 20) {
        injected = true;
        console.log('\n--- 检测到 AI 开始输出，注入新消息（要求打断换话题）---\n');
        engine.injectUserMessage(MEMBER_ID, '停！别继续刚才的话题了，改成回答：今天是星期几？');
      }
    },
  };

  const t0 = Date.now();
  const longPrompt = '用长篇幅介绍一下班级的评分规则和日常量化管理，多写细节，一口气写满 500 字以上，不要中途停。';
  const mainTurn = engine.processMessageStreamWithCallback(
    MEMBER_ID, longPrompt, null, { isAdmin: true }, callbacks);

  const result = await mainTurn;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const full = String(result?.content || '');
  console.log(`\n总耗时 ${elapsed}s，总输出 ${full.length} 字（token 流 ${tokens.length} 字）`);
  console.log('--- 完整输出 ---');
  console.log(full);
  console.log('--- 输出结束 ---');

  // 等待处理状态收敛 + 队列清空
  if (engine.isProcessing(MEMBER_ID)) {
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (!engine.isProcessing(MEMBER_ID)) { clearInterval(timer); resolve(); }
      }, 500);
      setTimeout(() => { clearInterval(timer); resolve(); }, 60000);
    });
  }
  const residual = engine._pendingInjections.get(MEMBER_ID);

  const checks = [
    ['输出明显被截断（<350 字，说明长输出被中断）', full.length < 350],
    ['drain 轮回答了新话题（含「周X/星期」）', /星期|周[一二三四五六日]/.test(full)],
    ['处理状态收敛、队列清空', !residual || residual.length === 0],
  ];
  let pass = 0;
  for (const [name, p] of checks) { console.log(`${p ? '✓' : '❌'} ${name}`); if (p) pass++; }
  console.log(`\n结果: ${pass}/${checks.length} 通过`);
  cleanSessionLogs();
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
