const BaseTool = require('./BaseTool');
const path = require('path');
const fs = require('fs').promises;
const { getDataPath } = require('../../utils/dataPath');

class PsychologyTool extends BaseTool {
  constructor() {
    super({
      name: 'psychology_station',
      description: '心理气象站：查询关系提名、心情追踪、社交地图。当用户说"心理气象站"、"关系提名"、"社交地图"时调用',
      parameters: {
        action: { type: 'string', description: '操作类型: relationship(关系提名) / mood_tracker(心情追踪) / social_map(社交地图,需管理员)', required: false },
        memberId: { type: 'string', description: '成员ID（不填默认当前用户）', required: false }
      },
      category: 'psychology'
    });
  }

  async execute(params, context) {
    const action = params.action || 'relationship';
    let memberId = params.memberId || context.memberId;
    if (!context.isAdmin && context.memberId) {
      memberId = context.memberId;
    }

    switch (action) {
      case 'relationship':
        return await this._getRelationshipNominations(memberId, context);
      case 'mood_tracker':
        return await this._getMoodHistory(memberId, context);
      case 'social_map':
        return await this._generateSocialMap(context);
      default:
        return this._getHelp(action);
    }
  }

  _getHelp(invalidAction) {
    return {
      type: 'help',
      validActions: [
        { action: 'relationship', desc: '查询关系提名数据' },
        { action: 'mood_tracker', desc: '查询心情自我评估历史' },
        { action: 'social_map', desc: '生成班级社交关系网络图（管理员）' }
      ],
      usageExample: '{"tool": "psychology_station", "params": {"action": "relationship"}}',
      ...(invalidAction ? { hint: `"${invalidAction}" 不是有效操作，请使用上方选项` } : {})
    };
  }

  async _getRelationshipNominations(memberId, context) {
    try {
      const dataPath = getDataPath('relationship_nominations.json');
      const allData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));

      const memberData = allData.find(m => String(m.evaluatorId) === String(memberId));
      if (!memberData) {
        return {
          type: 'relationship',
          memberId,
          hasData: false,
          message: '暂无关系提名记录，可以通过"填写心情记录"来提交',
          positiveNominations: [],
          negativeNominations: [],
          suggestion: '尝试：填写心情记录'
        };
      }

      const members = await this._getMembersFromAPI();
      const nameMap = {};
      members.forEach(m => { nameMap[m.id] = m.name; });

      const positiveNominations = (memberData.positiveNominations || []).map(id => ({
        id: String(id),
        name: nameMap[String(id)] || id
      }));
      const negativeNominations = (memberData.negativeNominations || []).map(id => ({
        id: String(id),
        name: nameMap[String(id)] || id
      }));

      return {
        type: 'relationship',
        memberId,
        memberName: nameMap[String(memberId)] || memberId,
        hasData: true,
        positiveNominations,
        negativeNominations,
        summary: this._analyzeRelationships(positiveNominations.length, negativeNominations.length),
        moodTag: memberData.moodTag || null,
        selfAssessment: memberData.selfAssessment || null
      };
    } catch (err) {
      return {
        type: 'relationship',
        memberId,
        hasData: false,
        message: '关系提名数据读取失败',
        error: err.message
      };
    }
  }

  async _getMoodHistory(memberId, context) {
    try {
      const dataPath = getDataPath('relationship_nominations.json');
      const allData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
      const records = allData.filter(m => String(m.evaluatorId) === String(memberId));

      if (records.length === 0) {
        return {
          type: 'mood_history',
          memberId,
          hasData: false,
          message: '暂无心情记录，可以通过"填写心情记录"开始记录',
          suggestion: '尝试：填写心情记录'
        };
      }

      const members = await this._getMembersFromAPI();
      const memberName = members.find(m => m.id === String(memberId))?.name || memberId;

      const history = records.map(r => ({
        date: r.timestamp ? new Date(r.timestamp).toLocaleDateString('zh-CN') : '未知日期',
        moodTag: r.moodTag,
        selfAssessment: r.selfAssessment,
        positiveCount: (r.positiveNominations || []).length,
        negativeCount: (r.negativeNominations || []).length
      }));

      return {
        type: 'mood_history',
        memberId,
        memberName,
        hasData: true,
        totalRecords: records.length,
        latestMood: records[records.length - 1]?.moodTag,
        history
      };
    } catch (err) {
      return { type: 'mood_history', error: err.message, message: '心情数据读取失败' };
    }
  }

  async _generateSocialMap(context) {
    try {
      const dataPath = getDataPath('relationship_nominations.json');
      const allData = JSON.parse(await fs.readFile(dataPath, 'utf-8'));

      const members = await this._getMembersFromAPI();
      const nameMap = {};
      members.forEach(m => { nameMap[m.id] = m.name; });

      const nodes = allData.map(m => ({
        id: m.evaluatorId,
        name: nameMap[m.evaluatorId] || m.evaluatorId,
        connections: (m.positiveNominations || []).length
      }));

      const edges = [];
      const seen = new Set();

      allData.forEach(source => {
        (source.positiveNominations || []).forEach(target => {
          const key = [String(source.evaluatorId), String(target)].sort().join('-');
          if (!seen.has(key)) {
            seen.add(key);
            edges.push({
              source: source.evaluatorId,
              target,
              sourceName: nameMap[source.evaluatorId] || source.evaluatorId,
              targetName: nameMap[target] || target,
              type: 'positive'
            });
          }
        });
      });

      return {
        type: 'social_map',
        nodeCount: nodes.length,
        edgeCount: edges.length,
        nodes: nodes.sort((a, b) => b.connections - a.connections),
        edges: edges.slice(0, 50)
      };
    } catch (err) {
      return { type: 'social_map', error: err.message, message: '无法生成社交地图' };
    }
  }

  _analyzeRelationships(posCount, negCount) {
    let assessment;
    if (posCount === 0 && negCount === 0) {
      assessment = '尚未提交关系提名';
    } else if (negCount === 0) {
      assessment = '人际关系良好，全部为正向提名';
    } else if (posCount > negCount * 2) {
      assessment = '人际关系良好';
    } else if (posCount > negCount) {
      assessment = '人际关系正常';
    } else {
      assessment = '建议关注人际交往情况';
    }

    return {
      totalPositive: posCount,
      totalNegative: negCount,
      ratio: negCount > 0 ? (posCount / negCount).toFixed(2) : '∞',
      assessment
    };
  }
}

module.exports = PsychologyTool;
