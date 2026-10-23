/**
 * test-dsh-member-tools.js —— 成员互发消息 + 管理员审批流测试
 *
 * 前置：后端已运行且 CLI_API_KEY 一致（如 CLI_API_KEY=dsh-test-internal-key-2026 node index.js）
 * 验证：
 *  1. send_message（成员互发，全量开放）：身份校验 / 自发拒绝 / 目标校验 / 未开管家时存档语义
 *  2. request_admin（普通成员提交审批请求，无管家时存档）
 *  3. query_pending_approvals（管理员看全部 / 普通成员只看自己的）
 *  4. approve_request（仅管理员可批；白名单 action 自动执行）
 *  5. reject_request（仅管理员可拒；通知请求者）
 *  6. delete_schedule（本人免密删；白名单自动执行产生的日程）
 */
const KEY = process.env.CLI_API_KEY || 'dsh-test-internal-key-2026';
process.env.CLI_API_KEY = KEY;
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3001}`;

async function call(action, params) {
  const res = await fetch(`${BACKEND}/api/internal/agent-tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Internal-Auth': KEY },
    body: JSON.stringify({ action, ...params }),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const results = [];
function check(name, pass, detail) {
  results.push(pass);
  console.log(`${pass ? '✓' : '❌'} ${name}${detail ? ' → ' + detail : ''}`);
}

