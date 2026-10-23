const store = require('../data/checkin_records/store');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const dailyReport = require('../routes/dailyReport');
const scheduleStore = require('../data/scheduleStore');
const automationStore = require('../data/automationStore');
const DataQueryTool = require('./tools/DataQueryTool');
const { beijingDateStr, beijingISO, beijingNow } = require('../utils/beijingTime');
const { getDataPath } = require('../utils/dataPath');
const { getCurrentWeek: getCurrentSemesterWeek } = require('../utils/semester');

const PUSH_MESSAGES = [
  '今天怎么样？',
  '快来领取你的专属问题~',
  '今天有什么想说的吗？',
  '休息一下，来记录今天的心情吧',
  '你今天过得充实吗？来聊聊',
  '每日一问在等你，快来！',
  '今天有什么新故事想分享？',
  '你的战友们都在记录，别掉队哦',
];

const ADMIN_PUSH_MESSAGES = [
  '今天的班级动态看过了吗？打开看看',
  '你的学员们在等你关注，快来看看',
  '今日管理反思已生成，来聊聊吧',
];

const DAILY_QUESTIONS_CACHE = getDataPath('daily_questions.json');

function todayStr() {
  return beijingDateStr();
}

function getRandomMessage() {
  return PUSH_MESSAGES[Math.floor(Math.random() * PUSH_MESSAGES.length)];
}

function getRandomAdminMessage() {
  return ADMIN_PUSH_MESSAGES[Math.floor(Math.random() * ADMIN_PUSH_MESSAGES.length)];
}

function loadMembers() {
  try {
    const file = getDataPath('members.json');
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return []; }
}

function hasAnsweredToday(memberId) {
  const today = todayStr();
  const records = store.readRecords(memberId);
  return records.some(r => {
    if (r.type !== 'question') return false;
    const rDate = (r.timestamp || '').substring(0, 10);
    return rDate === today && r.text && r.text.trim().length > 0;
  });
}

function readQuestionsCache() {
  try { return JSON.parse(fs.readFileSync(DAILY_QUESTIONS_CACHE, 'utf-8')); } catch { return {}; }
}

function writeQuestionsCache(data) {
  fs.writeFileSync(DAILY_QUESTIONS_CACHE, JSON.stringify(data, null, 2));
}

function getCachedQuestion(memberId) {
  const cache = readQuestionsCache();
  const entry = cache[memberId];
  if (!entry || entry.date !== todayStr()) return null;
  return entry;
}

function cacheQuestion(memberId, question, key) {
  const cache = readQuestionsCache();
  cache[memberId] = { question, key, date: todayStr(), generatedAt: beijingISO() };
  writeQuestionsCache(cache);
}

function getCachedAdminQuestion(adminId) {
  return getCachedQuestion(adminId);
}

