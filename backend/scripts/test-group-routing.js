/**
 * test-group-routing.js —— 群聊路由核心逻辑校验（不启动服务）
 * 1. _parseGroupCaller：复合 callerId（g:群id:学号）解析
 * 2. 群消息正文剥离：Content 前缀 "wxid:\n正文"
 * 3. 触发判定：@ / 唤醒词 / 唤醒词剥离
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const backendDir = path.join(__dirname, '..');

// ---- 1. _parseGroupCaller（提取生产函数）----
const src = fs.readFileSync(path.join(backendDir, 'index.js'), 'utf8');
const m = src.match(/function _parseGroupCaller\(callerId\) \{[\s\S]*?\n\}/);
assert.ok(m, 'index.js 中找不到 _parseGroupCaller 函数');
const _parseGroupCaller = eval(`(${m[0]})`);

const roomId = '12345678901@chatroom';
const deep = _parseGroupCaller(`g:${roomId}:612`);
assert.deepStrictEqual(deep, { chatroomId: roomId, memberId: '612' });
assert.strictEqual(_parseGroupCaller('612'), null);                    // 普通成员
assert.strictEqual(_parseGroupCaller('admin-张三'), null);             // 管理员上下文
assert.strictEqual(_parseGroupCaller('g:612'), null);                  // 缺群后缀
assert.strictEqual(_parseGroupCaller('g:xxx@chatroom:'), null);        // 空成员
assert.strictEqual(_parseGroupCaller('g::612'), null);                 // 空群
assert.strictEqual(_parseGroupCaller(null), null);
console.log('✓ _parseGroupCaller 复合 callerId 解析 7/7');

// ---- 2. 群消息正文剥离（steward._onGroupMessage 同款逻辑）----
const strip = (content, senderWxid) => {
  let text = String(content || '');
  if (senderWxid) {
    const idx = text.indexOf('\n');
    if (idx !== -1 && text.substring(0, idx).replace(/:$/, '') === senderWxid) {
      text = text.substring(idx + 1);
    }
  }
  return text.trim();
};
assert.strictEqual(strip('wxid_abc123:\n今天谁值日', 'wxid_abc123'), '今天谁值日');
assert.strictEqual(strip('wxid_abc123\n今天谁值日', 'wxid_abc123'), '今天谁值日');   // 无冒号变体
assert.strictEqual(strip('wxid_other:\n别的前缀', 'wxid_abc123'), 'wxid_other:\n别的前缀'); // 前缀不匹配不动
assert.strictEqual(strip('@Anaxis 今天吃什么', ''), '@Anaxis 今天吃什么');           // 无发送者不动
console.log('✓ 群消息正文剥离 4/4');

// ---- 3. 触发判定 + 唤醒词剥离（微信名称 Anaxis；不识别灵枢）----
const isAwake = (text, isAtBot) => isAtBot || /anaxis/i.test(text);
assert.strictEqual(isAwake('@Anaxis 帮我查个东西', true), true);
assert.strictEqual(isAwake('Anaxis在吗', false), true);
assert.strictEqual(isAwake('今天谁值日', false), false);
assert.strictEqual(isAwake('灵枢在吗', false), false);                              // 灵枢不再触发
const stripWake = (text) => text.replace(/@?anaxis\s*/gi, (m, off) => (off === 0 ? '' : m)).trim() || text;
assert.strictEqual(stripWake('@Anaxis 帮我查个东西'), '帮我查个东西');
assert.strictEqual(stripWake('Anaxis在吗'), '在吗');
assert.strictEqual(stripWake('今天天气不错'), '今天天气不错');
console.log('✓ 触发判定 + 唤醒词剥离 6/6');

// ---- 4. 群日程通知开关指令匹配（steward._onGroupMessage 同款正则）----
assert.ok(/^日程通知(开启|打开)$/.test('日程通知开启'));
assert.ok(/^日程通知(开启|打开)$/.test('日程通知打开'));
assert.ok(!/^日程通知(开启|打开)$/.test('日程通知关闭'));
assert.ok(/^日程通知关闭$/.test('日程通知关闭'));
assert.ok(!/^日程通知关闭$/.test('日程通知开'));
console.log('✓ 群日程通知开关指令 5/5');

// ---- 5. 最近群消息轻度注入（DshAgentEngine._buildPrompt 同款逻辑：全量，单条截断 300）----
const compressRecent = (recent) => {
  if (!Array.isArray(recent) || recent.length === 0) return null;
  const lines = [];
  for (const r of recent) {
    if (!r || !r.text) continue;
    lines.push(`${r.sender}：${String(r.text).substring(0, 300)}`);
  }
  return lines.length > 0 ? lines : null;
};
// 全量注入（超限靠 dsh 原生上下文压缩，与私聊同策略）
const recent = [
  { sender: '张三', text: '明天早操几点' },
  { sender: '李四', text: '六点半吧' },
  { sender: '王五', text: '又查内务…' },
];
assert.deepStrictEqual(compressRecent(recent), ['张三：明天早操几点', '李四：六点半吧', '王五：又查内务…']);
// 顺序保持（不倒序）
assert.strictEqual(compressRecent(recent)[0], '张三：明天早操几点');
// 超长单条截断 300 字
const longText = 'x'.repeat(500);
const out = compressRecent([{ sender: 'A', text: longText }]);
assert.strictEqual(out[0].length, 'A：'.length + 300);
// 空安全
assert.strictEqual(compressRecent([]), null);
assert.strictEqual(compressRecent(null), null);
console.log('✓ 最近群消息全量注入（单条截断） 5/5');

