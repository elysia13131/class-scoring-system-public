/**
 * fetchUrl —— 读取 http(s) 链接：正文转 markdown + 抽取页面图片直链。
 *
 * 内核复用 dsh 官方 @deepseek-ai/dsh-web-fetch-http 的 HttpFetchProvider
 * （匿名公网 HTTP：内置 SSRF 防护——私网拒绝、同源跳转限制、100k 字符体上限），
 * HTML→markdown 用官方同款 turndown + GFM。零新增依赖。
 *
 * 供 AI 工具链（agent-tool action=fetch_url，steward-bridge class_fetch_url）：
 * 学生发来链接/文章 → 模型读正文并可选配图（images 直链 → class_send_web_image）。
 */

let providerPromise;

/** 懒加载官方 provider（ESM 包，CJS 侧动态 import + 单例复用） */
function getProvider() {
  if (!providerPromise) {
    providerPromise = import('@deepseek-ai/dsh-web-fetch-http').then((mod) => {
      // 与官方 Config 默认一致；浏览器 UA 提升部分站点可达性
      const limits = {
        maxResponseBytes: 5e6,      // 5MB 响应体上限
        maxBodyChars: 1e5,          // 100k 字符正文上限
        timeoutMs: 30000,
        maxRedirects: 5,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      };
      return new mod.HttpFetchProvider(limits);
    }).catch((e) => {
      providerPromise = undefined;  // 失败可重试
      throw e;
    });
  }
  return providerPromise;
}

/** 懒加载 turndown（官方同款 HTML→markdown；CJS 包直接 require） */
let turndownInstance;
function getTurndown() {
  if (!turndownInstance) {
    const TurndownService = require('turndown');
    const { gfm } = require('@joplin/turndown-plugin-gfm');
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
    td.use(gfm);
    td.addRule('removeNonVisibleContent', {
      filter(node) {
        if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED'].includes(node.nodeName)) return true;
        if (node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return true;
        return (node.getAttribute('style') || '').split(';').some((d) => {
          const i = d.indexOf(':');
          if (i === -1) return false;
          const p = d.slice(0, i).trim().toLowerCase();
          const v = d.slice(i + 1).trim().toLowerCase();
          return (p === 'display' && v === 'none') || (p === 'visibility' && (v === 'hidden' || v === 'collapse'));
        });
      },
      replacement() { return ''; },
    });
    turndownInstance = td;
  }
  return turndownInstance;
}

/** markdown 正文给模型的上限（防止上下文膨胀；再大由模型说明需要精读时再说） */
const MAX_MD_CHARS = 15000;

/** 是否为公众号文章域名 */
function isMpWeixin(u) {
  try { return /(^|\.)mp\.weixin\.qq\.com$/i.test(new URL(u).hostname); } catch { return false; }
}

/** 公众号 HTML body 是否为验证拦截页（wappoc / 请在微信打开 / 环境异常等） */
function isMpBlockedBody(html) {
  return /wappoc_appmsgcaptcha|请在微信客户端打开|请在微信打开|访问过于频繁|环境异常|当前环境异常|去验证/i.test(String(html || '').slice(0, 20000));
}

/**
 * 公众号 HTML body 是否有文章正文容器（js_content / msg_title / rich_media_title）。
 * 完整直抓页面里这些标记必现；缺 → 空壳/非文章页。
 */
function hasMpArticleBody(html) {
  const h = String(html || '');
  return /<div[^>]*id=["']js_content["']/i.test(h)
    || /var\s+msg_title\s*=/.test(h)
    || /<h1[^>]*class=["'][^"']*rich_media_title/i.test(h);
}

/** 从 markdown 里抽图片直链（截 gfm 图片语法） */
function imagesFromMd(md, max = 6) {
  const out = [];
  const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(md)) && out.length < max) {
    const s = m[1];
    if (/^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * 公众号文章独立直抓：不走 dsh provider。
 * 原因：dsh provider 的 maxBodyChars=100k 会截断响应——微信文章页常见 3.5MB+，
 * 正文容器 js_content 常在 ~700KB 偏移处，100k 截断后被误判成"验证页/空壳"，
 * 进而误转境外 reader（成都服务器不可达 → 报错）。
 * 这里原生 https 直抓完整 HTML（限 8MB），命中正文再走统一的 HTML→markdown。
 * 仅当真的命中微信验证页/空壳时，才降级到 jina reader 通道。
 */

/** 原生 https 直抓 mp.weixin.qq.com 完整 HTML（跟随同域重定向，SSRF 安全：仅微信域） */
function fetchMpHtml(rawUrl, redirects = 5) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(rawUrl); } catch (e) { return reject(new Error('无效链接')); }
    if (!/(^|\.)mp\.weixin\.qq\.com$/i.test(u.hostname)) {
      return reject(new Error('仅支持公众号链接直抓'));
    }
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Referer': 'https://mp.weixin.qq.com/',
        'Accept': 'text/html,application/xhtml+xml,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'identity',   // 不压缩，直接按字节读
      },
      timeout: 30000,
    }, (res) => {
      // 同域重定向跟随（微信短链/长链可能先 3xx）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next = res.headers.location;
        try { next = new URL(next, u.href).href; } catch { return reject(new Error('重定向地址无效')); }
        return fetchMpHtml(next, redirects - 1).then(resolve, reject);
      }
      const chunks = [];
      let total = 0;
      res.on('data', (c) => {
        total += c.length;
        if (total > 8 * 1024 * 1024) { req.destroy(new Error('公众号页面过大')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, html: Buffer.concat(chunks).toString('utf8'), finalUrl: u.href });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('公众号页面读取超时（30s）')));
    req.on('error', (e) => reject(new Error(e.code === 'ERR_SSL_TLSV13_ALERT_INTERNAL_ERROR' ? '公众号 TLS 握手失败' : e.message)));
    req.end();
  });
}