// 凌晨自动生成管理员每日一问
async function generateAdminQuestions(wechatManager, engine) {
  const onlineAdmins = getOnlineAdminBots(wechatManager);
  if (onlineAdmins.length === 0) {
    console.log('[PushScheduler] 凌晨无在线管理员Bot，跳过生成');
    return;
  }

  const cache = readQuestionsCache();
  const members = loadMembers();
  const enabled = engine && engine.llm;

  for (const admin of onlineAdmins) {
    const adminId = admin.memberId;

    if (enabled) {
      try {
        // 收集班级数据（与 admin-question 接口一致，使用 DataQueryTool）
        const allClasses = [...new Set(members.map(m => m.class).filter(Boolean))];
        const lastWeek = getCurrentWeek() - 1;
        const dqTool = new DataQueryTool();
        let classData = [];
        try {
          const evalStatus = await dqTool.execute({ dataType: 'evaluation_status', week: lastWeek }, { memberId: adminId, isAdmin: true });
          classData = allClasses.map(cls => {
            const clsSummary = (evalStatus.classSummary || []).find(c => c.className === cls);
            const clsMembers = members.filter(m => m.class === cls);
            const clsIncomplete = (evalStatus.allIncomplete || []).filter(m => m.class === cls);
            const unscoredNames = clsIncomplete.map(m =>
              `${m.name}${m.missingSelf && m.missingPeer ? '(自评+互评)' : m.missingSelf ? '(自评)' : '(互评)'}`
            );
            return {
              className: cls,
              memberCount: clsMembers.length,
              selfCompletion: clsSummary ? `${clsSummary.selfCompletionRate}%` : '暂无',
              peerCompletion: clsSummary ? `${clsSummary.peerCompletionRate}%` : '暂无',
              unscoredCount: clsIncomplete.length,
              unscoredNames: unscoredNames.length > 0 ? unscoredNames.join(', ') : '无',
            };
          });
        } catch (e) {
          console.error(`[PushScheduler] 获取评分状态失败 ${adminId}:`, e.message);
          classData = allClasses.map(cls => ({
            className: cls, memberCount: members.filter(m => m.class === cls).length,
            selfCompletion: '查询失败', peerCompletion: '查询失败', unscoredCount: 0, unscoredNames: '查询失败',
          }));
        }

        // 日程信息
        const todayDateStr = todayStr();
        const upcomingSchedules = scheduleStore.getUpcomingSchedules(adminId, 5) || [];
        const todaySchedules = scheduleStore.getSchedulesByDate(todayDateStr, adminId) || [];
        const scheduleInfo = [];
        if (todaySchedules.length > 0) {
          scheduleInfo.push('今日日程：');
          todaySchedules.forEach(s => scheduleInfo.push(`  - ${s.title}${s.description ? '：' + s.description : ''}`));
        }
        if (upcomingSchedules.length > 0) {
          const upcoming = upcomingSchedules.filter(s => !todaySchedules.find(ts => ts.id === s.id));
          if (upcoming.length > 0) {
            scheduleInfo.push('近期日程：');
            upcoming.forEach(s => scheduleInfo.push(`  - ${s.dueAt?.substr(0, 10)} ${s.title}`));
          }
        }
        const scheduleText = scheduleInfo.length > 0 ? scheduleInfo.join('\n') : '暂无日程';

        const adminRecords = store.getRecentRecords(adminId, 30);
        const recentObs = adminRecords.filter(r => r.type === 'admin_observation' || r.type === 'question').slice(-3)
          .map(r => `${r.timestamp?.substr(0,10)}: ${(r.text||'').substr(0,100)}`).join('; ') || '无';
        const pastQuestions = adminRecords.filter(r => r.type === 'question' && r.text).slice(-7)
          .map(r => `Q:${(r.text||'').substr(0,60)}`);

        const prompt = `你是管理员的AI搭档。请生成一个管理反思问题。

【各班上周评分完成情况】
${classData.map(c => `${c.className}: ${c.memberCount}人, 自评${c.selfCompletion}, 互评${c.peerCompletion}, ${c.unscoredCount}人未完成评分, 未完成: ${c.unscoredNames}`).join('\n')}

【日程信息】${scheduleText}

【管理员近期观察记录】${recentObs}

【过去问过的问题】${pastQuestions.map(q => `  ${q}`).join('\n') || '(无)'}

【要求】基于上周评分完成情况（具体谁未完成评分）和当前日程安排生成管理反思问题，引导管理员反思管理方式而非指责学员，20-40字，避免空洞提问和与过去问题无意义重复。只输出问题本身。`;

        const response = await engine.llm.chat(
          [{ role: 'system', content: prompt }, { role: 'user', content: '请生成今日的管理反思问题' }],
          { stream: false, max_tokens: 100 }
        );

        const question = (response.content || '今天你们班最需要你关注的一个学员是谁？为什么？').trim();
        const key = `aq_${todayStr()}`;

        cache[adminId] = { question, key, date: todayStr(), generatedAt: beijingISO() };
        // 凌晨生成也写入 checkin_records
        store.writeRecord(adminId, {
          memberId: adminId, type: 'question_generated', question, text: null, source: 'midnight_llm',
          timestamp: beijingISO()
        });
        console.log(`[PushScheduler] 凌晨生成 → ${adminId}: "${question}"`);
      } catch (e) {
        console.error(`[PushScheduler] 凌晨生成失败 ${adminId}:`, e.message);
        cache[adminId] = { question: '今天你们班最需要你关注的一个学员是谁？为什么？', key: `aq_${todayStr()}`, date: todayStr(), generatedAt: beijingISO() };
      }
    } else {
      cache[adminId] = { question: '今天你们班最需要你关注的一个学员是谁？为什么？', key: `aq_${todayStr()}`, date: todayStr(), generatedAt: beijingISO() };
    }

    await new Promise(r => setTimeout(r, 500));
  }

  writeQuestionsCache(cache);
  console.log(`[PushScheduler] 凌晨生成完成，${onlineAdmins.length} 个管理员`);
}