// ---- 6. 群聊 callerId 统一收口（index.js dispatch 入口同款逻辑）----
const ADMIN_IDS = ['612'];
const isAdminCaller = (id) => ADMIN_IDS.includes(String(id));
const GROUP_ROUTED_ACTIONS = new Set(['send_sticker', 'send_web_image', 'send_message', 'group_coverage', 'submit_schedule', 'read_file', 'send_file']);
const gate = (action, callerId) => {
  const gc = _parseGroupCaller(callerId);
  if (!gc || GROUP_ROUTED_ACTIONS.has(action)) return { pass: true, normalized: callerId };
  if (!isAdminCaller(gc.memberId)) return { pass: false };
  return { pass: true, normalized: gc.memberId };
};
// 普通成员群内调非路由工具 → 拒（引导私聊）
assert.deepStrictEqual(gate('submit_score', `g:${roomId}:601`), { pass: false });
assert.deepStrictEqual(gate('cli_gateway', `g:${roomId}:601`), { pass: false });
// 管理员群内调非路由工具 → 放行且归一化
assert.deepStrictEqual(gate('submit_score', `g:${roomId}:612`), { pass: true, normalized: '612' });
assert.deepStrictEqual(gate('web_search', `g:${roomId}:612`), { pass: true, normalized: '612' });
// 路由工具保留复合格式（群回发路由需要）
assert.deepStrictEqual(gate('send_sticker', `g:${roomId}:601`), { pass: true, normalized: `g:${roomId}:601` });
assert.deepStrictEqual(gate('submit_schedule', `g:${roomId}:612`), { pass: true, normalized: `g:${roomId}:612` });
// 私聊 callerId 不受影响
assert.deepStrictEqual(gate('submit_score', '601'), { pass: true, normalized: '601' });
console.log('✓ 群聊 callerId 统一收口 7/7');

// ---- 7. 群消息去重水位（steward._onGroupMessage 同款逻辑：只注入未 seen 的）----
const dedupe = (buf) => {
  const unseen = buf.filter(e => !e.seen);
  const recent = unseen.slice(0, -1);
  for (const e of buf) e.seen = true;
  return recent;
};
// 首次触发：3 条全注入（当前触发消息本身进 session，不含在内）
const buf1 = [{ sender: 'A', text: '1', seen: false }, { sender: 'B', text: '2', seen: false }, { sender: 'C', text: '3', seen: false }];
assert.deepStrictEqual(dedupe(buf1).map(e => e.text), ['1', '2']);
// 第二次触发（无新消息）：不再重复注入
const buf2 = [{ sender: 'A', text: '1', seen: true }, { sender: 'B', text: '2', seen: true }, { sender: 'C', text: '3', seen: true }];
assert.deepStrictEqual(dedupe(buf2), []);
// 新消息到达（未触发入缓冲）：下一条触发时只注入那条未触发的新消息
const buf3 = [...buf2, { sender: 'D', text: '4', seen: false }, { sender: 'E', text: '5', seen: false }];
const r3 = dedupe(buf3).map(e => e.text);
assert.deepStrictEqual(r3, ['4']);   // E 是触发消息（slice 掉），D 是未触发的新消息 → 注入
assert.strictEqual(buf3[0].seen, true);
assert.strictEqual(buf3[3].seen, true);
console.log('✓ 群消息去重水位 3/3');

// ---- 8. 文件 lazy 元信息解析（steward._fileMetaFromXml 同款逻辑）----
const fileMetaFromXml = (xml) => {
  try {
    const u = (s) => String(s || '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
    const el = (name) => {
      const m = String(xml).match(new RegExp(`<${name}>([^<]*)</${name}>`));
      return m ? u(m[1]) : '';
    };
    const fileExt = el('fileext');
    const cdnUrl = el('cdnattachurl') || el('attachid');
    if (!fileExt || !cdnUrl) return null;
    const title = el('title') || `file.${fileExt}`;
    return { fileName: title, fileExt: fileExt.toLowerCase() };
  } catch (e) { return null; }
};
const fileXml = '<msg><appmsg><title>名单.xlsx</title><appattach><fileext>xlsx</fileext><cdnattachurl>abc123</cdnattachurl></appattach></appmsg></msg>';
assert.deepStrictEqual(fileMetaFromXml(fileXml), { fileName: '名单.xlsx', fileExt: 'xlsx' });
// title 缺省 → 兜底 file.ext
assert.deepStrictEqual(fileMetaFromXml('<msg><appmsg><appattach><fileext>pdf</fileext><cdnattachurl>cd</cdnattachurl></appattach></appmsg></msg>'),
  { fileName: 'file.pdf', fileExt: 'pdf' });
// 非文件类 appmsg（无 CDN 参数）→ null
assert.strictEqual(fileMetaFromXml('<msg><appmsg><title>链接</title></appmsg></msg>'), null);
// 空/异常 → null
assert.strictEqual(fileMetaFromXml(''), null);
console.log('✓ 文件 lazy 元信息解析 4/4');

console.log('全部通过');
