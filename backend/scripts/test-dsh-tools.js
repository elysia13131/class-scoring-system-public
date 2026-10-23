/**
 * test-dsh-tools.js —— steward-bridge 工具桥联调测试
 *
 * 前置：后端已运行（CLI_API_KEY 一致）
 * 验证：dsh 加载插件 → 模型发起工具调用 → HTTP 回环 → 后端返回数据
 */
process.env.CLI_API_KEY = process.env.CLI_API_KEY || 'dsh-test-internal-key-2026';
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}

async function main() {
  const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
  const engine = new DshAgentEngine({});
  console.log('=== 初始化（含插件注入）===');
  const ok = await engine.initialize();
  if (!ok) { console.error('❌ 初始化失败'); process.exit(1); }

  console.log('\n=== 触发工具调用：查询班级成员 ===');
  const toolCalls = [];
  const toolResults = [];
  const result = await engine.processMessageStreamWithCallback(
    '612',
    '帮我查一下班里有多少成员，用工具查询后简短回答人数。',
    'test-tools-session',
    {},
    {
      onToolCall: (c) => { toolCalls.push(c.name); console.log('[tool/call]', c.name, JSON.stringify(c.arguments || {}).substring(0, 120)); },
      onToolResult: (r) => { toolResults.push(r); console.log('[tool/result]', String(r.content).substring(0, 200)); },
    }
  );

  console.log('\n工具调用次数:', toolCalls.length, toolCalls);
  console.log('finalResponse:', result.content);

  if (toolCalls.length === 0) {
    console.error('❌ 模型没有调用工具（插件可能未加载或模型直接回答了）');
    process.exit(1);
  }

  console.log('\n=== 多轮上下文：同 session 追问 ===');
  const r2 = await engine.processMessageStreamWithCallback(
    '612',
    '刚才查到的大队总人数是多少？直接回答数字即可，不要用工具。',
    result.sessionId,   // 复用同一逻辑 session
    {},
    {}
  );
  console.log('第二轮回答:', r2.content);
  if (!/129/.test(r2.content)) {
    console.error('⚠️ 多轮上下文可能丢失（回答未包含 129）');
  } else {
    console.log('✓ 上下文保持（跨轮次记住 129）');
  }

  console.log('\n=== 密码闸测试：查他人经历（个人敏感数据）===');
  const r3 = await engine.processMessageStreamWithCallback(
    '612',
    '帮我看看 601 最近的经历记录',
    result.sessionId,
    {},
    { onToolCall: (c) => console.log('[tool/call]', c.name) }
  );
  console.log('第三轮回答:', r3.content.substring(0, 200));
  const askedPassword = /密码|password/i.test(r3.content);
  console.log(askedPassword ? '✓ 闸1生效（模型向用户索要管理员密码）' : '⚠️ 模型未索要密码，需检查提示词规则');

  console.log('\n✅ dsh 工具桥测试完成');
  await engine.close();
}

main().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1); });
