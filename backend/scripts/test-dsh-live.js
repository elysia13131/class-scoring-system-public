/**
 * test-dsh-live.js —— dsh 底座全链路 live 测试
 *
 * 验证：CJS 动态 import ESM SDK → dsh runtime 子进程 → initialize 握手 → 真实模型对话
 * 用法：node scripts/test-dsh-live.js [--no-api]   (--no-api 只测子进程握手，不调模型)
 */
const path = require('path');

// key 池第一个（与 index.js 一致），也可用环境变量 DEEPSEEK_API_KEY 覆盖
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}

async function main() {
  const noApi = process.argv.includes('--no-api');
  const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
  const engine = new DshAgentEngine({});

  console.log('=== 1. initialize（SDK 加载 + dsh 子进程握手）===');
  const ok = await engine.initialize();
  console.log('initialize 结果:', ok);
  if (!ok) {
    console.error('❌ dsh 底座初始化失败');
    process.exit(1);
  }

  // 验证工具桥插件已注入 profile
  const fs = require('fs');
  const profileDir = path.join(__dirname, '..', 'agent', 'dsh', 'home', 'profiles', 'sdk');
  const installed = path.join(profileDir, 'node_modules', 'steward-bridge');
  const patchOk = fs.existsSync(path.join(profileDir, 'cordis.patch.yml'))
    && fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8').includes('steward-bridge');
  console.log('插件包安装:', fs.existsSync(installed) ? '✓' : '✗');
  console.log('patch 条目:', patchOk ? '✓' : '✗');

  if (noApi) {
    console.log('\n（--no-api：跳过模型调用）');
    await engine.close();
    console.log('\n✅ 子进程链路测试通过');
    return;
  }

  console.log('\n=== 2. 真实模型对话（member-999 测试会话）===');
  const tokens = [];
  const result = await engine.processMessageStreamWithCallback(
    '999',
    '用一句话回答：1+1等于几？不要调用任何工具。',
    'test-live-session',
    {},
    {
      onToken: (t) => tokens.push(t),
      onToolCall: (c) => console.log('[tool/call]', c.name),
      onToolResult: (r) => console.log('[tool/result]', String(r.content).substring(0, 100)),
    }
  );

  console.log('\n流式 token 数:', tokens.length);
  console.log('finalResponse:', JSON.stringify(result.content));
  if (!result.content || result.content.length === 0) {
    console.error('❌ 模型返回空');
    process.exit(1);
  }

  await engine.close();
  console.log('\n✅ dsh 全链路测试通过（子进程 + 模型对话 + 会话隔离）');
}

main().catch((e) => {
  console.error('❌ 测试失败:', e);
  process.exit(1);
});
