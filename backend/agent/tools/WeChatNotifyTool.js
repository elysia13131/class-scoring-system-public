const BaseTool = require('./BaseTool');

class WeChatNotifyTool extends BaseTool {
  constructor() {
    super({
      name: 'wechat_notify',
      description: '向管理员或指定成员发送微信消息通知。用于异常情况告警（情绪持续低迷、伤病情、人际冲突等）。如果学员主动要求告知管理员，也可使用此工具。',
      parameters: {
        targetId: { type: 'string', description: '目标成员的ID或admin', required: true },
        message: { type: 'string', description: '要发送的通知内容（纯文本）', required: true },
        anonymous: { type: 'boolean', description: '是否匿名发送（不暴露学员姓名）', required: false }
      },
      requireAuth: false,
      category: 'communication'
    });
  }

  async execute(params, context) {
    const { targetId, message, anonymous } = params;

    if (!targetId) {
      return { success: false, error: '缺少必要参数 targetId' };
    }

    if (!message) {
      return { success: false, error: '缺少必要参数 message' };
    }

    const memberId = context.memberId;
    let senderName = null;

    if (!anonymous && memberId) {
      try {
        const allMembers = await this._getMembersFromAPI();
        const sender = allMembers.find(m => m.id === String(memberId));
        senderName = sender ? sender.name : null;
      } catch (e) {
        try {
          const allMembers = this._getMembersFromFile();
          const sender = allMembers.find(m => m.id === String(memberId));
          senderName = sender ? sender.name : null;
        } catch (e2) {
          senderName = null;
        }
      }
    }

    const prefix = anonymous
      ? '[匿名通知]'
      : (senderName ? `[来自${senderName}的通知]` : '[系统通知]');
    const fullMessage = `${prefix} ${message}`;

    let actualTargetId = targetId;

    if (targetId === 'admin') {
      const adminMemberId = process.env.NOTIFY_ADMIN_MEMBER_ID;
      if (!adminMemberId) {
        return { success: false, error: '未配置管理员微信通知ID（NOTIFY_ADMIN_MEMBER_ID）' };
      }
      actualTargetId = adminMemberId;
    }

    try {
      const axios = require('axios');
      const port = process.env.PORT || 3001;
      const internalKey = process.env.INTERNAL_API_KEY || process.env.__INTERNAL_API_KEY || '';

      await axios.post(
        `http://127.0.0.1:${port}/api/wechat/send`,
        { memberId: actualTargetId, text: fullMessage },
        {
          headers: {
            'x-internal-key': internalKey,
            'Authorization': 'Bearer ' + internalKey
          },
          timeout: 10000
        }
      );

      return {
        success: true,
        data: {
          sent: true,
          channel: 'wechat',
          targetId: actualTargetId,
          anonymous: anonymous || false
        }
      };
    } catch (err) {
      console.error(`[WeChatNotifyTool] 微信发送失败:`, err.message);
      return {
        success: false,
        error: `微信消息发送失败: ${err.message}`,
        data: {
          sent: false,
          channel: 'wechat',
          targetId: actualTargetId,
          anonymous: anonymous || false
        }
      };
    }
  }
}

module.exports = WeChatNotifyTool;