/**
 * 公众号文章走 jina reader 微信专属渲染通道（r.jina.ai）。
 * jina 对 mp.weixin.qq.com 有专门适配，能从验证拦截下取回可用 markdown 正文；
 * 通道失败/返回仍为空时抛出人话文案，供模型如实转述并引导用户粘贴正文。
 * 注意：r.jina.ai 为境外服务，部署在境内/成都的服务器不可达时会超时失败——
 * 此时 fallback 文案明确说明，引导用户粘贴正文/截图（机器读微信受风控限制）。
 */
async function fetchMpViaJina(rawUrl, opts) {
  const https = require('https');
  const jinaHost = 'r.jina.ai';
  const ctrl = new AbortController();
  const JINA_TIMEOUT_MS = 12000;   // 境外通道，短超时快速失败（境内服务器不可达，别让用户干等 45s）
  const timer = setTimeout(() => ctrl.abort(new Error('公众号阅读通道超时')), JINA_TIMEOUT_MS);
  try {
    const body = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: jinaHost,
        path: '/' + encodeURIComponent(rawUrl),
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'text/markdown, text/plain, */*',
          'Accept-Encoding': 'identity',
        },
        timeout: JINA_TIMEOUT_MS,
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => {
          chunks.push(c);
          if (Buffer.concat(chunks).length > 5 * 1024 * 1024) { req.destroy(new Error('公众号正文过大')); }
        });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('error', (e) => ctrl.signal.aborted ? reject(new Error('公众号阅读通道超时')) : reject(e));
      req.end();
    });
    const cap = opts.maxMarkdownChars || MAX_MD_CHARS;
    let md = String(body.body || '');
    // jina 输出头部的元信息块（Title/URL Source/…/Markdown Content:）剥掉，正文更干净
    const mdStart = md.indexOf('Markdown Content:');
    if (mdStart !== -1) md = md.slice(mdStart + 'Markdown Content:'.length);
    const txt = md.replace(/\s+/g, '').trim();
    if (body.status >= 400 || /请在微信客户端打开|访问过于频繁|系统繁忙|wappoc_appmsgcaptcha/i.test(md) || txt.length < 40) {
      throw new Error('这篇公众号文章受微信访问限制，机器直接读取会被验证页拦截，能读到正文的概率很低。如实告诉她：把文章正文复制或截图发过来，我就能读。');
    }
    const truncated = md.length > cap;
    if (truncated) md = `${md.slice(0, cap)}\n\n(正文过长已截断。需要更完整的某段，让模型说明再抓。)`;
    return {
      url: `https://${jinaHost}/${rawUrl}`,
      statusCode: body.status,
      kind: 'text',
      markdown: md,
      images: imagesFromMd(md, opts.maxImages || 6),
      truncated,
      viaJina: true,
    };
  } catch (e) {
    if (/公众号阅读通道超时|正文过大/.test(e.message)) {
      throw new Error('这篇公众号文章受微信访问限制，服务器直读被验证页拦截，辅助阅读通道在当前网络也不可用，能读到正文的概率很低。如实告诉她：把文章正文复制或截图发过来，我就能读。');
    }
    throw new Error('这篇公众号文章受微信访问限制，机器直接读取会被验证页拦截，能读到正文的概率很低。如实告诉她：把文章正文复制或截图发过来，我就能读。');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从原始 HTML 抽取图片直链（og:image 优先，其次 <img src>），相对地址绝对化。
 * @param {string} html 原始 HTML（provider 返回的仍是原始 HTML）
 * @param {string} baseUrl 用于解析相对地址
 * @param {number} max 最多返回张数
 * @returns {string[]} http(s) 图片直链（去重、去 data:/空链）
 */
function extractImages(html, baseUrl, max = 6) {
  const out = [];
  const seen = new Set();
  const push = (raw) => {
    if (!raw || out.length >= max) return;
    const src = String(raw).trim();
    if (!src || src.startsWith('data:') || src.startsWith('#')) return;
    if (/\.svg($|\?)/i.test(src)) return;  // svg 多为 logo/图标，不适合当配图发
    let abs;
    try { abs = new URL(src, baseUrl).href; } catch { return; }
    if (abs.startsWith('http:') || abs.startsWith('https:')) {
      if (!seen.has(abs)) { seen.add(abs); out.push(abs); }
    }
  };
  // og:image（分享卡片图，优先且通常就是正文图）
  const ogRe = /<meta[^>]+(?:property|name)=["']og:image["'][^>]*>/gi;
  let m;
  while ((m = ogRe.exec(html)) && out.length < max) {
    const c1 = /content=["']([^"']+)["']/i.exec(m[0]);
    if (c1) push(c1[1]);
  }
  // <img src>（跳过 1x1 追踪图：宽高属性同时为 1 的）
  const imgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((m = imgRe.exec(html)) && out.length < max) {
    const tag = m[0];
    const w = /width=["']?(\d+)["']?/i.exec(tag);
    const h = /height=["']?(\d+)["']?/i.exec(tag);
    if (w && h && w[1] === '1' && h[1] === '1') continue;  // 追踪像素
    push(m[1]);
  }
  return out;
}

/**
 * 公众号 HTML 预处理，让 turndown 能取到正文与图片：
 * 1. 正文容器 js_content 初始 style="visibility:hidden; opacity:0"（微信 JS 才显示），
 *    会命中 turndown 的隐藏内容过滤 → 把 visibility 置为 visible；
 * 2. 正文图片用 data-src 懒加载（<img data-src="..." /> 无 src）→ 补 src，
 *    让 turndown 能抽到 md 图片、extractImages 能取直链。
 */
function preprocessMpHtml(html) {
  return String(html || '')
    .replace(/(<div[^>]*id=["']js_content["'][^>]*style=["'])([^"']*)(["'][^>]*>)/gi, (m, p1, p2, p3) =>
      `${p1}${p2.replace(/visibility\s*:\s*hidden/gi, 'visibility: visible').replace(/opacity\s*:\s*0(\.\d+)?/gi, 'opacity: 1')}${p3}`)
    // data-src → src（懒加载图；已有 src 的不覆盖）
    .replace(/<img(?![^>]*\ssrc=)([^>]*?)\sdata-src=["']([^"']+)["']([^>]*?)>/gi, '<img$1 src="$2"$3>');
}

/**
 * 抓取一个 http(s) 链接。
 * @param {string} url 目标链接
 * @param {object} [opts] { maxMarkdownChars }
 * @returns {Promise<{url:string, statusCode:number, markdown:string, images:string[], truncated:boolean, kind:string}>}
 *   非 2xx 状态不抛错（同官方语义，HTTP 404/403 也是结果）；正文/图片可空。
 *   私网/非法协议/跨域跳转等安全拒绝由 provider 抛错（上层转 error 文案）。
 *
 *   公众号文章（mp.weixin.qq.com）特殊处理：微信页面体积大（常见 3.5MB+，正文
 *   js_content 在 ~700KB 偏移），dsh provider 的 100k 字符截断会把它切成"空壳"，
 *   所以走独立直抓通道取完整 HTML；直抓也命中验证页（wappoc 风控）时，再尝试
 *   jina reader 微信通道（r.jina.ai，境外服务——境内服务器不可达则如实转述引导
 *   粘贴正文），不让 AI 空转报"打不开"。
 */
async function fetchUrl(url, opts = {}) {
  const rawUrl = String(url || '').trim();

  // 公众号文章：独立完整直抓通道（不受 provider 100k 截断影响）
  if (isMpWeixin(rawUrl)) {
    let page;
    try {
      page = await fetchMpHtml(rawUrl);
    } catch (e) {
      // 直抓网络失败 → jina 通道兜底
      try {
        return await fetchMpViaJina(rawUrl, opts);
      } catch (je) {
        throw je;
      }
    }
    const rawHtml = String(page.html || '');
    // 真命中微信验证页/空壳（无正文容器）→ jina 通道
    if (page.statusCode >= 400 || isMpBlockedBody(rawHtml) || !hasMpArticleBody(rawHtml)) {
      try {
        return await fetchMpViaJina(rawUrl, opts);
      } catch (je) {
        throw je;
      }
    }
    const html = preprocessMpHtml(rawHtml);   // 可见性+懒加载图预处理
    const out = {
      url: page.finalUrl || rawUrl,
      statusCode: page.statusCode,
      kind: 'html',
      markdown: '',
      images: [],
      truncated: false,
    };
    out.images = extractImages(html, page.finalUrl || rawUrl, opts.maxImages || 6);
    const md = getTurndown().turndown(html);
    const cap = opts.maxMarkdownChars || MAX_MD_CHARS;
    if (md.length > cap) {
      out.markdown = `${md.slice(0, cap)}\n\n(正文过长已截断。需要更完整的某段，让模型说明再抓。)`;
      out.truncated = true;
    } else {
      out.markdown = md;
    }
    return out;
  }

  const provider = await getProvider();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('链接读取超时（30s）')), 30000);
  let result;
  try {
    result = await provider.fetch({ url: rawUrl }, controller.signal);
  } catch (e) {
    if (controller.signal.aborted && String(e.message).includes('链接读取超时')) throw e;
    throw new Error(`${e.code || '抓取失败'}: ${e.message}`);
  } finally {
    clearTimeout(timer);
  }

  const out = {
    url: result.url,
    statusCode: result.statusCode,
    kind: result.body.kind,
    markdown: '',
    images: [],
    truncated: result.truncated,
  };
  if (result.body.kind === 'html') {
    // provider 返回原始 HTML：同一份既转正文又抽图
    const html = result.body.content;
    out.images = extractImages(html, result.url, opts.maxImages || 6);
    const md = getTurndown().turndown(html);
    const cap = opts.maxMarkdownChars || MAX_MD_CHARS;
    if (md.length > cap) {
      out.markdown = `${md.slice(0, cap)}\n\n(正文过长已截断。需要更完整的某段，让模型说明再抓。)`;
      out.truncated = true;
    } else {
      out.markdown = md;
    }
  } else {
    // 纯文本（text/*、json、xml…）：原样给，长度同样收口
    const txt = result.body.content;
    const cap = opts.maxMarkdownChars || MAX_MD_CHARS;
    out.markdown = txt.length > cap ? `${txt.slice(0, cap)}\n\n(内容过长已截断。)` : txt;
    if (txt.length > cap) out.truncated = true;
  }
  return out;
}

module.exports = { fetchUrl, extractImages };
