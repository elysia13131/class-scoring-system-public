const BaseTool = require('./BaseTool');
const scheduleStore = require('../../data/scheduleStore');

class ScheduleDeleteTool extends BaseTool {
  constructor() {
    super({
      name: 'schedule_delete',
      description: '删除日程。只能删除自己创建的日程。根据日程ID删除。',
      parameters: {
        scheduleId: { type: 'string', description: '要删除的日程ID', required: true }
      },
      category: 'schedule'
    });
  }

  async execute(params, context) {
    const ok = scheduleStore.deleteSchedule(params.scheduleId, context.memberId);
    if (!ok) return { success: false, error: '日程不存在或无权删除' };
    return {
      success: true,
      data: { type: 'schedule_deleted', scheduleId: params.scheduleId, message: '日程已删除' }
    };
  }
}

module.exports = ScheduleDeleteTool;
