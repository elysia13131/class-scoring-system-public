const BaseTool = require('./BaseTool');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { getDataPath } = require('../../utils/dataPath');
const { getCurrentWeek, getCurrentSemesterId } = require('../../utils/semester');

class ScoreSubmitTool extends BaseTool {
  constructor() {
    super({
      name: 'submit_score',
      description: '提交或获取评分表单。当用户要填写评分、打分、提交评分时调用此工具。支持自评和互评。',
      parameters: {
        action: { type: 'string', description: '操作类型: get_form(获取填写表单) 或 submit(提交评分)', required: false },
        memberId: { type: 'string', description: '被评人ID（不填则默认当前用户）', required: false },
        evaluatorId: { type: 'string', description: '评分人ID', required: false },
        week: { type: 'number', description: '周次', required: false },
        type: { type: 'string', description: '评分类型: self(自评) 或 peer(互评)', required: false },
        subItemScores: { type: 'object', description: '各维度子项得分，格式: {"维度key_子项key": 分数}', required: false }
      },
      requireAuth: false,
      category: 'scores'
    });

    this.dimensions = [
      {
        key: 'study',
        name: '学习成绩',
        items: [
          { key: 'prep', label: '预习准备', min: 0, max: 2 },
          { key: 'class', label: '课堂参与', min: 0, max: 2 },
          { key: 'review', label: '复习巩固', min: 0, max: 2 },
          { key: 'apply', label: '知识应用', min: 0, max: 2 },
          { key: 'result', label: '学业成果', min: 0, max: 2 }
        ]
      },
      {
        key: 'fitness',
        name: '体能素质',
        items: [
          { key: 'base', label: '基础体能成绩', min: 0, max: 3 },
          { key: 'attitude', label: '训练态度方法', min: 0, max: 2 },
          { key: 'health', label: '健康管理', min: 0, max: 2 },
          { key: 'injury', label: '伤病管理', min: 0, max: 2 },
          { key: 'improve', label: '体能提升', min: 0, max: 1 }
        ]
      },
      {
        key: 'literacy',
        name: '人文素养',
        items: [
          { key: 'reading', label: '阅读学习', min: 0, max: 2 },
          { key: 'culture', label: '文体活动', min: 0, max: 2 },
          { key: 'discipline', label: '自律意识', min: 0, max: 2 },
          { key: 'problem', label: '问题解决', min: 0, max: 2 },
          { key: 'empathy', label: '共情能力', min: 0, max: 2 }
        ]
      },
      {
        key: 'discipline',
        name: '遵章守纪',
        items: [
          { key: 'queue', label: '队列内务', min: 0, max: 2 },
          { key: 'duty', label: '值班岗哨', min: 0, max: 2 },
          { key: 'daily', label: '日常规范', min: 0, max: 3 },
          { key: 'class', label: '课堂纪律', min: 0, max: 2 },
          { key: 'safety', label: '安全意识', min: 0, max: 1 }
        ]
      },
      {
        key: 'contribution',
        name: '班级贡献',
        items: [
          { key: 'work', label: '本职工作', min: 0, max: 2 },
          { key: 'environment', label: '环境维护', min: 0, max: 2 },
          { key: 'collective', label: '集体建设', min: 0, max: 2 },
          { key: 'honor', label: '荣誉争取', min: 0, max: 2 },
          { key: 'help', label: '互助支持', min: 0, max: 2 }
        ]
      },
      {
        key: 'management',
        name: '管理能力',
        items: [
          { key: 'responsibility', label: '职责履行', min: 0, max: 3 },
          { key: 'ability', label: '能力表现', min: 0, max: 3 },
          { key: 'activity', label: '活动组织', min: 0, max: 2 },
          { key: 'improvement', label: '改进提升', min: 0, max: 2 }
        ]
      }
    ];
  }

  async execute(params, context = {}) {
    const action = params.action || 'get_form';

    if (action === 'get_form') {
      return this._generateFormSchema(context);
    }

    if (action === 'submit') {
      return await this._doSubmit(params, context);
    }

    throw new Error(`未知操作: ${action}`);
  }

