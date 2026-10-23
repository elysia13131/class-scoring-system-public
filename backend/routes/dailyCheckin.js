const express = require('express');
const router = express.Router();
const store = require('../data/checkin_records/store');
const pushScheduler = require('../agent/pushScheduler');
const scheduleStore = require('../data/scheduleStore');
const DataQueryTool = require('../agent/tools/DataQueryTool');
const { beijingDateStr, beijingISO, beijingNow } = require('../utils/beijingTime');
const { getDataPath } = require('../utils/dataPath');
const { getCurrentWeek: getCurrentSemesterWeek } = require('../utils/semester');
const path = require('path');
const fs = require('fs');

function loadMembers() {
  try {
    const membersPath = getDataPath( 'members.json');
    if (fs.existsSync(membersPath)) {
      return JSON.parse(fs.readFileSync(membersPath, 'utf-8'));
    }
  } catch (e) {}
  return [];
}

function findMember(memberId) {
  const members = loadMembers();
  return members.find(m => m.id === memberId) || null;
}

router.post('/feedback', async (req, res) => {
  try {
    const { memberId, type, mood, tags, text, isAdmin } = req.body;
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });

    const member = findMember(memberId);
    const recentRecords = store.getRecentRecords(memberId, 4);
    const recentMoods = store.getRecentMoods(memberId, 7);

    let feedbackTier = 'warmth';
    const hasText = text && text.trim().length > 0;
    const textLength = hasText ? text.trim().length : 0;
    
    if (textLength > 20) {
      feedbackTier = 'insight';
    } else if (hasText || (tags && tags.length > 0)) {
      feedbackTier = 'connection';
    }

    const negativeMoods = recentMoods.filter(m => ['😤','😢','😰','😞'].includes(m.mood));
    const hasConsecutiveNegative = negativeMoods.length >= 3;
    
    const anomalySignals = [];
    if (hasConsecutiveNegative) anomalySignals.push('consecutive_negative_mood');
    if (hasText && /伤|疼|痛|病|复发|扭|拉伤|骨折/i.test(text)) anomalySignals.push('injury');
    if (hasText && /孤立|针对|排挤|欺负|冷落|没人理|被骂/i.test(text)) anomalySignals.push('social_risk');

    let feedback = '';
    let anomalyDetected = anomalySignals.length > 0;

    if (anomalyDetected) {
      try {
        const agentEngine = req.app.get('agentEngine');
        if (agentEngine && agentEngine.toolRegistry) {
          const member = findMember(memberId);
          const memberName = member?.name || memberId;
          const className = member?.class || '';
          const signalTexts = {
            consecutive_negative_mood: `学员 ${memberName}（${className}）连续3天情绪低迷，建议关注`,
            injury: `学员 ${memberName}（${className}）反馈中检测到伤病情信号，请核实`,
            social_risk: `学员 ${memberName}（${className}）反馈中检测到人际冲突信号，请关注`
          };
          const notifyMsg = anomalySignals.map(s => signalTexts[s] || s).join('\n');
          await agentEngine.toolRegistry.execute('wechat_notify', {
            targetId: 'admin',
            message: `[异常预警] ${notifyMsg}`
          }, { memberId, isAdmin: false });
          console.log(`[Checkin] 异常通知已发送: ${anomalySignals.join(',')}`);
        }
      } catch (e) {
        console.error('[Checkin] 异常通知失败:', e.message);
      }
    }
    
    try {
      const agentEngine = req.app.get('agentEngine');
      if (agentEngine) {
        const systemPrompt = isAdmin 
          ? buildAdminFeedbackPrompt(member, type, text, recentRecords, feedbackTier)
          : buildFeedbackPrompt(member, type, mood, tags, text, recentRecords, feedbackTier);
        const response = await agentEngine.llm.chat(
          [{ role: 'system', content: systemPrompt }, { role: 'user', content: '请生成反馈' }],
          { stream: false, max_tokens: 300 }
        );
        feedback = response.content || '';
      }
    } catch (e) {
      console.error('[Checkin] LLM feedback failed:', e.message);
      feedback = generateFallbackFeedback(mood, tags, text, feedbackTier);
    }

    const record = {
      memberId,
      type: type || 'checkin',
      mood: mood || null,
      tags: tags || [],
      text: text || '',
      feedback,
      feedbackTier,
      anomalyDetected,
      anomalySignals,
      actions: anomalyDetected ? ['auto_notified_admin'] : [],
      timestamp: beijingISO()
    };
    store.writeRecord(memberId, record);

    // dsh 微信管家上下文同步：App 侧打卡落库 → 注入静默系统事件
    //（微信 AI 下次对话时知晓，不会重复发每日一问、能自然衔接聊）
    try {
      const dshEngine = req.app.get('dshEngine');
      if (dshEngine && dshEngine.available) {
        const label = (type === 'question') ? '每日一问回答' : (type === 'checkin' ? '心情打卡' : `${type} 记录`);
        const brief = String(text || mood || '').substring(0, 40);
        dshEngine.injectSystemEvent(String(memberId),
          `成员刚在 App 完成了${label}（已存档）：「${brief}」。今天不需要再发每日一问。`);
      }
    } catch (e) {}

    return res.json({
      success: true,
      feedback,
      feedbackTier,
      anomalyDetected,
      anomalySignals
    });
  } catch (err) {
    console.error('[Checkin] Feedback error:', err);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/notify-admin', async (req, res) => {
  try {
    const { memberId, text, feedback, anonymous } = req.body;
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });

    const member = findMember(memberId);
    const memberName = anonymous ? '某学员' : (member?.name || memberId);
    const className = member?.class || '未知班级';
    
    const message = anonymous 
      ? `[匿名反馈] ${className}有学员通过系统反馈：${text || '(无详细内容)'}`
      : `[学员反馈] ${memberName}（${className}）通过系统反馈：\n${text || '(无详细内容)'}`;

    let sent = false;
    try {
      const agentEngine = req.app.get('agentEngine');
      if (agentEngine) {
        const response = await agentEngine.llm.chat([
          { role: 'system', content: `你可以使用 wechat_notify 工具。当前需要通知管理员，targetId='admin', message='${message.replace(/'/g,"\\'")}'` },
          { role: 'user', content: '请调用 wechat_notify 工具通知管理员' }
        ], { 
          stream: false, 
          max_tokens: 100,
          tools: [{
            type: 'function',
            function: {
              name: 'wechat_notify',
              description: '向管理员发送微信通知',
              parameters: {
                type: 'object',
                properties: {
                  targetId: { type: 'string', description: '目标ID' },
                  message: { type: 'string', description: '通知内容' },
                  anonymous: { type: 'boolean', description: '是否匿名' }
                },
                required: ['targetId', 'message']
              }
            }
          }]
        });
        
        if (response.toolCalls?.length > 0) {
          for (const tc of response.toolCalls) {
            if (tc.function?.name === 'wechat_notify') {
              const params = JSON.parse(tc.function.arguments || '{}');
              const toolRegistry = agentEngine.toolRegistry;
              if (toolRegistry) {
                const result = await toolRegistry.execute('wechat_notify', params, { memberId, isAdmin: false });
                sent = result.success;
                if (sent) {
                  const records = store.readRecords(memberId);
                  const lastRecord = records[records.length - 1];
                  if (lastRecord && !lastRecord.actions.includes('notified_admin')) {
                    lastRecord.actions.push('notified_admin');
                    const fs = require('fs');
                    const path = require('path');
                    const filePath = getDataPath( 'checkin_records', `${memberId}.json`);
                    fs.writeFileSync(filePath, JSON.stringify(records, null, 2), 'utf-8');
                  }
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.error('[Checkin] Notify admin failed:', e.message);
    }

    return res.json({
      success: true,
      sent,
      message: sent ? '已通知管理员' : '通知发送中（可能需要管理员手动查看）'
    });
  } catch (err) {
    console.error('[Checkin] Notify error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 学员每日一问 - LLM 基于个人历史生成个性化问题（生成后缓存当天）
router.post('/student-question', async (req, res) => {
  try {
    const { memberId } = req.body;
    if (!memberId) return res.status(400).json({ error: 'memberId is required' });

    const todayKey = `sq_${beijingDateStr()}`;

    // 先检查当天缓存
    const cached = pushScheduler.getCachedQuestion(memberId);
    if (cached) {
      return res.json({ question: cached.question, key: cached.key || todayKey, source: 'cache' });
    }

    const agentEngine = req.app.get('agentEngine');
    if (!agentEngine) {
      const fallback = '今天有什么让你觉得值得记住的事？';
      pushScheduler.cacheQuestion(memberId, fallback, todayKey);
      store.writeRecord(memberId, {
        memberId, type: 'question_generated', question: fallback, text: null, source: 'fallback',
        timestamp: beijingISO()
      });
      return res.json({ question: fallback, key: todayKey });
    }

    const member = findMember(memberId);
    const memberName = member?.name || memberId;
    const memberClass = member?.class || '';
    const memberMBTI = member?.mbti || '未设置';
    const memberBirthday = member?.birthday || '未设置';
    const memberZodiac = member?.zodiac || '未设置';
    const memberHobbies = member?.hobbies || '未设置';

    // 近期所有 checkin 记录（速记、每日一问、语音、周记）
    const recentRecords = store.getRecentRecords(memberId, 14);
    
    // 提取过去问过的问题（去重用）
    const pastQuestions = recentRecords
      .filter(r => r.type === 'question' && r.text)
      .slice(-7)
      .map(r => `Q:${(r.text||'').substr(0,60)}`);
    
    // 近期心情和标签
    const recentMoods = recentRecords.filter(r => r.mood).slice(-5)
      .map(r => `${r.timestamp?.substr(0,10)}: mood=${r.mood}`);
    
    const recentTags = recentRecords.filter(r => r.tags?.length).slice(-5)
      .map(r => `tags=[${r.tags.join(',')}]`);

    // 近期回答的完整内容（了解当前关注点）
    const recentAnswers = recentRecords.filter(r => r.text && r.text.length > 3).slice(-4)
      .map(r => `${r.timestamp?.substr(0,10)}|${r.type}: "${r.text.substr(0,80)}"`);

    // 日程信息
    const todayDateStr = beijingDateStr();
    const upcomingSchedules = scheduleStore.getUpcomingSchedules(memberId, 5) || [];
    const todaySchedules = scheduleStore.getSchedulesByDate(todayDateStr, memberId) || [];
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

    const systemPrompt = `你是一个陪伴学员成长的AI。请根据该学员信息生成一个专属的每日反思问题。

【学员】
姓名：${memberName}
班级：${memberClass}
MBTI：${memberMBTI}
生日：${memberBirthday}
星座：${memberZodiac}
爱好：${memberHobbies}

【近期心情轨迹】
${recentMoods.join('\n') || '(新学员，暂无数据)'}

【近期关注标签】
${recentTags.join('\n') || '(无)'}

【近期回答内容】
${recentAnswers.join('\n') || '(新学员)'}

【日程信息】
${scheduleText}

【过去问过的问题（严禁重复）】
${pastQuestions.map(q => `  ${q}`).join('\n') || '(无)'}

【要求】
生成一个问题，帮助学员停下来关注自己的内在状态。要求：
1. 问题要自然、温和，像一个关心的朋友/学长在聊天
2. 基于近期心情轨迹、回答内容和日程安排，针对学员当前的关注点提问
3. 如果近期情绪低迷，问题应偏向温和关怀而非追问
4. 如果近期积极稳定，可以稍微推进思考深度
5. 避免与"过去问过的问题"无意义重复，但如果从不同角度切入同一话题是允许的
6. 长度15-30字
7. 不要用"你觉得""你怎么看"等套话开头，尝试更自然的表达

只输出问题本身，不要加任何前缀或引号。`;

    const response = await agentEngine.llm.chat(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: '请生成今日的个性化问题' }],
      { stream: false, max_tokens: 80 }
    );

    const question = response.content || '今天有什么让你觉得值得记住的事？';
    const finalQuestion = question.trim().replace(/^["'「]|["'」]$/g, '');
    pushScheduler.cacheQuestion(memberId, finalQuestion, todayKey);
    store.writeRecord(memberId, {
      memberId, type: 'question_generated', question: finalQuestion, text: null, source: 'llm',
      timestamp: beijingISO()
    });
    res.json({ question: finalQuestion, key: todayKey, source: 'generated' });
  } catch (e) {
    console.error('[StudentQuestion] Error:', e.message);
    const todayKey = `sq_${beijingDateStr()}`;
    res.json({ question: '今天有什么让你觉得值得记住的事？', key: todayKey });
  }
});

// 管理员每日一问 - LLM 根据班级数据 + 历史管理记录生成个性化管理反思问题
router.post('/admin-question', async (req, res) => {
  try {
    const { adminId } = req.body;
    if (!adminId) return res.status(400).json({ error: 'adminId is required' });

    const todayKey = `aq_${beijingDateStr()}`;

    // 先检查凌晨预生成的缓存
    const cached = pushScheduler.getCachedAdminQuestion(adminId);
    if (cached) {
      return res.json({ question: cached.question, key: cached.key, source: 'cache' });
    }

    const agentEngine = req.app.get('agentEngine');
    if (!agentEngine) {
      const fallback = '今天你们班最需要你关注的一个学员是谁？为什么？';
      pushScheduler.cacheQuestion(adminId, fallback, todayKey);
      store.writeRecord(adminId, {
        memberId: adminId, type: 'question_generated', question: fallback, text: null, source: 'fallback',
        timestamp: beijingISO()
      });
      return res.json({ question: fallback, key: todayKey });
    }

    const members = loadMembers();
    const allClasses = [...new Set(members.map(m => m.class).filter(Boolean))];
    
    // 用 DataQueryTool 获取上周评分完成情况（复用已有工具）
    const lastWeek = getCurrentWeek() - 1;
    const dqTool = new DataQueryTool();
    let evalStatus = null;
    let classData = [];
    try {
      evalStatus = await dqTool.execute({ dataType: 'evaluation_status', week: lastWeek }, { memberId: adminId, isAdmin: true });
      
      // 构建各班评分数据
      classData = allClasses.map(cls => {
        const clsSummary = (evalStatus.classSummary || []).find(c => c.className === cls);
        const clsMembers = members.filter(m => m.class === cls);
        
        // 该班未完成评分的学员
        const clsIncomplete = (evalStatus.allIncomplete || []).filter(m => m.class === cls);
        const unscoredNames = clsIncomplete.map(m => 
          `${m.name}${m.missingSelf && m.missingPeer ? '(自评+互评)' : m.missingSelf ? '(自评)' : '(互评)'}`
        );
        
        // 该班异常学员
        const anomalyMembers = [];
        for (const m of clsMembers.slice(0, 5)) {
          const records = store.readRecords(m.id);
          const recent = records.slice(-3);
          if (recent.some(r => r.anomalyDetected)) anomalyMembers.push(m.name);
        }
        
        return {
          className: cls,
          memberCount: clsMembers.length,
          selfCompletion: clsSummary ? `${clsSummary.selfCompletionRate}%` : '暂无',
          peerCompletion: clsSummary ? `${clsSummary.peerCompletionRate}%` : '暂无',
          unscoredCount: clsIncomplete.length,
          unscoredNames: unscoredNames.length > 0 ? unscoredNames.join(', ') : '无',
          recentAnomalies: anomalyMembers.length > 0 ? anomalyMembers.join(', ') : '无',
        };
      });
    } catch (e) {
      console.error('[AdminQuestion] 获取评分状态失败:', e.message);
      classData = allClasses.map(cls => ({
        className: cls,
        memberCount: members.filter(m => m.class === cls).length,
        selfCompletion: '查询失败',
        peerCompletion: '查询失败',
        unscoredCount: 0,
        unscoredNames: '查询失败',
        recentAnomalies: '无',
      }));
    }
    
    // 日程信息
    const todayDateStr = beijingDateStr();
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
    
    // 管理员历史记录
    const adminRecords = store.getRecentRecords(adminId, 30);
    const recentObs = adminRecords.filter(r => r.type === 'admin_observation' || r.type === 'question').slice(-3)
      .map(r => `${r.timestamp?.substr(0,10)}: ${(r.text||'').substr(0,100)}`).join('; ') || '无';
    
    // 过去问过的管理反思问题（去重用）
    const pastQuestions = adminRecords
      .filter(r => r.type === 'question' && r.text)
      .slice(-7)
      .map(r => `Q:${(r.text||'').substr(0,60)}`);

    const systemPrompt = `你是管理员的AI搭档。请根据以下班级数据生成一个管理反思问题，帮助管理员发现盲点或改进方向。

【各班上周评分完成情况】
${classData.map(c => `${c.className}: ${c.memberCount}人, 自评${c.selfCompletion}, 互评${c.peerCompletion}, ${c.unscoredCount}人未完成评分, 未完成: ${c.unscoredNames}, 近期异常: ${c.recentAnomalies}`).join('\n')}

【日程信息】
${scheduleText}

【管理员近期观察记录】
${recentObs}

【过去问过的问题（严禁重复）】
${pastQuestions.map(q => `  ${q}`).join('\n') || '(无)'}

【要求】
生成一个管理反思问题，让管理员停下来思考班级管理中的真实问题。风格像资深教练而非考核官。要求：
1. 基于上周评分完成情况（如某班未完成评分人数多、具体谁未完成）和当前日程安排，提出针对性的引导问题
2. 引导管理员反思管理方式而非指责学员
3. 长度20-40字
4. 避免空洞提问如"你今天管理得好吗"
5. 避免与"过去问过的问题"无意义重复，但如果从不同角度切入同一话题是允许的

只输出问题本身，不要加任何前缀。`;

    const response = await agentEngine.llm.chat(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: '请生成今日的管理反思问题' }],
      { stream: false, max_tokens: 100 }
    );

    const question = response.content || '今天你们班最需要你关注的一个学员是谁？为什么？';
    const finalQuestion = question.trim();
    pushScheduler.cacheQuestion(adminId, finalQuestion, todayKey);
    store.writeRecord(adminId, {
      memberId: adminId, type: 'question_generated', question: finalQuestion, text: null, source: 'llm',
      timestamp: beijingISO()
    });
    res.json({ question: finalQuestion, key: todayKey, source: 'generated' });
  } catch (e) {
    console.error('[AdminQuestion] Error:', e.message);
    const todayKey = `aq_${beijingDateStr()}`;
    res.json({ question: '今天你们班最需要你关注的一个学员是谁？为什么？', key: todayKey });
  }
});

function getCurrentWeek() {
  // 按当前学期起点计算周次（config.startDate 为旧全局起点，学期化后不再维护）
  try {
    return getCurrentSemesterWeek();
  } catch { return 1; }
}

function buildAdminFeedbackPrompt(member, type, text, recentRecords, tier) {
  const adminName = member?.name || '管理员';
  const historySummary = recentRecords.filter(r => r.type === 'question' || r.type === 'admin_observation').slice(-5)
    .map(r => `${r.timestamp?.substring(0,10)}: ${(r.text||'').substring(0,80)}`)
    .join('\n') || '无';

  const tierInstructions = {
    warmth: '请生成1-2句简短确认，肯定管理员今天的观察记录。不超过40字。',
    connection: '请生成3-4句教练型反馈：先确认管理员的观察视角，再关联近期管理记录中的模式，最后给一个轻量引导。不超过100字。',
    insight: '请生成4-5句洞察型反馈：先共情管理员的观察，再分析可能暴露的管理盲点或班级趋势，最后给一条具体的管理行动建议。不超过150字。'
  };

  return `你是一位资深管理教练。你帮助管理者反思和成长。风格像导师而非上司。

【管理员】
${adminName}

【本次观察/反思】
${text || '(无)'}

【近期管理记录】
${historySummary}

【反馈要求】
${tierInstructions[tier] || tierInstructions.connection}
请给出具体可操作的建议（如"建议找XX聊聊""这周重点观察XX方面"），而非泛泛而谈。

请直接输出反馈文本，不要加任何前缀或标记。`;
}

function buildFeedbackPrompt(member, type, mood, tags, text, recentRecords, tier) {
  const memberName = member?.name || '学员';
  const memberClass = member?.class || '';
  const historySummary = recentRecords.slice(-10).map(r => 
    `${r.timestamp?.substring(0,10)} ${r.type}: mood=${r.mood||'-'} tags=${(r.tags||[]).join(',')} text="${(r.text||'').substring(0,50)}"`
  ).join('\n');

  const tierInstructions = {
    warmth: '输入仅有表情/标签，无文字。请生成1-2句温暖的共情型反馈，让学员感到被看见、被理解。严格不超过60字。不要用"加油""你一定行"等空洞鼓励。',
    connection: '输入含简短文字。请生成3-4句连接型反馈：先肯定表达，再关联历史（如果历史中有同主题则纵向对比），最后给一个轻量引导。不超过120字。',
    insight: '输入含较长文字。请生成5-6句洞察型反馈：先共情回应，再分析可能存在的矛盾或成长点，最后给一条具体可操作的建议。不超过180字。如果涉及学业/体能/人际三重矛盾，要点出来但不要批判。'
  };

  return `你是一个了解该学员成长历史的AI成长助手。你的回复风格像学长/战友而不是客服，温暖但不油腻。

【学员信息】
姓名：${memberName}
班级：${memberClass}

【本次输入】
类型：${type || '速记'}
心情：${mood || '未选'}
标签：${(tags || []).join(', ') || '无'}
内容：${text || '(无)'}

【近期历史】
${historySummary || '(无历史)'}

【反馈要求】
${tierInstructions[tier] || tierInstructions.warmth}

请直接输出反馈文本，不要加任何前缀或标记。`;
}

function generateFallbackFeedback(mood, tags, text, tier) {
  if (!mood && !text) return '收到你的记录。每一次记录都是在为自己的成长存档。';
  
  const positiveMoods = ['😊','😂','💪'];
  const negativeMoods = ['😤','😢','😰','😞'];
  
  if (mood && positiveMoods.includes(mood)) {
    return '看起来今天状态不错！保持这份好心情，它会成为你面对困难的底气。';
  }
  if (mood && negativeMoods.includes(mood)) {
    return '感受到了。有些日子就是比较难熬。给自己一点时间和空间，明天会是新的一天。';
  }
  if (text && text.length > 10) {
    return `收到你的分享："${text.substring(0, 30)}..." —— 每一次真诚的记录，都是对自我的善待。`;
  }
  return '收到了。你的每一次记录都在构建属于自己的成长地图。';
}

module.exports = router;
