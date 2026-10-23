const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const store = require('../data/checkin_records/store');
const conversationMemory = require('../agent/memory/ConversationMemory');
const { beijingDateStr, beijingDateStrOffset, beijingNow } = require('../utils/beijingTime');
const { getDataPath } = require('../utils/dataPath');
const { getBMIFilePath } = require('../utils/semester');
const REPORTS_FILE = getDataPath('daily_reports.json');

// 本地读取数据文件（避免与 index.js 形成循环依赖）
function readJSONLocal(filename) {
  try {
    const p = getDataPath(filename);
    if (!fs.existsSync(p)) return [];
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch { return []; }
}

function readBMILocal(week) {
  try {
    const p = getBMIFilePath(week);
    if (!fs.existsSync(p)) return {};
    const buf = fs.readFileSync(p);
    const decompressed = zlib.gunzipSync(buf);
    const text = decompressed.toString('utf8');
    if (!text || text.trim() === '') return {};
    return JSON.parse(text);
  } catch { return {}; }
}

// 计算周次对应的日期范围字符串（用于 BMI 报告日期标签）
function weekDateRange(week, startDateStr) {
  try {
    const startDate = new Date(startDateStr || '2026-03-02T00:00:00+08:00');
    const weekStart = new Date(startDate);
    weekStart.setDate(startDate.getDate() + (week - 1) * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    const fmt = (d) => `${d.getMonth() + 1}.${d.getDate()}`;
    return `${fmt(weekStart)}—${fmt(weekEnd)}`;
  } catch { return `第${week}周`; }
}

/**
 * 构建数据上传触发的报告数据 section
 * @param {string} triggerType - 'fitness_score' | 'academic_score' | 'bmi' | 'notice'
 * @param {object} uploadContext - 上传端点传入的上下文（含 week/month/count/notFoundNames 等）
 * @param {Array} members - 成员名册
 * @returns {{dataTypeLabel, dataDate, lines, notFoundNames}}
 */
function buildDataTriggerSection(triggerType, uploadContext, members) {
  const ctx = uploadContext || {};
  const memberMap = new Map((members || []).map(m => [String(m.id), m]));
  const result = { dataTypeLabel: '', dataDate: '', lines: [], notFoundNames: [] };

  if (triggerType === 'bmi') {
    result.dataTypeLabel = 'BMI 数据';
    result.timeDimension = '按周次（数据所属周次，非导入时间）';
    const week = parseInt(ctx.week, 10);
    if (!week) return result;
    const config = loadConfig();
    result.dataDate = `第${week}周(${weekDateRange(week, config.startDate)})`;
    const bmiData = readBMILocal(week);
    const entries = Object.entries(bmiData);
    if (entries.length === 0) return result;
    result.lines.push(`- 周次: 第${week}周`);
    result.lines.push(`- 导入人数: ${ctx.count || entries.length} 人`);
    // 统计体重分布
    const weights = [];
    for (const [mid, info] of entries) {
      if (info && info.weight) {
        const w = parseFloat(info.weight);
        if (!isNaN(w)) weights.push({ memberId: mid, weight: w });
      }
    }
    if (weights.length > 0) {
      const sorted = weights.slice().sort((a, b) => b.weight - a.weight);
      const avg = weights.reduce((s, x) => s + x.weight, 0) / weights.length;
      const max = sorted[0];
      const min = sorted[sorted.length - 1];
      const overThreshold = weights.filter(w => {
        const m = memberMap.get(String(w.memberId));
        // 粗略：>80 视为偏高（无性别/身高细分）
        return w.weight > 80;
      });
      result.lines.push(`- 体重范围: ${min.weight.toFixed(1)} - ${max.weight.toFixed(1)} kg`);
      result.lines.push(`- 平均体重: ${avg.toFixed(1)} kg`);
      const maxName = memberMap.get(String(max.memberId))?.name || max.memberId;
      const minName = memberMap.get(String(min.memberId))?.name || min.memberId;
      result.lines.push(`- 最高: ${maxName} (${max.weight.toFixed(1)} kg)`);
      result.lines.push(`- 最低: ${minName} (${min.weight.toFixed(1)} kg)`);
      if (overThreshold.length > 0) {
        result.lines.push(`- 体重 >80kg 的成员(${overThreshold.length}人): ${overThreshold.slice(0, 10).map(w => memberMap.get(String(w.memberId))?.name || w.memberId).join('、')}${overThreshold.length > 10 ? ' 等' : ''}`);
      }
    }
    if (ctx.notFoundNames && ctx.notFoundNames.length > 0) {
      result.notFoundNames = ctx.notFoundNames;
    }
  } else if (triggerType === 'fitness_score') {
    result.dataTypeLabel = '体能成绩';
    result.timeDimension = '按月份（数据所属月份，非导入时间）';
    const month = ctx.month || beijingDateStr().substring(0, 7);
    result.dataDate = `${month}`;
    const fitnessScores = readJSONLocal('fitness_scores.json');
    // 筛选本月记录
    const monthRecords = [];
    for (const item of fitnessScores) {
      if (!item || !item.history) continue;
      const rec = item.history.find(h => h.month === month);
      if (rec) {
        monthRecords.push({ memberId: item.memberId, name: item.name, scores: rec.scores || {} });
      }
    }
    if (monthRecords.length === 0) return result;
    result.lines.push(`- 月份: ${month}`);
    result.lines.push(`- 导入人数: ${ctx.count || monthRecords.length} 人`);
    // 统计各项目参与人数与异常（空值/不及格）
    const allKeys = new Set();
    monthRecords.forEach(r => Object.keys(r.scores).forEach(k => allKeys.add(k)));
    const keyStats = [];
    for (const key of allKeys) {
      let valid = 0, empty = 0;
      monthRecords.forEach(r => {
        const v = r.scores[key];
        if (v === undefined || v === null || v === '') empty++;
        else valid++;
      });
      keyStats.push({ key, valid, empty });
    }
    keyStats.sort((a, b) => b.valid - a.valid);
    const topItems = keyStats.slice(0, 8);
    result.lines.push(`- 项目数: ${allKeys.size} 项`);
    result.lines.push(`- 主要项目完成情况:`);
    for (const s of topItems) {
      result.lines.push(`  - ${s.key}: ${s.valid} 人有效, ${s.empty} 人空缺`);
    }
    if (ctx.notFoundMembers && ctx.notFoundMembers.length > 0) {
      result.notFoundNames = ctx.notFoundMembers;
    }
  } else if (triggerType === 'academic_score') {
    result.dataTypeLabel = '学业成绩';
    // 学业成绩无时间字段，用导入日期作为 dataDate，并明确告知 LLM
    result.timeDimension = '无时间维度（数据为最新快照，导入时间即数据时间）';
    result.dataDate = beijingDateStr();
    const academicScores = readJSONLocal('academic_scores.json');
    if (academicScores.length === 0) return result;
    result.lines.push(`- 导入人数: ${ctx.count || academicScores.length} 人`);
    const subjects = ctx.subjects || [];
    if (subjects.length > 0) {
      result.lines.push(`- 科目: ${subjects.join('、')}`);
    }
    // 统计各科目平均分（如有数值）
    const subjectAvg = {};
    let count = 0;
    for (const s of academicScores) {
      if (!s || !s.scores) continue;
      count++;
      for (const [k, v] of Object.entries(s.scores)) {
        const num = typeof v === 'number' ? v : parseFloat(v);
        if (!isNaN(num)) {
          if (!subjectAvg[k]) subjectAvg[k] = { sum: 0, count: 0 };
          subjectAvg[k].sum += num;
          subjectAvg[k].count++;
        }
      }
    }
    const avgs = Object.entries(subjectAvg).map(([k, v]) => ({ subject: k, avg: v.sum / v.count, count: v.count }));
    avgs.sort((a, b) => b.avg - a.avg);
    if (avgs.length > 0) {
      result.lines.push(`- 科目平均分:`);
      for (const a of avgs.slice(0, 10)) {
        result.lines.push(`  - ${a.subject}: ${a.avg.toFixed(1)} (${a.count} 人)`);
      }
    }
  } else if (triggerType === 'notice') {
    result.dataTypeLabel = '通报';
    result.timeDimension = '按通报自带 time 字段（每条通报有独立时间）';
    const notices = readJSONLocal('notices.json');
    if (notices.length === 0) return result;
    // 取最新一条通报的 time 作为 dataDate
    const latest = notices[notices.length - 1];
    const noticeTime = latest && (latest.time || latest.createdAt);
    result.dataDate = noticeTime ? String(noticeTime).substring(0, 10) : beijingDateStr();
    result.lines.push(`- 通报总数: ${notices.length}`);
    // 最近 5 条
    const recent = notices.slice(-5).reverse();
    result.lines.push(`- 最近通报:`);
    for (const n of recent) {
      const name = memberMap.get(String(n.memberId))?.name || n.memberId || '系统';
      const content = (n.content || '').substring(0, 80);
      const t = (n.time || '').substring(0, 10);
      result.lines.push(`  - [${t}] ${name}: ${content}`);
    }
  } else if (triggerType === 'rank_score') {
    result.dataTypeLabel = '学习成绩排名';
    // 排名数据按学期组织，无单一时间字段，用导入日期作为 dataDate
    result.timeDimension = '按学期（数据含多学期成绩，无单一时间字段，导入即最新快照）';
    result.dataDate = beijingDateStr();
    const rankScores = readJSONLocal('rank_scores.json');
    if (rankScores.length === 0) return result;
    result.lines.push(`- 导入人数: ${ctx.count || rankScores.length} 人`);
    // 学期列表
    const semesters = ctx.semesters || [];
    if (semesters.length > 0) {
      result.lines.push(`- 学期: ${semesters.join('、')}`);
    }
    // 统计总排名前列的学员
    const totalRanked = [];
    for (const r of rankScores) {
      if (!r || !r.semesterScores) continue;
      const totalEntry = r.semesterScores.find(s => s.semester === '总' || s.semester === '总评');
      if (totalEntry && typeof totalEntry.rank === 'number') {
        totalRanked.push({
          memberId: r.memberId,
          name: r.name || memberMap.get(String(r.memberId))?.name || r.memberId,
          score: totalEntry.score,
          rank: totalEntry.rank
        });
      }
    }
    totalRanked.sort((a, b) => a.rank - b.rank);
    if (totalRanked.length > 0) {
      result.lines.push(`- 总排名前 10:`);
      for (const t of totalRanked.slice(0, 10)) {
        result.lines.push(`  - 第${t.rank}名: ${t.name} (${t.score}分)`);
      }
      // 排名变化样本（如有 yearRanks）
      const unchanged = [];
      const changed = [];
      for (const r of rankScores) {
        if (!r.yearRanks) continue;
        const changeEntry = r.yearRanks.find(y => y.name && y.name.includes('总排名变化'));
        if (changeEntry) {
          const name = r.name || memberMap.get(String(r.memberId))?.name || r.memberId;
          const v = String(changeEntry.rank).trim();
          if (v === '不变' || v === '0') unchanged.push(name);
          else changed.push({ name, change: v });
        }
      }
      if (unchanged.length > 0) {
        result.lines.push(`- 排名不变: ${unchanged.length} 人`);
      }
      if (changed.length > 0) {
        result.lines.push(`- 排名变化(${changed.length}人):`);
        for (const c of changed.slice(0, 10)) {
          result.lines.push(`  - ${c.name}: ${c.change}`);
        }
      }
    }
  }

  return result;
}

function readReports() {
  try {
    if (!fs.existsSync(REPORTS_FILE)) return [];
    return JSON.parse(fs.readFileSync(REPORTS_FILE, 'utf-8'));
  } catch { return []; }
}

function writeReports(data) {
  fs.writeFileSync(REPORTS_FILE, JSON.stringify(data, null, 2));
}

function readJSON(filename) {
  try {
    return JSON.parse(fs.readFileSync(getDataPath(filename), 'utf-8'));
  } catch { return []; }
}

function loadMembers() {
  try { return JSON.parse(fs.readFileSync(getDataPath('members.json'), 'utf-8')); } catch { return []; }
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(getDataPath('config.json'), 'utf-8')); } catch { return {}; }
}