function getOnlineAdminBots(wechatManager) {
  if (!wechatManager) return [];
  const status = wechatManager.getStatus();
  if (!status || !status.bots) return [];
  return status.bots.filter(b => b.isAdmin && b.loggedIn);
}

function getOnlineMemberBots(wechatManager) {
  if (!wechatManager) return [];
  const status = wechatManager.getStatus();
  if (!status || !status.bots) return [];
  return status.bots.filter(b => !b.isAdmin && b.loggedIn);
}

function readJSON(filename) {
  try {
    return JSON.parse(fs.readFileSync(getDataPath( filename), 'utf-8'));
  } catch { return []; }
}

function getCurrentWeek() {
  // 按当前学期起点计算周次（config.startDate 为旧全局起点，学期化后不再维护）
  try {
    return getCurrentSemesterWeek();
  } catch {
    return 1;
  }
}

// 学员每日一问生成（HTTP 回环复用 /api/checkin/student-question：LLM 个性化生成 + 当天缓存）
async function fetchStudentQuestion(memberId) {
  try {
    const PORT = process.env.PORT || 3001;
    const res = await axios.post(`http://127.0.0.1:${PORT}/api/checkin/student-question`, { memberId }, { timeout: 30000 });
    return (res.data?.question || '').trim() || '今天有什么让你觉得值得记住的事？';
  } catch (e) {
    return '今天有什么让你觉得值得记住的事？';
  }
}

