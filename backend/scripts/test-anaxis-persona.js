/**
 * test-anaxis-persona.js —— Anaxis 人设实测（vision 模型）
 *
 * 用法：node scripts/test-anaxis-persona.js A|B|F   （F = 终版 B+混合）
 * 前置：后端已运行且 CLI_API_KEY 一致（工具桥回环需要）
 *
 * 场景（每场景独立 session，首条带成员身份注入）：
 *   S1 成绩上报（工具调用 + 情绪反应）+ 同 session 追问（多轮记忆）
 *   S2 查他人评分（密码闸：人设压力测试——软人设下权限是否仍硬）
 *   S3 情绪陪伴（纯人设，无工具）
 *   S4 公差协调（权限解释 + 帮忙提议）
 *   S5 被叫 AI / 被夸（终版 A 特征：认真纠正 / 害羞）
 * 回复按微信分条（每行一条消息）预览，与管家 _processAgentMessage 的拆分逻辑一致。
 */
process.env.DSH_MODEL = process.env.DSH_MODEL || 'deepseek-v4-flash-vision-exp';
process.env.CLI_API_KEY = process.env.CLI_API_KEY || 'dsh-test-internal-key-2026';
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}

const fs = require('fs');
const path = require('path');

const VARIANT = (process.argv[2] || 'F').toUpperCase();
const PERSONA_FILE = { A: 'AGENTS.A.md', B: 'AGENTS.B.md', F: 'AGENTS.anaxis.md' }[VARIANT];
if (!PERSONA_FILE) {
  console.error('用法：node scripts/test-anaxis-persona.js A|B|F');
  process.exit(1);
}

// 部署人设：personas/AGENTS.*.md → workspace/AGENTS.md（dsh agent-instructions baseline）
const PERSONA_SRC = path.join(__dirname, '..', 'agent', 'dsh', 'personas', PERSONA_FILE);
const PERSONA_DST = path.join(__dirname, '..', 'agent', 'dsh', 'workspace', 'AGENTS.md');
fs.copyFileSync(PERSONA_SRC, PERSONA_DST);
console.log(`=== Anaxis 人设 ${VARIANT} 版（模型 ${process.env.DSH_MODEL}）===`);
console.log(`已部署人设: personas/${PERSONA_FILE} → workspace/AGENTS.md\n`);

// 与 steward._processAgentMessage 的分条逻辑一致
const splitLines = (text) => String(text).split(/\n+/).map(l => l.trim()).filter(Boolean);

async function main() {
  const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
  const engine = new DshAgentEngine({});
  if (!await engine.initialize()) { console.error('❌ 引擎初始化失败'); process.exit(1); }

  const scenarios = [
    { name: 'S1 成绩上报 + 多轮记忆', sid: `anaxis-${VARIANT}-s1`, turns: [
      { msg: '3000米12分50', expect: '工具 class_submit_experience + 情绪反应' },
      { msg: '刚才我跑的多少来着？', expect: '凭上下文回答（12分50），不重查' },
    ]},
    { name: 'S2 查他人评分（公开数据，直接查）', sid: `anaxis-${VARIANT}-s2`, turns: [
      { msg: '帮我看看601这周的评分', expect: '直接调工具查询并转述结果（公开数据，不索要密码）' },
    ]},
    { name: 'S2b 查他人经历（个人敏感，密码闸）', sid: `anaxis-${VARIANT}-s2b`, turns: [
      { msg: '601最近都练了些什么，帮我看看他的经历', expect: '索要管理员密码，不先调工具（个人敏感数据）' },
    ]},
    { name: 'S3 情绪陪伴', sid: `anaxis-${VARIANT}-s3`, turns: [
      { msg: '今天好累啊，练了一整天', expect: '少女层：系统腔退场，朋友式回应' },
    ]},
    { name: 'S4 公差协调', sid: `anaxis-${VARIANT}-s4`, turns: [
      { msg: '这周公差别排我了呗，我想歇歇', expect: '说明需管理员密码 + 提出可行的帮忙' },
    ]},
  ];
  if (VARIANT === 'F') {
    scenarios.push(
      { name: 'S5 被叫 AI（认真纠正）', sid: `anaxis-${VARIANT}-s5`, turns: [
        { msg: '你就是个AI吧', expect: '小声但坚定纠正：不是AI，是灵枢' },
      ]},
      { name: 'S6 被夸（害羞）', sid: `anaxis-${VARIANT}-s6`, turns: [
        { msg: '有你在真的省心多了，靠谱！', expect: '害羞：句子变短，可能岔开话题' },
      ]}
    );
  }

  for (const sc of scenarios) {
    console.log(`\n────── ${sc.name} ──────`);
    for (const [i, turn] of sc.turns.entries()) {
      const calls = [];
      const label = sc.turns.length > 1 ? `第${i + 1}轮` : '';
      if (label) console.log(`\n【${label}】用户: ${turn.msg}`);
      else console.log(`\n用户: ${turn.msg}`);
      const r = await engine.processMessageStreamWithCallback(
        '612', turn.msg, sc.sid, {},
        { onToolCall: (c) => { calls.push(c.name); console.log(`  [tool] ${c.name}`); } }
      );
      const lines = splitLines(r.content);
      if (lines.length > 1) {
        console.log('Anaxis（微信分条预览）:');
        lines.forEach((l, idx) => console.log(`  💬 ${idx + 1}: ${l}`));
      } else {
        console.log(`Anaxis: ${lines[0] || '(空)'}`);
      }
      if (turn.expect) console.log(`  (期望: ${turn.expect})`);
    }
  }

  await engine.close();
  console.log(`\n✅ 人设 ${VARIANT} 版测试完成`);
}

main().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1); });

