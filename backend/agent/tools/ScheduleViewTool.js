const BaseTool = require('./BaseTool');
const scheduleStore = require('../../data/scheduleStore');

class ScheduleViewTool extends BaseTool {
  constructor() {
    super({
      name: 'schedule_view',
      description: '查看日程。可指定日期查看当天的日程，不指定则查看所有将来到期日程。管理员可查看任意成员的日程（传memberId），普通成员只能查看自己的。',
      parameters: {
        date: { type: 'string', description: '可选，日期 YYYY-MM-DD 格式，不传则看所有未到期日程', required: false },
        memberId: { type: 'string', description: '管理员可指定查看某成员的日程', required: false }
      },
      category: 'schedule'
    });
  }

  async execute(params, context) {
    const targetMemberId = context.isAdmin ? (params.memberId || context.memberId) : context.memberId;
    let schedules;

    if (params.date) {
      schedules = scheduleStore.getSchedulesByDate(params.date, targetMemberId);
    } else {
      schedules = scheduleStore.getUpcomingSchedules(targetMemberId, 20);
    }

    return {
      success: true,
      data: {
        type: 'schedule_list',
        date: params.date || 'all',
        count: schedules.length,
        schedules: schedules.map(s => ({
          id: s.id,
          title: s.title,
          description: s.description,
          dueAt: s.dueAt,
          createdBy: s.createdBy,
          notified: s.notified
        }))
      }
    };
  }
}

module.exports = ScheduleViewTool;
