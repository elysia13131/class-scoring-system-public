const BaseTool = require('./BaseTool');

class AdminCheckinTool extends BaseTool {
  constructor() {
    super({
      name: 'admin_checkin',
      description: '管理员速记工具。当管理员说"帮我记一下"、"记录一下"、"写个速记"等时调用。根据管理员的描述写入一条速记记录，包含文本内容、心情标签、分类标签和时间戳。',
      parameters: {
        text: { type: 'string', description: '要记录的内容文本', required: true },
        mood: { type: 'string', description: '心情标签，如 😊 😂 😐 😤 😢 💪 🥱 😰', required: false },
        tags: { type: 'array', description: '分类标签数组，如 ["工作","疲惫","压力"]', required: false },
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
      type: 'checkin',
      text,
      mood: params.mood || null,
      tags: params.tags || [],
      timestamp: params.timestamp || new Date().toISOString(),
      source: 'ai_tool'
    };

    store.writeRecord(context.memberId, record);

    return {
      success: true,
      message: `已写入速记：${text.substring(0, 40)}${text.length > 40 ? '...' : ''}`,
      record
    };
  }
}

module.exports = AdminCheckinTool;
