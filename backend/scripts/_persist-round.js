/**
 * _persist-round.js —— 跨进程恢复测试的单轮子进程脚本
 *
 * 环境变量 PERSIST_PAYLOAD：{ memberId, message }
 * stdout 输出最终回复文本（供父进程断言）。
 * 每次运行 = 全新 Node 进程 + 全新 dsh runtime 子进程（harness 生命周期随本进程）。
 */
// key 池第一个（与 test-dsh-live.js 一致）
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}
const DshAgentEngine = require('../agent/dsh/DshAgentEngine');

async function main() {
  const { memberId, message } = JSON.parse(process.env.PERSIST_PAYLOAD || '{}');
  const outFile = process.env.PERSIST_OUT_FILE;   // 最终回复写入约定文件（stdout 会被引擎日志污染）
  const engine = new DshAgentEngine({});
  const ok = await engine.initialize();
  if (!ok) { console.error('engine unavailable'); process.exit(1); }
  try {
    const result = await engine.processMessage(memberId, message, null, {});
    if (outFile) require('fs').writeFileSync(outFile, String(result?.content || ''));
    else process.stdout.write(String(result?.content || ''));
  } finally {
    await engine.close().catch(() => {});
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
