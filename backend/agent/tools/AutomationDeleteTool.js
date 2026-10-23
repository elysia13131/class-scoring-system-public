const BaseTool = require('./BaseTool');
const automationStore = require('../../data/automationStore');

class AutomationDeleteTool extends BaseTool {
  constructor() {
    super({
      name: 'automation_delete',
      description: '删除一个自动化任务。传入任务ID。',
      parameters: {
        automationId: { type: 'string', description: '要删除的自动化任务ID', required: true }
      },
      category: 'automation'
    });
  }

  async execute(params, context) {
    const ok = automationStore.deleteAutomation(params.automationId, context.memberId);
    if (!ok) return { success: false, error: '自动化任务不存在或无权删除' };
    return {
      success: true,
      data: { type: 'automation_deleted', message: '自动化任务已删除' }
    };
  }
}

module.exports = AutomationDeleteTool;
