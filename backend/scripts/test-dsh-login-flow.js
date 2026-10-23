/**
 * test-dsh-login-flow.js —— 登录体系测试（姓名+密码 / 管理员上下文登录）
 *
 * 验证：
 *  A. 成员登录：姓名+密码（重名由密码区分，无学号）；名字（不带姓）命中；
 *     未命中/密码错误的友好兜底；学号不再是登录凭据
 *  B. 管理员登录：名称+管理员密码；名称可注册（首次登录即注册）；
 *     绑定 admin-名称 上下文；换设备重绑；解绑（管理员密码确认）
 *  C. 引擎：admin- 上下文身份注入；bind_welcome 管理员变体指令
 *  D.（后端在线且已加载新代码时）isAdminCaller 识别 admin- 上下文
 *
 * 数据文件备份/还原：wechat_bindings.json / admin_contexts.json / config.json
 */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const KEY = process.env.CLI_API_KEY || 'dsh-test-internal-key-2026';
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`;
const DATA = path.join(__dirname, '..', 'data');

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? '✓' : '❌'} ${name}${detail !== undefined && detail !== '' ? ' → ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 备份/还原工具
const backupFile = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const restoreFile = (f, bak) => {
  try {
    if (bak !== null) fs.writeFileSync(f, bak);
    else fs.rmSync(f, { force: true });
  } catch {}
};

async function main() {
  const bindingsFile = path.join(DATA, 'wechat_bindings.json');
  const adminCtxFile = path.join(DATA, 'admin_contexts.json');
  const configFile = path.join(DATA, 'config.json');
  const bakBindings = backupFile(bindingsFile);
  const bakAdminCtx = backupFile(adminCtxFile);
  const bakConfig = backupFile(configFile);

  // 测试用管理员密码（临时写入 config；结束后还原）
  const ADMIN_PWD = 'test-admin-pwd-2609';
  fs.writeFileSync(configFile, JSON.stringify({ adminPasswords: [bcrypt.hashSync(ADMIN_PWD, 10)] }));
  try { fs.rmSync(adminCtxFile, { force: true }); } catch {}
  try { fs.writeFileSync(bindingsFile, '{}'); } catch {}

  const StewardManager = require('../wechat/steward');
  const sent = [];
  const mockChannel = {
    online: true, onMessage() {}, onFriendship() {},
    async sendText(wxid, text) { sent.push({ wxid, text }); return true; },
    async sendImage() {}, getStatus: () => ({ online: true }),
    start: async () => ({ success: true }), stop: async () => {},
  };
  const engineCalls = [];   // { type, memberId, message/kind/payload }
  const mockEngine = {
    isProcessing: () => false,
    async processMessageStreamWithCallback(memberId, message, sessionId, context, callbacks) {
      engineCalls.push({ type: 'message', memberId, message });
      callbacks.onToken('收到\n');
      callbacks.onDone?.({ content: '收到' });
      return { content: '收到' };
    },
    async processProactiveMessage(memberId, kind, payload, callbacks) {
      engineCalls.push({ type: 'proactive', memberId, kind, payload });
      callbacks.onToken('主动内容\n');
      callbacks.onDone?.({ content: '主动内容' });
      return { content: '主动内容' };
    },
  };
  const steward = new StewardManager({ engine: mockEngine, channel: mockChannel });

  // 测试名册（重名 + 复姓场景）
  const realGetMembers = steward._getMembers.bind(steward);
  steward._getMembers = () => ([
    { id: '612', name: '周祎宸', class: '一队', password: bcrypt.hashSync('pwd-612', 10) },
    { id: '601', name: '张三丰', class: '一队', password: bcrypt.hashSync('pwd-601', 10) },
    { id: '602', name: '张三丰', class: '二队', password: bcrypt.hashSync('pwd-602', 10) },
    { id: '603', name: '王独秀', class: '一队', password: bcrypt.hashSync('pwd-603', 10) },
    { id: '604', name: '欧阳熙媛', class: '一队', password: bcrypt.hashSync('pwd-604', 10) },
  ]);

  const msg = (wxid, text) => steward._onChannelMessage({ wxid, text, isSelf: false });

  try {
    // ---------- A. 成员登录（姓名+密码） ----------
    console.log('\n=== A. 成员登录（姓名+密码，无学号） ===');

    sent.length = 0; engineCalls.length = 0;
    await msg('wx_m1', '登录 周祎宸 pwd-612');
    await sleep(4000);
    check('全名+密码登录成功（612）', steward.bindings['wx_m1'] === '612');
    check('登录触发 AI 欢迎语（proactive）', engineCalls.some(c => c.type === 'proactive' && c.memberId === '612' && c.kind === 'bind_welcome'));

    sent.length = 0; engineCalls.length = 0;
    await msg('wx_m2', '绑定 熙媛 pwd-604');
    await sleep(5000);
    check('名字（不带姓，复姓）+密码登录成功（604）', steward.bindings['wx_m2'] === '604');

    // 重名由密码区分
    sent.length = 0; engineCalls.length = 0;
    await msg('wx_m3', '绑定 张三丰 pwd-601');
    await sleep(5000);
    check('重名+甲密码 → 绑定 601', steward.bindings['wx_m3'] === '601');
    sent.length = 0; engineCalls.length = 0;
    await msg('wx_m4', '绑定 张三丰 pwd-602');
    await sleep(5000);
    check('重名+乙密码 → 绑定 602（密码区分重名）', steward.bindings['wx_m4'] === '602');

    // 密码错误 → 剩余次数提示（不含学号）
    sent.length = 0;
    await msg('wx_m5', '绑定 张三丰 错误密码');
    await sleep(4000);
    const wrongMsg = sent.find(s => s.wxid === 'wx_m5');
    check('重名+错误密码 → 密码不对提示', !!wrongMsg && /密码不对/.test(wrongMsg.text), (wrongMsg?.text || '').substring(0, 50));
    check('剩余次数提示', !!wrongMsg && /次后/.test(wrongMsg.text));
    check('提示不再引导用学号', !!wrongMsg && !/学号/.test(wrongMsg.text));

    // 未命中
    sent.length = 0;
    await msg('wx_m6', '绑定 不存在的名字xyz 密码');
    await sleep(4000);
    const nf = sent.find(s => s.wxid === 'wx_m6');
    check('未命中 → 可操作提示（无学号引导）', !!nf && /没找到/.test(nf.text) && !/学号/.test(nf.text), (nf?.text || '').substring(0, 50));

    // 学号不再是登录凭据
    sent.length = 0;
    await msg('wx_m7', '绑定 612 pwd-612');
    await sleep(4000);
    const idLogin = sent.find(s => s.wxid === 'wx_m7');
    check('学号登录 → 未命中（学号是内部编码不外用）', !!idLogin && /没找到/.test(idLogin.text));
    check('学号登录未绑定', steward.bindings['wx_m7'] === undefined);

    // 分步引导
    sent.length = 0;
    await msg('wx_m8', '绑定');
    await sleep(4000);
    const guide = sent.find(s => s.wxid === 'wx_m8');
    check('只发「绑定」→ 分步引导（含管理员入口）', !!guide && /姓名/.test(guide.text) && /管理员登录/.test(guide.text),
      (guide?.text || '').substring(0, 60));

    // ---------- B. 管理员登录（名称+管理员密码，可注册） ----------
    console.log('\n=== B. 管理员登录（名称+管理员密码） ===');

    sent.length = 0;
    await msg('wx_a1', '管理员登录');
    await sleep(4000);
    const ah = sent.find(s => s.wxid === 'wx_a1');
    check('只发「管理员登录」→ 引导（名称自定+管理员密码）', !!ah && /管理员登录/.test(ah.text) && /管理员密码/.test(ah.text),
      (ah?.text || '').substring(0, 60));

    sent.length = 0;
    await msg('wx_a2', '管理员登录 测试管 错误密码x');
    await sleep(4000);
    const aw = sent.find(s => s.wxid === 'wx_a2');
    check('错误管理员密码 → 提示重试+剩余次数', !!aw && /管理员密码不对/.test(aw.text) && /次后/.test(aw.text),
      (aw?.text || '').substring(0, 60));

    // 非法名称
    sent.length = 0;
    await msg('wx_a3', '管理员登录 测试:管 ' + ADMIN_PWD);
    await sleep(4000);
    const an = sent.find(s => s.wxid === 'wx_a3');
    check('非法名称 → 字符集提示', !!an && /仅支持/.test(an.text));

    // 正确登录（新名称注册）
    sent.length = 0; engineCalls.length = 0;
    await msg('wx_a4', '管理员登录 测试管 ' + ADMIN_PWD);
    await sleep(5000);
    check('管理员登录成功 → 绑定 admin-测试管', steward.bindings['wx_a4'] === 'admin-测试管');
    const ctxData = JSON.parse(fs.readFileSync(adminCtxFile, 'utf8'));
    check('名称已注册（admin_contexts.json）', !!ctxData['测试管']?.createdAt && !!ctxData['测试管']?.lastLogin);
    const welcomeCall = engineCalls.find(c => c.type === 'proactive' && c.memberId === 'admin-测试管');
    check('AI 欢迎语走管理员上下文（payload.adminContext）',
      !!welcomeCall && welcomeCall.kind === 'bind_welcome' && welcomeCall.payload?.adminContext === true && welcomeCall.payload?.adminName === '测试管');
    check('AI 欢迎语进入该上下文会话', engineCalls.some(c => c.type === 'proactive' && c.memberId === 'admin-测试管'));

    // 换设备：另一 wxid 同名登录
    sent.length = 0; engineCalls.length = 0;
    await msg('wx_a5', '管理员登录 测试管 ' + ADMIN_PWD);
    await sleep(5000);
    check('换设备重绑（新 wxid → admin-测试管）', steward.bindings['wx_a5'] === 'admin-测试管');
    check('旧 wxid 绑定被替换', steward.bindings['wx_a4'] === undefined);
    check('reverse 指向新 wxid', steward.reverse['admin-测试管'] === 'wx_a5');

    // 管理员上下文的普通消息 → 路由到该上下文
    engineCalls.length = 0;
    await msg('wx_a5', '今天班级有什么安排');
    await sleep(4000);
    check('普通消息路由到 admin-上下文（memberId=admin-测试管）',
      engineCalls.some(c => c.type === 'message' && c.memberId === 'admin-测试管' && c.message === '今天班级有什么安排'));

    // 解绑：错误管理员密码
    sent.length = 0;
    await msg('wx_a5', '解绑 测试管 错误的管理员密码');
    await sleep(4000);
    const ub = sent.find(s => s.wxid === 'wx_a5');
    check('解绑失败（管理员密码不对）', !!ub && /解绑失败/.test(ub.text), (ub?.text || '').substring(0, 50));

    // 解绑：正确
    sent.length = 0;
    await msg('wx_a5', '解绑 admin-测试管 ' + ADMIN_PWD);
    await sleep(4000);
    check('解绑成功（admin- 名称或裸名称均可）', steward.bindings['wx_a5'] === undefined);
    const ubOk = sent.find(s => s.wxid === 'wx_a5');
    check('解绑确认（提示管理员登录恢复）', !!ubOk && /已解绑/.test(ubOk.text) && /管理员登录/.test(ubOk.text));

    // 成员解绑（姓名+密码）
    sent.length = 0;
    await msg('wx_m3', '解绑 张三丰 pwd-601');
    await sleep(4000);
    check('成员解绑成功（姓名+密码）', steward.bindings['wx_m3'] === undefined);

    // ---------- C. 引擎身份注入与指令变体 ----------
    console.log('\n=== C. 引擎（admin- 上下文身份/指令） ===');
    const DshAgentEngine = require('../agent/dsh/DshAgentEngine');
    const engine = new DshAgentEngine({});
    const memFile = engine._memoryFile('admin-测试管');
    let bakMem = null;
    try { bakMem = fs.readFileSync(memFile, 'utf8'); } catch {}
    try { fs.rmSync(memFile, { force: true }); } catch {}

    const prompt = await engine._buildPrompt('admin-测试管', {}, '你好', true);
    check('首条身份含管理员「名称」', prompt.includes('管理员「测试管」'));
    check('身份声明 callerId=admin-测试管', prompt.includes('callerId 使用 admin-测试管'));
    check('身份说明具备管理员权限（免密敏感操作）', /管理员权限/.test(prompt) && /无需密码/.test(prompt));
    check('身份说明会收管理员版推送（可 class_set_prefs 开关）', /管理员版每日一问/.test(prompt) && /class_set_prefs/.test(prompt));

    const dAdmin = engine._buildProactiveDirective('bind_welcome', { adminContext: true, adminName: '测试管', isNew: true });
    check('bind_welcome 管理员变体（独立上下文+推送清单+开关）',
      /管理员上下文/.test(dAdmin) && /新注册/.test(dAdmin) && /每日一问/.test(dAdmin) && /class_set_prefs/.test(dAdmin));
    const dMember = engine._buildProactiveDirective('bind_welcome', {});
    check('bind_welcome 成员变体不受影响（每日一问开关说明）', /每日一问/.test(dMember) && /class_set_prefs/.test(dMember));

    // 管理员上下文记忆导出（跨会话恢复同一名称）
    engine._appendMemory('admin-测试管', { kind: 'user', text: '帮我看下六维评分', reply: '好的，这就查。' });
    check('管理员上下文记忆落盘（跨重启恢复）', fs.existsSync(memFile));
    const summary = engine._memorySummary('admin-测试管', 20);
    check('摘要可注入恢复', !!summary && summary.includes('六维评分'));

    try { if (bakMem) fs.writeFileSync(memFile, bakMem); else fs.rmSync(memFile, { force: true }); } catch {}
    steward._getMembers = realGetMembers;

    // ---------- C'. 管理员上下文推送开关（与成员同机制，独立生效） ----------
    console.log('\n=== C\'. 管理员上下文推送开关 ===');
    const prefsFile = path.join(DATA, 'proactive_prefs.json');
    const bakPrefs = backupFile(prefsFile);
    try {
      const prefsStore = require('../data/proactivePrefs');
      // 临时绑定一个 wxid 到 admin- 上下文供 sendProactiveMessage 路由
      steward.bindings['wx_ae'] = 'admin-推送测试管';
      steward._rebuildReverse();
      const sent2 = sent;   // 复用同一 mock 通道的记录数组
      sent2.length = 0;

      let pr = await steward.sendProactiveMessage('admin-推送测试管', 'daily_question', { question: '今天最需要关注谁' });
      check('管理员上下文默认收每日一问（推送成功）', pr.success === true, pr.error || '');

      prefsStore.setPrefs('admin-推送测试管', { daily_question: false });
      pr = await steward.sendProactiveMessage('admin-推送测试管', 'daily_question', { question: '今天最需要关注谁' });
      check('关闭每日一问 → 拦截（skipped）', pr.success === false && pr.skipped === true, pr.error);

      pr = await steward.sendProactiveMessage('admin-推送测试管', 'schedule_notify', { title: '晚点名' });
      check('独立开关：日程提醒不受每日一问关闭影响', pr.success === true);

      prefsStore.setPrefs('admin-推送测试管', { schedule_notify: false });
      pr = await steward.sendProactiveMessage('admin-推送测试管', 'schedule_notify', { title: '晚点名' });
      check('关闭日程提醒 → 拦截（skipped）', pr.success === false && pr.skipped === true, pr.error);

      prefsStore.setPrefs('admin-推送测试管', { all: true });
      pr = await steward.sendProactiveMessage('admin-推送测试管', 'daily_question', { question: '今天最需要关注谁' });
      check('批量全开 → 恢复推送', pr.success === true);

      check('推送经 AI 路由到 admin- 上下文（engine 收到）',
        engineCalls.some(c => c.type === 'proactive' && c.memberId === 'admin-推送测试管'));
      delete steward.bindings['wx_ae'];
      steward._rebuildReverse();
    } finally {
      restoreFile(prefsFile, bakPrefs);
    }

    // ---------- D. 后端权限（需后端在线且已加载新代码） ----------
    console.log('\n=== D. 后端 isAdminCaller（admin- 上下文） ===');
    let backendNew = false;
    try {
      // 注册一个专用测试上下文（写盘，finally 清理）
      const adminCtx = require('../data/adminContexts');
      adminCtx.register('权限测试管');
      const call = async (action, params) => {
        const res = await fetch(`${BACKEND}/api/internal/agent-tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': KEY },
          body: JSON.stringify({ action, ...params }),
          signal: AbortSignal.timeout(8000),
        });
        return { status: res.status, json: await res.json().catch(() => ({})) };
      };
      const r1 = await call('query_pending_approvals', { callerId: 'admin-权限测试管' });
      backendNew = r1.status === 200;
      if (backendNew) {
        check('管理员上下文查待批请求 → 200（免密）', true);
        const r2 = await call('query_pending_approvals', { callerId: 'admin-未注册名' });
        check('未注册名称 → 403', r2.status === 403, r2.json.error);
        const r3 = await call('approve_request', { callerId: 'admin-未注册名', approvalId: 'x' });
        check('未注册名称不能批准 → 403', r3.status === 403);
        // 管理员上下文的功能开关 API（对话开关的后端）
        const r4 = await call('set_prefs', { callerId: 'admin-权限测试管', prefs: '{"daily_question": false}' });
        check('管理员上下文 set_prefs → 200（对话开关可用）', r4.status === 200 && r4.json.prefs?.daily_question === false,
          JSON.stringify(r4.json.prefs || r4.json.error));
        // 管理员上下文每日一问回答落库（hasAnsweredToday 判重链路）
        const r5 = await call('submit_checkin', { callerId: 'admin-权限测试管', text: '今天重点关注了体测补测安排' });
        check('管理员上下文 submit_checkin → 200（回答可落库判重）', r5.status === 200, r5.json.error || 'ok');
        const r6 = await call('set_prefs', { callerId: 'admin-未注册名' });
        check('未注册名称 set_prefs → 403', r6.status === 403);
      } else {
        console.log('（后端仍在运行旧代码（未重启），跳过 D 组在线验证）');
      }
    } catch (e) {
      console.log(`（后端未运行或不可达，跳过 D 组：${e.message}）`);
    }
    if (!backendNew) {
      // 模块级逻辑仍可本地验证
      const { isAdminContextId, contextIdOf, validName } = require('../data/adminContexts');
      check('（本地）isAdminContextId 识别注册上下文', isAdminContextId('admin-测试管') === true);
      check('（本地）未注册名称不识别', isAdminContextId('admin-随便什么') === false);
      check('（本地）非 admin- 前缀不识别', isAdminContextId('612') === false);
      check('（本地）contextIdOf/名称校验', contextIdOf('张三') === 'admin-张三' && validName('张三') && !validName('a:b'));
    }
  } finally {
    // 还原所有数据文件（bindings 恢复为测试前状态）
    steward._getMembers = realGetMembers;
    restoreFile(bindingsFile, bakBindings);
    restoreFile(adminCtxFile, bakAdminCtx);
    restoreFile(configFile, bakConfig);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n========== 结果：${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('测试脚本异常:', e); process.exit(1); });
