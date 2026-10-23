const BaseTool = require('./BaseTool');
const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');
const { getDataPath } = require('../../utils/dataPath');
const { getScoreFilePath } = require('../../utils/semester');

class AdminAnalysisTool extends BaseTool {
  constructor() {
    super({
      name: 'admin_analysis',
      description: '管理员专属综合分析工具。支持12种分析功能：全班统计、异常预警、成员排名、班级对比、风险检测、数据概览、多周趋势、个人画像、成员对比、评分分布、维度关联、互评网络。当用户说"统计"、"分析"、"排名"、"预警"、"趋势"、"画像"、"对比"、"分布"、"关联"、"互评"时调用。仅管理员可用',
      parameters: {
        action: { type: 'string', description: '分析类型: class_stats(全班统计)/anomaly_alert(异常预警)/member_rank(成员排名)/class_compare(班级对比)/risk_detection(风险检测)/overview(数据概览)/trend(多周趋势)/member_profile(个人画像)/member_compare(成员对比)/score_distribution(评分分布)/dimension_correlation(维度关联)/peer_network(互评网络)', required: true },
        week: { type: 'number', description: '周次（不填默认当前周）', required: false },
        dimension: { type: 'string', description: '维度筛选: study/fitness/literacy/discipline/contribution/management', required: false },
        className: { type: 'string', description: '班级名称', required: false },
        topN: { type: 'number', description: '排名前N名（默认10）', required: false },
        memberId: { type: 'string', description: '成员ID（用于个人画像）', required: false },
        memberIds: { type: 'string', description: '成员ID列表，逗号分隔（用于成员对比）', required: false },
        startWeek: { type: 'number', description: '趋势起始周（不填默认最近4周）', required: false },
        endWeek: { type: 'number', description: '趋势结束周（不填默认当前周）', required: false },
        scoreType: { type: 'string', description: '评分类型筛选: self/peer/all（默认all）', required: false },
        semesterId: { type: 'number', description: '学期ID（1=大一上,2=大一下,3=大二上,4=大二下...，分析特定学期的评分数据时使用，默认当前学期）', required: false }
      },
      requireAuth: false,
      category: 'admin'
    });

    this.dimensionNames = {
      study: '学习成绩',
      fitness: '体能素质',
      literacy: '人文素养',
      discipline: '遵章守纪',
      contribution: '班级贡献',
      management: '管理能力'
    };

    this.negativeMoods = ['焦虑', '沮丧', '愤怒', '疲惫', '孤独', '悲伤', '烦躁'];
  }

  async execute(params, context) {
    if (!context.isAdmin) {
      return {
        type: 'admin_analysis',
        error: 'permission_denied',
        message: '该分析工具仅管理员可用。你可以使用 query_scores 查看自己的评分数据，或使用 generate_chart 生成自己的雷达图。'
      };
    }

    const action = params.action;
    const week = params.week || this._getCurrentWeek();
    const semesterId = params.semesterId || this._getCurrentSemesterId();
    let className = params.className || null;
    if (className) {
      const members = await this._getFullMembers();
      className = this._resolveClassName(className, members);
    }

    switch (action) {
      case 'class_stats':
        return await this._getClassStats(week, params.dimension, className, semesterId);
      case 'anomaly_alert':
        return await this._getAnomalyAlerts(week, className, semesterId);
      case 'member_rank':
        return await this._getMemberRank(week, params.dimension, params.topN, className, semesterId);
      case 'class_compare':
        return await this._getClassCompare(week, params.dimension, semesterId);
      case 'risk_detection':
        return await this._getRiskDetection(week, className, semesterId);
      case 'overview':
        return await this._getOverview(week, semesterId);
      case 'trend':
        return await this._getTrend(params.startWeek, params.endWeek, params.memberId, params.dimension, className, semesterId);
      case 'member_profile':
        return await this._getMemberProfile(params.memberId || context.memberId, week, semesterId);
      case 'member_compare':
        return await this._getMemberCompare(params.memberIds, week, semesterId);
      case 'score_distribution':
        return await this._getScoreDistribution(week, params.dimension, params.className, semesterId);
      case 'dimension_correlation':
        return await this._getDimensionCorrelation(week, params.className, semesterId);
      case 'peer_network':
        return await this._getPeerNetwork(week, params.className, semesterId);
      default:
        return {
          type: 'admin_analysis',
          error: 'unknown_action',
          message: `未知分析类型: ${action}`,
          validActions: ['class_stats', 'anomaly_alert', 'member_rank', 'class_compare', 'risk_detection', 'overview', 'trend', 'member_profile', 'member_compare', 'score_distribution', 'dimension_correlation', 'peer_network']
        };
    }
  }

  async _getClassStats(week, dimension, className, semesterId) {
    try {
      const members = await this._getMembersFromAPI();
      let targetMembers = className ? members.filter(m => m.class === className) : members;

      const allScores = await this._loadWeekScores(week, semesterId);
      const memberScores = this._mapScoresToMembers(allScores, targetMembers);

      const dimensions = dimension ? [dimension] : Object.keys(this.dimensionNames);
      const stats = {};

      for (const dim of dimensions) {
        const values = memberScores.map(ms => ms.scores[dim]).filter(v => typeof v === 'number' && v > 0);
        if (values.length === 0) {
          stats[dim] = { name: this.dimensionNames[dim], count: 0, avg: 0, min: 0, max: 0, median: 0, stdDev: 0, p25: 0, p75: 0 };
          continue;
        }
        const sorted = [...values].sort((a, b) => a - b);
        const avg = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
        stats[dim] = {
          name: this.dimensionNames[dim],
          count: values.length,
          avg: parseFloat(avg.toFixed(2)),
          min: parseFloat(sorted[0].toFixed(2)),
          max: parseFloat(sorted[sorted.length - 1].toFixed(2)),
          median: parseFloat(this._percentile(sorted, 50).toFixed(2)),
          p25: parseFloat(this._percentile(sorted, 25).toFixed(2)),
          p75: parseFloat(this._percentile(sorted, 75).toFixed(2)),
          stdDev: parseFloat(Math.sqrt(variance).toFixed(2))
        };
      }

      const totalAvg = Object.values(stats).reduce((sum, s) => sum + s.avg, 0) / Math.max(Object.keys(stats).length, 1);
      const scoredCount = memberScores.filter(ms => Object.values(ms.scores).some(v => v > 0)).length;

      const backboneMembers = targetMembers.filter(m => m.isBackbone);
      const backboneScores = this._mapScoresToMembers(allScores, backboneMembers);
      const backboneAvg = this._calcOverallAvg(backboneScores);

      let overallComparison = null;
      if (className) {
        const overallMemberScores = this._mapScoresToMembers(allScores, members);
        const overallDimStats = {};
        for (const dim of dimensions) {
          const values = overallMemberScores.map(ms => ms.scores[dim]).filter(v => typeof v === 'number' && v > 0);
          overallDimStats[dim] = {
            name: this.dimensionNames[dim],
            avg: values.length > 0 ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0
          };
        }
        const overallTotalAvg = Object.values(overallDimStats).reduce((sum, s) => sum + s.avg, 0) / Math.max(Object.keys(overallDimStats).length, 1);
        const overallScoredCount = overallMemberScores.filter(ms => Object.values(ms.scores).some(v => v > 0)).length;
        overallComparison = {
          totalMembers: members.length,
          scoredMembers: overallScoredCount,
          overallAvg: parseFloat(overallTotalAvg.toFixed(2)),
          dimensionStats: overallDimStats
        };
      }

      return {
        type: 'admin_analysis',
        action: 'class_stats',
        week,
        className: className || '全部班级',
        totalMembers: targetMembers.length,
        scoredMembers: scoredCount,
        overallAvg: parseFloat(totalAvg.toFixed(2)),
        backboneCount: backboneMembers.length,
        backboneAvg: parseFloat(backboneAvg.toFixed(2)),
        dimensionStats: stats,
        overallComparison,
        summary: this._generateClassStatsSummary(stats, scoredCount, targetMembers.length, overallComparison)
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'class_stats', error: err.message };
    }
  }

