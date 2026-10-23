const BaseTool = require('./BaseTool');
const axios = require('axios');

class MoodRecordTool extends BaseTool {
  constructor() {
    super({
      name: 'mood_record',
      description: '填写心情记录表单或提交心情数据。当用户说"填写心情"、"心情记录"、"记录心情"时调用。action不填或=get_form返回填写表单，action=submit提交数据',
      parameters: {
        action: { type: 'string', description: 'get_form(获取表单，默认) 或 submit(提交数据)', required: false },
        moodTag: { type: 'string', description: '选择的心情标签' },
        selfAssessment: { type: 'object', description: '自我评估各维度分数' },
        copingStyle: { type: 'array', description: '选择的应对方式列表' },
        positiveNominations: { type: 'array', description: '正向提名成员ID列表' },
        negativeNominations: { type: 'array', description: '负向提名成员ID列表' }
      },
      category: 'psychology'
    });
  }

  async execute(params, context) {
    const action = params.action || 'get_form';

    if (action === 'submit') {
      return await this._doSubmit(params, context);
    }

    return this._generateFormSchema(context);
  }

  async _generateFormSchema(context) {
    const allMembers = await this._getMembersFromAPI();
    const currentMember = allMembers.find(m => m.id === String(context.memberId || ''));
    const currentClass = currentMember?.class || '';

    let members;
    members = allMembers;

    let moodTags = ['开心','满足','平静','焦虑','沮丧','愤怒','疲惫','孤独','兴奋','自信','紧张','放松','快乐','悲伤','烦躁','温暖'];
    try {
      const tagsRes = await this._fetchAPI('/api/mood-tags');
      if (Array.isArray(tagsRes) && tagsRes.length > 0) {
        moodTags = tagsRes;
      }
    } catch (e) {}

    const negativeTags = ['焦虑','沮丧','愤怒','疲惫','孤独','悲伤','烦躁'];

    return {
      type: 'form',
      formType: 'mood_record',
      submitAction: 'mood_record',
      title: '心情记录',
      formSchema: {
        title: '💭 心情记录',
        sections: [
          {
            key: 'mood_tag',
            label: '当前心情',
            type: 'tag_select',
            tags: moodTags,
            negativeTags: moodTags.filter(t => negativeTags.includes(t))
          },
          {
            key: 'self_assessment',
            label: '自我评估（1-10分）',
            type: 'sliders',
            fields: [
              { key: 'sleepQuality', label: '睡眠质量', min: 1, max: 10, default: 5 },
              { key: 'emotionalState', label: '情绪状态', min: 1, max: 10, default: 5 },
              { key: 'stressLevel', label: '压力感受', min: 1, max: 10, default: 5 },
              { key: 'appetiteLevel', label: '食欲状况', min: 1, max: 10, default: 5 },
              { key: 'roommateRelation', label: '室友关系', min: 1, max: 10, default: 5 }
            ]
          },
          {
            key: 'coping_style',
            label: '应对方式（可多选）',
            type: 'multi_select',
            options: ['倾诉','运动','写作','听音乐','打游戏','吃东西','睡觉','独自消化','寻求专业帮助']
          },
          {
            key: 'nominations',
            label: '关系提名',
            type: 'dual_list',
            positiveLabel: '正向提名（欣赏的人）',
            negativeLabel: '负向提名（需关注的人）',
            members
          }
        ],
        validation: { rules: ['请选择一个心情标签', '自我评估所有项目都需要填写'] }
      },
      meta: { memberCount: members.length }
    };
  }

  async _doSubmit(params, context) {
    const { moodTag, selfAssessment, copingStyle, positiveNominations, negativeNominations } = params;

    if (!moodTag) {
      return { type: 'submit_result', success: false, error: '请选择一个心情标签' };
    }

    try {
      const port = process.env.PORT || 3001;
      const response = await axios.post(`http://127.0.0.1:${port}/api/relationship-nominations`, {
        evaluatorId: context.memberId,
        moodTag,
        selfAssessment: selfAssessment || {},
        copingStyle: copingStyle || [],
        positiveNominations: positiveNominations || [],
        negativeNominations: negativeNominations || []
      });

      return {
        type: 'submit_result',
        success: true,
        message: `💭 心情记录提交成功！当前心情：【${moodTag}】`,
        data: response.data
      };
    } catch (error) {
      const errMsg = error.response?.data?.message || error.response?.data?.error || error.message;
      return { type: 'submit_result', success: false, error: `提交失败: ${errMsg}` };
    }
  }
}

module.exports = MoodRecordTool;