// 主启动函数
function start(pushManager, getWechatManager, getEngine, getSteward) {
  const wechatReady = () => getWechatManager ? getWechatManager() : null;
  const engineReady = () => getEngine ? getEngine() : null;
  // 单号管家（dsh 底座）：在线时每日一问/日程通知走 AI 主动消息（拼接入上下文）
  const stewardReady = () => {
    const st = getSteward ? getSteward() : null;
    if (!st || !st.getStatus) return null;
    try { return st.getStatus().online ? st : null; } catch { return null; }
  };
  const schedulePushToAdmins = async (label) => {
    const wm = wechatReady();
    const st = stewardReady();
    const today = todayStr();
    let aiSent = 0, sent = 0;

    // ① steward 在线：绑定的班长/指导员 → AI 主动消息（问题进 dsh 上下文，
    //    管理员回复自然衔接对话，AI 调 class_submit_checkin 落库）+ JPush（App 通道保留）
    if (st) {
      const members = loadMembers();
      const bound = new Set(st.getBindings().map(b => String(b.memberId)));
      for (const m of members) {
        if (!m.id || !m.isBackbone || (m.position !== '班长' && m.position !== '指导员')) continue;
        if (!bound.has(String(m.id))) continue;
        if (hasAnsweredToday(m.id)) continue;
        const cacheEntry = getCachedAdminQuestion(String(m.id));
        const question = cacheEntry?.question || '今天你们班最需要你关注的一个学员是谁？为什么？';
        const r = await st.sendProactiveMessage(String(m.id), 'daily_question', { question })
          .catch(e => ({ success: false, error: e.message }));
        if (r?.success) {
          aiSent++;
          console.log(`[PushScheduler] ${label} AI 每日一问 → ${m.name}(${m.id})`);
        } else {
          console.warn(`[PushScheduler] ${label} AI 每日一问失败 ${m.id}: ${r?.error}`);
        }
        const extras = JSON.stringify({ route: 'dailyQuestion', memberId: String(m.id), date: today });
        try {
          await pushManager.sendJPushWithExtras(String(m.id), getRandomAdminMessage(), question, extras);
        } catch (e) {
          await pushManager.sendPushToMember(String(m.id), question, question).catch(() => {});
        }
        await new Promise(r2 => setTimeout(r2, 2000));
      }

      // ①' 管理员上下文（微信「管理员登录 名称 管理员密码」注册的独立对话上下文）：
      //     同样收管理员版每日一问（可用 class_set_prefs 自行开关；回答走会话内
      //     class_submit_checkin 落库，hasAnsweredToday 按上下文 id 判重）
      const adminCtxIds = [...bound].filter(id => id.startsWith('admin-'));
      for (const ctxId of adminCtxIds) {
        if (hasAnsweredToday(ctxId)) continue;
        const cacheEntry = getCachedAdminQuestion(ctxId);
        const question = cacheEntry?.question || '今天你们班最需要你关注的一个学员是谁？为什么？';
        const r = await st.sendProactiveMessage(ctxId, 'daily_question', { question })
          .catch(e => ({ success: false, error: e.message }));
        if (r?.success) {
          aiSent++;
          console.log(`[PushScheduler] ${label} AI 每日一问 → ${ctxId}（管理员上下文）`);
        } else if (!r?.skipped) {
          console.warn(`[PushScheduler] ${label} AI 每日一问失败 ${ctxId}: ${r?.error}`);
        }
        await new Promise(r2 => setTimeout(r2, 2000));
      }
    }

    // ② per-member Bot 兜底（steward 未覆盖的在线管理员；与原逻辑一致）
    const onlineAdmins = getOnlineAdminBots(wm);
    for (const admin of onlineAdmins) {
      const adminId = admin.memberId;
      if (hasAnsweredToday(adminId)) continue;

      const msg = getRandomAdminMessage();
      const cacheEntry = getCachedAdminQuestion(adminId);
      const question = cacheEntry?.question || '今天你们班最需要你关注的一个学员是谁？为什么？';

      // JPush 推送
      const extras = JSON.stringify({ route: 'dailyQuestion', memberId: adminId, date: today });
      try {
        await pushManager.sendJPushWithExtras(adminId, msg, question, extras);
        console.log(`[PushScheduler] ${label} JPush → ${adminId}`);
      } catch (e) {
        console.log(`[PushScheduler] ${label} JPush fallback → ${adminId}`);
        await pushManager.sendPushToMember(adminId, msg, question).catch(() => {});
      }

      // 微信推送（per-member Bot 静态文本）
      const wechatText = `📋 ${question}\n\n${msg}\n（直接回复这条消息即可回答）`;
      try {
        const wxResult = await wm.sendToMember(adminId, wechatText);
        if (wxResult.success) {
          console.log(`[PushScheduler] ${label} WeChat → ${adminId}`);
        }
      } catch (e) {}

      sent++;
      await new Promise(r => setTimeout(r, 300));
    }

    console.log(`[PushScheduler] ${label} 管理员推送完成：AI ${aiSent} 条 / 静态 ${sent} 条`);
    return aiSent + sent;
  };

  const schedulePushToMembers = async (label) => {
    const members = loadMembers();
    const st = stewardReady();
    const today = todayStr();
    let aiSent = 0, sent = 0;

    // ① steward 在线：已绑定学员 → AI 主动消息（个性化问题生成 + 进 dsh 上下文，
    //    学员回复自然衔接对话，AI 调 class_submit_checkin 落库）。班长/指导员在管理员分支已发，跳过
    if (st) {
      const bound = new Set(st.getBindings().map(b => String(b.memberId)));
      for (const m of members) {
        if (!m.id || !bound.has(String(m.id))) continue;
        if (m.isBackbone && (m.position === '班长' || m.position === '指导员')) continue;
        if (hasAnsweredToday(m.id)) continue;
        const question = await fetchStudentQuestion(String(m.id));   // 回环生成（当天缓存）
        const r = await st.sendProactiveMessage(String(m.id), 'daily_question', { question })
          .catch(e => ({ success: false, error: e.message }));
        if (r?.success) {
          aiSent++;
          console.log(`[PushScheduler] ${label} AI 每日一问 → ${m.name}(${m.id})`);
        } else {
          console.warn(`[PushScheduler] ${label} AI 每日一问失败 ${m.id}: ${r?.error}`);
        }
        await new Promise(r2 => setTimeout(r2, 2000));
      }
    }

    // ② JPush（App 通道，原逻辑不变）
    for (const m of members) {
      if (!m.id) continue;
      if (hasAnsweredToday(m.id)) continue;
      if (!pushManager.hasAnyPushSubscription(m.id)) continue;

      const msg = getRandomMessage();
      const extras = JSON.stringify({ route: 'dailyQuestion', memberId: m.id, date: today });

      try {
        await pushManager.sendJPushWithExtras(m.id, msg, `${m.name}，${msg}`, extras);
        sent++;
        console.log(`[PushScheduler] ${label} → ${m.name}(${m.id}): "${msg}"`);
      } catch (e) {
        await pushManager.sendPushToMember(m.id, msg, `${m.name}，${msg}`);
        sent++;
      }

      await new Promise(r => setTimeout(r, 100));
    }

    console.log(`[PushScheduler] ${label} 学员推送完成：AI ${aiSent} 条 / JPush ${sent} 条`);
    return aiSent + sent;
  };

  const checkAndRun = async () => {
    const now = beijingNow();
    const h = now.getHours();
    const m = now.getMinutes();
    const date = todayStr();

    // 凌晨 00:00-00:02 自动生成管理员每日一问
    if (h === 0 && m >= 0 && m <= 2) {
      const genKey = `gen_${date}`;
      if (global._pushLastGen !== genKey) {
        global._pushLastGen = genKey;
        generateAdminQuestions(wechatReady(), engineReady()).catch(e =>
          console.error('[PushScheduler] 凌晨生成失败:', e.message)
        );
      }
    }

    // 每日一问只在 22:00 推送
    if (h === 22 && m >= 0 && m <= 2) {
      const runKey = `push_${date}_${h}`;
      if (global._pushLastRun !== runKey) {
        global._pushLastRun = runKey;
        schedulePushToAdmins(`${h}:00`);
        schedulePushToMembers(`${h}:00`);
      }
    }

    // 每日 08:00-08:05 自动生成管理日报（5分钟窗口防止重启错过）
    if (h === 8 && m >= 0 && m <= 5) {
      const reportKey = `report_${date}`;
      if (global._reportLastGen !== reportKey) {
        global._reportLastGen = reportKey;
        const isMonday = beijingNow().getDay() === 1;
        const triggerType = isMonday ? 'monday' : 'scheduled';
        dailyReport.generateReport(engineReady(), triggerType, wechatReady(), pushManager).then(report => {
          if (!report) {
            const yesterday = beijingNow();
            yesterday.setDate(yesterday.getDate() - 1);
            const yd = yesterday.toISOString().substring(0, 10);
            dailyReport.broadcastNoData(wechatReady(), pushManager, yd).catch(e =>
              console.error('[PushScheduler] 无数据通知失败:', e.message)
            );
          }
        }).catch(e =>
          console.error('[PushScheduler] 管理日报生成失败:', e.message)
        );
      }
    }

    // 每周一 09:00-09:05 给上周未完成评分的学员发推送提醒
    if (now.getDay() === 1 && h === 9 && m >= 0 && m <= 5) {
      const monKey = `mon_unscored_${date}`;
      if (global._pushLastMonUnscored !== monKey) {
        global._pushLastMonUnscored = monKey;
        remindUnscoredMembers(pushManager).catch(e =>
          console.error('[PushScheduler] 周一未评分提醒失败:', e.message)
        );
      }
    }

    // 检查到期的日程提醒
    const dueSchedules = scheduleStore.getDueSchedules();
    for (const sched of dueSchedules) {
      scheduleStore.markNotified(sched.id);
      const title = sched.title || '日程提醒';
      const desc = sched.description || '';
      const msg = `📅 ${title}\n${desc}`;
      const wechat = wechatReady();
      const st = stewardReady();
      // 单人通知：steward 在线 → AI 主动消息（人设口吻 + 进 dsh 上下文）；
      // 未绑定/失败 → per-member Bot 静态文本兜底
      const notifyOne = async (mid) => {
        if (st) {
          const r = await st.sendProactiveMessage(String(mid), 'schedule_notify',
            { title, description: desc, dueAt: sched.dueAt }).catch(e => ({ success: false, error: e.message }));
          if (r?.success) return 'ai';
          if (r && !/未绑定/.test(r.error || '')) console.warn(`[PushScheduler] AI 日程提醒失败 ${mid}: ${r.error}`);
        }
        if (wechat) {
          wechat.sendToMember(mid, msg).catch(() => {});
          return 'static';
        }
        return 'none';
      };
      if (sched.scope === 'group' && sched.groupChatroomId) {
        // 群日程（独立类型）：到点只在该群提醒（AI 口吻发群里），不推全员、不逐人私聊
        if (st) {
          st.sendProactiveToGroup(sched.groupChatroomId, 'schedule_notify',
            { title, description: desc, dueAt: sched.dueAt }).catch(e =>
            console.warn(`[PushScheduler] 群日程提醒失败 ${sched.groupChatroomId}: ${e.message}`));
        }
        console.log(`[PushScheduler] 群日程提醒: ${sched.id} "${title}" → 群 ${sched.groupChatroomId}`);
      } else if (sched.isGlobal) {
        // 全员公共日程：不发群（群日程才发群）、不逐人私聊生成 AI 消息——
        // AI 只生成一次（系统管理员会话），文本群发所有成员私聊，其余走 JPush 静态兜底
        try {
          const members = JSON.parse(fs.readFileSync(getDataPath('members.json'), 'utf-8'));
          let genText = '';
          if (st) {
            // 独立系统会话（人设相同、无成员/管理员上下文）：AI 只生成一次，供全员群发
            const r = await st.generateProactiveContent('sys-schedule', 'schedule_notify',
              { title, description: desc, dueAt: sched.dueAt }).catch(e => ({ error: e.message }));
            if (r?.success && r.content) genText = r.content;
            console.log(`[PushScheduler] 公共日程 "${title}" AI 生成 1 次（独立系统会话）`);
          }
          const finalMsg = genText || msg;
          let sent = 0;
          for (const m of members) {
            if (!m.id) continue;
            pushManager?.sendPushToMember(String(m.id), title, desc.substring(0, 100) || '您有一个日程提醒').catch(() => {});
            if (st) {
              const ok = await st.sendToMember(String(m.id), finalMsg).then(r => r?.success).catch(() => false);
              if (ok) {
                sent++;
                // 已绑定成员：注入静默事件进上下文（她下次说话时 AI 知道发过这个日程）
                st.injectMemberEvent(String(m.id), `已给你发过全员公共日程提醒「${title}」${desc ? '：' + desc : ''}`);
              }
            }
            else if (wechat) { wechat.sendToMember(m.id, finalMsg).catch(() => {}); sent++; }
          }
          // 管理员上下文同样收（同一文本，不单独生成）
          if (st) {
            for (const b of st.getBindings()) {
              const id = String(b.memberId);
              if (!id.startsWith('admin-')) continue;
              if (await st.sendToMember(id, finalMsg).then(r => r?.success).catch(() => false)) {
                sent++;
                st.injectMemberEvent(id, `已给你发过全员公共日程提醒「${title}」${desc ? '：' + desc : ''}`);
              }
            }
          }
          console.log(`[PushScheduler] 日程提醒: ${sched.id} "${title}" → 全员群发 ${sent} 人（AI 生成 1 次，不发群）`);
        } catch (e) {}
      } else {
        for (const mid of sched.targetMemberIds) {
          pushManager?.sendPushToMember(mid, title, desc.substring(0, 100) || '您有一个日程提醒').catch(() => {});
          await notifyOne(mid);
        }
        console.log(`[PushScheduler] 日程提醒: ${sched.id} "${title}" → ${sched.targetMemberIds.length}人`);
      }
    }

    // 检查到期的定时任务（automation：once/weekly/interval——到点唤醒 AI 执行预设指令并注入上下文）
    const dueAutos = automationStore.getDueAutomations();
    for (const auto of dueAutos) {
      automationStore.markRun(auto.id);
      const owner = String(auto.runFor || auto.createdBy || '');
      const st = stewardReady();
      // ① 单号管家（dsh）在线：目标会话唤醒 AI 生成 → 微信发出（指令与输出都进该会话上下文）
      if (st && typeof st.runAutomation === 'function') {
        const r = await st.runAutomation(auto).catch(e => ({ success: false, error: e.message }));
        if (r?.success) {
          console.log(`[PushScheduler] 定时任务完成: ${auto.id} "${auto.name || ''}" → ${owner}`);
        } else {
          console.warn(`[PushScheduler] 定时任务 AI 通道失败 ${auto.id}: ${r?.error}（回退静态兜底）`);
          const wechat = wechatReady();
          if (wechat && !owner.startsWith('guest-')) {
            wechat.sendToMember(owner, `🤖 [定时任务] ${auto.name || ''}\n\n${auto.prompt}`).catch(() => {});
          }
        }
        continue;
      }
      // ② 旧引擎/静态兜底（guest 目标只走 steward 通道，不在此兜底）
      const eng = engineReady();
      if (eng && !owner.startsWith('guest-')) {
        try {
          const result = await eng.processMessage(owner, auto.prompt, null, { isAdmin: true });
          const wechat = wechatReady();
          if (wechat && result?.content) {
            await wechat.sendToMember(owner, `🤖 [定时任务] ${auto.name || ''}\n\n${result.content}`);
          }
          console.log(`[PushScheduler] 定时任务完成: ${auto.id} "${auto.name || ''}"`);
        } catch (e) {
          console.error(`[PushScheduler] 定时任务执行失败 ${auto.id}:`, e.message);
          if (wechatReady()) {
            wechatReady().sendToMember(owner, `⚠️ 定时任务"${auto.name || ''}"执行失败: ${e.message}`).catch(() => {});
          }
        }
      }
    }
  };

  setInterval(checkAndRun, 60000);
  console.log('[PushScheduler] 已启动（凌晨生成 + 22:00 每日一问推送 + 周一未评分提醒）');
}

