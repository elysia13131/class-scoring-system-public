#!/usr/bin/env node
/**
 * 拉取服务器数据覆盖本地（上线前数据同步）
 *
 * 通过 CLI API（/api/cli/list + /api/cli/read）把 Zeabur 后端 /backend/data
 * 的全部数据文件拉到本地 backend/data，保持原目录结构：
 *   - .json        → JSON.stringify 后写入
 *   - .json.gz     → 服务器返回解压后的 JSON，本地重新 gzip 后写入
 *   - 文本(utf8)   → 原样写入
 *   - 二进制       → base64 解码后写入
 *
 * 跳过 .bak 备份文件；单文件 >20MB 读取被服务器拒绝时记录并继续。
 * 只覆盖同名文件，不删除本地多余文件。
 *
 * 用法:
 *   node backend/scripts/pullRemoteData.js           # 实际拉取
 *   node backend/scripts/pullRemoteData.js --dry-run # 只列出将拉取的文件
 */

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BACKEND_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(BACKEND_DIR, 'data');

// ---------------------- 配置加载（与 cli.js 一致） ----------------------
function loadEnvFile() {
  const candidates = [
    path.join(process.cwd(), '.cli.env'),
    path.join(BACKEND_DIR, '.cli.env'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8');
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!m) continue;
        let val = m[2];
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!process.env[m[1]]) process.env[m[1]] = val;
      }
      return p;
    }
  }
  return null;
}

loadEnvFile();

const API_BASE = (process.env.CLI_API_BASE || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const API_KEY = process.env.CLI_API_KEY || '';

async function cliRequest(method, apiPath) {
  const headers = {};
  if (API_KEY) headers['Authorization'] = 'Bearer ' + API_KEY;
  const res = await fetch(API_BASE + apiPath, { method, headers });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body };
}

function fail(msg) {
  console.error('错误: ' + msg);
  process.exit(1);
}

// ---------------------- 主流程 ----------------------
async function main() {
  const dryRun = process.argv.includes('--dry-run');

  console.log(`目标服务器: ${API_BASE}`);
  const ping = await cliRequest('GET', '/api/cli/ping');
  if (!ping.ok) fail(`连接失败 (${ping.status}): ${typeof ping.body === 'string' ? ping.body : JSON.stringify(ping.body)}`);
  console.log(`连接正常，服务器数据目录: ${ping.body.dataDir}（${ping.body.files} 个文件）`);

  // 1. 列出全部文件（含一级子目录内容）
  const listRes = await cliRequest('GET', '/api/cli/list');
  if (!listRes.ok) fail(`list 失败 (${listRes.status})`);
  const allFiles = (listRes.body.files || []).filter(f => f.type === 'file');

  // 跳过 .bak 备份（含 .bak.bak）
  const targets = allFiles.filter(f => !f.path.includes('.bak'));

  const skippedBak = allFiles.length - targets.length;
  console.log(`共 ${allFiles.length} 个文件，跳过 ${skippedBak} 个 .bak 备份，将同步 ${targets.length} 个文件${dryRun ? '（dry-run 模式）' : ''}`);

  let okCount = 0;
  const errors = [];

  for (const f of targets) {
    const localPath = path.join(DATA_DIR, ...f.path.split('/'));

    if (dryRun) {
      console.log(`  [dry-run] ${f.path} (${f.size}B)`);
      okCount++;
      continue;
    }

    try {
      const readRes = await cliRequest('GET', '/api/cli/read?path=' + encodeURIComponent(f.path));
      if (!readRes.ok) {
        errors.push(`${f.path}: 读取失败 ${readRes.status}`);
        continue;
      }
      const { encoding, content } = readRes.body;

      fs.mkdirSync(path.dirname(localPath), { recursive: true });

      if (encoding === 'json' || encoding === 'gzip-json') {
        const jsonStr = JSON.stringify(content, null, 2);
        if (f.path.endsWith('.json.gz')) {
          fs.writeFileSync(localPath, zlib.gzipSync(jsonStr));
        } else {
          fs.writeFileSync(localPath, jsonStr);
        }
      } else if (encoding === 'base64') {
        fs.writeFileSync(localPath, Buffer.from(content, 'base64'));
      } else {
        // utf8 文本原样
        fs.writeFileSync(localPath, Buffer.from(String(content), 'utf8'));
      }
      okCount++;
    } catch (e) {
      errors.push(`${f.path}: ${e.message}`);
    }
  }

  console.log(`\n完成: 成功 ${okCount}/${targets.length}`);
  if (errors.length > 0) {
    console.log('失败/跳过文件:');
    for (const e of errors) console.log('  ' + e);
    process.exitCode = 2;
  }
}

main().catch(e => fail(e.message));
