#!/usr/bin/env node
/**
 * 远程数据管理 CLI
 *
 * 用于通过 HTTP API 远程读取、修改、上传后端 /backend/data 目录下的数据文件。
 * 例如：用户把通报表格发给 AI 助手，AI 助手即可通过此 CLI 直接上传/导入数据。
 *
 * 使用方式:
 *   node cli.js <command> [args] [options]
 *
 * 命令:
 *   ping                                          测试连接与 API Key 是否有效
 *   week                                          读取后端当前周次（避免本地时间错误）
 *   list [dir]                                    列出数据目录文件（dir 为相对子目录）
 *   read <path>                                   读取文件内容（json/json.gz 自动解析）
 *   write <path> <content|--stdin> [--raw] [--merge|--append]  写入文件
 *                                                  --merge: JSON 深合并（对象递归合并/数组按 id 去重合并）
 *                                                  --append: 数组直接追加/文本末尾追加
 *                                                  默认: 整文件覆盖
 *   upload <localFile> <remotePath>               上传二进制文件到指定远程路径
 *   delete <path>                                 删除文件（自动备份为 .bak）
 *   import <type> <localFile> [--month=YYYY-MM|--week=N]  导入 Excel
 *                                                  type: fitness|academic|rank|bmi|weekly-report
 *                                                  fitness/academic 用 --month(如 2026-07), bmi 用 --week(纯数字如 17), rank/weekly-report 不需要
 *   api <method> <path> [jsonBody]                直接调用任意 API（GET/POST/PUT/DELETE）
 *   sticker list                                   查看远程表情包清单
 *   sticker add <localImg> <id> --text=文字 [--use=场景]  添加表情包（立即生效，无需重启）
 *   sticker remove <id>                            移除表情包
 *   sticker sync [本地目录]                        整包同步表情包（manifest+图片，清理旧图；默认内置 wechat/stickers）
 *   group list                                     查看群聊开关状态
 *   group coverage <群id>                          群成员绑定覆盖率（xxx@chatroom）
 *   help                                          显示帮助
 *
 * 配置 (优先级: 命令行 --api-base/--api-key > 环境变量 > .cli.env 文件):
 *   CLI_API_BASE  后端基础地址，如 https://xxx.cpolar.top 或 http://127.0.0.1:3001
 *   CLI_API_KEY   鉴权密钥（与后端 CLI_API_KEY 环境变量保持一致）
 *
 * 示例:
 *   node cli.js ping
 *   node cli.js list
 *   node cli.js list scores
 *   node cli.js read members.json
 *   node cli.js read scores/scores_week_18.json.gz
 *   node cli.js write notices.json '{"items":[1,2,3]}'
 *   echo '{"a":1}' | node cli.js write test.json --stdin
 *   node cli.js upload ./report.xlsx reports/2026-07.xlsx
 *   node cli.js delete test.json
 *   node cli.js import fitness ./体能成绩.xlsx --month=2026-07
 *   node cli.js api GET /api/members
 *   node cli.js api POST /api/admin/verify-password '{"password":"123456"}'
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------- 配置加载 ----------------------
function loadEnvFile() {
  // 1. 当前目录 .cli.env
  // 2. cli.js 同目录 .cli.env
  // 3. 上级 backend/.cli.env
  const candidates = [
    path.join(process.cwd(), '.cli.env'),
    path.join(__dirname, '.cli.env'),
    path.join(__dirname, '..', '.cli.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        const key = m[1];
        let val = m[2];
        // 去引号
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
      return p;
    }
  }
  return null;
}

loadEnvFile();

function getApiBase() {
  return process.env.CLI_API_BASE || 'http://127.0.0.1:3001';
}

function getApiKey() {
  return process.env.CLI_API_KEY || '';
}

// ---------------------- HTTP 请求 ----------------------
// 使用 Node 18+ 内置 fetch；旧版本回退到 https/http
async function httpFetch(method, url, options = {}) {
  if (typeof fetch === 'function') {
    const opts = { method, headers: options.headers || {} };
    if (options.body !== undefined) {
      if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
        opts.body = options.body;
        if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = options.contentType || 'application/json';
      } else {
        opts.body = JSON.stringify(options.body);
        if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
      }
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, ok: res.ok, headers: res.headers, body };
  }
  // 回退实现
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const u = new (require('url').URL)(url);
    const req = lib.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: options.headers || {},
    }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let body;
        try { body = JSON.parse(text); } catch { body = text; }
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body !== undefined) {
      const b = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      req.setHeader('Content-Type', options.contentType || 'application/json');
      req.write(b);
    }
    req.end();
  });
}

async function cliRequest(method, apiPath, options = {}) {
  const base = getApiBase().replace(/\/+$/, '');
  const url = base + (apiPath.startsWith('/') ? apiPath : '/' + apiPath);
  const headers = { ...((options.headers) || {}) };
  if (getApiKey()) headers['Authorization'] = 'Bearer ' + getApiKey();
  return httpFetch(method, url, { ...options, headers });
}

// ---------------------- multipart 上传 ----------------------
async function uploadMultipart(localFile, apiPath, fieldName = 'file', extraFields = {}) {
  const base = getApiBase().replace(/\/+$/, '');
  const url = base + (apiPath.startsWith('/') ? apiPath : '/' + apiPath);
  const boundary = '----cli' + Math.random().toString(16).slice(2);
  const parts = [];

  // extra fields
  for (const [k, v] of Object.entries(extraFields)) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  }
  // file
  const basename = path.basename(localFile);
  const fileBuf = fs.readFileSync(localFile);
  const fileHeader = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${basename}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(parts.join(''), 'utf8'),
    Buffer.from(fileHeader, 'utf8'),
    fileBuf,
    Buffer.from(tail, 'utf8'),
  ]);

  const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
  if (getApiKey()) headers['Authorization'] = 'Bearer ' + getApiKey();

  const res = await httpFetch('POST', url, {
    headers,
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  });
  return res;
}

// ---------------------- 输出 ----------------------
function printResult(res, pretty = true) {
  if (typeof res.body === 'string') {
    process.stdout.write(res.body);
    if (!res.body.endsWith('\n')) process.stdout.write('\n');
  } else {
    process.stdout.write(JSON.stringify(res.body, null, pretty ? 2 : 0));
    process.stdout.write('\n');
  }
}

function fail(msg, code = 1) {
  process.stderr.write('错误: ' + msg + '\n');
  process.exit(code);
}

// ---------------------- 命令实现 ----------------------
async function cmdPing() {
  const res = await cliRequest('GET', '/api/cli/ping');
  if (!res.ok) fail(`ping 失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  printResult(res);
}

async function cmdWeek() {
  // 读取后端当前周次，避免本地与服务器时间不一致导致数据写错周次
  const res = await cliRequest('GET', '/api/config');
  if (!res.ok) fail(`获取周次失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  const { currentWeek, startDate } = res.body || {};
  process.stdout.write(`当前周次: 第 ${currentWeek} 周\n`);
  if (startDate) process.stdout.write(`起始日期: ${startDate}\n`);
}

async function cmdList(dir = '') {
  const q = dir ? '?dir=' + encodeURIComponent(dir) : '';
  const res = await cliRequest('GET', '/api/cli/list' + q);
  if (!res.ok) fail(`list 失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  printResult(res);
}

async function cmdRead(p) {
  if (!p) fail('缺少 path 参数');
  const res = await cliRequest('GET', '/api/cli/read?path=' + encodeURIComponent(p));
  if (!res.ok) fail(`read 失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  printResult(res);
}

async function cmdWrite(p, content, opts = {}) {
  if (!p) fail('缺少 path 参数');
  if (content === undefined && !opts.stdin) fail('缺少 content 参数（或使用 --stdin 从标准输入读取）');

  let body;
  if (opts.stdin) {
    content = await readStdin();
  }

  // 解析 mode：--merge / --append / 默认 overwrite
  let mode = 'overwrite';
  if (opts.merge) mode = 'merge';
  else if (opts.append) mode = 'append';

  if (opts.raw) {
    body = { path: p, content: content, encoding: 'utf8', mode };
  } else {
    // 默认尝试把 content 解析为 JSON
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      // 不是合法 JSON，按 raw 文本写入
      body = { path: p, content: content, encoding: 'utf8', mode };
    }
    if (parsed !== undefined) {
      body = { path: p, content: parsed, mode };
    }
  }

  const res = await cliRequest('POST', '/api/cli/write', { body });
  if (!res.ok) fail(`write 失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  printResult(res);
}

async function cmdUpload(localFile, remotePath) {
  if (!localFile) fail('缺少 localFile 参数');
  if (!fs.existsSync(localFile)) fail(`本地文件不存在: ${localFile}`);

  // 如果没指定 remotePath，使用同名
  if (!remotePath) remotePath = path.basename(localFile);

  const res = await uploadMultipart(localFile, '/api/cli/upload', 'file', { path: remotePath });
  if (!res.ok) fail(`upload 失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  printResult(res);
}

async function cmdDelete(p) {
  if (!p) fail('缺少 path 参数');
  const res = await cliRequest('DELETE', '/api/cli/delete?path=' + encodeURIComponent(p));
  if (!res.ok) fail(`delete 失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  printResult(res);
}

async function cmdMove(from, to) {
  if (!from || !to) fail('用法: move <from> <to>');
  const res = await cliRequest('POST', '/api/cli/move', { body: { from, to } });
  if (!res.ok) fail(`move 失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  printResult(res);
}

// ---------------------- sticker：表情包远程管理 ----------------------
// 表情包 = data/stickers/{id}.png + manifest.json（[{id, file, text, use}]）。
// add：上传图片 + 合并 manifest；remove：删文件 + 更新 manifest；
// 后端动态读取 manifest（mtime 缓存），增删立即生效，无需重启。

const STICKER_MANIFEST = 'stickers/manifest.json';

async function stickerManifestRead() {
  const res = await cliRequest('GET', '/api/cli/read?path=' + encodeURIComponent(STICKER_MANIFEST));
  if (res.status === 404) return [];
  if (!res.ok) fail(`读取表情包清单失败 (${res.status}): ${JSON.stringify(res.body)}`);
  const content = res.body && res.body.content;
  return Array.isArray(content) ? content : [];
}

async function stickerManifestWrite(list) {
  const res = await cliRequest('POST', '/api/cli/write', {
    body: { path: STICKER_MANIFEST, content: list, mode: 'overwrite' },
  });
  if (!res.ok) fail(`写入表情包清单失败 (${res.status}): ${JSON.stringify(res.body)}`);
}

async function cmdSticker(sub, a, b, opts = {}) {
  if (sub === 'list' || !sub) {
    const list = await stickerManifestRead();
    if (list.length === 0) {
      process.stdout.write('（暂无表情包；用 sticker add 添加）\n');
      return;
    }
    process.stdout.write(`共 ${list.length} 个表情包：\n`);
    for (const s of list) {
      process.stdout.write(`  ${s.id}\t${s.text}${s.use ? '\t' + s.use : ''}\t${s.file || s.id + '.png'}\n`);
    }
    return;
  }

  if (sub === 'add') {
    // sticker add <localPng> <id> <text> [--use=场景说明]
    const localFile = a;
    const id = b;
    const text = opts.text;
    if (!localFile || !id || !text) fail('用法: sticker add <本地图片> <id> --text=表情文字 [--use=使用场景]\n例: sticker add ./happy.png happy --text=好耶！ --use=开心');
    if (!fs.existsSync(localFile)) fail(`本地文件不存在: ${localFile}`);
    if (!/^[a-z0-9_-]{1,24}$/i.test(id)) fail(`id 只能是字母/数字/下划线/横线（1-24 位），收到: ${id}`);
    if (!/\.(png|jpg|jpeg|webp)$/i.test(localFile)) fail('请上传 png/jpg/webp 图片');
    const list = await stickerManifestRead();
    if (list.some(s => s.id === id)) fail(`id 已存在: ${id}（换一个或先 sticker remove ${id}）`);
    // 上传图片（统一存 png 后缀；微信发送按图片消息，后缀不影响内容）
    const ext = path.extname(localFile).toLowerCase().replace('.jpeg', '.jpg') || '.png';
    const remoteFile = `stickers/${id}${ext}`;
    const up = await uploadMultipart(localFile, '/api/cli/upload', 'file', { path: remoteFile });
    if (!up.ok) fail(`上传图片失败 (${up.status}): ${JSON.stringify(up.body)}`);
    // 合并 manifest（保留其余条目）
    list.push({ id, file: `${id}${ext}`, text, ...(opts.use ? { use: opts.use } : {}) });
    await stickerManifestWrite(list);
    process.stdout.write(`✓ 表情包已添加: ${id}（${text}）→ ${remoteFile}\n立即生效（后端动态读取，无需重启）\n`);
    return;
  }

  if (sub === 'remove') {
    // sticker remove <id>
    const id = a;
    if (!id) fail('用法: sticker remove <id>');
    const list = await stickerManifestRead();
    const idx = list.findIndex(s => s.id === id);
    if (idx === -1) fail(`不存在: ${id}（sticker list 查看）`);
    const [removed] = list.splice(idx, 1);
    await stickerManifestWrite(list);
    // 删远端图片（不存在也不报错——文件可能手动清理过）
    const del = await cliRequest('DELETE', '/api/cli/delete?path=' + encodeURIComponent(`stickers/${removed.file || id + '.png'}`));
    process.stdout.write(`✓ 表情包已移除: ${id}（${removed.text}）${del.ok ? '，图片已删' : '，图片删除返回 ' + del.status + '（清单已更新）'}\n`);
    return;
  }

  if (sub === 'sync') {
    // sticker sync [本地目录] —— 整包同步：上传本地 manifest 引用的全部图片 →
    // 覆盖远端 manifest → 删除旧清单里有、新清单没有的图片。
    // 默认目录 = 代码内置 wechat/stickers（新表情包随版本发布后，一条命令推到远端持久卷）。
    const dir = a || path.join(__dirname, 'wechat', 'stickers');
    const localManifest = path.join(dir, 'manifest.json');
    if (!fs.existsSync(localManifest)) fail(`目录缺少 manifest.json: ${dir}`);
    let list;
    try { list = JSON.parse(fs.readFileSync(localManifest, 'utf8')); } catch (e) { fail(`manifest.json 解析失败: ${e.message}`); }
    if (!Array.isArray(list) || list.length === 0) fail('manifest.json 为空');
    const seen = new Set();
    for (const s of list) {
      if (!s.id || !s.file || !s.text) fail(`manifest 条目缺 id/file/text: ${JSON.stringify(s)}`);
      if (seen.has(s.id)) fail(`manifest id 重复: ${s.id}`);
      seen.add(s.id);
      if (!fs.existsSync(path.join(dir, s.file))) fail(`表情包文件缺失: ${s.file}（${dir}）`);
    }
    const oldList = await stickerManifestRead();
    for (const s of list) {
      const up = await uploadMultipart(path.join(dir, s.file), '/api/cli/upload', 'file', { path: `stickers/${s.file}` });
      if (!up.ok) fail(`上传 ${s.file} 失败 (${up.status}): ${JSON.stringify(up.body)}`);
    }
    await stickerManifestWrite(list);
    const newFiles = new Set(list.map(s => s.file));
    let removed = 0;
    for (const s of oldList) {
      const f = s.file || `${s.id}.png`;
      if (!newFiles.has(f)) {
        const del = await cliRequest('DELETE', '/api/cli/delete?path=' + encodeURIComponent(`stickers/${f}`));
        if (del.ok) removed++;
      }
    }
    process.stdout.write(`✓ 表情包已整包同步: 上传 ${list.length} 张，清单 ${list.length} 条，清理旧图 ${removed} 张\n立即生效（后端动态读取，无需重启）\n`);
    return;
  }

  fail(`未知 sticker 子命令: ${sub}\n可用: list / add / remove / sync`);
}

/** group 子命令：群聊管理（list 开关状态 / coverage 成员绑定覆盖率） */
async function cmdGroup(sub, chatroomId) {
  if (sub === 'list') {
    const res = await cliRequest('GET', '/api/cli/read?path=' + encodeURIComponent('wechat_groups.json'));
    if (!res.ok) fail(`读取群状态失败 (${res.status}): ${JSON.stringify(res.body)}`);
    const groups = res.body?.data || res.body || {};
    const ids = Object.keys(groups);
    if (ids.length === 0) { process.stdout.write('（无群配置——管理员在群里 @Anaxis 即可激活）\n'); return; }
    for (const [id, g] of Object.entries(groups)) {
      process.stdout.write(`${id}  ${g.enabled ? '已开启' : '已关闭'}  ${new Date(g.ts || 0).toLocaleString('zh-CN')}\n`);
    }
    return;
  }
  if (sub === 'coverage') {
    if (!chatroomId) fail('缺少群 id（xxx@chatroom 格式）');
    const res = await cliRequest('POST', '/api/internal/agent-tool', {
      action: 'group_coverage',
      callerId: '612',   // 系统管理员 callerId（DSH_ADMIN_IDS 兜底成员，免密）
      chatroomId,
    });
    if (!res.ok) fail(`查询失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
    const d = res.body || {};
    process.stdout.write(`群状态: ${d.enabled ? '已开启' : '已关闭'}\n`);
    process.stdout.write(`成员总数 ${d.total}，已绑定 ${d.bound}，未绑定 ${(d.unbound || []).length}\n`);
    if ((d.unbound || []).length > 0) {
      process.stdout.write('未绑定昵称: ' + d.unbound.map(u => u.nickName || u.wxid).join('、') + '\n');
    }
    return;
  }
  fail(`未知 group 子命令: ${sub}\n可用: list / coverage <群id>`);
}

async function cmdImport(type, localFile, opts = {}) {
  const allowedTypes = {
    fitness: '/api/upload/fitness-scores',
    academic: '/api/upload/academic-scores',
    rank: '/api/upload/rank-scores',
    bmi: '/api/upload/bmi-scores',
    'weekly-report': '/api/weekly-reports/upload',
  };
  if (!type || !allowedTypes[type]) fail(`未知导入类型: ${type}\n支持: ${Object.keys(allowedTypes).join(', ')}`);
  if (!localFile) fail('缺少 localFile 参数');
  if (!fs.existsSync(localFile)) fail(`本地文件不存在: ${localFile}`);

  const endpoint = allowedTypes[type];
  const fields = {};
  if (opts.month) fields.month = opts.month;
  if (opts.week) fields.week = opts.week;

  // bmi 类型必填 week 参数（纯数字周次，如 17，对应文件 bmi_week_17.json.gz）
  if (type === 'bmi' && !opts.week) {
    fail('bmi 类型必须指定 --week 参数（纯数字周次），如 --week=17');
  }

  const res = await uploadMultipart(localFile, endpoint, 'file', fields);
  if (!res.ok) fail(`import 失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  printResult(res);
}

async function cmdApi(method, apiPath, bodyStr) {
  if (!method) fail('缺少 method 参数');
  if (!apiPath) fail('缺少 path 参数');
  method = method.toUpperCase();

  const opts = {};
  if (bodyStr && method !== 'GET' && method !== 'HEAD') {
    // 尝试解析为 JSON
    try {
      opts.body = JSON.parse(bodyStr);
    } catch {
      fail('jsonBody 不是合法 JSON');
    }
  }

  const res = await cliRequest(method, apiPath, opts);
  process.stdout.write(`HTTP ${res.status}\n`);
  printResult(res);
}

function readStdin() {
  return new Promise((resolve) => {
    let chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

function showHelp() {
  process.stdout.write(`远程数据管理 CLI

用法: node cli.js <command> [args] [options]

命令:
  ping                                          测试连接与 API Key
  week                                          读取后端当前周次（数据上传前先确定周次）
  list [dir]                                    列出数据目录文件
  read <path>                                   读取文件内容
  write <path> <content|--stdin> [--raw] [--merge|--append]  写入文件
                                                 --merge: JSON 深合并（对象递归/数组按 id 去重）
                                                 --append: 数组追加/文本追加
                                                 默认: 整文件覆盖
  upload <localFile> <remotePath>               上传二进制文件
  delete <path>                                 删除文件
  import <type> <localFile> [--month=YYYY-MM|--week=N]  导入 Excel
                                                 type: fitness|academic|rank|bmi|weekly-report
                                                 fitness/academic 用 --month(如 2026-07), bmi 用 --week(纯数字如 17)
  api <method> <path> [jsonBody]                直接调用任意 API
  playlist <action> [args] [--opts]             播放模式清单（班级/图片/网页 轮播配置）
                                                 action: list | set-radar-duration <秒> | set-keep-alive <N>
                                                 | add <class|image|url> [--name 班级|--url U] [--label L]
                                                   [--duration N] [--at start|end|before:<id>|after:<id>]
                                                 | set-duration <id> <秒> | move <id> --to <序号|--at ...>
                                                 | rm <id> | clear
  help                                          显示帮助

配置 (环境变量或 .cli.env 文件):
  CLI_API_BASE  后端基础地址 (默认 http://127.0.0.1:3001)
  CLI_API_KEY   鉴权密钥

示例:
  node cli.js ping
  node cli.js week
  node cli.js list scores
  node cli.js read members.json
  node cli.js read scores/scores_week_18.json.gz
  node cli.js write notices.json '{"items":[1,2,3]}'
  echo '{"a":1}' | node cli.js write test.json --stdin
  node cli.js upload ./report.xlsx reports/2026-07.xlsx
  node cli.js delete test.json
  node cli.js import fitness ./体能成绩.xlsx --month=2026-07
  node cli.js api GET /api/members
`);
}

// ---------------------- 播放模式清单 (playlist) ----------------------
/** 解析插入锚点 → items 下标（before/after 以现有 id 定位） */
function resolveAnchorIndex(items, at) {
  if (!at || at === 'end') return items.length;
  if (at === 'start') return 0;
  if (at.startsWith('before:')) {
    const id = at.slice(7);
    const i = items.findIndex(x => x.id === id);
    if (i < 0) throw new Error(`锚点 id 不存在：${id}`);
    return i;
  }
  if (at.startsWith('after:')) {
    const id = at.slice(6);
    const i = items.findIndex(x => x.id === id);
    if (i < 0) throw new Error(`锚点 id 不存在：${id}`);
    return i + 1;
  }
  throw new Error('--at 只支持 start|end|before:<id>|after:<id>');
}

/** playlist：读当前 → 应用修改 → POST 全量（校验收口在服务端） */
async function cmdPlaylist(action, args, opts) {
  const cur = await cliRequest('GET', '/api/playmode');
  if (!cur.ok) fail(`读取失败 (${cur.status}): ${typeof cur.body === 'string' ? cur.body : JSON.stringify(cur.body)}`);
  const cfg = cur.body || {};
  const items = Array.isArray(cfg.items) ? cfg.items.slice() : [];
  let msg = '';

  if (action === 'list') {
    let classes = [];
    try {
      const mr = await cliRequest('GET', '/api/members');
      if (mr.ok && Array.isArray(mr.body)) classes = mr.body;
    } catch { /* 成员拉取失败仅影响预览 */ }
    process.stdout.write(`radarDuration=${cfg.radarDuration || 8} keepAlive=${cfg.keepAlive || 3} items=${items.length}\n`);
    items.forEach((it, i) => {
      if (it.type === 'class') {
        const n = classes.filter(m => m.class === it.className).length;
        process.stdout.write(`${i + 1}. [class] ${it.className} → ${Math.ceil(n / 6)} 页${it.duration ? ` (${it.duration}s/页)` : ''} (id=${it.id})\n`);
      } else {
        process.stdout.write(`${i + 1}. [${it.type}] ${it.label || it.url}${it.duration ? ` (${it.duration}s)` : ''} (id=${it.id})\n`);
      }
    });
    if (items.length === 0) process.stdout.write('（空清单 → 播放默认：全部班级按序）\n');
    return;
  }

  switch (action) {
    case 'set-radar-duration': {
      const n = Number(args[0]);
      if (!Number.isFinite(n) || n < 1 || n > 3600) fail('用法：playlist set-radar-duration <1-3600>');
      cfg.radarDuration = n; msg = `雷达页默认时长 → ${n}s`;
      break;
    }
    case 'set-keep-alive': {
      const k = Number(args[0]);
      if (!Number.isInteger(k) || k < 1 || k > 20) fail('用法：playlist set-keep-alive <1-20>');
      cfg.keepAlive = k; msg = `网页保活上限 → ${k}`;
      break;
    }
    case 'add': {
      const type = args[0];
      if (type !== 'class' && type !== 'image' && type !== 'url') fail('用法：playlist add <class|image|url> [--name 班级|--url U] [--label L] [--duration N] [--at …]');
      const idx = resolveAnchorIndex(items, opts.at);
      const it = { type };
      if (opts.duration !== undefined) {
        const d = Number(opts.duration);
        if (!Number.isFinite(d) || d < 1 || d > 3600) fail('--duration 需为 1-3600');
        it.duration = d;
      }
      if (type === 'class') {
        if (!opts.name) fail('add class 需 --name 班级名');
        it.className = opts.name;
      } else {
        if (!opts.url) fail(`add ${type} 需 --url`);
        it.url = opts.url;
        if (opts.label) it.label = opts.label;
      }
      items.splice(idx, 0, it);
      cfg.items = items; msg = `已插入 [${type}] → 位置 ${idx + 1}`;
      break;
    }
    case 'set-duration': {
      const id = args[0]; const d = Number(args[1]);
      const it = items.find(x => x.id === id);
      if (!it) fail(`id 不存在：${id}`);
      if (!Number.isFinite(d) || d < 1 || d > 3600) fail('时长需为 1-3600');
      it.duration = d; cfg.items = items; msg = `${id} 时长 → ${d}s`;
      break;
    }
    case 'move': {
      const id = args[0];
      const from = items.findIndex(x => x.id === id);
      if (from < 0) fail(`id 不存在：${id}`);
      let to;
      if (opts.to !== undefined) {
        to = Number(opts.to) - 1;
        if (!Number.isInteger(to)) fail('--to 需为 1-based 序号');
      } else if (opts.at !== undefined) {
        to = resolveAnchorIndex(items, opts.at);
      } else {
        fail('move 需 --to <序号> 或 --at start|end|before:<id>|after:<id>');
      }
      if (to < 0) to = 0;
      if (to > items.length) to = items.length;
      const [moved] = items.splice(from, 1);
      if (from < to) to--;
      items.splice(Math.max(0, to), 0, moved);
      cfg.items = items; msg = `${id} 移动到位置 ${to + 1}`;
      break;
    }
    case 'rm': {
      const id = args[0];
      const i = items.findIndex(x => x.id === id);
      if (i < 0) fail(`id 不存在：${id}`);
      items.splice(i, 1); cfg.items = items; msg = `已移除 ${id}`;
      break;
    }
    case 'clear':
      cfg.items = []; msg = '已清空，回到默认全校播放';
      break;
    default:
      fail(`未知 playlist 动作：${action}\n运行 "node cli.js help" 查看用法`);
  }

  // 全量写：任何修改都携带完整配置（标量 + items），避免覆盖丢失
  if (msg) {
    const body = { radarDuration: cfg.radarDuration || 8, keepAlive: cfg.keepAlive || 3, items: cfg.items };
    const res = await cliRequest('POST', '/api/playmode', { body });
    if (!res.ok) fail(`保存失败 (${res.status}): ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
    process.stdout.write(`OK：${msg}\n`);
  }
}

// ---------------------- 参数解析 ----------------------
async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    showHelp();
    return;
  }

  const cmd = argv[0];
  const args = [];
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const body = a.slice(2);
      // 支持 --key=value 和 --key value 两种格式
      const eqIdx = body.indexOf('=');
      if (eqIdx >= 0) {
        const key = body.slice(0, eqIdx);
        const val = body.slice(eqIdx + 1);
        opts[key] = val;
      } else {
        const key = body;
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          opts[key] = next;
          i++;
        } else {
          opts[key] = true;
        }
      }
    } else {
      args.push(a);
    }
  }

  try {
    switch (cmd) {
      case 'ping': await cmdPing(); break;
      case 'week': await cmdWeek(); break;
      case 'list': await cmdList(args[0] || ''); break;
      case 'read': await cmdRead(args[0]); break;
      case 'write': await cmdWrite(args[0], args[1], opts); break;
      case 'upload': await cmdUpload(args[0], args[1]); break;
      case 'move': await cmdMove(args[0], args[1]); break;
      case 'delete': await cmdDelete(args[0]); break;
      case 'import': await cmdImport(args[0], args[1], opts); break;
      case 'api': await cmdApi(args[0], args[1], args[2]); break;
      case 'sticker': await cmdSticker(args[0], args[1], args[2], opts); break;
      case 'group': await cmdGroup(args[0], args[1], args[2]); break;
      case 'playlist': await cmdPlaylist(args[0] || 'help', args.slice(1), opts); break;
      default:
        fail(`未知命令: ${cmd}\n运行 "node cli.js help" 查看帮助`);
    }
  } catch (err) {
    fail(err.message || String(err));
  }
}

main();
