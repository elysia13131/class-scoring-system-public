#!/usr/bin/env node
/**
 * pull-cloud-data.js —— 拉取 Zeabur 生产持久化卷数据覆盖本地 backend/data/
 *
 * 用途：后端上线前把云端生产数据同步到本地开发环境（云端 → 本地单向，只读云端）。
 * 实现：复用 cli.js 的 /api/cli/list + /api/cli/read 接口（.cli.env 鉴权），
 *       json.gz → 重新 gzip 写回；json → 格式化写回；文本原样；二进制 base64 解码。
 * 跳过：*.bak 备份文件（无业务价值）；wechat/gewe-session.json 本地测试态保留不删。
 *
 * 运行：node scripts/pull-cloud-data.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---- 配置加载（与 cli.js 一致：CLI_API_BASE / CLI_API_KEY） ----
(function loadEnvFile() {
  const candidates = [
    path.join(process.cwd(), '.cli.env'),
    path.join(__dirname, '.cli.env'),
    path.join(__dirname, '..', '.cli.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
        if (!process.env[m[1]]) process.env[m[1]] = val;
      }
      return;
    }
  }
})();

const API_BASE = (process.env.CLI_API_BASE || '').replace(/\/+$/, '');
const API_KEY = process.env.CLI_API_KEY || '';
if (!API_BASE || !API_KEY) {
  console.error('缺少 CLI_API_BASE / CLI_API_KEY（检查 backend/.cli.env）');
  process.exit(1);
}

const DATA_DIR = path.join(__dirname, '..', 'data');   // 本地 backend/data

async function apiGet(apiPath) {
  const res = await fetch(API_BASE + apiPath, { headers: { Authorization: 'Bearer ' + API_KEY } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${apiPath} → ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

async function main() {
  // 1. 递归收集云端文件清单（list 已含子目录文件，dir 条目再递归展开）
  const files = [];
  async function walk(dir) {
    const r = await apiGet('/api/cli/list' + (dir ? '?dir=' + encodeURIComponent(dir) : ''));
    for (const f of (r.files || [])) {
      if (f.type === 'dir') await walk(f.path);
      else files.push(f.path);
    }
  }
  await walk('');

  const targets = files.filter(p => !p.endsWith('.bak') && !p.endsWith('.bak.bak'));
  const skipped = files.length - targets.length;
  console.log(`云端共 ${files.length} 个文件，拉取 ${targets.length} 个（跳过 ${skipped} 个 .bak）`);

  // 2. 逐个读取并按编码写本地
  let ok = 0, fail = 0;
  for (const rel of targets) {
    try {
      const r = await apiGet('/api/cli/read?path=' + encodeURIComponent(rel));
      const local = path.join(DATA_DIR, ...rel.split('/'));
      fs.mkdirSync(path.dirname(local), { recursive: true });
      if (r.encoding === 'gzip-json') {
        fs.writeFileSync(local, zlib.gzipSync(Buffer.from(JSON.stringify(r.content))));
      } else if (r.encoding === 'json') {
        fs.writeFileSync(local, JSON.stringify(r.content, null, 2));
      } else if (r.encoding === 'utf8') {
        fs.writeFileSync(local, String(r.content));
      } else if (r.encoding === 'base64') {
        fs.writeFileSync(local, Buffer.from(r.content, 'base64'));
      } else {
        throw new Error('未知 encoding: ' + r.encoding);
      }
      ok++;
    } catch (e) {
      fail++;
      console.error(`  ✗ ${rel}: ${e.message}`);
    }
  }
  console.log(`完成：成功 ${ok}，失败 ${fail}，写入目录 ${DATA_DIR}`);
  if (fail > 0) process.exit(1);
}

main().catch(e => { console.error('拉取失败: ' + e.message); process.exit(1); });
