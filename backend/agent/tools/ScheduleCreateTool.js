const BaseTool = require('./BaseTool');
const scheduleStore = require('../../data/scheduleStore');
const { beijingNow } = require('../../utils/beijingTime');

class ScheduleCreateTool extends BaseTool {
  constructor() {
    super({
      name: 'schedule_create',
      description: '创建日程提醒。可以在指定日期时间提醒用户做某事。管理员可为学员创建日程（传入targetMemberIds），普通成员只能给自己创建。可多选成员批量创建或全选（isGlobal=true创建给所有人）。',
      parameters: {
        title: { type: 'string', description: '日程标题', required: true },
        description: { type: 'string', description: '日程详细描述', required: false },
        dueAt: { type: 'string', description: 'ISO格式日期时间，如2026-07-01T14:30:00', required: true },
        targetMemberIds: { type: 'array', description: '目标成员ID列表，管理员可为多人创建；非管理员时自动设为当前用户', required: false, items: { type: 'string' } },
        isGlobal: { type: 'boolean', description: '是否发给所有人（管理员专用），优先级高于targetMemberIds', required: false }
      },
      category: 'schedule'
    });
  }

  async execute(params, context) {
    const { title, description, dueAt, targetMemberIds, isGlobal } = params;
    const createdBy = context.memberId;
    const isAdmin = context.isAdmin;

    if (!dueAt || isNaN(Date.parse(dueAt))) {
      return { success: false, error: 'dueAt格式不正确，应为ISO格式如2026-07-01T14:30:00' };
    }

    let targets;
    if (isAdmin && isGlobal) {
      targets = ['__all__'];
    } else if (isAdmin && targetMemberIds && targetMemberIds.length > 0) {
      targets = targetMemberIds;
    } else {
      targets = [createdBy];
    }

    // 将用户输入的北京时间转换为 UTC 存储（dueAt 不含时区时默认视为北京时间）
    const dueAtISO = dueAt.includes('Z') || dueAt.includes('+') || dueAt.includes('-', 10)
      ? new Date(dueAt).toISOString()
      : new Date(dueAt + '+08:00').toISOString();

    const schedule = scheduleStore.createSchedule({
      title: title || '提醒',
      description: description || '',
      dueAt: dueAtISO,
      createdBy,
      targetMemberIds: targets,
      isGlobal: isGlobal || false
    });

    const globalNote = isGlobal ? '（已创建全局日程，将通知所有成员）' : '';

    return {
      success: true,
      data: {
        type: 'schedule_created',
        schedule: { id: schedule.id, title: schedule.title, dueAt: schedule.dueAt, targets },
        message: `日程"${schedule.title}"已创建，将于${schedule.dueAt}提醒${targets.includes('__all__') ? '所有人' : targets.length + '人'}。${globalNote}`
      }
    };
  }
}

module.exports = ScheduleCreateTool;
