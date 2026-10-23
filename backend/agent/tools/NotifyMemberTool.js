const BaseTool = require('./BaseTool');
const pushManager = require('../pushManager');

class NotifyMemberTool extends BaseTool {
  constructor() {
    super({
      name: 'notify_member',
      description: '向一个或多个成员发送通知消息。三种用法：(1) 单个 memberId="612" (2) 多个 memberIds=["612","613"] (3) className="一班" 发送给全班。已安装APP的用户收到推送通知，未安装的用户收到系统消息。仅管理员可用。',
      parameters: {
        memberIds: { type: 'array', description: '成员ID列表，如 ["612","613"]', required: false, items: { type: 'string' } },
        memberId: { type: 'string', description: '单个成员ID，如 "612"', required: false },
        className: { type: 'string', description: '班级名称，如 "一班" 或 "Class 1"，发送给全班成员', required: false },
        message: { type: 'string', description: '要发送的通知内容，自然语言的完整消息', required: true }
      },
      requireAuth: true,
      category: 'communication'
    });
  }

  async execute(params, context) {
    if (!context.isAdmin) {
      return { success: false, error: '仅管理员可调用此工具', adminRequired: true };
    }

    const { memberId, memberIds, className, message } = params;

    if (!message) {
      return { success: false, error: '缺少必要参数 message' };
    }

    if (!memberId && !memberIds && !className) {
      return { success: false, error: '请指定目标：memberId（单个）、memberIds（列表）或 className（班级）' };
    }

    const allMembers = await this._getMembersFromAPI();

    let targets = [];

    if (memberIds && Array.isArray(memberIds)) {
      targets = memberIds.map(id => {
        const m = allMembers.find(mm => mm.id === String(id));
        return { memberId: String(id), name: m ? m.name : id };
      });
    } else if (memberId) {
      const m = allMembers.find(mm => mm.id === String(memberId));
      targets = [{ memberId: String(memberId), name: m ? m.name : memberId }];
    } else if (className) {
      const classMembers = allMembers.filter(m => m.class && (m.class.includes(className) || className.includes(m.class)));
      if (classMembers.length === 0) {
        return { success: false, error: `未找到班级"${className}"的成员` };
      }
      targets = classMembers.map(m => ({ memberId: m.id, name: m.name || m.id }));
    }

    const pushSent = [];
    const pushFailed = [];
    const fallbackSent = [];
    const title = '管理员通知';
    const body = message;

    for (const target of targets) {
      if (pushManager.hasAnyPushSubscription(target.memberId)) {
        const result = await pushManager.sendPushToMember(target.memberId, title, body);
        if (result.success) {
          pushSent.push(target.name);
        } else {
          pushFailed.push({ name: target.name, reason: result.error || '发送失败' });
        }
      } else {
        // 无推送订阅：直接写入 inbox 作为系统消息兜底
        try {
          pushManager.saveNotificationToInbox(target.memberId, title, body);
          fallbackSent.push(target.name);
        } catch (err) {
          pushFailed.push({ name: target.name, reason: '系统消息发送失败: ' + err.message });
        }
      }
    }

    const parts = [];
    if (pushSent.length > 0) {
      parts.push(`✅ 已推送至 ${pushSent.length} 人的移动端：${pushSent.join('、')}`);
    }
    if (fallbackSent.length > 0) {
      parts.push(`📬 已发送系统消息至 ${fallbackSent.length} 人：${fallbackSent.join('、')}`);
    }
    if (pushFailed.length > 0) {
      parts.push(`❌ 失败 ${pushFailed.length} 人：${pushFailed.map(f => `${f.name}（${f.reason}）`).join('、')}`);
    }

    return {
      success: pushSent.length + fallbackSent.length > 0,
      total: targets.length,
      pushSentCount: pushSent.length,
      fallbackSentCount: fallbackSent.length,
      failedCount: pushFailed.length,
      pushSent,
      fallbackSent,
      pushFailed,
      message: parts.join('\n') || '未能发送任何通知'
    };
  }
}

module.exports = NotifyMemberTool;
