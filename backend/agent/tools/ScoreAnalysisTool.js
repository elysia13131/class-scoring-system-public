const BaseTool = require('./BaseTool');
const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');
const { getDataPath } = require('../../utils/dataPath');
const { getScoreFilePath } = require('../../utils/semester');

class ScoreAnalysisTool extends BaseTool {
  constructor() {
    super({
      name: 'query_scores',
      description: '查询成员评分数据。当用户说"查看成绩"、"我的评分"、"查分"、"成绩查询"、"本周评分"时调用。支持按周次、维度筛选，可自动生成雷达图',
      parameters: {
        memberId: { type: 'string', description: '成员ID（不填默认当前用户）', required: false },
        week: { type: 'number', description: '周次（不填默认当前周）', required: false },
        dimension: { type: 'string', description: '维度筛选: study/fitness/literacy/discipline/contribution/management', required: false },
        semesterId: { type: 'number', description: '学期ID（1=大一上,2=大一下,3=大二上,4=大二下...，查询特定学期的评分数据时使用，默认当前学期）', required: false }
      },
      category: 'scores'
    });

    this.dimensionNames = {
      study: '学习成绩',
      fitness: '体能素质',
      literacy: '人文素养',
      discipline: '遵章守纪',
      contribution: '班级贡献',
      management: '管理能力'
    };
  }

  async execute(params, context) {
    let memberId = params.memberId || context.memberId;
    const week = params.week || this._getCurrentWeek();
    const dimension = params.dimension;
    const semesterId = params.semesterId || this._getCurrentSemesterId();

    try {
      const scores = await this._loadScores(memberId, week, semesterId);
      const memberName = await this._getMemberName(memberId);

      if (dimension) {
        return this._filterByDimension(scores, dimension, memberName);
      }

      const resultData = scores.aggregatedScores || scores.scores || scores;

      const hasData = resultData && typeof resultData === 'object' && Object.keys(resultData).some(k => typeof resultData[k] === 'number' && resultData[k] > 0);

      if (!hasData) {
        return {
          type: 'score_data',
          hasData: false,
          member: memberId,
          week,
          message: `暂无第${week}周的评分数据，可能还未填写或正在审核中`,
          suggestion: `可以尝试：填写第${this._getCurrentWeek()}周评分`
        };
      }

      return {
        type: 'score_data',
        hasData: true,
        member: memberId,
        memberName,
        week,
        scores: resultData,
        summary: this._generateSummary(resultData),
        detail: scores.selfEval ? {
          selfScores: scores.selfEval.scores,
          subItemScores: scores.selfEval.subItemScores,
          peerCount: (scores.peerEvals || []).length,
          totalRecords: scores.recordCount
        } : null
      };
    } catch (err) {
      return {
        type: 'score_data',
        error: 'load_failed',
        message: `查询失败: ${err.message}`,
        member: memberId,
        week
      };
    }
  }

  async getRadarConfig(memberId, week, semesterId) {
    const rawData = await this._loadScores(memberId, week, semesterId);
    const scores = rawData.aggregatedScores || rawData.scores || rawData;
    const dimensions = Object.keys(this.dimensionNames);

    const values = dimensions.map(dim => {
      const val = scores[dim];
      return typeof val === 'number' ? parseFloat(val.toFixed(2)) : 0;
    });

    const memberName = await this._getMemberName(memberId);

    return {
      type: 'echarts_config',
      chartType: 'radar',
      config: {
        title: { text: `${memberName} 第${week || this._getCurrentWeek()}周 六维评分`, left: 'center', textStyle: { fontSize: 14, fontWeight: 600, color: '#1f2937' } },
        tooltip: { trigger: 'item' },
        legend: { data: ['评分'], bottom: 0 },
        radar: {
          indicator: dimensions.map(dim => ({
            name: this.dimensionNames[dim],
            max: 10
          })),
          shape: 'polygon',
          splitNumber: 5,
          axisName: { color: '#6b7280', fontSize: 11 }
        },
        series: [{
          type: 'radar',
          data: [{
            value: values,
            name: '评分',
            areaStyle: { color: 'rgba(102,126,234,0.2)' },
            lineStyle: { color: '#667eea', width: 2 },
            itemStyle: { color: '#667eea' }
          }]
        }],
        color: ['#667eea']
      }
    };
  }

