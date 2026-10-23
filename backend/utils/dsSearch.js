/**
 * dsSearch —— DeepSeek 官方联网搜索（网页文本）。
 *
 * 协议与 @deepseek-ai/dsh-web-search-deepseek 完全一致：调用 Anthropic 兼容
 * Messages API（api.deepseek.com/anthropic/v1）+ 原生 web_search_20250305
 * server tool。搜索由 DeepSeek 官方完成（语义甄别/多轮子搜索），质量显著高于
 * 本地无 key 的 Bing/DDG HTML 爬虫；代价是每次搜索消耗一次模型调用。
 *
 * 供 AI 工具链（agent-tool action=web_search）作为文本搜索第一引擎；失败、
 * 超时或无来源时由上层降级到 utils/webSearch.js（Bing→DDG 兜底）。
 * 官方联网不返回图片直链 —— 图片搜索仍走 webSearch.imageSearch。
 */

/** 默认端点（与 dsh-web-search-deepseek 相同：非 chat-completions base） */
const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic/v1';
/** 默认模型（与 dsh 官方搜索 provider 一致；比 vision 变体便宜） */
const DEFAULT_MODEL = 'deepseek-v4-flash';
/** 单次搜索生成上限：只需"甄别结论 + 来源引用"，2048 足够且省钱 */
const DEFAULT_MAX_TOKENS = 2048;
/** 一次调用内最多子搜索次数（多轮甄别冲突信息用；dsh 默认 5） */
const DEFAULT_MAX_USES = 3;
/** 含模型生成的总预算；超时抛错由上层降级 */
const DEFAULT_TIMEOUT_MS = 25000;

/** text block 里的 citation（url → cited_text），是 snippet 的唯一来源 */
function citationSnippets(blocks) {
  const map = new Map();
  for (const block of blocks) {
    if (block.type !== 'text') continue;
    for (const cite of block.citations ?? []) {
      if (cite.url && cite.cited_text && !map.has(cite.url)) map.set(cite.url, cite.cited_text);
    }
  }
  return map;
}

/**
 * 发起一次 DeepSeek 官方联网搜索。
 * @param {string} query 搜索词（中文/英文皆可）
 * @param {object} [opts]
 * @param {string} [opts.apiKey] DeepSeek API key（默认读 process.env.DEEPSEEK_API_KEY）
 * @param {string} [opts.baseURL] 覆盖端点（默认官方）
 * @param {string} [opts.model] 覆盖模型
 * @param {number} [opts.maxTokens] / [opts.maxUses] / [opts.timeoutMs]
 * @returns {Promise<{ answer: string, sources: Array<{title:string,url:string,snippet?:string,publishedAt?:string}>, usage?:object }>}
 *   官方搜索无来源时抛 Error（上层据此降级），绝不返回空壳成功。
 */
async function deepseekSearch(query, opts = {}) {
  const apiKey = opts.apiKey || process.env.DEEPSEEK_API_KEY || '';
  if (!apiKey) throw new Error('缺少 DEEPSEEK_API_KEY，DeepSeek 官方搜索不可用');
  const baseURL = opts.baseURL || process.env.DEEPSEEK_SEARCH_BASE_URL || DEFAULT_BASE_URL;
  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens || DEFAULT_MAX_TOKENS;
  const maxUses = opts.maxUses || DEFAULT_MAX_USES;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const q = String(query || '').trim();
  if (!q) throw new Error('缺少 query');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`DeepSeek 搜索超时（${timeoutMs}ms）`)), timeoutMs);
  let res;
  try {
    res = await fetch(`${baseURL}/messages`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': 'class-steward/1.0',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: `Perform a web search for the query: ${q}` }],
        }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
      }),
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`DeepSeek 官方搜索请求失败: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const parsed = await res.json();
      detail += `: ${parsed.error?.message || parsed.message || ''}`;
    } catch { /* 忽略解析失败 */ }
    throw new Error(`DeepSeek 官方搜索失败（${detail}）`);
  }

  const json = await res.json();
  const blocks = json.content ?? [];
  const resultBlocks = blocks.filter((b) => b.type === 'web_search_tool_result');
  if (resultBlocks.length === 0) {
    throw new Error('DeepSeek 官方搜索未返回结果块（可能未触发联网搜索）');
  }
  const snippets = citationSnippets(blocks);
  const seen = new Set();
  const sources = [];
  for (const rb of resultBlocks) {
    for (const item of rb.content ?? []) {
      if (item.type !== 'web_search_result' || !item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      const snippet = snippets.get(item.url);
      sources.push({
        url: item.url,
        ...(item.title ? { title: item.title } : {}),
        ...(snippet ? { snippet } : {}),
        ...(item.page_age ? { publishedAt: item.page_age } : {}),
      });
    }
  }
  if (sources.length === 0) {
    throw new Error('DeepSeek 官方搜索无可用来源');
  }
  // 模型甄别结论（text block）：给上层 AI 直接引用，比链接列表更有信息量
  const answer = blocks
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text)
    .join('\n')
    .slice(0, 6000);
  return { answer, sources, usage: json.usage };
}

module.exports = { deepseekSearch, DEFAULT_BASE_URL, DEFAULT_MODEL };