  async _generateFormSchema(context) {
    try {
      const port = process.env.PORT || 3001;
      const host = '127.0.0.1';

      const [membersRes, weeksRes] = await Promise.all([
        axios.get(`http://${host}:${port}/api/members`),
        axios.get(`http://${host}:${port}/api/available-scoring-weeks`)
      ]);

      const rawMembers = Array.isArray(membersRes.data) ? membersRes.data : (membersRes.data.members || []);

      const currentMember = rawMembers.find(m => String(m.id || m.memberId || '') === String(context.memberId || ''));
      const currentClass = currentMember?.class || '';

      let classMembers;
      classMembers = rawMembers.map(m => ({
        id: String(m.id || m.memberId || ''),
        name: m.name || m.nickname || '',
        class: m.class || ''
      })).filter(m => m.id);

      const weekData = weeksRes.data || {};
      const currentWeek = weekData.currentWeek || 1;
      const makeupWeeks = Array.isArray(weekData.makeupWeeks) ? weekData.makeupWeeks : [];
      const activeMakeupWeeks = makeupWeeks.filter(w => w.isActive);

      const allAvailableWeeks = [
        { value: currentWeek, label: `第${currentWeek}周（本周）`, isCurrent: true, isMakeup: false },
        ...activeMakeupWeeks.map(w => ({
          value: w.week,
          label: `第${w.week}周（补评）`,
          isCurrent: false,
          isMakeup: true,
          startDate: w.startDate || '',
          endDate: w.endDate || ''
        }))
      ];

      return {
        type: 'form',
        formType: 'score_submit',
        submitAction: 'submit_score',
        title: '填写评分',
        formSchema: {
          title: '📝 填写评分',
          validation: {
            rules: ['所有子项必须填写', '分数范围: 0 ~ 各项最大值', '请客观公正评分']
          },
          fields: [
            {
              key: 'targetMemberId',
              label: '被评人',
              type: 'select',
              options: classMembers.map(m => ({ value: m.id, label: m.name })),
              default: String(context.memberId || classMembers[0]?.id || ''),
              required: true
            },
            {
              key: 'scoreType',
              label: '评分方式',
              type: 'select',
              options: [
                { value: 'self', label: '自评' },
                { value: 'peer', label: '互评' }
              ],
              default: 'self',
              required: true
            },
            {
              key: 'week',
              label: '选择周次',
              type: 'select',
              options: allAvailableWeeks.map(w => ({
                value: w.value,
                label: w.label,
                isCurrent: w.isCurrent,
                isMakeup: w.isMakeup
              })),
              default: currentWeek,
              required: true
            }
          ],
          dimensions: this.dimensions.map(dim => ({
            key: dim.key,
            name: dim.name,
            items: dim.items.map(item => ({
              key: item.key,
              label: item.label,
              min: item.min,
              max: item.max,
              default: Math.ceil(item.max / 2)
            }))
          }))
        },
        meta: {
          currentWeek,
          availableWeekCount: allAvailableWeeks.length,
          memberCount: members.length,
          makeupWeekCount: activeMakeupWeeks.length
        }
      };
    } catch (err) {
      console.error('[ScoreSubmit] 获取表单数据失败:', err.message);
      return this._generateFallbackFormSchema(context);
    }
  }

  _generateFallbackFormSchema(context) {
    const allMembers = this._readMembers();
    const currentMember = allMembers.find(m => m.id === String(context.memberId || ''));
    const currentClass = currentMember?.class || '';
    const members = allMembers.filter(m => !currentClass || m.class === currentClass);
    const currentWeek = this._getCurrentWeek();

    return {
      type: 'form',
      formType: 'score_submit',
      submitAction: 'submit_score',
      title: '填写评分',
      formSchema: {
        title: '📝 填写评分',
        validation: {
          rules: ['所有子项必须填写', '分数范围: 0 ~ 各项最大值']
        },
        fields: [
          {
            key: 'targetMemberId',
            label: '被评人',
            type: 'select',
            options: members.map(m => ({ value: m.id, label: m.name })),
            default: String(context.memberId || members[0]?.id || ''),
            required: true
          },
          {
            key: 'scoreType',
            label: '评分方式',
            type: 'select',
            options: [{ value: 'self', label: '自评' }, { value: 'peer', label: '互评' }],
            default: 'self'
          },
          {
            key: 'week',
            label: '周次',
            type: 'number',
            min: 1,
            max: Math.max(currentWeek, 10),
            default: currentWeek
          }
        ],
        dimensions: this.dimensions.map(dim => ({
          key: dim.key,
          name: dim.name,
          items: dim.items.map(item => ({
            key: item.key,
            label: item.label,
            min: item.min,
            max: item.max,
            default: Math.ceil(item.max / 2)
          }))
        }))
      },
      meta: { currentWeek, fallbackMode: true }
    };
  }

