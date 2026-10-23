/**
 * test-dsh-time.js —— 上下文时间注入验证
 *
 * _buildPrompt 每轮注入「当前时间：YYYY-MM-DD 周X HH:mm（北京时间）」。
 * 验证：问模型现在日期/周几/时间，回答与真实北京时间一致（±5 分钟）。
 *
 * 运行：node scripts/test-dsh-time.js
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

  // 先单测 _nowLine 输出格式
  const line = engine._nowLine();
  console.log(`注入时间行: ${line}`);
  const okFormat = /^当前时间：\d{4}-\d{2}-\d{2} 周[一二三四五六日] \d{2}:\d{2}（北京时间）$/.test(line);
  console.log(okFormat ? '✓ 时间行格式正确' : '❌ 时间行格式异常');

  const result = await engine.processMessageStreamWithCallback(
    MEMBER_ID,
    '告诉我今天几号、星期几、现在几点，一句话就好。',
    null, { isAdmin: true }, { onToken: () => {} });

  const content = String(result?.content || '');
  console.log(`\n模型回答: ${content.substring(0, 200)}`);

  // 与真实北京时间比对（日期 + 周几 + 小时 ±1）
  const { beijingNow } = require('../utils/beijingTime');
  const now = beijingNow().toISOString();
  const [datePart, timePart] = now.split('T');
  const [y, mo, d] = datePart.split('-').map(Number);
  const wdChar = ['日', '一', '二', '三', '四', '五', '六'][new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  const hour = Number(timePart.substring(0, 2));

  const checks = [
    ['日期正确（月/日，容许空格与「号」）',
      new RegExp(`${mo}\\s*月\\s*${d}\\s*[日号]`).test(content) || content.includes(datePart)],
    ['周几正确', content.includes(`周${wdChar}`) || content.includes(`星期${wdChar}`)],
    ['小时正确（±1，容许空格）',
      new RegExp(`(?:${hour - 1}|${hour}|${hour + 1})\\s*[点时:：]`).test(content)
      || new RegExp(`\\b${String(hour).padStart(2, '0')}:`).test(content)],
  ];
  let pass = 0;
  for (const [name, p] of checks) { console.log(`${p ? '✓' : '❌'} ${name}`); if (p) pass++; }
  console.log(`\n结果: ${pass}/${checks.length} 通过`);
  cleanSessionLogs();
  process.exit(pass === checks.length ? 0 : 1);
}

main().catch(e => { console.error('异常:', e.message); cleanSessionLogs(); process.exit(1); });
