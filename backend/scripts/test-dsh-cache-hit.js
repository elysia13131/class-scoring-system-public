/**
 * test-dsh-cache-hit.js —— DeepSeek 前缀缓存命中实测
 *
 * 背景：dsh harness 的成本优势核心是请求前缀字节级稳定（稳定系统提示 + 稳定工具目录 +
 * append-only 历史），使 DeepSeek 服务端 prefix cache 持续命中（缓存命中 token 价格 ≈ 1/10）。
 *
 * 本脚本直连 https://api.deepseek.com/chat/completions（与 dsh-llm-deepseek 同端点同模型），
 * 模拟两种请求形状量化差异：
 *   A（dsh 形状）：固定 system + 逐轮追加消息 → 第 2/3 轮应大量 prompt_cache_hit_tokens
 *   B（反例）：每轮消息里重复拼接系统提示且前缀漂移 → 命中显著下降
 *
 * 注：需 DEEPSEEK_API_KEY（缺省用引擎测试同款 key）。工具 schema 不在本测试范围
 * （dsh 真实链路里工具目录跨模式恒定，见 dsh-base cordis.patch.yml 的
 * "request-cache stability" 注释）。
 */
if (!process.env.DEEPSEEK_API_KEY) {
  process.env.DEEPSEEK_API_KEY = 'YOUR_DEEPSEEK_API_KEY';
}
const KEY = process.env.DEEPSEEK_API_KEY;
const MODEL = process.env.DSH_MODEL || 'deepseek-v4-flash';
const URL = 'https://api.deepseek.com/chat/completions';

const SYSTEM = [
  '你是班级管家「小智」，正在微信上与周子涵（学号 612，丁丕硕班）私聊。',
  '当前成员学号：612。工具调用时以该学号作为身份，只能查询/操作该成员自己的数据。',
  '敏感操作必须先向用户索要管理员密码。回复口语化、简短。',
].join('\n');

async function chat(messages) {
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, messages, stream: false, max_tokens: 32 }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  const json = await res.json();
  const u = json.usage || {};
  return {
    content: json.choices?.[0]?.message?.content || '',
    hit: u.prompt_cache_hit_tokens ?? 0,
    miss: u.prompt_cache_miss_tokens ?? 0,
  };
}

function report(label, r) {
  const total = r.hit + r.miss;
  const rate = total > 0 ? (r.hit / total * 100).toFixed(1) : '0.0';
  console.log(`  ${label}: hit=${r.hit} miss=${r.miss} 命中率=${rate}%`);
}

async function main() {
  console.log(`模型: ${MODEL}（dsh 同款 deepseek-official 端点）\n`);

  // ---- A：dsh 请求形状（固定 system + append-only 追加）----
  console.log('A. dsh 形状：固定 system，逐轮追加（append-only）');
  const histA = [{ role: 'system', content: SYSTEM }];
  const r1 = await chat(histA); report('第1轮（冷启动）', r1);
  histA.push({ role: 'user', content: '用户消息：今天有什么安排？' }, { role: 'assistant', content: '今天下午有体能训练。' });
  const r2 = await chat(histA); report('第2轮（追加历史）', r2);
  histA.push({ role: 'user', content: '用户消息：那明天呢？' }, { role: 'assistant', content: '明天上午是自习。' });
  const r3 = await chat(histA); report('第3轮（追加历史）', r3);

  // ---- B：反例：每轮 user 消息前拼系统提示（前缀漂移 + 历史膨胀）----
  console.log('\nB. 反例：系统提示拼进每轮 user 消息（模拟修复前的注入方式）');
  const histB = [];
  const b1 = await chat([{ role: 'user', content: `${SYSTEM}\n\n用户消息：今天有什么安排？` }]);
  report('第1轮', b1);
  histB.push(
    { role: 'user', content: `${SYSTEM}\n\n用户消息：今天有什么安排？` },
    { role: 'assistant', content: '今天下午有体能训练。' },
    { role: 'user', content: `${SYSTEM}\n\n用户消息：那明天呢？` },
  );
  const b2 = await chat(histB); report('第2轮', b2);
  histB.push({ role: 'assistant', content: '明天上午是自习。' }, { role: 'user', content: `${SYSTEM}\n\n用户消息：后天呢？` });
  const b3 = await chat(histB); report('第3轮', b3);

  console.log('\n结论：A 第 2/3 轮 hit 应显著 > 0（历史全部命中缓存）；');
  console.log('B 因第 2 条 user 消息起前缀与缓存不一致，中段历史 miss（且每轮多耗一份系统提示 token）。');
  console.log('（注：B 形状的历史在写入后同样稳定，若继续追加同形状消息，后续轮也会命中——');
  console.log('真正持续 miss 的是"每轮改写历史/重排消息"的形状；B 的固定代价是历史里重复 N 份系统提示。）');
}

main().catch((e) => { console.error('❌ 测试失败:', e.message); process.exit(1); });
