const BaseTool = require('./BaseTool');

class AdminObservationTool extends BaseTool {
  constructor() {
    super({
      name: 'admin_observation',
      description: '管理记录工具。当管理员说"记录管理观察"、"写个管理笔记"、讨论班级管理中的观察和反思时调用。将管理员的观察、反思、决策等写入管理记录，带上时间戳。这些记录后续可以用于反馈生成和趋势分析。',
      parameters: {
        text: { type: 'string', description: '管理观察/反思的内容文本', required: true },
        category: { type: 'string', description: '记录分类: observation(观察记录), reflection(反思), decision(管理决策), note(一般记录)', required: false },
        relatedMembers: { type: 'array', description: '涉及的学员ID列表', required: false },
        relatedClass: { type: 'string', description: '涉及的班级名称', required: false },
        timestamp: { type: 'string', description: '记录的时间戳（ISO格式），不填则默认当前时间', required: false }
      },
      requireAuth: true,
      category: 'checkin'
    });
  }

  async execute(params, context) {
    const store = require('../../data/checkin_records/store');
    const text = (params.text || '').trim();
    if (!text) return { success: false, error: '内容不能为空' };

    const record = {
      memberId: context.memberId,
      type: 'admin_observation',
      text,
      category: params.category || 'note',
      relatedMembers: params.relatedMembers || [],
      relatedClass: params.relatedClass || null,
      tags: [
        params.category || 'note',
        params.relatedClass ? `班级:${params.relatedClass}` : null,
        params.relatedMembers && params.relatedMembers.length > 0 ? '涉及学员' : null
      ].filter(Boolean),
      timestamp: params.timestamp || new Date().toISOString(),
      source: 'ai_tool'
    };

    store.writeRecord(context.memberId, record);

    return {
      success: true,
      message: `已写入管理记录[${record.category}]：${text.substring(0, 40)}${text.length > 40 ? '...' : ''}`,
      record
    };
  }
}

module.exports = AdminObservationTool;