async function main() {
  console.log('=== 1. send_message：身份与参数校验 ===');
  let r = await call('send_message', { callerId: '999', targetMemberId: '612', text: 'hi' });
  check('无效 callerId → 403', r.status === 403, r.json.error);
  r = await call('send_message', { callerId: '601', targetMemberId: '999', text: 'hi' });
  check('目标不存在 → 404', r.status === 404, r.json.error);
  r = await call('send_message', { callerId: '601', targetMemberId: '602', text: '' });
  check('空 text → 400', r.status === 400, r.json.error);
  r = await call('send_message', { callerId: '601', targetMemberId: '601', text: 'hi' });
  check('给自己发 → 400', r.status === 400, r.json.error);
  r = await call('send_message', { callerId: '601', targetMemberId: '602', text: '帮我跟他说谢谢' });
  // 无管家环境：400 微信管家未启用（校验通过、走到发送层）；有管家环境：200 成功
  check('互发请求通过权限层（200 或 管家未启用 400）', r.status === 200 || (r.status === 400 && /管家未启用/.test(r.json.error || '')), r.status === 200 ? JSON.stringify(r.json) : r.json.error);
  const stewardOffline = r.status === 400;
  if (stewardOffline) console.log('  （测试环境管家未上线，权限层校验已通过）');

  console.log('\n=== 2. request_admin：普通成员提交审批请求 ===');
  r = await call('request_admin', { callerId: '601', summary: '测试：帮我给大家广播明早集合' });
  check('提交审批 → 200', r.status === 200, JSON.stringify(r.json).substring(0, 100));
  const approvalId = r.json.approvalId;
  check('返回 approvalId', !!approvalId, approvalId);

  r = await call('request_admin', { callerId: '601', summary: 'x', pendingAction: 'bogus_action' });
  check('非白名单 pendingAction → 400', r.status === 400 && /pendingAction 必须/.test(r.json.error || ''), r.json.error);

  console.log('\n=== 3. request_admin：绑定白名单 pendingAction（批准后自动执行） ===');
  r = await call('request_admin', {
    callerId: '601', summary: '测试：给 602 安排值日',
    pendingAction: 'submit_schedule',
    actionParams: JSON.stringify({
      callerId: '601', title: '【审批测试】值日：打扫器材室',
      dueAt: '2026-09-05 10:00', targetMemberIds: '602',
    }),
  });
  check('带 action 提交 → 200', r.status === 200, r.json.approvalId);
  const autoApprovalId = r.json.approvalId;

  console.log('\n=== 4. query_pending_approvals：可见范围 ===');
  r = await call('query_pending_approvals', { callerId: '612' });
  check('管理员视角 → 200', r.status === 200, `待批 ${r.json.count} 条`);
  const adminSeesAuto = (r.json.approvals || []).some(a => a.id === autoApprovalId);
  check('管理员能看到 601 的请求', adminSeesAuto);
  r = await call('query_pending_approvals', { callerId: '602' });
  const memberOnlySelf = (r.json.approvals || []).every(a => a.requesterId === '602');
  check('普通成员只看到自己的（602 应看不到 601 的）', r.status === 200 && memberOnlySelf, `待批 ${r.json.count} 条`);
  r = await call('query_pending_approvals', { callerId: '999' });
  check('无效 callerId → 403', r.status === 403, r.json.error);

  console.log('\n=== 5. approve_request：管理员批准 + 白名单自动执行 ===');
  r = await call('approve_request', { callerId: '602', approvalId: autoApprovalId });
  check('非管理员批准 → 403', r.status === 403, r.json.error);
  r = await call('approve_request', { callerId: '612', approvalId: autoApprovalId, note: '测试批准' });
  check('管理员批准 → 200', r.status === 200, r.json.error || '已批准');
  check('白名单 action 已自动执行', !!r.json.executed?.success, JSON.stringify(r.json.executed || {}).substring(0, 100));
  const createdSchedule = r.json.executed?.schedule;
  check('自动执行的日程已创建', !!createdSchedule?.id, createdSchedule?.title || '');
  r = await call('approve_request', { callerId: '612', approvalId: autoApprovalId });
  check('重复批准已处理请求 → 404', r.status === 404, r.json.error);

  console.log('\n=== 6. delete_schedule：删除自动执行产生的日程 ===');
  if (createdSchedule?.id) {
    r = await call('delete_schedule', { callerId: '602', scheduleId: createdSchedule.id });
    // 602 是目标成员（onlySelf 免密）或 403（需管理员）均算权限层正确
    check('目标成员删涉及自己的日程（200 免密 或 403 需管理员）', r.status === 200 || r.status === 403, r.json.error || r.json.deleted?.title || '');
    if (r.status === 403) {
      r = await call('delete_schedule', { callerId: '612', scheduleId: createdSchedule.id });
      check('管理员直通删除 → 200', r.status === 200, r.json.error || r.json.deleted?.title || '');
    }
    r = await call('delete_schedule', { callerId: '612', scheduleId: 'sched_nonexistent' });
    check('删除不存在的日程 → 404', r.status === 404, r.json.error);
  } else {
    console.log('  ⚠ 跳过（白名单未生成日程）');
  }

  console.log('\n=== 7. reject_request：管理员拒绝 ===');
  r = await call('reject_request', { callerId: '601', approvalId, reason: '不该我批' });
  check('非管理员拒绝 → 403', r.status === 403, r.json.error);
  r = await call('reject_request', { callerId: '612', approvalId, reason: '测试拒绝理由' });
  check('管理员拒绝 → 200', r.status === 200, r.json.error || '已拒绝');
  check('拒绝理由已记录', r.json.approval?.reason === '测试拒绝理由', r.json.approval?.reason || '');

  console.log('\n=== 8. notify_all 管理员直通（无密码） ===');
  r = await call('notify_all', { callerId: '612', text: '测试广播' });
  check('管理员 callerId 免密码广播（200 或管家未启用）', r.status === 200 || (r.status === 400 && /管家未启用/.test(r.json.error || '')), r.status === 200 ? '已入队' : r.json.error);
  r = await call('notify_all', { callerId: '601', text: '测试广播' });
  check('普通成员无密码广播 → 403', r.status === 403, r.json.error);

  const passed = results.filter(Boolean).length;
  console.log(`\n========== 结果：${passed}/${results.length} 通过 ==========`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch(e => { console.error('测试脚本异常:', e.message); process.exit(1); });