  _checkAccessPermission(targetMemberId, context) {
  }

  async _loadScores(memberId, week, semesterId) {
    const targetId = String(memberId || '');

    if (week) {
      const filePath = getScoreFilePath(week, semesterId);
      try {
        const compressed = await fs.readFile(filePath);
        const buffer = await _p(zlib.unzip)(compressed);
        const allScores = JSON.parse(buffer.toString());

        if (Array.isArray(allScores)) {
          const memberRecords = allScores.filter(s => String(s.memberId) === targetId);
          if (memberRecords.length === 0) return { week, empty: true };

          const selfRecord = memberRecords.find(r => r.type === 'self');
          const peerRecords = memberRecords.filter(r => r.type !== 'self');

          return {
            week,
            recordCount: memberRecords.length,
            selfEval: selfRecord ? {
              scores: selfRecord.scores || {},
              subItemScores: selfRecord.subItemScores || {},
              evaluatorId: selfRecord.evaluatorId,
              timestamp: selfRecord.timestamp
            } : null,
            peerEvals: peerRecords.map(r => ({
              scores: r.scores || {},
              evaluatorId: r.evaluatorId,
              timestamp: r.timestamp
            })),
            aggregatedScores: this._aggregateMemberScores(memberRecords),
            rawRecords: memberRecords
          };
        }
        return allScores[targetId] || { week, empty: true };
      } catch (err) {
        return { week, error: '数据文件不存在或损坏', empty: true };
      }
    }

    try {
      const mainScoresPath = getDataPath('scores.json');
      const mainScores = JSON.parse(await fs.readFile(mainScoresPath, 'utf-8'));
      return mainScores[targetId] || {};
    } catch (err) {
      return {};
    }
  }

  _aggregateMemberScores(records) {
    const dimensions = Object.keys(this.dimensionNames);
    const result = {};
    for (const dim of dimensions) {
      const values = records.map(r => (r.scores && r.scores[dim]) || 0).filter(v => v > 0);
      result[dim] = values.length > 0
        ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2))
        : 0;
    }
    return result;
  }

  _filterByDimension(scores, dimension, memberName) {
    const dimData = scores[dimension] || (scores.scores?.[dimension]);
    if (!dimData) {
      return {
        dimension,
        memberName,
        data: null,
        summary: { message: `暂无"${this.dimensionNames[dimension] || dimension}"维度的数据` }
      };
    }
    return {
      dimension,
      memberName,
      data: dimData,
      summary: this._generateDimensionSummary(dimData)
    };
  }

  _generateSummary(scores) {
    const totals = {};
    for (const [dim, value] of Object.entries(scores)) {
      if (typeof value === 'number') {
        totals[dim] = parseFloat(value.toFixed(2));
      } else if (value && typeof value === 'object') {
        const values = Object.values(value).filter(v => typeof v === 'number');
        totals[dim] = values.length > 0
          ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2))
          : 0;
      } else {
        totals[dim] = 0;
      }
    }
    return totals;
  }

  _generateDimensionSummary(dimScores) {
    if (!dimScores || typeof dimScores !== 'number') {
      return { message: '暂无该维度详细数据' };
    }
    return { avg: dimScores, max: dimScores, min: dimScores };
  }

  async _getMemberName(memberId) {
    try {
      const members = await this._getMembersFromAPI();
      const found = members.find(m => m.id === String(memberId));
      return found?.name || memberId;
    } catch (e) {
      return memberId;
    }
  }
}

function _p(fn) {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (err, result) => err ? reject(err) : resolve(result));
  });
}

module.exports = ScoreAnalysisTool;