function todayStr(offsetDays = 0) {
  return offsetDays === 0 ? beijingDateStr() : beijingDateStrOffset(offsetDays);
}

function yesterdayStr() {
  return beijingDateStrOffset(-1);
}

function getCurrentWeek() {
  try {
    const config = loadConfig();
    const startDate = new Date(config.startDate);
    const now = beijingNow();
    return Math.max(1, Math.floor((now.getTime() - startDate.getTime()) / (7 * 24 * 60 * 60 * 1000)) + 1);
  } catch { return 1; }
}

function generateId() {
  return 'report_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

function getAdminMemberIds(wechatManager) {
  const ids = new Set();
  try {
    if (wechatManager) {
      const status = wechatManager.getStatus();
      if (status && status.bots) {
        status.bots.filter(b => b.isAdmin).forEach(b => ids.add(b.memberId));
      }
    }
    const bindings = readJSON('wechat_bindings.json');
    if (Array.isArray(bindings)) {
      bindings.forEach(b => { if (b.isAdmin && b.memberId) ids.add(b.memberId); });
    }
    if (ids.size === 0) {
      const registry = readJSON('wechat/bot_registry.json');
      if (Array.isArray(registry)) {
        registry.forEach(b => { if (b.isAdmin && b.memberId) ids.add(b.memberId); });
      }
    }
  } catch (e) {}
  return ids;
}

const WECHAT_CHUNK_SIZE = 1200;

async function sendWeChatChunked(wechatManager, memberId, fullText) {
  const chunks = [];
  let remaining = fullText;
  while (remaining.length > 0) {
    if (remaining.length <= WECHAT_CHUNK_SIZE) {
      chunks.push(remaining);
      remaining = '';
    } else {
      let cutPoint = remaining.lastIndexOf('\n', WECHAT_CHUNK_SIZE);
      if (cutPoint < WECHAT_CHUNK_SIZE * 0.6) {
        cutPoint = remaining.lastIndexOf('。', WECHAT_CHUNK_SIZE);
      }
      if (cutPoint < WECHAT_CHUNK_SIZE * 0.6) {
        cutPoint = remaining.lastIndexOf('，', WECHAT_CHUNK_SIZE);
      }
      if (cutPoint < WECHAT_CHUNK_SIZE * 0.4) {
        cutPoint = WECHAT_CHUNK_SIZE;
      }
      chunks.push(remaining.substring(0, cutPoint + (cutPoint < remaining.length ? 1 : 0)));
      remaining = remaining.substring(cutPoint + (cutPoint < remaining.length ? 1 : 0));
    }
  }

  let allSuccess = true;
  for (let i = 0; i < chunks.length; i++) {
    const prefix = chunks.length > 1 ? `(${i + 1}/${chunks.length})\n` : '';
    const text = prefix + chunks[i].trim();
    try {
      const result = await wechatManager.sendToMember(memberId, text);
      if (!result.success) allSuccess = false;
    } catch (e) {
      allSuccess = false;
      console.error(`[DailyReport] 微信分片发送失败 ${memberId} chunk ${i+1}:`, e.message);
    }
    if (i < chunks.length - 1) {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return allSuccess;
}

async function generateReport(agentEngine, triggerType, wechatManager, pushManager, uploadContext = null) {
  const members = loadMembers();
  const yesterday = yesterdayStr();
  const week = getCurrentWeek();
  const isMonday = beijingNow().getDay() === 1;

  // 数据触发时，报告主体针对上传的数据，而不是昨日 checkin
  const isDataTrigger = ['fitness_score', 'academic_score', 'bmi', 'notice', 'rank_score'].includes(triggerType);

  const adminIds = getAdminMemberIds(wechatManager);
  const studentMemberIds = new Set(members.filter(m => !adminIds.has(String(m.id))).map(m => String(m.id)));

  // 数据触发时只读取昨日 checkin 作为辅助信息（可能为空），不作为主体
  const checkinRecords = [];
  for (const member of members) {
    const mid = String(member.id);
    if (adminIds.has(mid)) continue;
    try {
      const records = store.readRecords(mid);
      const yesterdayRecords = records.filter(r => {
        const rDate = (r.timestamp || '').substring(0, 10);
        return rDate === yesterday;
      });
      yesterdayRecords.forEach(r => {
        checkinRecords.push({ ...r, memberName: member.name, memberClass: member.class, memberId: mid });
      });
    } catch (e) {}
  }

  const anomalyRecords = checkinRecords.filter(r =>
    r.anomalyDetected || (r.actions && r.actions.includes('auto_notified_admin'))
  );
  const notifiedRecords = checkinRecords.filter(r =>
    r.actions && r.actions.includes('notified_admin')
  );
  const questionRecords = checkinRecords.filter(r => r.type === 'question' && r.text);
  const checkinTextRecords = checkinRecords.filter(r => r.type === 'checkin' && r.text);
  const hasAnyStudentActivity = checkinRecords.length > 0;
  const hasAnomalous = anomalyRecords.length > 0 ||
    notifiedRecords.length > 0 ||
    questionRecords.length > 0 ||
    checkinTextRecords.length > 0;

  if (!hasAnyStudentActivity && !isMonday && !isDataTrigger) {
    console.log(`[DailyReport] ${yesterday} 无任何学员活动，跳过报告生成`);
    return null;
  }

  // 数据触发时，构建上传数据摘要（核心内容）；非数据触发时为 null
  const dataSection = isDataTrigger ? buildDataTriggerSection(triggerType, uploadContext, members) : null;
  const dataDate = dataSection ? dataSection.dataDate : yesterday;
  const hasDataContent = dataSection && dataSection.lines.length > 0;

  let reportText = '';
  let reportTitle = '';
  let summary = '';

  if (agentEngine && agentEngine.llm) {
    try {
      const sections = [];
      // 数据触发时，报告日期标注为数据所属日期，不是 yesterday
      const reportDateLabel = isDataTrigger && dataDate ? dataDate : yesterday;
      sections.push(`【日期】${reportDateLabel}`);
      if (isDataTrigger && dataSection) {
        sections.push(`【数据类型】${dataSection.dataTypeLabel}`);
        // 明确告诉 LLM 数据的时间维度，区分"数据所属时间"与"导入时间"
        const timeDimDesc = dataSection.timeDimension || '未指定';
        sections.push(`【数据时间维度】${timeDimDesc}`);
        sections.push(`【导入时间】${beijingNow().toISOString().substring(0, 19)} (北京时间)`);
      }
      sections.push(`【总学员数】${studentMemberIds.size}人（已排除管理员）`);
      sections.push('');

      // 数据触发时，把上传数据摘要放在最前面（报告主体）
      if (hasDataContent) {
        sections.push(`## ${dataSection.dataTypeLabel}上传摘要`);
        for (const line of dataSection.lines) {
          sections.push(line);
        }
        if (dataSection.notFoundNames && dataSection.notFoundNames.length > 0) {
          sections.push('');
          sections.push('### 未匹配成员（需人工确认）');
          for (const name of dataSection.notFoundNames) {
            sections.push(`- ${name}`);
          }
        }
        sections.push('');
      }

      const allAnomalySet = new Map();
      for (const r of anomalyRecords) {
        const key = r.memberId;
        if (!allAnomalySet.has(key)) {
          allAnomalySet.set(key, { memberName: r.memberName, memberClass: r.memberClass, anomalies: [] });
        }
        const entry = allAnomalySet.get(key);
        if (r.anomalySignals && r.anomalySignals.length > 0) {
          const signalMap = { consecutive_negative_mood: '连续情绪低迷', injury: '伤病情信号', social_risk: '人际冲突信号' };
          r.anomalySignals.forEach(s => {
            if (!entry.anomalies.includes(signalMap[s] || s)) {
              entry.anomalies.push(signalMap[s] || s);
            }
          });
        }
      }

      if (anomalyRecords.length > 0) {
        sections.push('## LLM自动检测异常（速记/每日一问）');
        for (const [mid, entry] of allAnomalySet) {
          sections.push(`- **${entry.memberName}**（${entry.memberClass}）：${entry.anomalies.join('、')}`);
          const recent = anomalyRecords.find(r => r.memberId === mid && r.text);
          if (recent && recent.text) {
            sections.push(`  > ${recent.text.substring(0, 100)}`);
          }
        }
        sections.push('');
      }

      if (notifiedRecords.length > 0) {
        sections.push('## 学员主动通知管理员');
        for (const r of notifiedRecords) {
          sections.push(`- **${r.memberName}**（${r.memberClass}）：${(r.text || '(无详细内容)').substring(0, 200)}`);
        }
        sections.push('');
      }

      if (questionRecords.length > 0) {
        sections.push('## 每日一问回答');
        for (const r of questionRecords) {
          sections.push(`- **${r.memberName}**（${r.memberClass}）：${r.text.substring(0, 150)}`);
        }
        sections.push('');
      }

      if (checkinTextRecords.length > 0) {
        sections.push('## 速记内容');
        for (const r of checkinTextRecords) {
          sections.push(`- **${r.memberName}**（${r.memberClass}）：${r.text.substring(0, 150)}`);
        }
        sections.push('');
      }

      if (isMonday || triggerType === 'monday') {
        sections.push('## 评分完成情况');
        try {
          const DataQueryTool = require('../agent/tools/DataQueryTool');
          const dqTool = new DataQueryTool();
          const queryWeek = isMonday ? Math.max(1, week - 1) : week;
          const evalResult = await dqTool.execute({ dataType: 'evaluation_status', week: queryWeek }, { memberId: 'system' });
          if (evalResult) {
            const studentIncomplete = (evalResult.allIncomplete || []).filter(m =>
              studentMemberIds.has(String(m.memberId))
            );
            sections.push(`- 自评完成率：${evalResult.selfCompletionRate || 0}%`);
            sections.push(`- 互评完成率：${evalResult.peerCompletionRate || 0}%`);
            if (studentIncomplete.length > 0) {
              sections.push('- **未完成评分的学员：**');
              const byClass = {};
              studentIncomplete.forEach(m => {
                if (!byClass[m.class]) byClass[m.class] = [];
                byClass[m.class].push(m.name);
              });
              for (const [cls, names] of Object.entries(byClass)) {
                sections.push(`  - ${cls}：${names.join('、')}`);
              }
            } else {
              sections.push('- 全部学员已完成评分 ✅');
            }
          }
        } catch (e) {
          console.error('[DailyReport] 评分查询失败:', e.message);
          sections.push('- 评分数据查询失败，请手动查看');
        }
        sections.push('');
      }

      // 决定报告日期标签：数据触发用上传数据日期，其他用 yesterday
      const reportDateForTitle = isDataTrigger && dataDate ? dataDate : yesterday;

      if (!hasAnomalous && !isMonday && !(triggerType === 'monday') && !isDataTrigger) {
        reportText = `📊 管理日报（${reportDateForTitle}）\n\n昨日无异常数据，所有学员状态正常。`;
        reportTitle = `📊 管理日报（${reportDateForTitle}）`;
        summary = '昨日无异常数据';
      } else {
        const contextForLLM = sections.join('\n');
        let dataFocusHint;
        if (isDataTrigger && hasDataContent) {
          const timeDim = dataSection.timeDimension || '';
          dataFocusHint = `2. **重点分析上传的${dataSection.dataTypeLabel}数据**：统计范围、值得关注的成员、与历史趋势的对比（如有）
3. 对数据中的异常值（如 BMI 过高/过低、成绩波动大）给出简要分析和建议
4. **数据时间维度**: ${timeDim}。报告中引用数据时,请明确标注数据所属的时间维度（如"第17周(6.22—6.28)的 BMI 数据显示..."）,不要混淆"数据时间"与"导入时间"。导入时间仅供审计,不代表数据本身的时间范围。`;
        } else {
          dataFocusHint = `2. 重点分析速记和每日一问中自动检测的异常信号，以及学员主动通知管理员的信息
3. 对异常情况给出简要分析和建议`;
        }
        const prompt = `你是管理分析助手。请根据以下数据生成一份管理日报。

${contextForLLM}

【要求】
1. 用中文撰写，语气专业但温暖
${dataFocusHint}
5. ${isMonday || triggerType === 'monday' ? '包含评分完成情况分析' : '如无评分完成情况数据则跳过此项'}
6. 报告用 Markdown 格式，标题以"📊 管理日报"开头，长度 200-400 字
7. 如果没有标记异常且没有通知，简短说明"昨日各项数据正常"即可`;

        const response = await agentEngine.llm.chat(
          [{ role: 'system', content: prompt }, { role: 'user', content: '请生成管理日报' }],
          { stream: false, max_tokens: 1000 }
        );

        reportText = (response.content || '').trim();
        if (!reportText) {
          reportText = `📊 管理日报（${reportDateForTitle}）\n\nLLM 生成失败，请查看原始数据。\n\n${contextForLLM}`;
        }
        reportTitle = `📊 管理日报（${reportDateForTitle}）`;
        const summaryLines = reportText.split('\n').filter(l => l.trim() && !l.startsWith('#'));
        summary = summaryLines.slice(0, 2).join(' ').substring(0, 150);
      }
    } catch (e) {
      console.error('[DailyReport] LLM 生成失败:', e.message);
      const reportDateForTitle = isDataTrigger && dataDate ? dataDate : yesterday;
      reportText = `📊 管理日报（${reportDateForTitle}）\n\nLLM 生成失败：${e.message}`;
      reportTitle = `📊 管理日报（${reportDateForTitle}）`;
      summary = 'LLM 生成失败';
    }
  } else {
    const reportDateForTitle = isDataTrigger && dataDate ? dataDate : yesterday;
    reportText = `📊 管理日报（${reportDateForTitle}）\n\nLLM 服务未初始化`;
    reportTitle = `📊 管理日报（${reportDateForTitle}）`;
    summary = 'LLM 服务未初始化';
  }

  const report = {
    id: generateId(),
    type: triggerType === 'monday' ? 'monday' : triggerType === 'scheduled' ? 'daily' : triggerType,
    title: reportTitle,
    content: reportText,
    summary,
    generatedAt: beijingNow().toISOString(),
    date: isDataTrigger && dataDate ? dataDate : yesterday,
    trigger: triggerType,
    sentTo: [],
    metadata: {
      totalStudents: studentMemberIds.size,
      anomalousCount: anomalyRecords.length,
      notifiedCount: notifiedRecords.length,
      week: getCurrentWeek(),
      isMonday: isMonday,
      // 记录上传数据上下文，便于审计
      uploadContext: isDataTrigger ? uploadContext : undefined
    }
  };

  const reports = readReports();
  reports.unshift(report);
  if (reports.length > 500) reports.length = 500;
  writeReports(reports);

  console.log(`[DailyReport] 报告生成完成: ${report.id} (${triggerType})`);

  // 注入所有管理员对话上下文
   await injectReportToAdminMemories(report, wechatManager);

  if (wechatManager) {
    await broadcastToAdmins(report, wechatManager, pushManager);
  }

  return report;
}

async function injectReportToAdminMemories(report, wechatManager) {
  try {
    const adminIds = getAdminMemberIds(wechatManager);
    if (adminIds.size === 0) return;

    const summaryForContext = `[管理日报] ${report.title}\n${report.summary || report.content.substring(0, 200)}`;

    for (const adminId of adminIds) {
      try {
        conversationMemory.addMessage(adminId, 'system', summaryForContext, 'daily_report');
        await conversationMemory.flush(adminId);
      } catch (e) {}
    }
    console.log(`[DailyReport] 已注入 ${adminIds.size} 个管理员对话上下文`);
  } catch (e) {
    console.error('[DailyReport] 注入管理员记忆失败:', e.message);
  }
}

async function broadcastNoData(wechatManager, pushManager, yesterday) {
  if (!wechatManager) return;
  const msg = `📊 管理日报（${yesterday}）\n\n昨日无新增学员活动数据。`;
  const adminIds = getAdminMemberIds(wechatManager);

  try {
    const status = wechatManager.getStatus();
    if (!status || !status.bots) return;

    const onlineAdmins = status.bots.filter(b => b.isAdmin && b.loggedIn);
    if (onlineAdmins.length === 0) {
      console.log('[DailyReport] 无在线管理员Bot，跳过无数据通知');
      return;
    }

    let sent = 0;
    for (const admin of onlineAdmins) {
      try {
        const result = await wechatManager.sendToMember(admin.memberId, msg);
        if (result.success) sent++;
      } catch (e) {}
      if (pushManager) {
        try {
          await pushManager.sendPushToMember(admin.memberId, '管理日报', '昨日无新增学员活动数据').catch(() => {});
        } catch (e) {}
      }
      await new Promise(r => setTimeout(r, 300));
    }
    console.log(`[DailyReport] 无数据通知完成，发送 ${sent}/${onlineAdmins.length} 个管理员`);
  } catch (e) {
    console.error('[DailyReport] 无数据通知失败:', e.message);
  }

  const report = {
    id: generateId(),
    type: 'daily',
    title: `📊 管理日报（${yesterday}）`,
    content: msg,
    summary: '昨日无新增学员活动数据',
    generatedAt: beijingNow().toISOString(),
    date: yesterday,
    trigger: 'scheduled',
    sentTo: [],
    metadata: { totalStudents: 0, noData: true, week: getCurrentWeek() }
  };
  const reports = readReports();
  reports.unshift(report);
  if (reports.length > 500) reports.length = 500;
  writeReports(reports);

  // 注入所有管理员对话上下文
   injectReportToAdminMemories(report, wechatManager).catch(e =>
     console.error('[DailyReport] 无数据报告注入管理员记忆失败:', e.message)
   );
}

async function broadcastToAdmins(report, wechatManager, pushManager) {
  if (!wechatManager) return;
  try {
    const status = wechatManager.getStatus();
    if (!status || !status.bots) return;

    const onlineAdmins = status.bots.filter(b => b.isAdmin && b.loggedIn);
    if (onlineAdmins.length === 0) {
      console.log('[DailyReport] 无在线管理员Bot，跳过推送');
      return;
    }

    const fullText = `${report.title}\n\n${report.content}`;
    const reports = readReports();
    const reportIndex = reports.findIndex(r => r.id === report.id);
    const sentTo = [];

    for (const admin of onlineAdmins) {
      const success = await sendWeChatChunked(wechatManager, admin.memberId, fullText);
      if (success) {
        sentTo.push(admin.memberId);
        console.log(`[DailyReport] 微信完整推送 → ${admin.memberId}`);
      }

      if (pushManager) {
        try {
          const jpushBody = report.summary || '新的管理日报已生成';
          await pushManager.sendPushToMember(admin.memberId, report.title, jpushBody).catch(() => {});
        } catch (e) {}
      }

      await new Promise(r => setTimeout(r, 300));
    }

    if (reportIndex >= 0) {
      reports[reportIndex].sentTo = sentTo;
      writeReports(reports);
    }

    console.log(`[DailyReport] 广播完成，微信=${sentTo.length}/${onlineAdmins.length}，JPush同步`);
  } catch (e) {
    console.error('[DailyReport] 广播失败:', e.message);
  }
}

module.exports = {
  readReports,
  writeReports,
  generateReport,
  broadcastNoData,
  broadcastToAdmins,
  REPORTS_FILE
};
