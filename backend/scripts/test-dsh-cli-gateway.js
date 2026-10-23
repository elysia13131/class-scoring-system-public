/**
 * test-dsh-cli-gateway.js —— cli_gateway 兜底工具权限矩阵测试
 *
 * 前置：后端已运行且 CLI_API_KEY 一致（如 CLI_API_KEY=dsh-test-internal-key-2026 node index.js）
 * 验证：闸2（鉴权）+ 闸3（路径分级 / 身份隔离 / 密码闸 / 封禁 / JSON 防损坏 / 审计日志）
 * 可选：node test-dsh-cli-gateway.js --model 追加模型真实调用（需 DEEPSEEK_API_KEY）
 */
const fs = require('fs');
const path = require('path');

const KEY = process.env.CLI_API_KEY || 'dsh-test-internal-key-2026';
process.env.CLI_API_KEY = KEY; // dsh 子进程需继承（插件 X-Internal-Auth 鉴权头）
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`;
const WITH_MODEL = process.argv.includes('--model');

async function gw(params, expect) {
  const res = await fetch(`${BACKEND}/api/internal/agent-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': KEY },
    body: JSON.stringify({ action: 'cli_gateway', ...params }),
  });
  const json = await res.json().catch(() => ({}));
  const expects = Array.isArray(expect) ? expect : [expect];
  const pass = expects.includes(res.status);
  console.log(`${pass ? '✓' : '❌'} [${res.status}] ${params.command} "${params.path || ''}"${params.mode ? ' mode=' + params.mode : ''} → ${json.error || JSON.stringify(json).substring(0, 90)}`);
  return { pass, status: res.status, json };
}

