/**
 * test-gewe-channel.js —— GeweChat 通道全链路集成测试（本地 mock GeweChat 服务端）
 *
 * 验证 geweChannel.js 对齐真实 GeweChat API（github.com/Devo919/Gewechat）：
 *  A. 登录协议：getTokenId（X-GEWE-TOKEN 头）→ getLoginQrCode（appId 持久化）
 *     → checkLogin 轮询 status=2 → 上线
 *  B. 回调注册：setCallback {token, callbackUrl} + GeweChat testMsg 测试消息可达
 *  C. 二维码端点：/api/wechat/steward/qrcode 返回 data URL
 *  D. 入站消息：AddMsg 回调 → 绑定成员 → 引擎回复 → postText 出站（真实后端实例）
 *  E. 回调去重：同 Appid+NewMsgId 重复推送不重复处理
 *  F. 好友申请：MsgType 37 XML 解析（v3/v4/scene）→ addContacts option=3 → 欢迎语
 *  G. 媒体端点：/api/wechat/steward/media/:file 服务图表 PNG；sendImage imgUrl 可下载
 *  H. 免验证重登：checkOnline（appId 复用，不重新扫码）
 *  I. 云托管模式：GEWE_MODE=cloud + GEWE_TOKEN（GeWeAPI 商业服务）——
 *     前缀 /gewe/v2/api、token 不走 getTokenId、回调注册 /login/setCallback
 *
 * 运行：node scripts/test-gewe-channel.js
 * （自动起 mock GeweChat :32531 + 临时后端实例 :3199，结束后恢复数据文件）
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const MOCK_PORT = 32531;
const BACKEND_PORT = 3199;
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;
const DATA = path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA, 'wechat', 'gewe-session.json');
const BINDINGS_FILE = path.join(DATA, 'wechat_bindings.json');
const MEDIA_DIR = path.join(DATA, 'chart_images');

// 环境变量须在 require 通道模块前设置（模块级读取）
process.env.GEWE_API = `http://127.0.0.1:${MOCK_PORT}`;
process.env.GEWE_CALLBACK_URL = `${BACKEND}/api/wechat/steward/callback`;

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? '✓' : '❌'} ${name}${detail !== undefined && detail !== '' ? ' → ' + detail : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const backupFile = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const restoreFile = (f, bak) => {
  try {
    if (bak !== null) fs.writeFileSync(f, bak);
    else fs.rmSync(f, { force: true });
  } catch {}
};
async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// ---------- mock GeweChat 服务端（复刻真实 API 的请求/响应与关键行为） ----------
const mock = {
  token: 'mock-gewe-token-2609',
  checkLoginCalls: 0,
  online: false,
  callback: null,            // setCallback 收到的 {token, callbackUrl}（自部署路径）
  cloudCallback: null,       // setCallback 收到的 {token, callbackUrl}（云路径 /login/setCallback）
  getTokenIdCalls: 0,        // getTokenId 调用计数（云模式不应调用）
  testMsgResponse: null,     // testMsg 推到回调地址的响应状态
  texts: [],                 // postText 记录
  images: [],                // postImage 记录（含 imgUrl 下载验证）
  friends: [],               // addContacts 记录
  checkOnlineCalls: [],
  setCallbackCalls: 0,
  cdnDownloads: [],          // downloadCdn 请求记录（入站媒体）
  cdnImageBuf: null,         // CDN 图片文件字节（test-fixture.jpg）
  cdnFileBuf: null,          // CDN 文件字节（xlsx）
};

function startMockServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      // CDN 文件直链（downloadCdn 返回的 fileUrl 指向这里；GET 二进制）
      if (req.method === 'GET' && req.url.startsWith('/cdn-files/')) {
        const name = req.url.split('/cdn-files/')[1].split('?')[0];
        const buf = name === 'test_img.jpg' ? mock.cdnImageBuf : mock.cdnFileBuf;
        if (!buf) { res.statusCode = 404; res.end(); return; }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(buf);
        return;
      }
      let payload = {};
      try { payload = body ? JSON.parse(body) : {}; } catch {}
      const reply = (data) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ret: 200, msg: '操作成功', data }));
      };
      // 云托管前缀 /gewe/v2/api/* 与自部署 /v2/api/* 归一到同一路由表
      const p = req.url.replace(/^\/gewe(?=\/v2\/api)/, '');
      // 真实 GeweChat：除 getTokenId 外所有接口要求 X-GEWE-TOKEN 头
      if (!p.endsWith('/tools/getTokenId') && req.headers['x-gewe-token'] !== mock.token) {
        res.end(JSON.stringify({ ret: 500, msg: 'header:X-GEWE-TOKEN 不可为空' }));
        return;
      }
      switch (p) {
        case '/v2/api/tools/getTokenId':
          mock.getTokenIdCalls++;
          reply(mock.token);   // 真实响应：data 直接是 token 字符串
          return;
        case '/v2/api/login/setCallback':   // 云托管（GeWeAPI）回调注册路径
          mock.cloudCallback = payload;
          mock.setCallbackCalls++;
          reply({});
          return;
        case '/v2/api/tools/setCallback':
          mock.callback = payload;
          mock.setCallbackCalls++;
          // 真实行为：立即向回调地址发测试消息验证公网可达
          try {
            const r = await fetch(payload.callbackUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ testMsg: '验证回调地址是否可用', token: payload.token }),
            });
            mock.testMsgResponse = r.status;
          } catch (e) { mock.testMsgResponse = `ERR:${e.message}`; }
          reply({});
          return;
        case '/v2/api/login/getLoginQrCode':
          reply({ appId: 'wx_mock_app_1', uuid: 'mock-uuid-2609' });
          return;
        case '/v2/api/login/checkLogin':
          mock.checkLoginCalls++;
          // 跨省/新设备验证流程：第 1 次已扫码未确认 → 第 2 次返回验证 url → 第 3 次登录成功
          if (mock.checkLoginCalls === 2) reply({ url: 'http://example.com:8081/s/mockverify2609' });
          else if (mock.checkLoginCalls >= 3) reply({ status: 2, expiredTime: 60, nickName: '测试管家小智' });
          else reply({ status: 1, expiredTime: 90, nickName: '' });
          return;
        case '/v2/api/login/checkOnline':
          mock.checkOnlineCalls.push(payload.appId);
          reply(mock.online);   // 真实响应：data 为在线布尔
          return;
        case '/v2/api/message/postText':
          mock.texts.push(payload);
          reply({});
          return;
        case '/v2/api/message/postImage': {
          // 真实行为：GeweChat 服务器下载 imgUrl 后发图
          const rec = { ...payload, fetchStatus: null, contentType: null };
          mock.images.push(rec);
          try {
            const r = await fetch(payload.imgUrl);
            rec.fetchStatus = r.status;
            rec.contentType = r.headers.get('content-type');
            await r.arrayBuffer();
          } catch (e) { rec.fetchStatus = `ERR:${e.message}`; }
          reply({});
          return;
        }
        case '/v2/api/contacts/addContacts':
          mock.friends.push(payload);
          reply({});
          return;
        case '/v2/api/message/downloadCdn': {
          // 真实响应：data.fileUrl（7 天有效的临时直链）；按 type 分流图片/文件
          mock.cdnDownloads.push(payload);
          const isFile = String(payload.type) === '5';
          reply({ fileUrl: `http://127.0.0.1:${MOCK_PORT}/cdn-files/${isFile ? 'test_table.xlsx' : 'test_img.jpg'}` });
          return;
        }
        default:
          res.statusCode = 404;
          res.end(JSON.stringify({ ret: 404, msg: `mock: no such endpoint ${req.url}` }));
      }
    });
  });
  return new Promise(resolve => server.listen(MOCK_PORT, () => resolve(server)));
}

// ---------- 主流程 ----------
async function main() {
  // 数据文件备份（结束后恢复）
  const bakBindings = backupFile(BINDINGS_FILE);
  const bakState = backupFile(STATE_FILE);
  const chartFile = path.join(MEDIA_DIR, 'test_gewe_chart_2609.png');

  // 预绑定：测试 wxid → 真实成员（走 AI 回复路径；agent-tool 的成员校验要求 id 存在于名册）
  // 会话成员用 612（真实成员，本地无既有对话上下文，测试后清理）；
  // wxid_test_member2 → 611：J 段匿名转发的接收方（仅收消息不产生对话上下文）
  fs.writeFileSync(BINDINGS_FILE, JSON.stringify({ wxid_test_member: '612', wxid_test_member2: '611' }));
  try { fs.rmSync(STATE_FILE, { force: true }); } catch {}
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  // 假图表 PNG（魔数 + 随机体；媒体端点按字节流服务，不校验图片内容）
  fs.writeFileSync(chartFile, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    Buffer.alloc(64, 7),
  ]));

  // CDN 入站媒体素材：真 JPEG（vision 模型需要真实图片）+ xlsx 表格
  const UPLOADS_DIR = path.join(DATA, 'uploads');
  mock.cdnImageBuf = fs.readFileSync(path.join(__dirname, 'test-fixture.jpg'));
  {
    const XLSX = require('xlsx');
    const ws = XLSX.utils.aoa_to_sheet([
      ['学号', '姓名', '总分', '排名'],
      ['613', '测试成员', '285', '2'],
      ['614', '测试同学', '278', '3'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '成绩');
    mock.cdnFileBuf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  }
  // 记录测试前 uploads 现状（结束后清掉新增文件，不碰用户文件）
  const uploadsBefore = new Set();
  try { for (const f of fs.readdirSync(UPLOADS_DIR)) uploadsBefore.add(f); } catch {}

  const mockServer = await startMockServer();
  console.log(`[mock] GeweChat 服务端已启动 :${MOCK_PORT}`);

  // 临时后端实例（STEWARD_ENABLED + mock GEWE_API + 回调指向本实例）
  // DSH_ENGINE=1 对齐生产：D2 走 dsh 底座 + anaxis 人设（灵枢），
  // 验证微信真人式分条回复；缺省 DEEPSEEK_API_KEY 由 index.js key 池兜底
  // CLI_API_KEY：J 段 agent-tool 直调（send_sticker）鉴权
  const backend = spawn(process.execPath, ['index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(BACKEND_PORT),
      STEWARD_ENABLED: '1',
      DSH_ENGINE: '1',
      CLI_API_KEY: 'mock-cli-key-2609',
      GEWE_API: `http://127.0.0.1:${MOCK_PORT}`,
      GEWE_CALLBACK_URL: `${BACKEND}/api/wechat/steward/callback`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let backendLog = '';
  backend.stdout.on('data', d => backendLog += d);
  backend.stderr.on('data', d => backendLog += d);

  try {
    // 等待管家上线（引擎初始化 + 扫码登录：QR → 验证码 → 成功）
    console.log('\n=== A/B. 登录（含跨省验证流程）+ 回调注册 ===');
    let status = null;
    let loginQr = null;      // type=login 阶段快照
    let verifyQr = null;     // type=verification 阶段快照
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      try {
        const r = await fetch(`${BACKEND}/api/wechat/steward/status`);
        status = await r.json();
        // 采样二维码阶段（登录码 → 验证码，上线后 404）
        try {
          const qr = await (await fetch(`${BACKEND}/api/wechat/steward/qrcode`)).json();
          if (qr.type === 'login' && !loginQr) loginQr = qr;
          if (qr.type === 'verification' && !verifyQr) verifyQr = qr;
        } catch {}
        if (status.channel && status.channel.online === true) break;
      } catch {}
      if (backend.exitCode !== null) throw new Error(`后端进程提前退出:\n${backendLog.slice(-2000)}`);
    }
    check('A1 管家上线（验证流程走完后 status=2）', !!status && status.channel && status.channel.online === true,
      status ? JSON.stringify(status.channel) : '超时');
    check('A2 appId 已持久化（getLoginQrCode 返回的 appId）', !!status && status.channel && status.channel.appId === 'wx_mock_app_1');
    check('A3 登录状态已落盘（重启可免验证）', (() => {
      try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).appId === 'wx_mock_app_1'; } catch { return false; }
    })());
    check('A4 跨省验证流程：checkLogin 返回 url → /qrcode 切换为验证码（type=verification）',
      !!verifyQr && /mockverify2609/.test(verifyQr.qrUrl || '') && /人脸/.test(verifyQr.hint || ''),
      verifyQr ? verifyQr.qrUrl : '未采样到验证码阶段');
    const qrAfterLogin = await fetch(`${BACKEND}/api/wechat/steward/qrcode`);
    check('A5 登录成功后二维码清空（/qrcode 回到 404）', qrAfterLogin.status === 404);
    check('B1 setCallback 收到 token+callbackUrl', !!mock.callback && mock.callback.token === mock.token
      && mock.callback.callbackUrl === `${BACKEND}/api/wechat/steward/callback`);
    check('B2 GeweChat testMsg 测试消息可达（回调端点 200）', mock.testMsgResponse === 200, String(mock.testMsgResponse));

    // C. 二维码端点（登录码阶段已采样）
    console.log('\n=== C. 二维码端点 ===');
    check('C1 登录码为 data URL（可直接 <img> 渲染）', !!loginQr && /^data:image\/png;base64,/.test(loginQr.qrcode || ''));
    check('C2 登录码 qrUrl 为微信扫码链接（http://weixin.qq.com/x/{uuid}）',
      !!loginQr && (loginQr.qrUrl || '').startsWith('http://weixin.qq.com/x/mock-uuid-2609'), loginQr && loginQr.qrUrl);

    // D. 入站消息 → 引擎回复 → postText 出站
    console.log('\n=== D. 入站消息 → AI 回复 → 出站（真实引擎） ===');
    const now = Math.floor(Date.now() / 1000);
    const msgPayload = {
      TypeName: 'AddMsg',
      Appid: 'wx_mock_app_1',
      Wxid: 'wxid_bot_zhixin',
      Data: {
        MsgId: 1001, NewMsgId: 9000000001, CreateTime: now,
        FromUserName: { string: 'wxid_test_member' },
        ToUserName: { string: 'wxid_bot_zhixin' },
        MsgType: 1,
        Content: { string: '你好，简单介绍一下你自己' },
      },
    };
    const cb1 = await post(`${BACKEND}/api/wechat/steward/callback`, msgPayload);
    check('D1 回调端点响应 success', cb1.status === 200 && cb1.json.success === true);
    let replyTexts = [];
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      replyTexts = mock.texts.filter(t => t.toWxid === 'wxid_test_member');
      if (replyTexts.length > 0) break;
    }
    check('D2 AI 回复经 postText 出站（appId/toWxid/ats 参数）', replyTexts.length > 0
      && replyTexts[0].appId === 'wx_mock_app_1' && 'ats' in replyTexts[0],
      replyTexts.length ? String(replyTexts[0].content || '').substring(0, 40) : '90s 内无回复');
    // 人设分条连发：自称（Anaxis/灵枢）可能出现在后续行（出站队列按真人节奏 2.5s+ 连发）→
    // 轮询等待后续行，任意一行命中即算人设生效
    if (replyTexts.length > 0 && !replyTexts.some(t => /Anaxis|灵枢/.test(String(t.content)))) {
      for (let i = 0; i < 10; i++) {
        await sleep(3000);
        replyTexts = mock.texts.filter(t => t.toWxid === 'wxid_test_member');
        if (replyTexts.some(t => /Anaxis|灵枢/.test(String(t.content)))) break;
      }
    }
    check('D3 anaxis 人设生效（Anaxis/灵枢自称，无客服腔/AI 助手）', replyTexts.length > 0
      && replyTexts.some(t => /Anaxis|灵枢/.test(String(t.content)))
      && !/AI ?助手|能帮您|有什么可以帮你/.test(replyTexts.map(t => t.content).join(' ')),
      replyTexts.length ? replyTexts.map(t => String(t.content || '').substring(0, 20)).join(' / ') : '无回复');

    // F. 好友申请（MsgType 37 XML）
    console.log('\n=== F. 好友申请自动通过 ===');
    const friendXml = '<msg fromusername="wxid_applicant_1" encryptusername="v3_020b_mock@stranger"'
      + ' fromnickname="测试申请人" content="你好，我是新同学" scene="14">'
      + '<ticket v4="v4_000b_mock@stranger"/></msg>';
    const friendPayload = {
      TypeName: 'AddMsg',
      Appid: 'wx_mock_app_1',
      Wxid: 'wxid_bot_zhixin',
      Data: {
        MsgId: 1002, NewMsgId: 9000000002, CreateTime: Math.floor(Date.now() / 1000),
        FromUserName: { string: 'fmessage' },   // 真实回调中为系统账号，申请人 wxid 在 XML 里
        ToUserName: { string: 'wxid_bot_zhixin' },
        MsgType: 37,
        Content: { string: friendXml },
      },
    };
    await post(`${BACKEND}/api/wechat/steward/callback`, friendPayload);
    let welcome = null;
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      welcome = mock.texts.find(t => t.toWxid === 'wxid_applicant_1');
      if (welcome) break;
    }
    check('F1 addContacts option=3（同意好友）+ v3/v4/scene 解析', mock.friends.length === 1
      && mock.friends[0].option === 3 && mock.friends[0].v3 === 'v3_020b_mock@stranger'
      && mock.friends[0].v4 === 'v4_000b_mock@stranger' && mock.friends[0].scene === 14,
      mock.friends.length ? JSON.stringify({ option: mock.friends[0].option, scene: mock.friends[0].scene }) : '未收到 addContacts');
    check('F2 欢迎语已发送给申请人', !!welcome && /绑定/.test(welcome.content || ''),
      welcome ? String(welcome.content).substring(0, 40) : '未发送');

    // E. 去重：同 Appid+NewMsgId 重复推送（用好友申请验证——无 AI 流式时序干扰，确定性断言）
    console.log('\n=== E. 回调去重 ===');
    const friendsBefore = mock.friends.length;
    const welcomeBefore = mock.texts.filter(t => t.toWxid === 'wxid_applicant_1').length;
    await post(`${BACKEND}/api/wechat/steward/callback`, friendPayload);   // 完全相同的重复推送
    await sleep(5000);
    check('E1 重复推送不重复处理（addContacts 不重复 + 欢迎语不重发）',
      mock.friends.length === friendsBefore
      && mock.texts.filter(t => t.toWxid === 'wxid_applicant_1').length === welcomeBefore,
      `addContacts ${friendsBefore} → ${mock.friends.length}`);

    // G. 媒体端点 + sendImage（imgUrl 公网可下载）
    console.log('\n=== G. 媒体端点 / sendImage ===');
    const mediaRes = await fetch(`${BACKEND}/api/wechat/steward/media/test_gewe_chart_2609.png`);
    const mediaBuf = Buffer.from(await mediaRes.arrayBuffer());
    check('G1 媒体端点返回 PNG（字节一致）', mediaRes.status === 200
      && (mediaRes.headers.get('content-type') || '').includes('image/png')
      && mediaBuf.length === 72 && mediaBuf[0] === 0x89);
    const notFound = await fetch(`${BACKEND}/api/wechat/steward/media/no_such_file.png`);
    check('G2 不存在的文件 → 404', notFound.status === 404);
    // 通道直发（验证 _toMediaUrl 构造 + postImage 协议 + mock 端 imgUrl 下载）
    const { GeweChannel } = require('../wechat/geweChannel');
    const ch = new GeweChannel();
    ch.online = true; ch.appId = 'wx_mock_app_1'; ch.token = mock.token;
    await ch.sendImage('wxid_target_1', chartFile);
    const imgRec = mock.images[mock.images.length - 1];
    check('G3 sendImage imgUrl 指向媒体端点（回调同源）', !!imgRec && /\/api\/wechat\/steward\/media\/test_gewe_chart_2609\.png$/.test(imgRec.imgUrl || ''), imgRec && imgRec.imgUrl);
    check('G4 GeweChat 可下载 imgUrl（200 + image/png）', imgRec && imgRec.fetchStatus === 200
      && (imgRec.contentType || '').includes('image/png'), imgRec && `${imgRec.fetchStatus} ${imgRec.contentType}`);

    // H. 免验证重登（checkOnline，appId 复用）
    console.log('\n=== H. 免验证重登 ===');
    mock.online = true;
    const ch2 = new GeweChannel();   // 从磁盘状态加载 appId/token
    const r2 = await ch2.start();
    check('H1 checkOnline 直接上线（无需扫码）', r2.online === true && ch2.online === true);
    check('H2 checkOnline 携带持久化 appId', mock.checkOnlineCalls.includes('wx_mock_app_1'));
    check('H3 上线后重新注册回调', mock.setCallbackCalls >= 2, String(mock.setCallbackCalls));
    await ch2.stop();

    // I. 云托管模式（GeWeAPI 商业服务：GEWE_TOKEN + 前缀 /gewe/v2/api + /login/setCallback）
    // 用子进程隔离模块级环境变量（父进程已按自部署模式 require 过通道模块）；
    // 必须用异步 spawn——spawnSync 会阻塞父进程事件循环，mock 服务端就无法应答子进程
    console.log('\n=== I. 云托管模式（GeWeAPI） ===');
    const getTokenBefore = mock.getTokenIdCalls;
    const cloudScript = `
      const m = require('./wechat/geweChannel');
      (async () => {
        const ch = new m.GeweChannel();
        const token = await ch._ensureToken(true);
        const online = await ch._api('/login/checkOnline', { appId: ch.appId });
        await ch._api(m.SET_CALLBACK_PATH, { token, callbackUrl: 'http://cloud-cb-probe' });
        console.log(JSON.stringify({ base: m.GEWE_BASE, cloud: m.IS_CLOUD, cb: m.SET_CALLBACK_PATH, token, online, appId: ch.appId }));
      })().catch(e => { console.error('PROBE_ERR:' + e.message); process.exit(1); });
    `;
    const cloudOut = await new Promise((resolve) => {
      const cp = spawn(process.execPath, ['-e', cloudScript], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          GEWE_MODE: 'cloud',
          GEWE_API: `http://127.0.0.1:${MOCK_PORT}`,
          GEWE_TOKEN: mock.token,
          GEWE_CALLBACK_URL: 'http://cloud-cb-probe',
          GEWE_APP_ID: 'wx_cloud_probe_app',   // 控制台在线登录注入的 appId（应覆盖磁盘 state）
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      cp.stdout.on('data', d => out += d);
      cp.stderr.on('data', d => err += d);
      const timer = setTimeout(() => cp.kill(), 60000);
      cp.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
    });
    const probeLine = (cloudOut.out || '').trim().split('\n').pop() || '';
    let probe = {};
    try { probe = JSON.parse(probeLine); } catch {}
    check('I1 云模式接口前缀 /gewe/v2/api', /\/gewe\/v2\/api$/.test(probe.base || ''), probe.base || (cloudOut.err || probeLine));
    check('I2 云模式判定 + 回调注册路径 /login/setCallback', probe.cloud === true && probe.cb === '/login/setCallback',
      JSON.stringify({ cloud: probe.cloud, cb: probe.cb }));
    check('I3 token 取自 GEWE_TOKEN（云模式不调 getTokenId）', probe.token === mock.token && mock.getTokenIdCalls === getTokenBefore,
      `token=${probe.token}，getTokenId ${getTokenBefore}→${mock.getTokenIdCalls}`);
    check('I4 checkOnline 经 /gewe 前缀路由（在线）', probe.online === true, String(probe.online));
    check('I5 setCallback 走云路径（token + callbackUrl 透传）',
      !!mock.cloudCallback && mock.cloudCallback.token === mock.token && mock.cloudCallback.callbackUrl === 'http://cloud-cb-probe',
      JSON.stringify(mock.cloudCallback));
    check('I6 GEWE_APP_ID 注入优先于磁盘 state（控制台在线登录的 appId）',
      probe.appId === 'wx_cloud_probe_app' && mock.checkOnlineCalls.includes('wx_cloud_probe_app'),
      `appId=${probe.appId}`);

    // J. 入站媒体（图片 vision / 文件解析）+ 表情包 + 匿名附件转发
    console.log('\n=== J. 入站媒体 + 表情包 + 匿名转发 ===');
    const imgXml = '<msg><img aeskey="aes_mock_img_2609" encryver="1" cdnthumbaeskey="aes_thumb"'
      + ' cdnthumburl="3057020100thumb" cdnmidimgurl="3057020100midimg" length="61207"'
      + ' md5="md5mock" cdnhdimgurl=""/></msg>';
    const textsBeforeImg = mock.texts.filter(t => t.toWxid === 'wxid_test_member').length;
    await post(`${BACKEND}/api/wechat/steward/callback`, {
      TypeName: 'AddMsg', Appid: 'wx_mock_app_1', Wxid: 'wxid_bot_zhixin',
      Data: {
        MsgId: 1003, NewMsgId: 9000000003, CreateTime: Math.floor(Date.now() / 1000),
        FromUserName: { string: 'wxid_test_member' },
        ToUserName: { string: 'wxid_bot_zhixin' },
        MsgType: 3,
        Content: { string: imgXml },
      },
    });
    let imgReplied = false;
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      if (mock.texts.filter(t => t.toWxid === 'wxid_test_member').length > textsBeforeImg) { imgReplied = true; break; }
    }
    check('J1 图片消息：downloadCdn 参数（aesKey/fileId/type=2 常规图）', mock.cdnDownloads.length >= 1
      && mock.cdnDownloads[0].aesKey === 'aes_mock_img_2609'
      && mock.cdnDownloads[0].fileId === '3057020100midimg' && String(mock.cdnDownloads[0].type) === '2',
      JSON.stringify(mock.cdnDownloads[0] || {}));
    let newUploads = [];
    try { newUploads = fs.readdirSync(UPLOADS_DIR).filter(f => !uploadsBefore.has(f)); } catch {}
    check('J2 图片已落盘 data/uploads/（字节与 CDN 一致）', newUploads.some(f => {
      try { return fs.readFileSync(path.join(UPLOADS_DIR, f)).equals(mock.cdnImageBuf); } catch { return false; }
    }), `${newUploads.length} 个新文件`);
    check('J3 vision 会话回复（AI 看图后分条回复）', imgReplied);

    // J4 表情包：agent-tool 直调 send_sticker（多张：逗号分隔）→ postImage 出站（imgUrl 可下载）
    const stickerRes = await fetch(`${BACKEND}/api/internal/agent-tool`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': 'mock-cli-key-2609' },
      body: JSON.stringify({ action: 'send_sticker', callerId: '612', sticker: 'sad,hooray' }),
    });
    const stickerJson = await stickerRes.json().catch(() => ({}));
    let stickerImg = null;
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      stickerImg = [...mock.images].reverse()
        .find(t => t.toWxid === 'wxid_test_member' && /\/api\/wechat\/steward\/media\//.test(t.imgUrl || ''));
      if (stickerImg && stickerImg.fetchStatus === 200) break;
    }
    check('J4 表情包发送（send_sticker → postImage，imgUrl 可下载）',
      stickerRes.status === 200 && stickerJson.success === true
      && !!stickerImg && stickerImg.fetchStatus === 200,
      stickerJson.error || (stickerImg && String(stickerImg.fetchStatus)) || '未出站');

    // J5/J6 文件：MsgType 49 appmsg（xlsx）→ downloadCdn(type=5) → SheetJS 解析进会话
    const textsBeforeFile = mock.texts.filter(t => t.toWxid === 'wxid_test_member').length;
    const fileXml = '<msg><appmsg appid="" sdkver="0"><title>成绩表.xlsx</title><des></des>'
      + '<action>view</action><type>6</type><content></content><url></url>'
      + '<appattach><totallen>5290</totallen><attachid>@cdn_3057020100attach</attachid>'
      + '<fileext>xlsx</fileext><cdnattachurl>3057020100cdnattach</cdnattachurl>'
      + '<aeskey>aes_mock_file_2609</aeskey></appattach></appmsg>'
      + '<fromusername>wxid_test_member</fromusername></msg>';
    await post(`${BACKEND}/api/wechat/steward/callback`, {
      TypeName: 'AddMsg', Appid: 'wx_mock_app_1', Wxid: 'wxid_bot_zhixin',
      Data: {
        MsgId: 1004, NewMsgId: 9000000004, CreateTime: Math.floor(Date.now() / 1000),
        FromUserName: { string: 'wxid_test_member' },
        ToUserName: { string: 'wxid_bot_zhixin' },
        MsgType: 49,
        Content: { string: fileXml },
      },
    });
    let fileReplied = false;
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      if (mock.texts.filter(t => t.toWxid === 'wxid_test_member').length > textsBeforeFile) { fileReplied = true; break; }
    }
    const lastCdn = mock.cdnDownloads[mock.cdnDownloads.length - 1] || {};
    check('J5 文件消息：downloadCdn type=5 + suffix=xlsx', mock.cdnDownloads.length >= 2
      && String(lastCdn.type) === '5' && lastCdn.suffix === 'xlsx' && lastCdn.aesKey === 'aes_mock_file_2609',
      JSON.stringify(lastCdn));
    check('J6 xlsx 解析进会话（AI 收到表格内容并回复）', fileReplied);
    await sleep(10000);   // 等文件回合收尾，避免 J7 撞 isProcessing

    // J7 匿名附件转发（E2E：AI 从上下文取 mediaId 调 class_send_message）
    await post(`${BACKEND}/api/wechat/steward/callback`, {
      TypeName: 'AddMsg', Appid: 'wx_mock_app_1', Wxid: 'wxid_bot_zhixin',
      Data: {
        MsgId: 1005, NewMsgId: 9000000005, CreateTime: Math.floor(Date.now() / 1000),
        FromUserName: { string: 'wxid_test_member' },
        ToUserName: { string: 'wxid_bot_zhixin' },
        MsgType: 1,
        Content: { string: '把刚才那张图片匿名转发给611，不要说是我发的' },
      },
    });
    let anonText = null, anonImg = null;
    const t2 = 'wxid_test_member2';
    for (let i = 0; i < 40; i++) {
      await sleep(3000);
      // 自然口吻后系统不再加「托我转达」前缀——校验到达且不泄露发送者身份（周祎宸/612）
      const texts = mock.texts.filter(t => t.toWxid === t2);
      const last = texts[texts.length - 1];
      if (last && !/周祎宸|托我转达|612/.test(String(last.content || ''))) anonText = last;
      anonImg = mock.images.find(t => t.toWxid === t2);
      if (anonText && anonImg) break;
    }
    check('J7 匿名附件转发（AI 调 send_message mediaId+anonymous → 611 收不露身份文本+图片）',
      !!anonText && !!anonImg,
      anonText ? String(anonText.content).substring(0, 30) : '120s 内未完成转发');
  } finally {
    backend.kill();
    mockServer.close();
    // 恢复数据文件
    restoreFile(BINDINGS_FILE, bakBindings);
    restoreFile(STATE_FILE, bakState);
    try { fs.rmSync(chartFile, { force: true }); } catch {}
    // 清理测试会话上下文（成员 612 借用了真实账号槽位：dsh 磁盘日志 + conversation_memory）
    try { fs.rmSync(path.join(DATA, 'conversation_memory', '612_dsh.json'), { force: true }); } catch {}
    try {
      const sessionsRoot = path.join(__dirname, '..', 'agent', 'dsh', 'home', 'sessions');
      for (const proj of fs.readdirSync(sessionsRoot)) {
        fs.rmSync(path.join(sessionsRoot, proj, 'member-612'), { recursive: true, force: true });
      }
    } catch {}
    // uploads：只删测试新增的文件（不碰用户媒体）
    try {
      for (const f of fs.readdirSync(UPLOADS_DIR)) {
        if (!uploadsBefore.has(f)) fs.rmSync(path.join(UPLOADS_DIR, f), { force: true });
      }
    } catch {}
    // 等后端进程退出释放端口
    await sleep(1500);
  }
  const passed = results.filter(Boolean).length;
  console.log(`\n========== 结果：${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => {
  console.error('测试脚本异常:', e.message);
  process.exit(1);
});
