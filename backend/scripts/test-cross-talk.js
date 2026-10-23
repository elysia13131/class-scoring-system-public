/**
 * test-cross-talk.js —— 跨会话（私聊↔群聊）发送基础逻辑单测
 * 1. listMemberGroups：成员所在群反查（{ts,map} 缓存 + reverse）
 * 2. memberName 兜底
 * 3. _resolveGroupAt：出站文本 @昵称 → 群成员 wxid（真实艾特）
 * 4. 文本分段（换行 → 多条；逗号不被拆开——自然语言分段语义）
 *
 * 运行：node scripts/test-cross-talk.js
 */
const assert = require('assert');
const path = require('path');
const StewardManager = require('../wechat/steward.js');

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? '✓' : '❌'} ${name}${detail !== undefined && detail !== '' ? ' → ' + detail : ''}`);
}

const seg = (text) => String(text || '').trim().split('\n').map(s => s.trim()).filter(Boolean);

(async () => {
  try {
    const engineStub = { isProcessing: () => false };
    const st = new StewardManager({ engine: engineStub });
    st.bindings = { wxid_a: '612', wxid_b: '703', wxid_c: '801' };
    st.reverse = { '612': 'wxid_a', '703': 'wxid_b', '801': 'wxid_c' };
    st.groups = {};   // 隔离真实群配置（候选群以缓存为准）
    const now = Date.now();
    st._groupMembers = new Map([
      ['111@chatroom', { ts: now, map: new Map([['wxid_a', '周祎宸'], ['wxid_b', '张三']]) }],
      ['222@chatroom', { ts: now, map: new Map([['wxid_a', '周祎宸'], ['wxid_c', '李四']]) }],
      ['333@chatroom', { ts: now, map: new Map([['wxid_b', '张三'], ['wxid_d', '王五']]) }],   // wxid_d 未绑定
    ]);

    // 1. 成员 → 所在群
    const g1 = await st.listMemberGroups('612');
    check('612 在 111/222 两群', g1.length === 2
      && g1.every(g => ['111@chatroom', '222@chatroom'].includes(g.chatroomId))
      && g1[0].label.length > 0, g1.map(g => g.chatroomId).join('|'));
    const g2 = await st.listMemberGroups('703');
    check('703 在 111/333 两群', g2.length === 2
      && g2.every(g => ['111@chatroom', '333@chatroom'].includes(g.chatroomId)), g2.map(g => g.chatroomId).join('|'));
    const g3 = await st.listMemberGroups('999');
    check('未加入任何已知群 → 空列表', g3.length === 0);
    // 清空缓存后（未入过群）应为空
    st._groupMembers = new Map();
    const g4 = await st.listMemberGroups('612');
    check('群缓存为空 → 空列表', g4.length === 0);

    // 2. memberName 兜底
    st._findMemberById = (id) => id === '612' ? { name: '周祎宸' } : null;
    check('memberName 命中返回姓名', st.memberName('612') === '周祎宸');
    check('memberName 未命中返回学号', st.memberName('999') === '999');

    // 3. _resolveGroupAt：@昵称 → wxid（真实艾特）
    st._groupMembers = new Map([
      ['111@chatroom', { ts: Date.now(), map: new Map([['wxid_a', '周祎宸'], ['wxid_b', '张三'], ['wxid_bot', 'Anaxis']]) }],
    ]);
    const r1 = await st._resolveGroupAt('111@chatroom', '@张三 你周六有空吗');
    check('精确匹配群昵称 → 返回该 wxid', r1.length === 1 && r1[0] === 'wxid_b', r1.join(','));
    const r2 = await st._resolveGroupAt('111@chatroom', '大家觉得呢 @周祎宸 @李四');
    check('只命中在群的名字（李四不在 → 忽略）', r2.length === 1 && r2[0] === 'wxid_a', r2.join(','));
    const r3 = await st._resolveGroupAt('111@chatroom', '我回来了 @Anaxis');
    check('艾特管家自己 → 不算真艾特', r3.length === 0);
    const r4 = await st._resolveGroupAt('111@chatroom', '今天天气不错，没人被艾特');
    check('无 @昵称 → 空', r4.length === 0);
    const r5 = await st._resolveGroupAt('wxid_a', '@张三 私聊不算艾特');
    check('私聊会话不解析 @ → 空', r5.length === 0);
    const r6 = await st._resolveGroupAt('111@chatroom', '@张三 @张三 重复去重');
    check('同一人被 @ 多次 → 只返回一次', r6.length === 1 && r6[0] === 'wxid_b', r6.join(','));

    // 4. 文本分段：换行拆多条、逗号保留
    const a = seg('今天真累呀');
    check('单句不分段', a.length === 1 && a[0] === '今天真累呀');
    const b = seg('群里有没有人周六有空？\n我请喝奶茶');
    check('换行拆两段', b.length === 2 && b[1] === '我请喝奶茶');
    const c = seg('饭点了，去食堂，人多吗');
    check('逗号不被拆开', c.length === 1 && c[0] === '饭点了，去食堂，人多吗');
    const d = seg('  \n  ');
    check('空文本 → 空数组', d.length === 0);

    const pass = results.filter(Boolean).length;
    console.log(`\n${pass}/${results.length} 通过`);
    process.exit(pass === results.length ? 0 : 1);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
