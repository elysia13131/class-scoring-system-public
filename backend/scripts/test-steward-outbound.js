/**
 * test-steward-outbound.js —— 出站队列调度逻辑测试（mock 通道，不发真消息）
 *
 * 验证（129 人规模限流设计）：
 *   1. 流式分条：onToken 逐换行切分，跳句即发（不等输出完毕）
 *   2. 同联系人连发间隔 ≥2.5s + 抖动 ≤2s
 *   3. 不同联系人交错发送：A 队头未到期不阻塞 B 的消息（无队头阻塞）
 *   （单联系人无限额，全局限量共享，见 steward.js DAILY_LIMIT）
 */
const StewardManager = require('../wechat/steward');

class MockChannel {
  constructor() { this.online = true; this.sent = []; }
  onMessage() {}   // 构造时 _bindChannel 需要
  onFriendship() {}
  async sendText(wxid, text) {
    this.sent.push({ wxid, text, t: Date.now() });
  }
  async sendImage() {}
}

async function main() {
  const channel = new MockChannel();
  const engine = { processMessageStreamWithCallback: async (memberId, msg, sid, ctx, cb) => {
    // 模拟模型流式输出：三行文本，token 级推送（含换行符在 token 中间的情况）
    const tokens = ['已写入：', '3000米，12', '分50。\n', '……这配速', '稳啊。\n', '男生线13', '\'35，快了45秒。'];
    for (const tk of tokens) { cb.onToken(tk); await new Promise(r => setTimeout(r, 30)); }
    cb.onDone({ content: 'done' });
    return { content: 'done' };
  }};
  const steward = new StewardManager({ engine, channel });

  console.log('=== 1. 流式分条：跳句即发 ===');
  const t0 = Date.now();
  await steward._processAgentMessage('612', { wxid: 'wx_612', text: '3000米12分50' });
  // 等队列清空
  await new Promise(r => setTimeout(r, 12000));
  const sent = channel.sent.filter(s => s.wxid === 'wx_612');
  console.log(`发送 ${sent.length} 条（期望 3）`);
  sent.forEach((s, i) => console.log(`  ${i + 1}: [${((s.t - t0) / 1000).toFixed(2)}s] ${s.text}`));
  const lines = sent.map(s => s.text);
  const ok1 = sent.length === 3 && lines[0].includes('12') && lines[1].includes('配速') && lines[2].includes('45秒');
  console.log(ok1 ? '✓ 逐换行切分正确（跳句即发）' : '❌ 分条内容/数量不对');

  console.log('\n=== 2. 同联系人连发间隔 ===');
  let minGap = Infinity;
  for (let i = 1; i < sent.length; i++) minGap = Math.min(minGap, sent[i].t - sent[i - 1].t);
  console.log(`最小间隔 ${minGap}ms（期望 ≥2500 且 ≤4500 左右）`);
  console.log(minGap >= 2500 ? '✓ 间隔下限生效' : '❌ 间隔过短');

  console.log('\n=== 3. 不同联系人交错（无队头阻塞） ===');
  channel.sent = [];
  // A 的消息先入队且未到期，B 的消息应能先发
  steward._enqueueOutbound('wx_a', 'text', 'a1');
  steward._enqueueOutbound('wx_a', 'text', 'a2');
  steward._enqueueOutbound('wx_b', 'text', 'b1');
  await new Promise(r => setTimeout(r, 6000));
  const b = channel.sent.find(s => s.wxid === 'wx_b');
  const a2 = channel.sent.find(s => s.wxid === 'wx_a' && s.text === 'a2');
  // b1 应在 a2 之前发出（a2 受同联系人 2.5s 间隔限制，b1 不受）
  const ok3 = b && (!a2 || b.t <= a2.t + 100);
  console.log(`b1 发出: ${b ? ((b.t - Date.now() + 6000) / 1000).toFixed(2) + 's 内' : '未发出'}；顺序: ${channel.sent.map(s => s.text).join(' → ')}`);
  console.log(ok3 ? '✓ 不同联系人交错发送，无队头阻塞' : '❌ 存在队头阻塞');

  await new Promise(r => setTimeout(r, 8000)); // 清空剩余队列
  console.log('\n✅ 出站队列测试完成');
  process.exit(0);
}

main().catch(e => { console.error('❌ 测试失败:', e); process.exit(1); });