  _readMembers() {
    try {
      const filePath = getDataPath('members.json');
      if (!fs.existsSync(filePath)) return [];
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list = Array.isArray(data) ? data : (data.members || []);
      return list.map(m => ({
        id: String(m.id || m.memberId || ''),
        name: m.name || m.nickname || '',
        class: m.class || ''
      })).filter(m => m.id);
    } catch (e) {
      console.warn('[ScoreSubmit] 读取成员失败:', e.message);
      return [];
    }
  }

  _getCurrentWeek() {
    return getCurrentWeek();
  }

  _getCurrentSemesterId() {
    return getCurrentSemesterId();
  }

  async _doSubmit(params, context) {
    const { memberId, evaluatorId, week, type, subItemScores } = params;

    if (!memberId) {
      return { success: false, error: '缺少被评人ID' };
    }

    if (!week || week < 1) {
      return { success: false, error: '无效的周次' };
    }

    if (!subItemScores || Object.keys(subItemScores).length === 0) {
      return { success: false, error: '没有提交任何评分数据' };
    }

    for (const [key, value] of Object.entries(subItemScores)) {
      if (typeof value === 'number' && value % 0.5 !== 0) {
        return { success: false, error: `评分项"${key}"的值${value}不是0.5的倍数，评分必须是0.5的倍数` };
      }
    }

    const aggregatedScores = this._aggregateDimensionScores(subItemScores);

    const payload = {
      memberId,
      evaluatorId: evaluatorId || context.memberId,
      week: parseInt(week),
      semesterId: this._getCurrentSemesterId(),
      type: type || 'self',
      scores: aggregatedScores,
      subItemScores,
      timestamp: new Date().toISOString()
    };

    try {
      const port = process.env.PORT || 3001;
      const host = '127.0.0.1';
      const response = await axios.post(`http://${host}:${port}/api/scores`, payload);

      if (response.status === 201 || response.data?.id) {
        const targetName = this._getMemberName(memberId);
        const typeName = type === 'peer' ? '互评' : '自评';
        return {
          success: true,
          message: `${typeName}提交成功！已为【${targetName}】完成第${week}周的评分。`,
          submittedData: payload
        };
      }

      return { success: false, error: response.data?.error || '提交失败' };
    } catch (err) {
      console.error('[ScoreSubmit] 提交失败:', err.response?.data || err.message);
      return {
        success: false,
        error: err.response?.data?.error || err.message || '网络错误，提交失败'
      };
    }
  }

  _aggregateDimensionScores(subItemScores) {
    const result = {};

    for (const dim of this.dimensions) {
      let totalScore = 0;
      let maxPossibleScore = 0;

      for (const item of dim.items) {
        const fullKey = `${dim.key}_${item.key}`;
        maxPossibleScore += item.max;
        if (subItemScores.hasOwnProperty(fullKey)) {
          const val = parseFloat(subItemScores[fullKey]);
          if (!isNaN(val) && val >= item.min && val <= item.max) {
            totalScore += val;
          }
        }
      }

      if (maxPossibleScore > 0) {
        result[dim.key] = Math.round((totalScore / maxPossibleScore) * 10 * 10) / 10;
      } else {
        result[dim.key] = 0;
      }
    }

    return result;
  }

  _getMemberName(memberId) {
    const members = this._readMembers();
    const found = members.find(m => m.id === String(memberId));
    return found?.name || memberId;
  }
}

module.exports = ScoreSubmitTool;
