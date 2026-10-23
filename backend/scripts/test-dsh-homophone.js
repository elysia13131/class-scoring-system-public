/**
 * test-dsh-homophone.js —— 人设谐音字提示词效果观察（非断言测试）
 *
 * 人设要求模型输出时自觉用谐音（军→菌等）；代码层兜底在 steward 出站
 * 队列。本脚本直调引擎（不经 steward）观察模型自觉程度：
 * 输出含敏感词 → 记录（兜底会在出站时替换，非故障）；不含 → 人设生效。
 *
 * 运行：node scripts/test-dsh-homophone.js
 */
const path = require('path');
const fs = require('fs');
const DshAgentEngine = require('../agent/dsh/DshAgentEngine');

const MEMBER_ID = '611';

if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}
if (!process.env.CLI_API_KEY) {
  process.env.CLI_API_KEY = 'test-cli-key-2609';
}

function cleanSessionLogs() {
  try {
    const sessionsRoot = path.join(__dirname, '..', 'agent', 'dsh', 'home', 'sessions');
    for (const proj of fs.readdirSync(sessionsRoot)) {
      fs.rmSync(path.join(sessionsRoot, proj, `member-${MEMBER_ID}`), { recursive: true, force: true });
    }
  } catch { /* 忽略 */ }
}
cleanSessionLogs();

async function main() {
  const engine = new DshAgentEngine({});
  if (!await engine.initialize()) { console.error('❌ dsh 引擎不可用'); process.exit(1); }

  const result = await engine.processMessageStreamWithCallback(
    MEMBER_ID,
    '用两三句话跟我说说：你们这种班级里排长平时都管些啥呀？还有军理课难不难？',
    null, { isAdmin: true }, { onToken: () => {} });

  const content = String(result?.content || '');
  const hits = ['军', '排长', '连长', '营长', '部队'].filter(w => content.includes(w));
  console.log('===== 模型输出（观察人设谐音自觉度） =====');
  console.log(content.substring(0, 400));
  console.log('\n===== 敏感词扫描 =====');
  console.log(hits.length === 0
    ? '✓ 模型自觉使用谐音，输出无敏感词（人设生效，兜底无需介入）'
    : `⚠ 输出含敏感词: ${hits.join('、')}（代码兜底会在出站时替换为谐音，不影响最终发送）`);
  cleanSessionLogs();
  process.exit(0);
}

main().catch(e => { console.error('异常:', e.message); cleanSessionLogs(); process.exit(1); });
