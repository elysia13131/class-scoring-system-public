/**
 * 修复逻辑回归自测：node backend/scripts/test-repair-dsh.js
 * 构造 4 种 session.jsonl.zstd 场景，断言修复结果。
 * 布局：{homeDir}/sessions/{projectKey}/{seg}/session.jsonl.zstd
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { repairSessionLog, sanitizeSessionLog, analyzeSessionLog } = require(path.join(__dirname, '..', 'agent', 'dsh', 'sessionLogRepair'));

const CHECKSUM = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const enc = (s) => zlib.zstdCompressSync(Buffer.from(s, 'utf8'), CHECKSUM);
const ev = (obj) => JSON.stringify(obj) + '\n';

const header = ev({ type: 'session', version: 1, id: 'member-612', createdAt: 1700000000000, delegationDepth: 0 });
const closedTurn = [
  ev({ type: 'user/message', seq: 0, text: '在吗' }),
  ev({ type: 'turn/start', seq: 1, turn: 1 }),
  ev({ type: 'assistant/message', seq: 2, turn: 1 }),
  ev({ type: 'turn/end', seq: 3, turn: 1, reason: { kind: 'completed' } }),
].join('');
const openTurn = [
  ev({ type: 'user/message', seq: 4, text: '帮我查成绩' }),
  ev({ type: 'turn/start', seq: 5, turn: 2 }),
  ev({ type: 'tool/call', seq: 6, turn: 2, step: 1, name: 'query_score' }),
].join('');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { failed++; console.log(`FAIL ${name}${detail ? '  ' + detail : ''}`); }
}

function mkHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-dsh-'));
  const file = path.join(dir, 'sessions', 'proj', 'member-612', 'session.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return { dir, file };
}

// 1) 已闭合：不需要修复
{
  const { dir } = mkHome();
  fs.writeFileSync(path.join(dir, 'sessions', 'proj', 'member-612', 'session.jsonl.zstd'),
    Buffer.concat([enc(header), enc(closedTurn)]));
  const r = repairSessionLog('member-612', { homeDir: dir });
  check('已闭合日志判定为 already-closed', r.ok && r.reason === 'already-closed', r.reason);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2) 尾部回合未写完（完整帧，无 turn/end）→ 截尾修复
{
  const { dir, file } = mkHome();
  fs.writeFileSync(file, Buffer.concat([enc(header), enc(closedTurn), enc(openTurn)]));
  const r = repairSessionLog('member-612', { homeDir: dir });
  check('未闭合回合被截尾修复', r.ok && r.reason === 'repaired', `${r.reason} removed=${r.removedLines}`);
  check('裁掉 openTurn 3 行', r.removedLines === 3, `removed=${r.removedLines}`);
  const r2 = repairSessionLog('member-612', { homeDir: dir });
  check('修复后日志已闭合', r2.ok && r2.reason === 'already-closed', r2.reason);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 3) 最后一帧被硬杀截断（撕裂帧）
{
  const { dir, file } = mkHome();
  const buf = Buffer.concat([enc(header), enc(closedTurn), enc(openTurn)]);
  fs.writeFileSync(file, buf.subarray(0, buf.length - 12)); // 砍掉撕裂帧尾部
  const r = repairSessionLog('member-612', { homeDir: dir });
  check('撕裂帧被识别并清除', r.ok && r.tornStart != null && (r.reason === 'repaired' || r.reason === 'already-closed'),
    `tornStart=${r.tornStart} reason=${r.reason}`);
  const r2 = repairSessionLog('member-612', { homeDir: dir });
  check('清除后日志已闭合', r2.ok && r2.reason === 'already-closed', r2.reason);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 4) 中间坏行 → 坏行前闭合回合保留，坏区裁掉
{
  const { dir, file } = mkHome();
  const badBody = 'not-json{...\n';
  fs.writeFileSync(file, Buffer.concat([enc(header), enc(closedTurn), enc(badBody), enc(openTurn)]));
  const r = repairSessionLog('member-612', { homeDir: dir });
  check('坏行被识别', r.ok && r.firstBadLine != null, `firstBad=${r.firstBadLine}`);
  check('保留坏行前的闭合回合', r.ok && r.reason === 'repaired' && r.removedLines >= 1,
    `${r.reason} removed=${r.removedLines}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 5) 孤立代理（lone surrogate）清洗：识别 → 实际替换 → 恢复后无孤立代理
{
  const { dir, file } = mkHome();
  // 🥰 被 substring 切断：只剩高位 \ud83e，丢低位 \udd70
  const loneMsg = ev({ type: 'user/message', seq: 0, text: '随时喊我～ \ud83e\n再来点', data: { content: [{ type: 'text', text: '随时喊我～ \ud83e' }] } });
  const body = header + loneMsg + closedTurn;
  fs.writeFileSync(file, Buffer.concat([enc(body)]));
  const dry = sanitizeSessionLog('member-612', { homeDir: dir, dryRun: true });
  check('sanitize dry-run 识别孤立代理', dry.ok && dry.reason === 'would-sanitize' && dry.loneSurrogates >= 1,
    `${dry.reason} lone=${dry.loneSurrogates}`);
  const r = sanitizeSessionLog('member-612', { homeDir: dir });
  check('sanitize 实际替换', r.ok && r.reason === 'sanitized' && r.loneSurrogates >= 1 && r.backup,
    `${r.reason} lone=${r.loneSurrogates}`);
  const a = analyzeSessionLog('member-612', { homeDir: dir });
  check('清洗后日志可解析且无孤立代理', a.ok, `reason=${a.reason}`);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 6) 幂等：已干净日志 sanitize 不改动（reason=clean）
{
  const { dir, file } = mkHome();
  fs.writeFileSync(file, Buffer.concat([enc(header), enc(closedTurn)]));
  const r = sanitizeSessionLog('member-612', { homeDir: dir });
  check('干净日志 sanitize 幂等（clean 不写盘）', r.ok && r.reason === 'clean', r.message || '');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
