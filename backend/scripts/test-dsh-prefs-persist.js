/**
 * test-dsh-prefs-persist.js —— 功能开关 + 友好绑定/登录 + 上下文持久化恢复测试
 *
 * 前置：后端已运行且 CLI_API_KEY 一致（如 CLI_API_KEY=dsh-test-internal-key-2026 node index.js）
 * 验证：
 *  A. set_prefs action：查询默认 / 单个开关 / all 批量 / 非法参数
 *  B. Steward 主动消息开关拦截（关闭 → skipped；bind_welcome 不受控）
 *  C. 绑定/登录友好兜底：学号/全名/名字唯一命中 / 重名列候选 / 未命中引导 /
 *     密码错提示剩余次数 / 分步引导（只发"绑定"）/ 解绑
 *  D. 记忆导出与恢复摘要（_appendMemory/_memorySummary 注入 prompt）
 *  E. 稳定 session id（默认）/ DSH_SESSION_PERSIST=0 隔离模式 / 冲突降级
 *  F.（可选 --persist-model，需 DEEPSEEK_API_KEY）真实跨进程恢复：进程1 对话 → 关闭 →
 *     进程2 同 session id 继续对话，验证记得暗号
 */
const fs = require('fs');
const path = require('path');

const KEY = process.env.CLI_API_KEY || 'dsh-test-internal-key-2026';
process.env.CLI_API_KEY = KEY;
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`;
const WITH_MODEL = process.argv.includes('--persist-model');

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? '✓' : '❌'} ${name}${detail !== undefined && detail !== '' ? ' → ' + detail : ''}`);
}

