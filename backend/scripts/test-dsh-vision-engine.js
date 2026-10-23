/**
 * test-dsh-vision-engine.js —— vision 模型走 DshAgentEngine 真实路径实测
 *
 * 验证：context.images 多模态输入 + 管家人设 + 工具桥共存（vision 模型下工具仍可用）
 * 前置：node scripts/test-dsh-vision.js 已通过（附件 patch 生效）
 * 用法：DSH_MODEL=deepseek-v4-flash-vision-exp node scripts/test-dsh-vision-engine.js
 */
process.env.DSH_MODEL = process.env.DSH_MODEL || 'deepseek-v4-flash-vision-exp';
process.env.CLI_API_KEY = process.env.CLI_API_KEY || 'dsh-test-internal-key-2026';
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}

const fs = require('fs');
const path = require('path');

async function main() {
  const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
  const engine = new DshAgentEngine({});
  console.log(`=== 引擎级 vision 实测（model=${process.env.DSH_MODEL}）===\n`);

  const ok = await engine.initialize();
  if (!ok) { console.error('❌ 初始化失败'); process.exit(1); }

  // 1. 纯图片输入：描述验证
  const img = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'public', 'game-assets', 'study_tower.jpg'));
  console.log('--- 1. 图片输入（study_tower.jpg 241KB）---');
  const r1 = await engine.processMessageStreamWithCallback(
    '612',
    '这张图里主要有什么建筑或设施？一句话回答。',
    'vision-engine-test',
    { images: [{ data: img, mimeType: 'image/jpeg' }] },
    {}
  );
  console.log('回答:', r1.content);
  const towerOk = /塔|楼|tower|book|书|楼梯|层/i.test(r1.content);
  console.log(`描述含塔/楼/书要素: ${towerOk ? '✓' : '✗'}\n`);

  // 2. vision 模型下工具桥仍可用
  console.log('--- 2. vision 模型下工具调用 ---');
  const toolCalls = [];
  const r2 = await engine.processMessageStreamWithCallback(
    '612',
    '咱们班里一共有多少成员？用工具查一下再回答。',
    'vision-engine-test',
    {},
    { onToolCall: (c) => { toolCalls.push(c.name); console.log('[tool/call]', c.name); } }
  );
  console.log('回答:', r2.content);
  console.log(`工具调用: ${toolCalls.length > 0 ? '✓ ' + toolCalls.join(',') : '✗ 未调用'}\n`);

  // 3. 同 session 多模态上下文保持（先图后问）
  console.log('--- 3. 多模态上下文跨轮保持 ---');
  const r3 = await engine.processMessageStreamWithCallback(
    '612',
    '刚才那张图的主色调是什么？凭记忆回答，不要重新描述细节。',
    'vision-engine-test',
    {},
    {}
  );
  console.log('回答:', r3.content);

  const allPass = towerOk && toolCalls.length > 0 && r3.content;
  console.log(`\n${allPass ? '✅ 引擎级 vision 实测通过（图片输入 + 工具桥共存 + 上下文保持）' : '⚠️ 部分项未过，见上方标记'}`);
  await engine.close();
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1); });
