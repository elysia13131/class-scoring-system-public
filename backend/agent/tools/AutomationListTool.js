const BaseTool = require('./BaseTool');
const automationStore = require('../../data/automationStore');

class AutomationListTool extends BaseTool {
  constructor() {
    super({
      name: 'automation_list',
      description: '查看所有自动化任务列表（该成员创建的）。',
      parameters: {},
      category: 'automation'
    });
  }

  async execute(params, context) {
    const list = automationStore.getAutomationsByMember(context.memberId);
    return {
      success: true,
      data: {
        type: 'automation_list',
        count: list.length,
        automations: list.map(a => ({
          id: a.id, name: a.name, enabled: a.enabled,
          intervalMinutes: a.intervalMinutes, fixedTime: a.fixedTime,
          lastRunAt: a.lastRunAt, createdAt: a.createdAt
        }))
      }
    };
  }
}

module.exports = AutomationListTool;