async function call(action, params) {
  const res = await fetch(`${BACKEND}/api/internal/agent-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': KEY },
    body: JSON.stringify({ action, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------- A. set_prefs（需后端运行） ----------
async function testPrefsApi() {
  console.log('\n=== A. set_prefs（功能开关 API） ===');
  let r = await call('set_prefs', { callerId: '999' });
  check('无效 callerId → 403', r.status === 403, r.json.error);

  r = await call('set_prefs', { callerId: '612' });
  check('查询默认状态 → 200 全开', r.status === 200 && r.json.prefs.daily_question === true && r.json.prefs.schedule_notify === true,
    JSON.stringify(r.json.prefs));

  r = await call('set_prefs', { callerId: '612', prefs: '{"daily_question": false}' });
  check('关闭每日一问 → 200', r.status === 200 && r.json.prefs.daily_question === false && r.json.prefs.schedule_notify === true,
    JSON.stringify(r.json.prefs));

  r = await call('set_prefs', { callerId: '612', prefs: '{"all": false}' });
  check('all 批量全关 → 200', r.status === 200 && r.json.prefs.daily_question === false && r.json.prefs.schedule_notify === false,
    JSON.stringify(r.json.prefs));

  r = await call('set_prefs', { callerId: '612', prefs: '{"all": true}' });
  check('all 批量全开 → 200', r.status === 200 && r.json.prefs.daily_question === true && r.json.prefs.schedule_notify === true,
    JSON.stringify(r.json.prefs));

  r = await call('set_prefs', { callerId: '612', prefs: '{"bogus": false}' });
  check('未知功能 → 400', r.status === 400 && /未知功能/.test(r.json.error || ''), r.json.error);

  r = await call('set_prefs', { callerId: '612', prefs: '{not json' });
  check('非法 JSON → 400', r.status === 400, r.json.error);

  r = await call('set_prefs', { callerId: '601', prefs: '{"all": false}' });
  check('601 关闭全部 → 200', r.status === 200 && r.json.prefs.daily_question === false);
}

// ---------- B/C/D. Steward 开关拦截 + 绑定流程（mock 引擎+通道，无需模型） ----------
async function testSteward() {
  console.log('\n=== B. Steward 主动消息开关拦截 ===');
  const StewardManager = require('../wechat/steward');
  // 先本地关闭 601（与后端同读写 data/proactive_prefs.json）
  const prefsStore = require('../data/proactivePrefs');
  prefsStore.setPrefs('601', { daily_question: false, schedule_notify: false });
  const sent = [];
  const mockChannel = {
    online: true, onMessage() {}, onFriendship() {},
    async sendText(wxid, text) { sent.push({ wxid, text }); return true; },
    async sendImage() {}, getStatus: () => ({ online: true }),
    start: async () => ({ success: true }), stop: async () => {},
  };
  const mockEngine = {
    isProcessing: () => false,
    async processProactiveMessage(memberId, kind, payload, callbacks) {
      callbacks.onToken('主动消息内容\n');
      callbacks.onDone?.({ content: 'ok' });
      return { content: 'ok' };
    },
  };
  const steward = new StewardManager({ engine: mockEngine, channel: mockChannel });
  steward.bindings = { wx_a: '612', wx_b: '601' };
  steward._rebuildReverse();

  // 601 已全部关闭（A 组设置）→ 拦截
  let r = await steward.sendProactiveMessage('601', 'daily_question', { question: '今天怎么样' });
  check('关闭后 daily_question → skipped', r.success === false && r.skipped === true, r.error);
  r = await steward.sendProactiveMessage('601', 'schedule_notify', { title: '值日' });
  check('关闭后 schedule_notify → skipped', r.success === false && r.skipped === true, r.error);
  // bind_welcome 不受控
  r = await steward.sendProactiveMessage('601', 'bind_welcome', {});
  check('bind_welcome 不受开关控制（发送）', r.success === true);
  await new Promise(res => setTimeout(res, 5000));
  // 612 全开 → 正常发送
  r = await steward.sendProactiveMessage('612', 'daily_question', { question: '今天怎么样' });
  check('开启状态正常发送', r.success === true);
  await new Promise(res => setTimeout(res, 8000));
  check('612 微信收到消息', sent.some(s => s.wxid === 'wx_a'));

  // 恢复 601 开关（避免污染数据）
  await call('set_prefs', { callerId: '601', prefs: '{"all": true}' });

  console.log('\n=== C. 绑定/登录友好兜底（mock 通道） ===');
  // 备份 bindings 文件（_finishBind 会落盘，结束后还原）
  const bindingsFile = require('path').join(__dirname, '..', 'data', 'wechat_bindings.json');
  let bakBindings = null;
  try { bakBindings = fs.readFileSync(bindingsFile, 'utf8'); } catch {}
  // 读取真实 members.json 造测试用例
  const members = steward._getMembers();
  check('名册可读', members.length > 0, `${members.length} 人`);
  const target = members.find(m => m.id && m.name && m.name.length >= 3) || members[0];
  const givenName = target.name.substring(1);

  // ① 全名/名字 解析（姓名制，无学号）
  const f2 = steward._findMembersByName(target.name);
  check('全名解析命中', f2.members && f2.members.some(mm => String(mm.id) === String(target.id)), target.name);
  const f3 = steward._findMembersByName(givenName);
  check(`名字（不带姓）解析：${givenName}`, (f3.members && f3.members.some(mm => String(mm.id) === String(target.id))) || !!f3.error,
    f3.members ? '命中（候选交密码区分）' : (f3.error || '').substring(0, 60));
  const f4 = steward._findMembersByName('不存在的名字xyz');
  check('未命中 → 可操作提示', !!f4.error && /没找到/.test(f4.error), (f4.error || '').substring(0, 40));

  // ② 分步引导：只发"绑定"
  sent.length = 0;
  await steward._onChannelMessage({ wxid: 'wx_new1', text: '绑定', isSelf: false });
  await new Promise(res => setTimeout(res, 4000));
  const guideMsg = sent.find(s => s.wxid === 'wx_new1');
  check('只发「绑定」→ 分步引导（姓名+管理员入口）', !!guideMsg && /姓名/.test(guideMsg.text) && /管理员登录/.test(guideMsg.text),
    (guideMsg?.text || '').substring(0, 60));

  // ③ 密码错误 → 提示剩余次数（姓名制）
  sent.length = 0;
  await steward._onChannelMessage({ wxid: 'wx_new2', text: `绑定 ${target.name} 错误密码x` });
  await new Promise(res => setTimeout(res, 4000));
  const wrongMsg = sent.find(s => s.wxid === 'wx_new2');
  check('密码错误 → 提示重试', !!wrongMsg && /密码不对/.test(wrongMsg.text) && wrongMsg.text.includes(target.name),
    (wrongMsg?.text || '').substring(0, 60));
  check('密码错误 → 剩余次数提示', !!wrongMsg && /次后/.test(wrongMsg.text));

  // ④ 正确密码绑定（mock 引擎走静态降级文案，因 processProactiveMessage 是 mock 的会成功走 AI 路径）
  sent.length = 0;
  // members.json 的密码是 bcrypt 的，无法构造正确密码 → 用 mock 成员表替换
  const realGetMembers = steward._getMembers.bind(steward);
  const bcrypt = require('bcryptjs');
  const mockMembers = [
    { id: '612', name: '周祎宸', class: '一队', password: bcrypt.hashSync('test-pwd-123', 10) },
    { id: '601', name: '张三丰', class: '一队', password: bcrypt.hashSync('test-pwd-456', 10) },
    { id: '602', name: '张三丰', class: '二队', password: bcrypt.hashSync('test-pwd-789', 10) },
  ];
  steward._getMembers = () => mockMembers;

  // 登录指令（别名） + 全名
  sent.length = 0;
  await steward._onChannelMessage({ wxid: 'wx_new3', text: '登录 周祎宸 test-pwd-123' });
  await new Promise(res => setTimeout(res, 5000));
  check('「登录 全名 密码」绑定成功（612 管理员）', steward.bindings['wx_new3'] === '612');
  check('管理员绑定后消息已发（AI 路径）', sent.some(s => s.wxid === 'wx_new3'),
    sent.filter(s => s.wxid === 'wx_new3').map(s => s.text).join(' | ').substring(0, 80));

  // 重名 → 密码区分（甲密码绑定 601）
  sent.length = 0;
  await steward._onChannelMessage({ wxid: 'wx_new4', text: '绑定 张三丰 test-pwd-456' });
  await new Promise(res => setTimeout(res, 5000));
  check('重名+甲密码 → 绑定 601（密码区分重名）', steward.bindings['wx_new4'] === '601');

  // 名字唯一命中（构造唯一名字）
  mockMembers.push({ id: '603', name: '王独秀', class: '一队', password: bcrypt.hashSync('test-pwd-603', 10) });
  sent.length = 0;
  await steward._onChannelMessage({ wxid: 'wx_new5', text: '绑定 独秀 test-pwd-603' });
  await new Promise(res => setTimeout(res, 5000));
  check('名字（不带姓）唯一命中绑定成功', steward.bindings['wx_new5'] === '603');

  // 解绑（密码确认）
  sent.length = 0;
  await steward._onChannelMessage({ wxid: 'wx_new5', text: '解绑 王独秀 test-pwd-603' });
  await new Promise(res => setTimeout(res, 4000));
  check('解绑成功', steward.bindings['wx_new5'] === undefined);
  const unbindMsg = sent.find(s => s.wxid === 'wx_new5');
  check('解绑确认消息', !!unbindMsg && /已解绑/.test(unbindMsg.text));

  // 解绑密码错误
  sent.length = 0;
  await steward._onChannelMessage({ wxid: 'wx_new3', text: '解绑 周祎宸 错误密码' });
  await new Promise(res => setTimeout(res, 4000));
  const unbindFail = sent.find(s => s.wxid === 'wx_new3');
  check('解绑密码错误提示', !!unbindFail && /解绑失败/.test(unbindFail.text));

  // 还原 mock + bindings 文件（_finishBind 会落盘，恢复测试前状态）
  steward._getMembers = realGetMembers;
  try {
    if (bakBindings !== null) fs.writeFileSync(bindingsFile, bakBindings);
    else fs.rmSync(bindingsFile, { force: true });
  } catch {}
}

// ---------- D/E. 引擎记忆与稳定 session id ----------
async function testEngineMemory() {
  console.log('\n=== D. 记忆导出与恢复摘要 ===');
  const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
  const engine = new DshAgentEngine({});
  const memFile = engine._memoryFile('612');

  // 备份现有记忆文件（避免污染）
  let backup = null;
  try { backup = fs.readFileSync(memFile, 'utf8'); } catch {}
  try { fs.rmSync(memFile, { force: true }); } catch {}

  engine._appendMemory('612', { kind: 'user', text: '帮我记一下：我的暗号是雪鲸号', reply: '已记下：雪鲸号。' });
  engine._appendMemory('612', { kind: 'daily_question', text: '每日一问：今天训练状态怎么样', reply: '今天训练状态怎么样？' });
  check('记忆已落盘', fs.existsSync(memFile));

  const summary = engine._memorySummary('612', 20);
  check('恢复摘要含暗号轮', !!summary && summary.includes('雪鲸号'));
  check('恢复摘要含主动消息标注', !!summary && summary.includes('[你主动发的 daily_question]'));
  check('恢复摘要含轮数说明', !!summary && /最近 2 轮/.test(summary));

  // 滚动裁剪：写入 210 轮 → 保留 200
  for (let i = 0; i < 210; i++) engine._appendMemory('612', { kind: 'user', text: `轮次${i}`, reply: `回${i}` });
  const data = JSON.parse(fs.readFileSync(memFile, 'utf8'));
  check('滚动窗口保留 200 轮', data.turns.length === 200, String(data.turns.length));
  check('最早的轮次被裁剪', !data.turns.some(t => t.text === '轮次0'));

  // 摘要注入 prompt（firstTurn）
  const prompt = await engine._buildPrompt('612', {}, '我们继续', true);
  check('首条 prompt 注入历史摘要', prompt.includes('【历史对话摘要'));

  // 无记忆成员 → 不注入（先清掉残留记忆文件，避免历史测试数据干扰）
  const memFile613 = engine._memoryFile('613');
  let backup613 = null;
  try { backup613 = fs.readFileSync(memFile613, 'utf8'); } catch {}
  try { fs.rmSync(memFile613, { force: true }); } catch {}
  const prompt2 = await engine._buildPrompt('613', {}, '你好', true);
  check('无记忆成员不注入摘要', !prompt2.includes('【历史对话摘要'));
  try {
    if (backup613) fs.writeFileSync(memFile613, backup613);
  } catch {}

  console.log('\n=== E. 稳定 session id / 隔离模式 / 冲突降级 ===');
  const e1 = new DshAgentEngine({});
  check('默认稳定 session id', e1._resolveSessionId('member-612') === 'member-612');
  const orig = process.env.DSH_SESSION_PERSIST;
  process.env.DSH_SESSION_PERSIST = '0';
  const e2 = new DshAgentEngine({});
  e2._bootId = 'deadbeef';
  check('DSH_SESSION_PERSIST=0 → bootId 隔离', e2._resolveSessionId('member-612') === 'member-612-deadbeef');
  process.env.DSH_SESSION_PERSIST = orig;
  // 冲突过的 logicalId → 降级隔离
  e1._conflictIds.add('member-612');
  e1._sessionMap.delete('member-612');
  e1._bootId = 'cafe1234';
  check('冲突后降级隔离 id', e1._resolveSessionId('member-612') === 'member-612-cafe1234');
  // 冲突识别启发式
  check('冲突识别（collision）', e1._isSessionConflict(new Error('session id collision detected')));
  check('冲突识别（中文 已存在）', e1._isSessionConflict(new Error('会话已存在')));
  check('非冲突错误不误判', !e1._isSessionConflict(new Error('网络超时 timeout')));

  // 恢复备份记忆文件
  try {
    if (backup) fs.writeFileSync(memFile, backup);
    else fs.rmSync(memFile, { force: true });
  } catch {}
}

// ---------- F. 真实跨进程恢复（--persist-model，需 DEEPSEEK_API_KEY） ----------
// 机制级验证（server fork resume）：
//   F1. 进程1 记暗号 → 会话日志落盘（稳定 id）
//   F2. 进程2（全新 dsh runtime 子进程）同 id 问暗号 → 引擎检测磁盘日志（跳摘要）、
//       服务端 fork agents.resume 完整恢复历史 → 回答正确
//   F3. 同一日志文件被追加（resume 续写同一 session，而非另开新会话）
//   F4. 无 bootId 隔离目录（未走降级路径 = resume 真正生效，非摘要兜底）
async function testCrossProcessRestore() {
  console.log('\n=== F. 真实跨进程上下文恢复（server fork resume 机制验证） ===');
  const { spawn } = require('child_process');
  const script = path.join(__dirname, '_persist-round.js');
  const sessionsRoot = path.join(__dirname, '..', 'agent', 'dsh', 'home', 'sessions');
  const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
  const seg = new DshAgentEngine({})._encodeSegment('member-613');

  const round = (payload) => new Promise((resolve, reject) => {
    const outFile = path.join(__dirname, `_persist-out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`);
    const p = spawn(process.execPath, [script], {
      env: { ...process.env, PERSIST_PAYLOAD: JSON.stringify(payload), PERSIST_OUT_FILE: outFile },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '', stdout = '';
    p.stderr.on('data', d => err += d);
    p.stdout.on('data', d => stdout += d);
    p.on('exit', code => {
      try {
        const reply = code === 0 ? fs.readFileSync(outFile, 'utf8') : '';
        fs.rmSync(outFile, { force: true });
        code === 0 ? resolve({ reply: reply.trim(), stdout }) : reject(new Error(err || `exit ${code}`));
      } catch (e) { reject(e); }
    });
  });

  const memFile = path.join(__dirname, '..', 'data', 'conversation_memory', '613_dsh.json');
  try { fs.rmSync(memFile, { force: true }); } catch {}

  // 清理 member-613 历史日志（确定性：两轮都在全新会话上跑）
  const cleanLogs = () => {
    try {
      for (const proj of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        for (const sid of fs.readdirSync(path.join(sessionsRoot, proj.name))) {
          if (sid === seg || /^member-613-[0-9a-f]{8}$/.test(sid)) {
            fs.rmSync(path.join(sessionsRoot, proj.name, sid), { recursive: true, force: true });
          }
        }
      }
    } catch {}
  };
  const findLog = () => {
    try {
      for (const proj of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        for (const f of ['session.jsonl.zstd', 'session.jsonl']) {
          const p = path.join(sessionsRoot, proj.name, seg, f);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {}
    return null;
  };
  const findIsolatedDir = () => {
    try {
      for (const proj of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!proj.isDirectory()) continue;
        for (const sid of fs.readdirSync(path.join(sessionsRoot, proj.name))) {
          if (/^member-613-[0-9a-f]{8}$/.test(sid)) return sid;
        }
      }
    } catch {}
    return null;
  };
  cleanLogs();

  // F1. 第 1 轮：独立进程，记暗号（全新会话，无日志 → create）
  console.log('  进程1：记住暗号…');
  const r1 = await round({ memberId: '613', message: '（记住这个，不用工具）我的暗号是雪鲸号。回复"记住了"即可。' });
  console.log(`  进程1 回复: ${r1.reply.substring(0, 60)}`);
  check('进程1 正常完成', r1.reply.length > 0);
  const log1 = findLog();
  check('F1 会话日志已落盘（稳定 id）', !!log1, log1 || '');
  const size1 = log1 ? fs.statSync(log1).size : 0;

  // F2. 第 2 轮：全新进程（dsh 子进程完全重启），同 session id 问暗号
  console.log('  进程2：新进程问暗号…');
  const r2 = await round({ memberId: '613', message: '我的暗号是什么？只回暗号本身。' });
  console.log(`  进程2 回复: ${r2.reply.substring(0, 80)}`);
  const restored = /雪鲸/.test(r2.reply);
  check('F2 进程2 恢复上下文（记得暗号）', restored, restored ? '雪鲸号 ✓' : '未记得');
  check('F2 引擎检测到磁盘日志（跳摘要，走 resume）', /有磁盘日志，服务端将 resume/.test(r2.stdout));
  check('F2 进程2 未走空转降级', !/空转/.test(r2.stdout));

  // F3/F4. 机制断言：同一日志增长（resume 续写）+ 无隔离目录（未降级）
  const log2 = findLog();
  check('F3 同一日志文件被续写（resume 追加，非另开会话）',
    !!log2 && log2 === log1 && fs.statSync(log2).size > size1,
    log2 ? `${size1} → ${fs.statSync(log2).size} bytes` : '日志丢失');
  check('F4 无 bootId 隔离目录（resume 真正生效）', findIsolatedDir() === null, findIsolatedDir() || '');

  // 清理测试记忆与日志
  try { fs.rmSync(memFile, { force: true }); } catch {}
  cleanLogs();
}

async function main() {
  await testEngineMemory();
  await testSteward();
  // API 测试需后端在线
  try {
    const ping = await fetch(`${BACKEND}/api/internal/agent-tool`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': KEY },
      body: JSON.stringify({ action: 'bogus_ping' }), signal: AbortSignal.timeout(3000),
    });
    if (ping.status === 400) await testPrefsApi();
    else throw new Error('offline');
  } catch (e) {
    console.log('\n（后端未运行，跳过 A 组 API 测试）');
  }
  if (WITH_MODEL) await testCrossProcessRestore();
  else console.log('\n（跨进程恢复真实模型测试：加 --persist-model 运行）');

  const passed = results.filter(Boolean).length;
  console.log(`\n========== 结果：${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('测试脚本异常:', e.message); process.exit(1); });
