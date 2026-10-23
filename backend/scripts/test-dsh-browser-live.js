/**
 * test-dsh-browser-live.js —— 浏览器自动化 live 测试（DSH_BROWSER=1）
 *
 * 验证：dsh-plugin-playwright 注入嵌入式 sdk profile 后，模型能真实驱动
 * headless 浏览器（导航/读状态/截屏），并确认截图落盘路径。
 * 用法：node scripts/test-dsh-browser-live.js
 * 前置：本机有 chromium 系浏览器（默认用 Edge），或 DSH_BROWSER_EXECUTABLE 指定。
 */
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}
// 浏览器自动化开关 + 本机 Edge 当 chromium 引擎（无 Edge 环境可改 DSH_BROWSER_EXECUTABLE）
process.env.DSH_BROWSER = '1';
if (!process.env.DSH_BROWSER_EXECUTABLE && require('fs').existsSync('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')) {
  process.env.DSH_BROWSER_EXECUTABLE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
}

const fs = require('fs');
const path = require('path');

async function main() {
  console.log('env: DSH_BROWSER=1, executable =', process.env.DSH_BROWSER_EXECUTABLE || '(playwright 默认)');
  const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
  const engine = new DshAgentEngine({});

  console.log('\n=== 1. initialize（注入 profile + 起 dsh runtime）===');
  const ok = await engine.initialize();
  console.log('initialize:', ok);
  if (!ok) { console.error('❌ dsh 底座初始化失败'); process.exit(1); }

  // 确认插件已注入 profile
  const profileDir = path.join(__dirname, '..', 'agent', 'dsh', 'home', 'profiles', 'sdk');
  const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
  console.log('patch 含 dsh-plugin-playwright:', patch.includes('dsh-plugin-playwright') ? '✓' : '✗');
  console.log('node_modules 已装:', fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-plugin-playwright')) ? '✓' : '✗');

  console.log('\n=== 2. 模型驱动浏览器（导航 + 读标题 + 截屏）===');
  const toolCalls = [];
  const result = await engine.processMessageStreamWithCallback(
    'browser-test',
    '测试你的浏览器能力：1) 用浏览器打开 https://example.com ；2) 读页面标题并告诉我；3) 对当前页面截屏保存（browser_screenshot，不需要传路径）。做完后用一句话汇报标题和截图文件路径。',
    'test-browser-session',
    {},
    {
      onToken: (t) => process.stdout.write(t),
      onToolCall: (c) => { toolCalls.push(c.name); console.log('\n[tool/call]', c.name, JSON.stringify(c.args || {}).slice(0, 200)); },
      onToolResult: (r) => console.log('[tool/result]', String(r.content).slice(0, 160)),
    }
  );
  console.log('\n\n工具调用序列:', toolCalls.join(' → ') || '(无)');
  console.log('模型结论:', (result.content || '').slice(0, 300));

  // 找截图落盘
  await new Promise(r => setTimeout(r, 300));
  const shotDirs = [
    path.join(__dirname, '..', 'agent', 'dsh', 'workspace', '.dsh', 'playwright'),
    path.join(__dirname, '..', 'agent', 'dsh', 'home', '.dsh', 'playwright'),
    path.join(__dirname, '..', '.dsh', 'playwright'),
  ];
  let found = [];
  for (const dir of shotDirs) {
    if (fs.existsSync(dir)) {
      const pngs = fs.readdirSync(dir).filter(f => f.endsWith('.png'));
      if (pngs.length) { found = pngs.map(f => path.join(dir, f)); break; }
    }
  }
  console.log('截图落盘:', found.length ? found.join('\n') : '(未找到——输出目录可能在其他 cwd)');

  console.log('\n=== 3. 跨轮续接：同一会话第二轮让模型回到同一页面刷新 ===');
  const toolCalls2 = [];
  const result2 = await engine.processMessageStreamWithCallback(
    'browser-test',
    '还在吗？请回到刚才打开的那个 example.com 页面（浏览器实例应该还开着），用 browser_reload 刷新它，然后确认标题是否还是 Example Domain。',
    'test-browser-session',
    {},
    {
      onToken: () => {},
      onToolCall: (c) => { toolCalls2.push(c.name); console.log('\n[tool/call]', c.name, JSON.stringify(c.args || {}).slice(0, 160)); },
      onToolResult: (r) => console.log('[tool/result]', String(r.content).slice(0, 120)),
    }
  );
  console.log('\n第二轮工具序列:', toolCalls2.join(' → ') || '(无)');
  console.log('第二轮结论:', (result2.content || '').slice(0, 200));

  await engine.close();
  console.log('\n✅ 浏览器 live 测试结束');
}

main().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1); });
