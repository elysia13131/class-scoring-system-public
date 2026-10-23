const BaseTool = require('./BaseTool');
const automationStore = require('../../data/automationStore');

class AutomationCreateTool extends BaseTool {
  constructor() {
    super({
      name: 'automation_create',
      description: '创建自动化任务。设置间隔时间或固定时间，到点自动将prompt发送给LLM执行（就像用户发消息一样），结果会自动注入上下文并通过微信发送。管理员可用此功能设置定时报告、自动提醒等。',
      parameters: {
        name: { type: 'string', description: '任务名称', required: true },
        prompt: { type: 'string', description: '到点发送给LLM的提示词，描述要执行的任务。如"生成今日学员出勤报告"', required: true },
        intervalMinutes: { type: 'number', description: '每隔多少分钟执行一次（与fixedTime二选一）', required: false },
        fixedTime: { type: 'string', description: '每天固定时间执行，格式HH:MM（与intervalMinutes二选一）', required: false }
      },
      category: 'automation'
    });
  }

  async execute(params, context) {
    try {
      const auto = automationStore.createAutomation({
        name: params.name,
        prompt: params.prompt,
        intervalMinutes: params.intervalMinutes || null,
        fixedTime: params.fixedTime || null,
        createdBy: context.memberId
      });

      const scheduleDesc = params.intervalMinutes
        ? `每${params.intervalMinutes}分钟执行一次`
        : `每天${params.fixedTime}执行`;

      return {
        success: true,
        data: {
          type: 'automation_created',
          automation: { id: auto.id, name: auto.name, enabled: auto.enabled },
          message: `自动化任务"${auto.name}"已创建，${scheduleDesc}。`
        }
      };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
}

module.exports = AutomationCreateTool;