// 周一给上周未完成评分的学员发推送提醒
async function remindUnscoredMembers(pushManager) {
  const lastWeek = getCurrentWeek() - 1;
  if (lastWeek < 1) {
    console.log('[PushScheduler] 周一未评分提醒: 无上周数据可查，跳过');
    return;
  }

  const members = loadMembers();
  if (members.length === 0) {
    console.log('[PushScheduler] 周一未评分提醒: 无成员数据，跳过');
    return;
  }

  // 用 DataQueryTool 查询上周评分状态
  const dqTool = new DataQueryTool();
  let evalStatus;
  try {
    evalStatus = await dqTool.execute(
      { dataType: 'evaluation_status', week: lastWeek },
      { memberId: 'system', isAdmin: true }
    );
  } catch (e) {
    console.error('[PushScheduler] 周一未评分提醒: 查询评分状态失败:', e.message);
    return;
  }

  const incomplete = evalStatus.allIncomplete || [];
  if (incomplete.length === 0) {
    console.log(`[PushScheduler] 周一未评分提醒: 上周(${lastWeek})全员已完成评分，跳过`);
    return;
  }

  const title = `第${lastWeek}周评分未完成提醒`;
  let sent = 0;
  let noSubscription = 0;

  for (const m of incomplete) {
    const memberId = String(m.id || m.memberId);
    if (!memberId) continue;

    const name = m.name || memberId;
    const missParts = [];
    if (m.missingSelf) missParts.push('自评');
    if (m.missingPeer) missParts.push('互评');
    const missText = missParts.join('+') || '评分';

    const body = `${name}，你第${lastWeek}周的${missText}尚未完成，请尽快登录系统完成评分。`;

    // 优先用推送订阅，无订阅的也写 inbox 兜底（sendPushToMember 内部会处理）
    try {
      const result = await pushManager.sendPushToMember(memberId, title, body);
      if (result.success) {
        sent++;
        console.log(`[PushScheduler] 周一未评分提醒 → ${name}(${memberId}): ${missText}`);
      } else {
        noSubscription++;
      }
    } catch (e) {
      console.error(`[PushScheduler] 周一未评分提醒失败 ${name}(${memberId}):`, e.message);
    }

    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`[PushScheduler] 周一未评分提醒完成: 上周${lastWeek}周, 未完成${incomplete.length}人, 已推送${sent}人, 无订阅${noSubscription}人`);
}

module.exports = { start, hasAnsweredToday, PUSH_MESSAGES, getCachedAdminQuestion, getCachedQuestion, cacheQuestion };