async function main() {
  let fails = 0;
  const t = (r) => { if (!r.pass) fails++; };

  console.log('=== 0. 闸2：无鉴权 ===');
  const noAuth = await fetch(`${BACKEND}/api/internal/agent-tool`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'cli_gateway', callerId: '612', command: 'list', path: '.' }),
  });
  console.log(`${noAuth.status === 401 ? '✓' : '❌'} [${noAuth.status}] 无 X-Internal-Auth → 401`);
  if (noAuth.status !== 401) fails++;

  console.log('\n=== 1. 身份闸：callerId 必须是真实成员 ===');
  t(await gw({ callerId: '999', command: 'list', path: '.' }, 403));

  console.log('\n=== 2. list：免密（含根目录） ===');
  t(await gw({ callerId: '612', command: 'list', path: '.' }, 200));
  t(await gw({ callerId: '612', command: 'list', path: 'data/checkin_records' }, 200)); // 容忍 data/ 前缀

  console.log('\n=== 3. 本人文件：免密读写删 ===');
  t(await gw({ callerId: '612', command: 'write', path: 'checkin_records/612.json', mode: 'merge',
    content: '{"records":[{"date":"2026-08-31","note":"gateway-test"}]}' }, 200));
  t(await gw({ callerId: '612', command: 'read', path: 'checkin_records/612.json' }, 200));
  t(await gw({ callerId: '612', command: 'write', path: 'temp/612_scratch.txt', content: 'scratch' }, 200));
  t(await gw({ callerId: '612', command: 'read', path: 'temp/612_scratch.txt' }, 200));
  t(await gw({ callerId: '612', command: 'delete', path: 'temp/612_scratch.txt' }, 200));

  console.log('\n=== 4. 他人/共享文件：需管理员密码（deny 路径） ===');
  t(await gw({ callerId: '612', command: 'read', path: 'checkin_records/601.json' }, 403));
  t(await gw({ callerId: '612', command: 'read', path: 'conversation_memory/601.json' }, 403));
  t(await gw({ callerId: '612', command: 'read', path: 'experiences.json' }, 403));
  t(await gw({ callerId: '612', command: 'write', path: 'scores.json', content: '{}' }, 403));
  t(await gw({ callerId: '612', command: 'read', path: 'scores/semester_1/week_1.json.gz' }, 403));

  console.log('\n=== 5. 公开文件：读免密，写需密码 ===');
  t(await gw({ callerId: '612', command: 'read', path: 'members.json' }, 200));
  t(await gw({ callerId: '612', command: 'write', path: 'members.json', content: '{}' }, 403));

  console.log('\n=== 6. 封禁路径：永久拒绝（含 .bak 绕过尝试） ===');
  t(await gw({ callerId: '612', command: 'read', path: 'config.json' }, 403));
  t(await gw({ callerId: '612', command: 'read', path: 'config.json.bak' }, 403));
  t(await gw({ callerId: '612', command: 'read', path: 'wechat/session.json' }, 403));
  t(await gw({ callerId: '612', command: 'list', path: 'wechat' }, 403));
  t(await gw({ callerId: '612', command: 'read', path: 'devices.json' }, 403));
  t(await gw({ callerId: '612', command: 'read', path: 'notification_inbox.json' }, 403));
  t(await gw({ callerId: '612', command: 'read', path: 'agent_cli_audit.jsonl' }, 403));
  t(await gw({ callerId: '612', command: 'write', path: 'scheduleStore.js', content: 'x' }, 403));

  console.log('\n=== 7. JSON 防损坏闸 ===');
  t(await gw({ callerId: '612', command: 'write', path: 'temp/612_bad.json', content: '{not json' }, 400));

  console.log('\n=== 8. 路径穿越防护 ===');
  t(await gw({ callerId: '612', command: 'read', path: '../index.js' }, [400, 403]));

  console.log('\n=== 9. 审计日志（本地直读文件验证） ===');
  const auditPath = path.join(__dirname, '..', 'data', 'agent_cli_audit.jsonl');
  try {
    const lines = fs.readFileSync(auditPath, 'utf8').split('\n').filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    const hasDenied = lines.some(l => l.includes('"ok":false'));
    console.log(`${lines.length >= 8 ? '✓' : '❌'} 审计已记录 ${lines.length} 条`);
    console.log(`${hasDenied ? '✓' : '❌'} 拒绝操作也有审计（含 denied 原因）`);
    console.log(`  最新一条: ${JSON.stringify(last).substring(0, 120)}`);
    if (lines.length < 8 || !hasDenied) fails++;
  } catch (e) {
    console.log('❌ 审计文件不存在或不可读:', e.message);
    fails++;
  }

  console.log('\n=== 10. 清理测试数据 ===');
  t(await gw({ callerId: '612', command: 'delete', path: 'checkin_records/612.json' }, 200));
  t(await gw({ callerId: '612', command: 'delete', path: 'checkin_records/612.json.bak' }, 200));
  t(await gw({ callerId: '612', command: 'delete', path: 'temp/612_bad.json.bak' }, [200, 404])); // 非法 JSON write 被拒时无 .bak

  // ---------- 可选：模型真实调用（验证模型会用 cli_gateway 工具） ----------
  if (WITH_MODEL) {
    console.log('\n=== 11. 模型真实调用 cli_gateway（dsh 全链路） ===');
    if (!process.env.DEEPSEEK_API_KEY) {
      process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
    }
    const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
    const engine = new DshAgentEngine({});
    if (!await engine.initialize()) { console.error('❌ 引擎初始化失败'); process.exit(1); }
    const calls = [];
    const r = await engine.processMessageStreamWithCallback(
      '612', '用 cli_gateway 工具往 data/temp/612_model_test.txt 写入内容 "hello from model"，然后再读出来告诉我内容。',
      'test-cli-gateway', {},
      { onToolCall: (c) => { calls.push(c.name); console.log('[tool/call]', c.name, JSON.stringify(c.arguments || {}).substring(0, 100)); } }
    );
    console.log('回答:', r.content.substring(0, 200));
    const usedGateway = calls.includes('cli_gateway');
    console.log(usedGateway ? '✓ 模型调用了 cli_gateway' : '❌ 模型未调用 cli_gateway');
    if (!usedGateway) fails++;
    if (fs.existsSync(path.join(__dirname, '..', 'data', 'temp', '612_model_test.txt'))) {
      console.log('✓ 文件真实写入');
      fs.unlinkSync(path.join(__dirname, '..', 'data', 'temp', '612_model_test.txt'));
    } else {
      console.log('❌ 文件未写入'); fails++;
    }
    await engine.close();
  }

  console.log(`\n${fails === 0 ? '✅' : '❌'} cli_gateway 权限矩阵测试完成（${fails} 项失败）`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => { console.error('❌ 测试失败:', e); process.exit(1); });
