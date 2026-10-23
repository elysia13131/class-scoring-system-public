/**
 * webSearch —— 网页搜索（无 API key，Bing 主引擎 + DuckDuckGo 兜底）
 *
 * 供 AI 工具链使用（steward-bridge class_web_search → /api/internal/agent-tool
 * action=web_search）：文本结果（标题/摘要/链接）+ 图片结果（原图 URL）。
 *
 * 引擎选择：
 *   - Bing HTML/图片页：中国与海外均直连、中文结果质量好（主引擎）
 *   - DDG html/i.js：海外可达（Zeabur 节点），Bing 结构变化/风控时兜底
 * 均无需鉴权；失败返回空结果由上层降级（AI 如实说搜不到）。
 */

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TIMEOUT = 15000;

// ---------------------- Bing（主引擎） ----------------------

/** Bing 文本搜索：/search 结果列表 li.b_algo（h2>a 标题/链接 + b_caption 摘要） */
async function bingWeb(query, count) {
  const res = await axios.get('https://www.bing.com/search', {
    params: { q: String(query || '').trim(), count: Math.min(count * 2, 16) },
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    timeout: TIMEOUT,
  });
  const html = String(res.data || '');
  const results = [];
  // 每个结果：<li class="b_algo">…<h2 class=""><a ... href="URL">标题</a></h2>…<p class="b_lineclampN">摘要</p>
  //（h2/a 均带属性；标题内含 <strong> 高亮标签由 decodeEntities 剥离）
  const blockRe = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < count) {
    const url = m[1];
    // 跳过 Bing 内部链接（跳转页/子产品页）
    if (!/^https?:\/\//i.test(url)) continue;
    const snippetMatch = m[3].match(/<p[^>]*>([\s\S]*?)<\/p>/);
    results.push({
      title: decodeEntities(m[2]).trim(),
      url,
      snippet: snippetMatch ? decodeEntities(snippetMatch[1]).trim().substring(0, 300) : '',
    });
  }
  return results;
}

/** Bing 图片搜索：/images/search 结果 tile 的 iusc 元素 m 属性 JSON（murl 原图/t 标题） */
async function bingImages(query, count) {
  const res = await axios.get('https://www.bing.com/images/search', {
    params: { q: String(query || '').trim(), first: 1, count: Math.min(count * 2, 20) },
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
    timeout: TIMEOUT,
  });
  const html = String(res.data || '');
  const images = [];
  // <a class="iusc" m="{&quot;murl&quot;:&quot;https://原图&quot;…,&quot;t&quot;:&quot;标题&quot;…}">
  const tileRe = /<a[^>]+class="iusc"[^>]+m="([^"]+)"[^>]*>/g;
  let m;
  while ((m = tileRe.exec(html)) && images.length < count) {
    try {
      const meta = JSON.parse(decodeEntities(m[1]));
      if (meta.murl && /^https?:\/\//i.test(meta.murl)) {
        images.push({
          title: String(meta.t || '').substring(0, 100),
          image: meta.murl,               // 原图直链（send_web_image 可直接发）
          thumbnail: meta.turl || '',     // 缩略图（bing 引用）
          sourceUrl: meta.purl || '',     // 来源页面
          width: meta.w,
          height: meta.h,
        });
      }
    } catch { /* m 属性解析失败跳过该 tile */ }
  }
  return images;
}

// ---------------------- DuckDuckGo（兜底） ----------------------

/** DDG 文本搜索：html 端解析（.result__a 标题/链接 + .result__snippet 摘要） */
async function ddgWeb(query, count) {
  const res = await axios.get('https://html.duckduckgo.com/html/', {
    params: { q: String(query || '').trim() },
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    timeout: TIMEOUT,
  });
  const html = String(res.data || '');
  const results = [];
  const blockRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = blockRe.exec(html)) && results.length < count) {
    results.push({
      title: decodeEntities(m[2]).trim(),
      url: decodeDdgRedirect(m[1]),
      snippet: decodeEntities(m[3]).trim().substring(0, 300),
    });
  }
  return results;
}

/** DDG 图片搜索：html 搜拿 vqd → i.js JSON */
async function ddgImages(query, count) {
  const q = String(query || '').trim();
  const htmlRes = await axios.get('https://html.duckduckgo.com/html/', {
    params: { q },
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    timeout: TIMEOUT,
  });
  const vqdMatch = String(htmlRes.data || '').match(/vqd=["']?([\d-]+)["']?/);
  const vqd = vqdMatch && vqdMatch[1];
  if (!vqd) return [];
  const jsonRes = await axios.get('https://duckduckgo.com/i.js', {
    params: { l: 'zh-cn', o: 'json', q, vqd, f: ',,,' },
    headers: { 'User-Agent': UA, 'Referer': 'https://duckduckgo.com/', 'Accept': 'application/json' },
    timeout: TIMEOUT,
  });
  const list = jsonRes.data && Array.isArray(jsonRes.data.results) ? jsonRes.data.results : [];
  return list.slice(0, count).map(r => ({
    title: String(r.title || '').substring(0, 100),
    image: r.image,
    thumbnail: r.thumbnail,
    sourceUrl: r.url,
    width: r.width,
    height: r.height,
  }));
}

// ---------------------- 对外入口（主引擎 → 兜底） ----------------------

/** 文本搜索：Bing 主，DDG 兜底（任一有结果即返回） */
async function webSearch(query, count = 5) {
  try {
    const r = await bingWeb(query, count);
    if (r.length > 0) return r;
  } catch { /* Bing 失败 → DDG */ }
  return ddgWeb(query, count);
}

/** 图片搜索：Bing 主，DDG 兜底（任一有结果即返回） */
async function imageSearch(query, count = 5) {
  try {
    const r = await bingImages(query, count);
    if (r.length > 0) return r;
  } catch { /* Bing 失败 → DDG */ }
  return ddgImages(query, count);
}

// ---------------------- 工具函数 ----------------------

/** DDG 跳转链接 → 真实 URL（uddg 参数解码） */
function decodeDdgRedirect(href) {
  try {
    const h = href.startsWith('//') ? `https:${href}` : href;
    const u = new URL(h);
    const uddg = u.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : h;
  } catch {
    return href;
  }
}

/** HTML 实体解码（标题/摘要/JSON 属性里的 &amp; &quot; &#x27; 等） */
function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ');
}

module.exports = { webSearch, imageSearch };
