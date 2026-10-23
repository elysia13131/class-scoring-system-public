/**
 * dsh 会话日志手动修复入口 —— 在 Zeabur 容器内执行：
 *
 *   node backend/scripts/repair-dsh-session.js <memberId|logicalId> [--dry-run]
 *
 * 例：
 *   node backend/scripts/repair-dsh-session.js 612 --dry-run   # 先看诊断，不改文件
 *   node backend/scripts/repair-dsh-session.js 612             # 截尾修复，完整保留历史
 *   node backend/scripts/repair-dsh-session.js group-56279217975@chatroom
 *
 * 修复原理：把 session.jsonl.zstd 里被硬杀截断/未写完的尾部回合裁掉，日志以
 * 最后一个完整闭合回合（turn/end）收尾；修复后重启后端进程，下一条消息即
 * resume 稳定 id —— 之前的上下文一字不丢地完整恢复（不再是摘要兜底）。
 */
const path = require('path');
const { repairSessionLog, analyzeSessionLog, sanitizeSessionLog } = require(path.join(__dirname, '..', 'agent', 'dsh', 'sessionLogRepair'));

function normalizeLogicalId(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^member-/i.test(s) || /^group-.*@chatroom$/i.test(s) || /^admin-/i.test(s)) return s;
  if (/^\d+$/.test(s)) return `member-${s}`;
  return s; // 其它按完整 logicalId 原样处理
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const sanitize = args.includes('--sanitize');
  const idArg = args.find((a) => a !== '--dry-run' && a !== '--sanitize');
  const logicalId = normalizeLogicalId(idArg);
  if (!logicalId) {
    console.error('用法: node backend/scripts/repair-dsh-session.js <memberId|logicalId> [--dry-run] [--sanitize]');
    console.error('  --sanitize  只清洗会话日志中的孤立代理（lone surrogate），不截尾');
    process.exit(2);
  }
  console.log(`[repair-dsh] logicalId=${logicalId}${dryRun ? '（dry-run，不写文件）' : ''}${sanitize ? '（sanitize 模式：清洗孤立代理）' : ''}`);
  if (sanitize) {
    const s = sanitizeSessionLog(logicalId, { dryRun });
    console.log('--- 清洗报告 ---');
    console.log(`结果: ${s.ok ? '✅' : '❌'} ${s.reason}  ${s.message || ''}`);
    if (s.path) console.log(`日志: ${s.path}`);
    console.log(`行数: ${s.lines ?? '-'} | 需清洗行: ${s.cleanedLines ?? '-'} | 孤立代理: ${s.loneSurrogates ?? '-'}`);
    if (s.backup) console.log(`备份: ${s.backup}`);
    process.exit(s.ok ? 0 : 1);
  }
  console.log(`[repair-dsh] logicalId=${logicalId}${dryRun ? '（dry-run，不写文件）' : ''}`);
  const r = repairSessionLog(logicalId, { dryRun });
  console.log('--- 修复报告 ---');
  console.log(`结果: ${r.ok ? '✅' : '❌'} ${r.reason}  ${r.message || ''}`);
  if (r.path) console.log(`日志: ${r.path}`);
  console.log(`字节: ${r.bytes ?? '-'} | 完整帧: ${r.frames ?? '-'}${r.tornStart != null ? `（含撕裂尾 @${r.tornStart}，已丢弃）` : ''}`);
  console.log(`行数: ${r.lines ?? '-'} | 首个坏行: ${r.firstBadLine ?? '无'} | 最后闭合回合行: ${r.lastClosedLine ?? '无'} | 裁掉行: ${r.removedLines ?? '-'}`);
  if (r.backup) console.log(`备份: ${r.backup}`);
  if (r.tailTypes && r.tailTypes.length) console.log(`收尾事件类型: ${r.tailTypes.join(' → ')}`);
  if (r.removedPreview && r.removedPreview.length) console.log(`被裁掉的坏尾类型: ${r.removedPreview.join(' → ')}`);
  // 400/空转现场：解出日志内容块分布 + 原始尾部（含调模型前落盘的 user/message，
  // 可直接看到被拒请求实际发的消息/附件块）
  const a = analyzeSessionLog(logicalId);
  if (a && a.ok) {
    const pts = a.partTypes || {};
    if (Object.keys(pts).length) {
      console.log(`内容块分布: ${Object.keys(pts).slice(0, 20).map(k => `${k}:${pts[k]}`).join(' ')}`);
    }
    if (Array.isArray(a.rawTail) && a.rawTail.length) {
      console.log(`--- 原始尾部（${a.rawTail.length} 行）---`);
      for (const ln of a.rawTail) console.log(`| ${ln}`);
    }
  }
  process.exit(r.ok ? 0 : 1);
}

main();
