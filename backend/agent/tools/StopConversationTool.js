const BaseTool = require('./BaseTool');

class StopConversationTool extends BaseTool {
  constructor() {
    super({
      name: 'stop_conversation',
      description: '当对话任务已完成、用户问题已充分解决时，主动调用此工具结束对话，避免不必要的循环。调用后可附带一段简短的结束语。',
      parameters: {
        message: { type: 'string', description: '可选的结束语，告诉用户对话已完成', required: false }
      },
      category: 'communication'
    });
  }

  async execute(params, context) {
    const endingMessage = params.message || '';
    return {
      success: true,
      data: {
        type: 'stop_conversation',
        message: endingMessage
      }
    };
  }
}

module.exports = StopConversationTool;
