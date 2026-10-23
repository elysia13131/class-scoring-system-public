// 每日重复日程回归测试：repeat=daily 到点通知后自动推进到下一天同一时刻
const fs = require('fs');
const path = require('path');
const store = require('../data/scheduleStore');
const { beijingDateStrOffset } = require('../utils/beijingTime');

const FILE = path.join(__dirname, '..', 'data', 'schedules.json');
let backup = null;
if (fs.existsSync(FILE)) backup = fs.readFileSync(FILE, 'utf8');

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name} ${extra}`); }
};

(async () => {
  console.log('== 每日重复日程测试 ==');
  // 清空测试数据（用一次性文件隔离：直接操作 store 指向的真实文件，结束后恢复）
  try { store.writeSchedules([]); } catch {}

  // 1. 创建每日重复日程：明天 08:00
  const tomorrow = beijingDateStrOffset(1);
  const s = store.createSchedule({
    title: '每天提醒丁丕硕交作业',
    dueAt: `${tomorrow} 08:00`,
    createdBy: '612',
    targetMemberIds: ['612'],
    repeat: 'daily',
  });
  check('创建 repeat=daily 日程', s.repeat === 'daily' && s.notified === false);

  // 2. 把 dueAt 改成当前时刻（刚到期、在 1 分钟窗口内），getDueSchedules 应命中
  const nowLine = require('../utils/beijingTime').beijingDateStr();
  const nowTime = require('../utils/beijingTime').beijingNow().toISOString().substring(11, 16);
  const scheds = store.readSchedules();
  scheds[0].dueAt = `${nowLine} ${nowTime}`;
  store.writeSchedules(scheds);
  let due = store.getDueSchedules();
  check('到点后 getDueSchedules 命中', due.length === 1 && due[0].id === s.id);

  // 3. markNotified → 推进到下一天同一时刻，重置 notified，计数 +1
  store.markNotified(s.id);
  let after = store.readSchedules().find(x => x.id === s.id);
  check('通知后 dueAt 推进到明天同一时刻', String(after.dueAt).startsWith(beijingDateStrOffset(1)) && after.dueAt.endsWith(nowTime), `dueAt=${after.dueAt}`);
  check('推进后 notified 重置为 false（明日继续提醒）', after.notified === false);
  check('repeatCount=1', after.meta.repeatCount === 1, `repeatCount=${after.meta.repeatCount}`);

  // 4. 再次到点（从今天再次触发，推进一天；repeatCount 累计）
  const s2 = store.readSchedules();
  s2[0].dueAt = `${nowLine} ${nowTime}`;
  store.writeSchedules(s2);
  store.markNotified(s.id);
  after = store.readSchedules().find(x => x.id === s.id);
  check('第二次通知后再推进一天', String(after.dueAt).startsWith(beijingDateStrOffset(1)) && after.dueAt.endsWith(nowTime), `dueAt=${after.dueAt}`);
  check('repeatCount=2', after.meta.repeatCount === 2, `repeatCount=${after.meta.repeatCount}`);

  // 5. 一次性日程：通知后 notified=true，dueAt 不推进
  const one = store.createSchedule({ title: '一次性', dueAt: '2000-01-01 08:00', createdBy: '612', targetMemberIds: ['612'] });
  check('一次性日程 repeat=none', one.repeat === 'none');
  store.markNotified(one.id);
  const oneAfter = store.readSchedules().find(x => x.id === one.id);
  check('一次性通知后 notified=true 且 dueAt 不变', oneAfter.notified === true && oneAfter.dueAt === '2000-01-01 08:00');

  // 恢复原数据
  try { store.writeSchedules(backup ? JSON.parse(backup) : []); } catch {}
  console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