  async _getAnomalyAlerts(week, className, semesterId) {
    try {
      const allMembers = await this._getMembersFromAPI();
      let targetMembers = className ? allMembers.filter(m => m.class === className) : allMembers;
      const allScores = await this._loadWeekScores(week, semesterId);
      const memberScores = this._mapScoresToMembers(allScores, targetMembers);
      const alerts = [];

      const overallScores = this._mapScoresToMembers(allScores, allMembers);
      const overallStats = this._calculateClassAverages(overallScores);
      const classStats = className ? this._calculateClassAverages(memberScores) : overallStats;

      for (const ms of memberScores) {
        for (const dim of Object.keys(this.dimensionNames)) {
          const val = ms.scores[dim];
          if (typeof val !== 'number' || val <= 0) continue;
          const oAvg = overallStats[dim]?.avg || 5;
          const oStdDev = overallStats[dim]?.stdDev || 2;
          const cAvg = classStats[dim]?.avg || oAvg;
          const cStdDev = classStats[dim]?.stdDev || oStdDev;
          if (val < oAvg - 2 * oStdDev) {
            alerts.push({ memberId: ms.memberId, memberName: ms.memberName, type: 'score_low', dimension: dim, dimensionName: this.dimensionNames[dim], value: val, overallAvg: parseFloat(oAvg.toFixed(2)), classAvg: parseFloat(cAvg.toFixed(2)), deviation: parseFloat((val - oAvg).toFixed(2)), severity: 'high', message: `${ms.memberName}的${this.dimensionNames[dim]}得分${val}，显著低于整体平均${oAvg.toFixed(2)}（班级平均${cAvg.toFixed(2)}）` });
          } else if (val < cAvg - cStdDev) {
            alerts.push({ memberId: ms.memberId, memberName: ms.memberName, type: 'score_below_avg', dimension: dim, dimensionName: this.dimensionNames[dim], value: val, overallAvg: parseFloat(oAvg.toFixed(2)), classAvg: parseFloat(cAvg.toFixed(2)), deviation: parseFloat((val - cAvg).toFixed(2)), severity: 'medium', message: `${ms.memberName}的${this.dimensionNames[dim]}得分${val}，低于班级平均${cAvg.toFixed(2)}（整体平均${oAvg.toFixed(2)}）` });
          }
        }
      }

      const nominationData = await this._loadNominationData();
      if (nominationData) {
        const nameMap = {};
        targetMembers.forEach(m => { nameMap[m.id] = m.name; });
        const filteredNominations = className
          ? nominationData.filter(r => targetMembers.some(m => m.id === String(r.evaluatorId)))
          : nominationData;
        for (const record of filteredNominations) {
          const memberId = String(record.evaluatorId);
          const memberName = nameMap[memberId] || memberId;
          if (this.negativeMoods.includes(record.moodTag)) {
            alerts.push({ memberId, memberName, type: 'negative_mood', moodTag: record.moodTag, severity: 'medium', message: `${memberName}当前心情为"${record.moodTag}"，属于负面情绪` });
          }
          const posCount = (record.positiveNominations || []).length;
          const negCount = (record.negativeNominations || []).length;
          if (posCount === 0 && negCount === 0) {
            alerts.push({ memberId, memberName, type: 'social_isolation', severity: 'high', message: `${memberName}未提交任何关系提名，可能存在社交孤立风险` });
          } else if (negCount > 0 && posCount === 0) {
            alerts.push({ memberId, memberName, type: 'no_positive_nomination', severity: 'high', message: `${memberName}仅有负向提名无正向提名` });
          }
          if (record.selfAssessment) {
            const sa = record.selfAssessment;
            const lowDims = [];
            if (sa.sleepQuality && sa.sleepQuality <= 3) lowDims.push('睡眠质量');
            if (sa.emotionalState && sa.emotionalState <= 3) lowDims.push('情绪状态');
            if (sa.stressLevel && sa.stressLevel >= 8) lowDims.push('压力感受');
            if (sa.appetiteLevel && sa.appetiteLevel <= 3) lowDims.push('食欲状况');
            if (lowDims.length >= 2) {
              alerts.push({ memberId, memberName, type: 'self_assessment_low', lowDimensions: lowDims, severity: 'high', message: `${memberName}自我评估多项偏低：${lowDims.join('、')}` });
            }
          }
        }
      }

      const prevScores = await this._loadWeekScores(week - 1, semesterId);
      if (prevScores.length > 0) {
        const prevMemberScores = this._mapScoresToMembers(prevScores, targetMembers);
        const prevMap = {};
        prevMemberScores.forEach(ms => { prevMap[ms.memberId] = ms; });
        for (const ms of memberScores) {
          const prev = prevMap[ms.memberId];
          if (!prev) continue;
          for (const dim of Object.keys(this.dimensionNames)) {
            const curr = ms.scores[dim];
            const prevVal = prev.scores[dim];
            if (typeof curr !== 'number' || typeof prevVal !== 'number' || curr <= 0 || prevVal <= 0) continue;
            const change = curr - prevVal;
            if (change <= -2) {
              alerts.push({ memberId: ms.memberId, memberName: ms.memberName, type: 'score_drop', dimension: dim, dimensionName: this.dimensionNames[dim], prevValue: prevVal, currentValue: curr, change: parseFloat(change.toFixed(2)), severity: 'high', message: `${ms.memberName}的${this.dimensionNames[dim]}较上周下降${Math.abs(change).toFixed(1)}分（${prevVal}→${curr}）` });
            } else if (change <= -1) {
              alerts.push({ memberId: ms.memberId, memberName: ms.memberName, type: 'score_drop', dimension: dim, dimensionName: this.dimensionNames[dim], prevValue: prevVal, currentValue: curr, change: parseFloat(change.toFixed(2)), severity: 'medium', message: `${ms.memberName}的${this.dimensionNames[dim]}较上周下降${Math.abs(change).toFixed(1)}分` });
            }
          }
        }
      }

      alerts.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.severity] || 2) - ({ high: 0, medium: 1, low: 2 }[b.severity] || 2));
      return {
        type: 'admin_analysis', action: 'anomaly_alert', week,
        className: className || '全部班级',
        totalAlerts: alerts.length,
        highSeverity: alerts.filter(a => a.severity === 'high').length,
        mediumSeverity: alerts.filter(a => a.severity === 'medium').length,
        alerts: alerts.slice(0, 30),
        summary: this._generateAlertSummary(alerts)
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'anomaly_alert', error: err.message };
    }
  }

  async _getMemberRank(week, dimension, topN = 10, className, semesterId) {
    try {
      const members = await this._getMembersFromAPI();
      const allScores = await this._loadWeekScores(week, semesterId);
      const overallMemberScores = this._mapScoresToMembers(allScores, members);
      const dims = Object.keys(this.dimensionNames);

      const overallRanked = overallMemberScores
        .filter(ms => Object.values(ms.scores).some(v => v > 0))
        .map(ms => {
          const totalScore = dims.reduce((sum, d) => sum + (ms.scores[d] || 0), 0);
          const avgScore = totalScore / dims.length;
          return {
            memberId: ms.memberId, memberName: ms.memberName, class: ms.class,
            totalScore: parseFloat(totalScore.toFixed(2)),
            avgScore: parseFloat(avgScore.toFixed(2)),
            dimensionScore: dimension ? ms.scores[dimension] : undefined,
            scores: ms.scores
          };
        })
        .sort((a, b) => dimension ? (b.dimensionScore || 0) - (a.dimensionScore || 0) : b.avgScore - a.avgScore)
        .map((item, index) => ({ overallRank: index + 1, ...item }));

      const overallRankMap = {};
      overallRanked.forEach(r => { overallRankMap[r.memberId] = r.overallRank; });

      let targetMembers = className ? members.filter(m => m.class === className) : members;
      const classMemberScores = this._mapScoresToMembers(allScores, targetMembers);

      const classRanked = classMemberScores
        .filter(ms => Object.values(ms.scores).some(v => v > 0))
        .map(ms => {
          const totalScore = dims.reduce((sum, d) => sum + (ms.scores[d] || 0), 0);
          const avgScore = totalScore / dims.length;
          return {
            memberId: ms.memberId, memberName: ms.memberName, class: ms.class,
            totalScore: parseFloat(totalScore.toFixed(2)),
            avgScore: parseFloat(avgScore.toFixed(2)),
            dimensionScore: dimension ? ms.scores[dimension] : undefined,
            scores: ms.scores,
            overallRank: overallRankMap[ms.memberId] || 0
          };
        })
        .sort((a, b) => dimension ? (b.dimensionScore || 0) - (a.dimensionScore || 0) : b.avgScore - a.avgScore)
        .slice(0, topN || 10)
        .map((item, index) => ({ classRank: index + 1, ...item }));

      const ranked = className ? classRanked : overallRanked.slice(0, topN || 10).map((item, index) => ({ rank: index + 1, ...item }));

      return {
        type: 'admin_analysis', action: 'member_rank', week,
        dimension: dimension ? this.dimensionNames[dimension] : '综合',
        className: className || '全部班级',
        totalRanked: overallRanked.length,
        rankings: ranked,
        summary: ranked.length > 0 ? `第1名: ${ranked[0].memberName}（${dimension ? ranked[0].dimensionScore : ranked[0].avgScore}分）${className ? `，整体排名${ranked[0].overallRank}` : ''}` : '暂无排名数据'
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'member_rank', error: err.message };
    }
  }

  async _getClassCompare(week, dimension, semesterId) {
    try {
      const members = await this._getMembersFromAPI();
      const classes = [...new Set(members.map(m => m.class).filter(Boolean))];
      const allScores = await this._loadWeekScores(week, semesterId);
      const comparison = [];

      for (const cls of classes) {
        const classMembers = members.filter(m => m.class === cls);
        const memberScores = this._mapScoresToMembers(allScores, classMembers);
        const dims = dimension ? [dimension] : Object.keys(this.dimensionNames);
        const dimStats = {};
        for (const dim of dims) {
          const values = memberScores.map(ms => ms.scores[dim]).filter(v => typeof v === 'number' && v > 0);
          dimStats[dim] = { name: this.dimensionNames[dim], avg: values.length > 0 ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0, count: values.length };
        }
        const overallAvg = Object.values(dimStats).reduce((sum, s) => sum + s.avg, 0) / Math.max(Object.keys(dimStats).length, 1);
        comparison.push({ className: cls, memberCount: classMembers.length, scoredCount: memberScores.filter(ms => Object.values(ms.scores).some(v => v > 0)).length, overallAvg: parseFloat(overallAvg.toFixed(2)), dimensionStats: dimStats });
      }

      comparison.sort((a, b) => b.overallAvg - a.overallAvg);
      return {
        type: 'admin_analysis', action: 'class_compare', week,
        dimension: dimension ? this.dimensionNames[dimension] : '综合',
        classCount: comparison.length, comparison,
        summary: comparison.length >= 2 ? `${comparison[0].className}领先（均分${comparison[0].overallAvg}），${comparison[comparison.length - 1].className}需关注（均分${comparison[comparison.length - 1].overallAvg}）` : '班级数量不足'
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'class_compare', error: err.message };
    }
  }

  async _getRiskDetection(week, className, semesterId) {
    try {
      const allMembers = await this._getMembersFromAPI();
      let targetMembers = className ? allMembers.filter(m => m.class === className) : allMembers;
      const nameMap = {};
      targetMembers.forEach(m => { nameMap[m.id] = m.name; });
      const riskMembers = [];
      const nominationData = await this._loadNominationData();

      if (nominationData) {
        const filteredNominations = className
          ? nominationData.filter(r => targetMembers.some(m => m.id === String(r.evaluatorId)))
          : nominationData;
        const memberNominations = {};
        for (const record of filteredNominations) {
          const eid = String(record.evaluatorId);
          if (!memberNominations[eid]) memberNominations[eid] = [];
          memberNominations[eid].push(record);
        }
        const receivedPositive = {};
        const receivedNegative = {};
        for (const record of filteredNominations) {
          for (const posId of (record.positiveNominations || [])) { receivedPositive[String(posId)] = (receivedPositive[String(posId)] || 0) + 1; }
          for (const negId of (record.negativeNominations || [])) { receivedNegative[String(negId)] = (receivedNegative[String(negId)] || 0) + 1; }
        }

        for (const [memberId, records] of Object.entries(memberNominations)) {
          const memberName = nameMap[memberId] || memberId;
          const riskFactors = [];
          let riskLevel = 'low';
          const negativeMoodCount = records.filter(r => this.negativeMoods.includes(r.moodTag)).length;
          if (negativeMoodCount >= 2) { riskFactors.push(`连续${negativeMoodCount}次负面情绪记录`); riskLevel = 'high'; }
          else if (negativeMoodCount === 1) { riskFactors.push('存在负面情绪记录'); if (riskLevel === 'low') riskLevel = 'medium'; }
          const latestRecord = records[records.length - 1];
          if (latestRecord?.selfAssessment) {
            const sa = latestRecord.selfAssessment;
            if (sa.stressLevel >= 8) { riskFactors.push(`压力极高(${sa.stressLevel}/10)`); riskLevel = 'high'; }
            if (sa.emotionalState <= 3) { riskFactors.push(`情绪极低(${sa.emotionalState}/10)`); riskLevel = 'high'; }
            if (sa.sleepQuality <= 3) { riskFactors.push(`睡眠极差(${sa.sleepQuality}/10)`); if (riskLevel === 'low') riskLevel = 'medium'; }
          }
          const posReceived = receivedPositive[memberId] || 0;
          const negReceived = receivedNegative[memberId] || 0;
          if (posReceived === 0 && negReceived > 0) { riskFactors.push(`未被正向提名但被负向提名${negReceived}次`); riskLevel = 'high'; }
          else if (posReceived === 0 && targetMembers.length > 3) { riskFactors.push('未被正向提名'); if (riskLevel === 'low') riskLevel = 'medium'; }
          if (riskFactors.length > 0) {
            riskMembers.push({ memberId, memberName, riskLevel, riskFactors, positiveReceived: posReceived, negativeReceived: negReceived, latestMood: latestRecord?.moodTag || '未知' });
          }
        }
      }

      const allScores = await this._loadWeekScores(week, semesterId);
      const memberScores = this._mapScoresToMembers(allScores, targetMembers);
      for (const ms of memberScores) {
        const dims = Object.keys(this.dimensionNames);
        const allLow = dims.every(d => typeof ms.scores[d] === 'number' && ms.scores[d] < 4);
        if (allLow && dims.some(d => ms.scores[d] > 0)) {
          const existing = riskMembers.find(r => r.memberId === ms.memberId);
          if (existing) {
            existing.riskFactors.push('所有维度评分均低于4分');
            if (existing.riskLevel !== 'high') existing.riskLevel = 'high';
          } else {
            riskMembers.push({ memberId: ms.memberId, memberName: ms.memberName, riskLevel: 'high', riskFactors: ['所有维度评分均低于4分'], positiveReceived: 0, negativeReceived: 0, latestMood: '未知' });
          }
        }
      }

      riskMembers.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.riskLevel] || 2) - ({ high: 0, medium: 1, low: 2 }[b.riskLevel] || 2));
      return {
        type: 'admin_analysis', action: 'risk_detection', week,
        className: className || '全部班级',
        totalAtRisk: riskMembers.length,
        highRisk: riskMembers.filter(r => r.riskLevel === 'high').length,
        mediumRisk: riskMembers.filter(r => r.riskLevel === 'medium').length,
        riskMembers: riskMembers.slice(0, 20),
        summary: this._generateRiskSummary(riskMembers)
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'risk_detection', error: err.message };
    }
  }

  async _getOverview(week, semesterId) {
    try {
      const members = await this._getMembersFromAPI();
      const classes = [...new Set(members.map(m => m.class).filter(Boolean))];
      const allScores = await this._loadWeekScores(week, semesterId);
      const memberScoresMap = {};
      for (const record of allScores) {
        const mid = String(record.memberId);
        if (!memberScoresMap[mid]) memberScoresMap[mid] = { scores: {}, count: 0 };
        memberScoresMap[mid].count++;
        if (record.scores) {
          for (const [dim, val] of Object.entries(record.scores)) {
            if (typeof val === 'number') { memberScoresMap[mid].scores[dim] = memberScoresMap[mid].scores[dim] ? (memberScoresMap[mid].scores[dim] + val) / 2 : val; }
          }
        }
      }
      const scoredCount = Object.keys(memberScoresMap).length;

      let moodStats = { total: 0, positive: 0, negative: 0, moodDistribution: {} };
      const nominationData = await this._loadNominationData();
      if (nominationData) {
        moodStats.total = nominationData.length;
        for (const record of nominationData) {
          if (record.moodTag) {
            moodStats.moodDistribution[record.moodTag] = (moodStats.moodDistribution[record.moodTag] || 0) + 1;
            if (this.negativeMoods.includes(record.moodTag)) moodStats.negative++; else moodStats.positive++;
          }
        }
      }

      const backboneMembers = members.filter(m => m.isBackbone);
      const classOverview = classes.map(cls => {
        const classMembers = members.filter(m => m.class === cls);
        const classScored = classMembers.filter(m => memberScoresMap[m.id]).length;
        return { className: cls, memberCount: classMembers.length, scoredCount: classScored, completionRate: classMembers.length > 0 ? parseFloat((classScored / classMembers.length * 100).toFixed(1)) : 0 };
      });

      return {
        type: 'admin_analysis', action: 'overview', week,
        totalMembers: members.length, totalClasses: classes.length,
        scoredMembers: scoredCount,
        scoreCompletionRate: members.length > 0 ? parseFloat((scoredCount / members.length * 100).toFixed(1)) : 0,
        backboneCount: backboneMembers.length,
        moodStats, classOverview,
        summary: `共${members.length}名成员（${classes.length}个班级），第${week}周已评分${scoredCount}人（${members.length > 0 ? (scoredCount / members.length * 100).toFixed(1) : 0}%），心情记录${moodStats.total}条`
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'overview', error: err.message };
    }
  }

  async _getTrend(startWeek, endWeek, memberId, dimension, className, semesterId) {
    try {
      const currentWeek = this._getCurrentWeek();
      const sWeek = startWeek || Math.max(1, currentWeek - 3);
      const eWeek = endWeek || currentWeek;
      const members = await this._getMembersFromAPI();
      let targetMembers = className ? members.filter(m => m.class === className) : members;

      const weeks = [];
      for (let w = sWeek; w <= eWeek; w++) weeks.push(w);

      const trendData = [];
      for (const w of weeks) {
        const allScores = await this._loadWeekScores(w, semesterId);
        const memberScores = this._mapScoresToMembers(allScores, targetMembers);

        if (memberId) {
          const ms = memberScores.find(m => m.memberId === String(memberId));
          const memberName = ms?.memberName || memberId;
          const dims = dimension ? [dimension] : Object.keys(this.dimensionNames);
          const dimValues = {};
          for (const d of dims) { dimValues[d] = ms ? ms.scores[d] || 0 : 0; }
          const avg = Object.values(dimValues).filter(v => v > 0);
          trendData.push({ week: w, memberName, dimensions: dimValues, avgScore: avg.length > 0 ? parseFloat((avg.reduce((a, b) => a + b, 0) / avg.length).toFixed(2)) : 0 });
        } else {
          const dims = dimension ? [dimension] : Object.keys(this.dimensionNames);
          const dimAvgs = {};
          for (const d of dims) {
            const values = memberScores.map(ms => ms.scores[d]).filter(v => typeof v === 'number' && v > 0);
            dimAvgs[d] = values.length > 0 ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0;
          }
          const avg = Object.values(dimAvgs).filter(v => v > 0);
          trendData.push({ week: w, dimensions: dimAvgs, avgScore: avg.length > 0 ? parseFloat((avg.reduce((a, b) => a + b, 0) / avg.length).toFixed(2)) : 0, scoredCount: memberScores.filter(ms => Object.values(ms.scores).some(v => v > 0)).length });
        }
      }

      const changes = [];
      if (trendData.length >= 2) {
        const first = trendData[0];
        const last = trendData[trendData.length - 1];
        const dims = dimension ? [dimension] : Object.keys(this.dimensionNames);
        for (const d of dims) {
          const fVal = first.dimensions[d] || 0;
          const lVal = last.dimensions[d] || 0;
          if (fVal > 0 || lVal > 0) {
            changes.push({ dimension: d, name: this.dimensionNames[d], from: fVal, to: lVal, change: parseFloat((lVal - fVal).toFixed(2)), trend: lVal > fVal ? 'up' : lVal < fVal ? 'down' : 'stable' });
          }
        }
      }

      const subject = memberId ? (trendData[0]?.memberName || `成员${memberId}`) : (className || '全部');
      return {
        type: 'admin_analysis', action: 'trend',
        startWeek: sWeek, endWeek: eWeek,
        subject,
        dimension: dimension ? this.dimensionNames[dimension] : '综合',
        trendData, changes,
        summary: this._generateTrendSummary(trendData, changes, subject)
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'trend', error: err.message };
    }
  }

  async _getMemberProfile(memberId, week, semesterId) {
    try {
      const allMembers = await this._getFullMembers();
      const member = allMembers.find(m => m.id === String(memberId));
      if (!member) return { type: 'admin_analysis', action: 'member_profile', error: `未找到成员ID: ${memberId}` };

      const allScores = await this._loadWeekScores(week, semesterId);
      const memberScores = this._mapScoresToMembers(allScores, [member]);
      const ms = memberScores[0] || { scores: {} };

      const dims = Object.keys(this.dimensionNames);
      const avgScore = dims.reduce((sum, d) => sum + (ms.scores[d] || 0), 0) / dims.length;

      const classMembers = allMembers.filter(m => m.class === member.class);
      const classScores = this._mapScoresToMembers(allScores, classMembers);
      const classAvg = this._calcOverallAvg(classScores);

      const overallScores = this._mapScoresToMembers(allScores, allMembers);
      const overallAvg = this._calcOverallAvg(overallScores);

      const scoredClassMembers = classScores
        .filter(cms => Object.values(cms.scores).some(v => v > 0))
        .map(cms => ({
          memberId: cms.memberId,
          avgScore: dims.reduce((s, d) => s + (cms.scores[d] || 0), 0) / dims.length
        }))
        .sort((a, b) => b.avgScore - a.avgScore);
      const classRank = scoredClassMembers.findIndex(cms => cms.memberId === String(memberId)) + 1;

      const scoredOverallMembers = overallScores
        .filter(oms => Object.values(oms.scores).some(v => v > 0))
        .map(oms => ({
          memberId: oms.memberId,
          avgScore: dims.reduce((s, d) => s + (oms.scores[d] || 0), 0) / dims.length
        }))
        .sort((a, b) => b.avgScore - a.avgScore);
      const overallRank = scoredOverallMembers.findIndex(oms => oms.memberId === String(memberId)) + 1;

      const dimensionAnalysis = {};
      for (const dim of dims) {
        const val = ms.scores[dim] || 0;
        const classValues = classScores.map(cs => cs.scores[dim]).filter(v => typeof v === 'number' && v > 0);
        const overallValues = overallScores.map(os => os.scores[dim]).filter(v => typeof v === 'number' && v > 0);
        const cAvg = classValues.length > 0 ? classValues.reduce((a, b) => a + b, 0) / classValues.length : 0;
        const oAvg = overallValues.length > 0 ? overallValues.reduce((a, b) => a + b, 0) / overallValues.length : 0;
        dimensionAnalysis[dim] = {
          name: this.dimensionNames[dim],
          score: val,
          classAvg: parseFloat(cAvg.toFixed(2)),
          classDeviation: parseFloat((val - cAvg).toFixed(2)),
          overallAvg: parseFloat(oAvg.toFixed(2)),
          overallDeviation: parseFloat((val - oAvg).toFixed(2)),
          level: val >= oAvg + 1 ? 'excellent' : val >= oAvg ? 'good' : val >= oAvg - 1 ? 'normal' : 'weak'
        };
      }

      let psychology = { hasData: false };
      const nominationData = await this._loadNominationData();
      if (nominationData) {
        const memberRecords = nominationData.filter(r => String(r.evaluatorId) === String(memberId));
        if (memberRecords.length > 0) {
          const latest = memberRecords[memberRecords.length - 1];
          const receivedPositive = nominationData.filter(r => (r.positiveNominations || []).includes(String(memberId))).length;
          const receivedNegative = nominationData.filter(r => (r.negativeNominations || []).includes(String(memberId))).length;
          psychology = {
            hasData: true,
            latestMood: latest.moodTag || '未知',
            moodHistory: memberRecords.map(r => ({ mood: r.moodTag, date: r.timestamp ? new Date(r.timestamp).toLocaleDateString('zh-CN') : '' })),
            selfAssessment: latest.selfAssessment || null,
            copingStyle: latest.copingStyle || [],
            positiveNominations: (latest.positiveNominations || []).length,
            negativeNominations: (latest.negativeNominations || []).length,
            receivedPositive, receivedNegative,
            socialStatus: receivedPositive >= 3 ? 'popular' : receivedPositive >= 1 ? 'normal' : 'isolated'
          };
        }
      }

      const currentWeek = this._getCurrentWeek();
      const recentWeeks = Math.min(4, currentWeek);
      const scoreTrend = [];
      for (let w = Math.max(1, currentWeek - recentWeeks + 1); w <= currentWeek; w++) {
        const wScores = await this._loadWeekScores(w, semesterId);
        const wMs = this._mapScoresToMembers(wScores, [member]);
        if (wMs[0] && Object.values(wMs[0].scores).some(v => v > 0)) {
          const wAvg = dims.reduce((s, d) => s + (wMs[0].scores[d] || 0), 0) / dims.length;
          scoreTrend.push({ week: w, avgScore: parseFloat(wAvg.toFixed(2)) });
        }
      }

      let experiences = [];
      try {
        const expPath = getDataPath('experiences.json');
        const expData = JSON.parse(await fs.readFile(expPath, 'utf-8'));
        const list = Array.isArray(expData) ? expData : [];
        experiences = list.filter(e => String(e.memberId) === String(memberId)).map(e => ({ type: e.type, name: e.data?.name || '', award: e.data?.award || '' }));
      } catch (e) {}

      return {
        type: 'admin_analysis', action: 'member_profile', week,
        memberId: member.id, memberName: member.name, class: member.class,
        mbti: member.mbti || '', zodiac: this._getZodiac(member.birthday),
        isBackbone: member.isBackbone || false, position: member.position || '',
        avgScore: parseFloat(avgScore.toFixed(2)),
        classAvg: parseFloat(classAvg.toFixed(2)),
        overallAvg: parseFloat(overallAvg.toFixed(2)),
        classRank: classRank || 0,
        classSize: scoredClassMembers.length,
        overallRank: overallRank || 0,
        overallSize: scoredOverallMembers.length,
        dimensionAnalysis,
        psychology,
        scoreTrend,
        experiences,
        summary: this._generateProfileSummary(member, avgScore, classAvg, overallAvg, classRank, overallRank, psychology, dimensionAnalysis)
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'member_profile', error: err.message };
    }
  }

  async _getMemberCompare(memberIdsStr, week, semesterId) {
    try {
      if (!memberIdsStr) return { type: 'admin_analysis', action: 'member_compare', error: '请提供memberIds参数（逗号分隔的成员ID）' };
      const ids = memberIdsStr.split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length < 2) return { type: 'admin_analysis', action: 'member_compare', error: '至少需要2个成员ID进行对比' };

      const members = await this._getMembersFromAPI();
      const allScores = await this._loadWeekScores(week, semesterId);
      const dims = Object.keys(this.dimensionNames);
      const compareData = [];

      for (const mid of ids) {
        const member = members.find(m => m.id === String(mid));
        const ms = this._mapScoresToMembers(allScores, member ? [member] : []);
        const data = ms[0] || { scores: {} };
        const avgScore = dims.reduce((s, d) => s + (data.scores[d] || 0), 0) / dims.length;

        let mood = null;
        const nominationData = await this._loadNominationData();
        if (nominationData) {
          const record = nominationData.find(r => String(r.evaluatorId) === String(mid));
          if (record) mood = record.moodTag;
        }

        compareData.push({
          memberId: String(mid),
          memberName: member?.name || mid,
          class: member?.class || '',
          mbti: member?.mbti || '',
          isBackbone: member?.isBackbone || false,
          position: member?.position || '',
          avgScore: parseFloat(avgScore.toFixed(2)),
          scores: data.scores,
          mood
        });
      }

      const dimensionComparison = {};
      for (const dim of dims) {
        dimensionComparison[dim] = {
          name: this.dimensionNames[dim],
          values: compareData.map(c => ({ memberId: c.memberId, memberName: c.memberName, score: c.scores[dim] || 0 }))
        };
      }

      const ranked = [...compareData].sort((a, b) => b.avgScore - a.avgScore);
      const strongest = dims.reduce((best, dim) => {
        const maxEntry = compareData.reduce((max, c) => (c.scores[dim] || 0) > (max.score) ? { memberName: c.memberName, score: c.scores[dim] || 0 } : max, { memberName: '', score: 0 });
        if (!best[dim]) best[dim] = maxEntry;
        return best;
      }, {});

      return {
        type: 'admin_analysis', action: 'member_compare', week,
        memberCount: compareData.length,
        compareData,
        dimensionComparison,
        ranking: ranked.map((r, i) => ({ rank: i + 1, memberName: r.memberName, avgScore: r.avgScore })),
        summary: this._generateCompareSummary(compareData, dimensionComparison)
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'member_compare', error: err.message };
    }
  }

  async _getScoreDistribution(week, dimension, className, semesterId) {
    try {
      const members = await this._getMembersFromAPI();
      let targetMembers = className ? members.filter(m => m.class === className) : members;
      const allScores = await this._loadWeekScores(week, semesterId);
      const memberScores = this._mapScoresToMembers(allScores, targetMembers);
      const dims = dimension ? [dimension] : Object.keys(this.dimensionNames);
      const distributions = {};

      for (const dim of dims) {
        const values = memberScores.map(ms => ms.scores[dim]).filter(v => typeof v === 'number' && v > 0);
        const bins = [
          { label: '0-2', min: 0, max: 2, count: 0 },
          { label: '2-4', min: 2, max: 4, count: 0 },
          { label: '4-6', min: 4, max: 6, count: 0 },
          { label: '6-8', min: 6, max: 8, count: 0 },
          { label: '8-10', min: 8, max: 10.01, count: 0 }
        ];
        for (const v of values) {
          for (const bin of bins) {
            if (v >= bin.min && v < bin.max) { bin.count++; break; }
          }
        }
        const total = values.length || 1;
        distributions[dim] = {
          name: this.dimensionNames[dim],
          total: values.length,
          avg: values.length > 0 ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)) : 0,
          bins: bins.map(b => ({ label: b.label, count: b.count, percentage: parseFloat((b.count / total * 100).toFixed(1)) }))
        };
      }

      const overallValues = memberScores
        .map(ms => { const ds = dims.map(d => ms.scores[d] || 0).filter(v => v > 0); return ds.length > 0 ? ds.reduce((a, b) => a + b, 0) / ds.length : 0; })
        .filter(v => v > 0);
      const overallBins = [
        { label: '0-2', min: 0, max: 2, count: 0 },
        { label: '2-4', min: 2, max: 4, count: 0 },
        { label: '4-6', min: 4, max: 6, count: 0 },
        { label: '6-8', min: 6, max: 8, count: 0 },
        { label: '8-10', min: 8, max: 10.01, count: 0 }
      ];
      for (const v of overallValues) {
        for (const bin of overallBins) {
          if (v >= bin.min && v < bin.max) { bin.count++; break; }
        }
      }
      const oTotal = overallValues.length || 1;
      const overallDistribution = {
        total: overallValues.length,
        avg: overallValues.length > 0 ? parseFloat((overallValues.reduce((a, b) => a + b, 0) / overallValues.length).toFixed(2)) : 0,
        bins: overallBins.map(b => ({ label: b.label, count: b.count, percentage: parseFloat((b.count / oTotal * 100).toFixed(1)) }))
      };

      return {
        type: 'admin_analysis', action: 'score_distribution', week,
        className: className || '全部班级',
        dimension: dimension ? this.dimensionNames[dimension] : '综合',
        overallDistribution,
        dimensionDistributions: distributions,
        summary: this._generateDistributionSummary(overallDistribution, distributions)
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'score_distribution', error: err.message };
    }
  }

  async _getDimensionCorrelation(week, className, semesterId) {
    try {
      const members = await this._getMembersFromAPI();
      let targetMembers = className ? members.filter(m => m.class === className) : members;
      const allScores = await this._loadWeekScores(week, semesterId);
      const memberScores = this._mapScoresToMembers(allScores, targetMembers);
      const scoredMembers = memberScores.filter(ms => Object.values(ms.scores).some(v => v > 0));
      const dims = Object.keys(this.dimensionNames);
      const correlationMatrix = {};

      for (const d1 of dims) {
        correlationMatrix[d1] = {};
        for (const d2 of dims) {
          const pairs = scoredMembers
            .map(ms => ({ x: ms.scores[d1], y: ms.scores[d2] }))
            .filter(p => typeof p.x === 'number' && p.x > 0 && typeof p.y === 'number' && p.y > 0);
          correlationMatrix[d1][d2] = this._pearsonCorrelation(pairs.map(p => p.x), pairs.map(p => p.y));
        }
      }

      const significantPairs = [];
      for (let i = 0; i < dims.length; i++) {
        for (let j = i + 1; j < dims.length; j++) {
          const r = correlationMatrix[dims[i]][dims[j]];
          if (Math.abs(r) >= 0.3) {
            significantPairs.push({
              dim1: dims[i], dim1Name: this.dimensionNames[dims[i]],
              dim2: dims[j], dim2Name: this.dimensionNames[dims[j]],
              correlation: parseFloat(r.toFixed(3)),
              strength: Math.abs(r) >= 0.7 ? 'strong' : Math.abs(r) >= 0.5 ? 'moderate' : 'weak',
              direction: r > 0 ? 'positive' : 'negative'
            });
          }
        }
      }
      significantPairs.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

      return {
        type: 'admin_analysis', action: 'dimension_correlation', week,
        className: className || '全部班级',
        sampleSize: scoredMembers.length,
        correlationMatrix,
        significantPairs,
        summary: significantPairs.length > 0
          ? `最强关联：${significantPairs[0].dim1Name}与${significantPairs[0].dim2Name}（r=${significantPairs[0].correlation}，${significantPairs[0].direction === 'positive' ? '正相关' : '负相关'}）`
          : '未发现显著维度关联'
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'dimension_correlation', error: err.message };
    }
  }

  async _getPeerNetwork(week, className, semesterId) {
    try {
      const members = await this._getMembersFromAPI();
      let targetMembers = className ? members.filter(m => m.class === className) : members;
      const nameMap = {};
      targetMembers.forEach(m => { nameMap[m.id] = m.name; });

      const allScores = await this._loadWeekScores(week, semesterId);
      const evaluatorMap = {};
      for (const record of allScores) {
        const eid = String(record.evaluatorId);
        const mid = String(record.memberId);
        if (!evaluatorMap[eid]) evaluatorMap[eid] = { evaluated: [] };
        evaluatorMap[eid].evaluated.push({ memberId: mid, memberName: nameMap[mid] || mid, type: record.type || 'unknown' });
      }

      const nominationData = await this._loadNominationData();
      const nominationNetwork = { nodes: [], positiveEdges: [], negativeEdges: [] };

      if (nominationData) {
        const filteredData = className
          ? nominationData.filter(r => targetMembers.some(m => m.id === String(r.evaluatorId)))
          : nominationData;

        const nodeSet = new Set();
        for (const record of filteredData) {
          const eid = String(record.evaluatorId);
          nodeSet.add(eid);
          for (const pid of (record.positiveNominations || [])) nodeSet.add(String(pid));
          for (const nid of (record.negativeNominations || [])) nodeSet.add(String(nid));
        }

        nominationNetwork.nodes = [...nodeSet].map(id => ({
          id, name: nameMap[id] || id,
          class: targetMembers.find(m => m.id === id)?.class || ''
        }));

        const seenPos = new Set();
        const seenNeg = new Set();
        for (const record of filteredData) {
          const source = String(record.evaluatorId);
          for (const pid of (record.positiveNominations || [])) {
            const target = String(pid);
            const key = [source, target].sort().join('-');
            if (!seenPos.has(key)) {
              seenPos.add(key);
              nominationNetwork.positiveEdges.push({ source, target, sourceName: nameMap[source] || source, targetName: nameMap[target] || target });
            }
          }
          for (const nid of (record.negativeNominations || [])) {
            const target = String(nid);
            const key = [source, target].sort().join('-');
            if (!seenNeg.has(key)) {
              seenNeg.add(key);
              nominationNetwork.negativeEdges.push({ source, target, sourceName: nameMap[source] || source, targetName: nameMap[target] || target });
            }
          }
        }
      }

      const receivedCount = {};
      const givenCount = {};
      for (const [eid, data] of Object.entries(evaluatorMap)) {
        givenCount[eid] = data.evaluated.length;
        for (const ev of data.evaluated) {
          receivedCount[ev.memberId] = (receivedCount[ev.memberId] || 0) + 1;
        }
      }

      const mostEvaluated = Object.entries(receivedCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([id, count]) => ({ memberId: id, memberName: nameMap[id] || id, receivedCount: count }));

      const mostActiveEvaluators = Object.entries(givenCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([id, count]) => ({ memberId: id, memberName: nameMap[id] || id, givenCount: count }));

      const mutualPairs = [];
      const evalPairs = {};
      for (const record of allScores) {
        const eid = String(record.evaluatorId);
        const mid = String(record.memberId);
        if (eid !== mid) {
          const key = [eid, mid].sort().join('-');
          if (!evalPairs[key]) evalPairs[key] = { ids: [eid, mid].sort(), count: 0 };
          evalPairs[key].count++;
        }
      }
      for (const pair of Object.values(evalPairs)) {
        if (pair.count >= 2) {
          mutualPairs.push({ member1: pair.ids[0], member1Name: nameMap[pair.ids[0]] || pair.ids[0], member2: pair.ids[1], member2Name: nameMap[pair.ids[1]] || pair.ids[1] });
        }
      }

      return {
        type: 'admin_analysis', action: 'peer_network', week,
        className: className || '全部班级',
        totalEvaluators: Object.keys(evaluatorMap).length,
        nominationNetwork,
        mostEvaluated,
        mostActiveEvaluators,
        mutualPairs: mutualPairs.slice(0, 10),
        summary: `${Object.keys(evaluatorMap).length}人参与评分，${nominationNetwork.positiveEdges.length}条正向关系，${nominationNetwork.negativeEdges.length}条负向关系`
      };
    } catch (err) {
      return { type: 'admin_analysis', action: 'peer_network', error: err.message };
    }
  }

  _pearsonCorrelation(x, y) {
    const n = x.length;
    if (n < 3) return 0;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
    const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
    const sumY2 = y.reduce((acc, yi) => acc + yi * yi, 0);
    const numerator = n * sumXY - sumX * sumY;
    const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
    if (denominator === 0) return 0;
    return numerator / denominator;
  }

  _percentile(sortedArr, p) {
    if (sortedArr.length === 0) return 0;
    const idx = (p / 100) * (sortedArr.length - 1);
    const lower = Math.floor(idx);
    const upper = Math.ceil(idx);
    if (lower === upper) return sortedArr[lower];
    return sortedArr[lower] + (sortedArr[upper] - sortedArr[lower]) * (idx - lower);
  }

  _calcOverallAvg(memberScores) {
    const scored = memberScores.filter(ms => Object.values(ms.scores).some(v => v > 0));
    if (scored.length === 0) return 0;
    const dims = Object.keys(this.dimensionNames);
    const avgs = scored.map(ms => dims.reduce((s, d) => s + (ms.scores[d] || 0), 0) / dims.length);
    return avgs.reduce((a, b) => a + b, 0) / avgs.length;
  }

  _getZodiac(birthday) {
    if (!birthday) return '未知';
    const date = new Date(birthday);
    if (isNaN(date.getTime())) return '未知';
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const zodiacMap = [
      { name: '摩羯座', start: [1, 1], end: [1, 19] }, { name: '水瓶座', start: [1, 20], end: [2, 18] },
      { name: '双鱼座', start: [2, 19], end: [3, 20] }, { name: '白羊座', start: [3, 21], end: [4, 19] },
      { name: '金牛座', start: [4, 20], end: [5, 20] }, { name: '双子座', start: [5, 21], end: [6, 21] },
      { name: '巨蟹座', start: [6, 22], end: [7, 22] }, { name: '狮子座', start: [7, 23], end: [8, 22] },
      { name: '处女座', start: [8, 23], end: [9, 22] }, { name: '天秤座', start: [9, 23], end: [10, 23] },
      { name: '天蝎座', start: [10, 24], end: [11, 22] }, { name: '射手座', start: [11, 23], end: [12, 21] },
      { name: '摩羯座', start: [12, 22], end: [12, 31] }
    ];
    for (const z of zodiacMap) {
      const [sm, sd] = z.start; const [em, ed] = z.end;
      if ((month === sm && day >= sd) || (month === em && day <= ed)) return z.name;
    }
    return '未知';
  }

  async _loadNominationData() {
    try {
      const dataPath = getDataPath('relationship_nominations.json');
      return JSON.parse(await fs.readFile(dataPath, 'utf-8'));
    } catch (e) { return null; }
  }

  async _getFullMembers() {
    try {
      const filePath = getDataPath('members.json');
      const raw = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      const list = Array.isArray(raw) ? raw : (raw.members || []);
      return list.map(m => ({
        id: String(m.id || m.memberId || ''),
        name: m.name || m.nickname || '',
        class: m.class || '',
        mbti: m.mbti || '',
        birthday: m.birthday || '',
        isBackbone: m.isBackbone || false,
        position: m.position || '',
        hobbies: m.hobbies || ''
      })).filter(m => m.id);
    } catch (e) { return []; }
  }

  _resolveClassName(input, members) {
    if (!input) return input;
    const allClasses = [...new Set(members.map(m => m.class).filter(Boolean))];
    if (allClasses.includes(input)) return input;
    const inputLower = input.toLowerCase();
    for (const cls of allClasses) {
      if (cls.toLowerCase() === inputLower) return cls;
    }
    for (const cls of allClasses) {
      if (cls.includes(input) || input.includes(cls)) return cls;
    }
    const inputClean = input.replace(/[班级组队]/g, '');
    for (const cls of allClasses) {
      const clsClean = cls.replace(/[班级组队]/g, '');
      if (clsClean === inputClean) return cls;
    }
    const numMap = { '一': '1', '二': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10', '十一': '11', '十二': '12' };
    const inputNum = input.replace(/[班级组队]/g, '').split('').map(c => numMap[c] || c).join('');
    for (const cls of allClasses) {
      const clsNum = cls.replace(/[班级组队]/g, '').split('').map(c => numMap[c] || c).join('');
      if (clsNum === inputNum) return cls;
    }
    let bestMatch = null;
    let bestScore = 0;
    for (const cls of allClasses) {
      let score = 0;
      const shorter = cls.length < input.length ? cls : input;
      const longer = cls.length < input.length ? input : cls;
      for (let i = 0; i < shorter.length; i++) {
        if (longer.includes(shorter[i])) score++;
      }
      score = score / Math.max(cls.length, input.length);
      if (score > bestScore) { bestScore = score; bestMatch = cls; }
    }
    if (bestScore >= 0.5) return bestMatch;
    return input;
  }

  async _loadWeekScores(week, semesterId) {
    if (!week) return [];
    const filePath = getScoreFilePath(week, semesterId);
    try {
      const compressed = await fs.readFile(filePath);
      const buffer = await new Promise((resolve, reject) => {
        zlib.unzip(compressed, (err, result) => err ? reject(err) : resolve(result));
      });
      return JSON.parse(buffer.toString());
    } catch (err) {
      try {
        const mainPath = getDataPath('scores.json');
        const data = JSON.parse(await fs.readFile(mainPath, 'utf-8'));
        return Array.isArray(data) ? data : [];
      } catch (e) { return []; }
    }
  }

  _mapScoresToMembers(allScores, members) {
    const nameMap = {};
    const idSet = new Set();
    members.forEach(m => { nameMap[m.id] = m.name; idSet.add(m.id); });
    if (Array.isArray(allScores) && allScores.length > 0) {
      const grouped = {};
      for (const record of allScores) {
        const mid = String(record.memberId);
        if (!idSet.has(mid)) continue;
        if (!grouped[mid]) grouped[mid] = { memberId: mid, memberName: nameMap[mid] || mid, class: members.find(m => m.id === mid)?.class || '', scores: {}, records: [] };
        grouped[mid].records.push(record);
        if (record.scores) {
          for (const [dim, val] of Object.entries(record.scores)) {
            if (typeof val === 'number') {
              grouped[mid].scores[dim] = grouped[mid].scores[dim] ? (grouped[mid].scores[dim] + val) / 2 : val;
            }
          }
        }
      }
      return Object.values(grouped);
    }
    return members.map(m => ({ memberId: m.id, memberName: m.name, class: m.class, scores: {} }));
  }

  _calculateClassAverages(memberScores) {
    const stats = {};
    for (const dim of Object.keys(this.dimensionNames)) {
      const values = memberScores.map(ms => ms.scores[dim]).filter(v => typeof v === 'number' && v > 0);
      if (values.length === 0) { stats[dim] = { avg: 0, stdDev: 0 }; continue; }
      const avg = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((acc, v) => acc + Math.pow(v - avg, 2), 0) / values.length;
      stats[dim] = { avg: parseFloat(avg.toFixed(2)), stdDev: parseFloat(Math.sqrt(variance).toFixed(2)) };
    }
    return stats;
  }

  _generateClassStatsSummary(stats, scoredCount, totalMembers, overallComparison) {
    const weakest = Object.entries(stats).sort(([, a], [, b]) => a.avg - b.avg).slice(0, 2).map(([, s]) => `${s.name}(${s.avg})`);
    const strongest = Object.entries(stats).sort(([, a], [, b]) => b.avg - a.avg).slice(0, 2).map(([, s]) => `${s.name}(${s.avg})`);
    let summary = `已评分${scoredCount}/${totalMembers}人，最强维度：${strongest.join('、')}，最弱维度：${weakest.join('、')}`;
    if (overallComparison) {
      const classAvg = Object.values(stats).reduce((sum, s) => sum + s.avg, 0) / Math.max(Object.keys(stats).length, 1);
      const diff = classAvg - overallComparison.overallAvg;
      summary += `，${diff >= 0 ? '高于' : '低于'}整体均分${overallComparison.overallAvg}共${Math.abs(diff).toFixed(2)}分`;
    }
    return summary;
  }

  _generateAlertSummary(alerts) {
    const high = alerts.filter(a => a.severity === 'high').length;
    const medium = alerts.filter(a => a.severity === 'medium').length;
    if (high === 0 && medium === 0) return '当前无异常预警，班级状态良好';
    const parts = [];
    if (high > 0) parts.push(`${high}项高优先级预警`);
    if (medium > 0) parts.push(`${medium}项中优先级关注`);
    return `共检测到${alerts.length}项异常：${parts.join('，')}`;
  }

  _generateRiskSummary(riskMembers) {
    const high = riskMembers.filter(r => r.riskLevel === 'high').length;
    const medium = riskMembers.filter(r => r.riskLevel === 'medium').length;
    if (high === 0 && medium === 0) return '未检测到高风险成员，班级整体状态良好';
    const names = riskMembers.filter(r => r.riskLevel === 'high').slice(0, 3).map(r => r.memberName);
    return `检测到${high}名高风险、${medium}名中风险成员${names.length > 0 ? '，高风险：' + names.join('、') : ''}`;
  }

  _generateTrendSummary(trendData, changes, subject) {
    if (trendData.length < 2) return `${subject}仅有${trendData.length}周数据，不足以分析趋势`;
    const first = trendData[0];
    const last = trendData[trendData.length - 1];
    const overallChange = last.avgScore - first.avgScore;
    const direction = overallChange > 0.5 ? '上升' : overallChange < -0.5 ? '下降' : '平稳';
    const biggestChange = changes.sort((a, b) => Math.abs(b.change) - Math.abs(a.change))[0];
    let detail = '';
    if (biggestChange && Math.abs(biggestChange.change) >= 0.5) {
      detail = `，变化最大：${biggestChange.name}${biggestChange.change > 0 ? '上升' : '下降'}${Math.abs(biggestChange.change).toFixed(1)}分`;
    }
    return `${subject}整体趋势${direction}（${first.avgScore}→${last.avgScore}）${detail}`;
  }

  _generateProfileSummary(member, avgScore, classAvg, overallAvg, classRank, overallRank, psychology, dimensionAnalysis) {
    const parts = [`${member.name}（${member.class}）`];
    parts.push(`综合均分${avgScore.toFixed(1)}，班级排名${classRank || '?'}，整体排名${overallRank || '?'}`);
    if (avgScore >= overallAvg + 1) parts.push('整体表现优秀');
    else if (avgScore >= overallAvg) parts.push('整体表现良好');
    else if (avgScore < overallAvg - 1) parts.push('整体需关注');
    const weak = Object.entries(dimensionAnalysis).filter(([, d]) => d.level === 'weak').map(([, d]) => d.name);
    const excellent = Object.entries(dimensionAnalysis).filter(([, d]) => d.level === 'excellent').map(([, d]) => d.name);
    if (excellent.length > 0) parts.push(`优势：${excellent.join('、')}`);
    if (weak.length > 0) parts.push(`薄弱：${weak.join('、')}`);
    if (psychology.hasData) {
      if (psychology.latestMood && this.negativeMoods.includes(psychology.latestMood)) parts.push(`当前情绪：${psychology.latestMood}（需关注）`);
      if (psychology.socialStatus === 'isolated') parts.push('社交状态：孤立');
    }
    return parts.join('；');
  }

  _generateCompareSummary(compareData, dimensionComparison) {
    const ranked = [...compareData].sort((a, b) => b.avgScore - a.avgScore);
    const parts = [`${ranked[0].memberName}综合领先（${ranked[0].avgScore}分）`];
    for (const [dim, data] of Object.entries(dimensionComparison)) {
      const best = data.values.sort((a, b) => b.score - a.score)[0];
      if (best && best.score > 0) parts.push(`${data.name}最强：${best.memberName}(${best.score})`);
    }
    return parts.join('；');
  }

  _generateDistributionSummary(overall, distributions) {
    if (!overall || overall.total === 0) return '暂无评分分布数据';
    const dominantBin = overall.bins ? overall.bins.reduce((max, b) => b.count > max.count ? b : max, { count: 0, label: '无', percentage: 0 }) : { label: '无', percentage: 0 };
    return `综合均分${overall.avg || 0}，主要分布在${dominantBin.label}分段（${dominantBin.percentage || 0}%）`;
  }
}

module.exports = AdminAnalysisTool;
