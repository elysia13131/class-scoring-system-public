const BaseTool = require('./BaseTool');
const fs = require('fs');
const path = require('path');
const { getDataPath } = require('../../utils/dataPath');

class MemberInfoTool extends BaseTool {
  constructor() {
    super({
      name: 'member_info',
      description: '查询成员个人详细信息，包括MBTI、生日、星座、骨干职务、爱好、经历等。当用户说"查看个人信息"、"我的资料"、"了解某人"、"TA的MBTI"、"星座"、"经历"时调用。普通用户可查看所有成员的基本信息（姓名、班级、职务），但MBTI、生日、星座等隐私信息只能查看自己的',
      parameters: {
        memberId: { type: 'string', description: '成员ID（不填默认当前用户）', required: false },
        includeExperiences: { type: 'boolean', description: '是否包含经历信息，默认true', required: false }
      },
      requireAuth: false,
      category: 'members'
    });

    this.zodiacMap = [
      { name: '摩羯座', start: [1, 1], end: [1, 19] },
      { name: '水瓶座', start: [1, 20], end: [2, 18] },
      { name: '双鱼座', start: [2, 19], end: [3, 20] },
      { name: '白羊座', start: [3, 21], end: [4, 19] },
      { name: '金牛座', start: [4, 20], end: [5, 20] },
      { name: '双子座', start: [5, 21], end: [6, 21] },
      { name: '巨蟹座', start: [6, 22], end: [7, 22] },
      { name: '狮子座', start: [7, 23], end: [8, 22] },
      { name: '处女座', start: [8, 23], end: [9, 22] },
      { name: '天秤座', start: [9, 23], end: [10, 23] },
      { name: '天蝎座', start: [10, 24], end: [11, 22] },
      { name: '射手座', start: [11, 23], end: [12, 21] },
      { name: '摩羯座', start: [12, 22], end: [12, 31] }
    ];

    this.mbtiDescriptions = {
      ISTJ: '检查者 - 安静严肃，通过全面性和可靠性来获得成功',
      ISFJ: '保护者 - 安静友好，有责任心和尽责心',
      INFJ: '提倡者 - 寻求思想、关系和物质事物的意义和联系',
      INTJ: '建筑师 - 在实现自己的想法和达成目标方面有强烈的驱动力',
      ISTP: '鉴赏家 - 灵活忍耐，对新的经验有开放的态度',
      ISFP: '探险家 - 安静友好，敏感和善良',
      INFP: '调停者 - 理想主义，忠诚于自己的价值观',
      INTP: '逻辑学家 - 对任何感兴趣的事物都寻求发展出合理的解释',
      ESTP: '企业家 - 灵活忍耐，务实地解决问题',
      ESFP: '表演者 - 外向友好，接受力强，热爱生活',
      ENFP: '竞选者 - 热情有创造力，社交能力强',
      ENTP: '辩论家 - 聪明有创造力，对挑战充满激情',
      ESTJ: '总经理 - 务实现实，事实导向',
      ESFJ: '执政官 - 热心肠有责任心，合作性强',
      ENFJ: '主人公 - 热情为他人着想，积极回应',
      ENTJ: '指挥官 - 坦率果断，有天生的领导力'
    };
  }

  async execute(params, context) {
    let targetId = params.memberId || context.memberId;
    const isSelf = !context.memberId || String(targetId) === String(context.memberId);
    const canViewSensitive = context.isAdmin || isSelf;

    const member = this._findMember(targetId);
    if (!member) {
      return {
        type: 'member_info',
        found: false,
        message: `未找到ID为${targetId}的成员`
      };
    }

    const includeExperiences = params.includeExperiences !== false;
    const info = this._buildMemberInfo(member, canViewSensitive, includeExperiences);

    return {
      type: 'member_info',
      found: true,
      permission: canViewSensitive ? 'full' : 'basic',
      ...info
    };
  }

  _findMember(memberId) {
    try {
      const filePath = getDataPath('members.json');
      if (!fs.existsSync(filePath)) return null;
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list = Array.isArray(data) ? data : (data.members || []);
      return list.find(m => String(m.id || m.memberId || '') === String(memberId)) || null;
    } catch (e) {
      return null;
    }
  }

  _isSameClass(memberId1, memberId2) {
    try {
      const filePath = getDataPath('members.json');
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list = Array.isArray(data) ? data : (data.members || []);
      const m1 = list.find(m => String(m.id) === String(memberId1));
      const m2 = list.find(m => String(m.id) === String(memberId2));
      return m1 && m2 && m1.class && m2.class && m1.class === m2.class;
    } catch (e) {
      return false;
    }
  }

  _buildMemberInfo(member, canViewFull, includeExperiences) {
    const info = {
      id: member.id,
      name: member.name,
      class: member.class || '',
      isBackbone: member.isBackbone || false,
      position: member.position || ''
    };

    if (canViewFull) {
      info.mbti = member.mbti || '';
      info.mbtiDesc = this.mbtiDescriptions[member.mbti] || '';
      info.zodiac = this._getZodiac(member.birthday);
      info.birthday = member.birthday || '';
      info.age = this._calculateAge(member.birthday);
      info.hobbies = member.hobbies || '';
      info.hometown = member.hometown || '';
    }

    if (includeExperiences) {
      info.experiences = this._loadExperiences(member.id, canViewFull);
    }

    info.summary = this._generateSummary(info, canViewFull);

    return info;
  }

  _maskName(name) {
    if (!name || name.length <= 1) return name;
    if (name.length === 2) return name[0] + '*';
    return name[0] + '*'.repeat(name.length - 2) + name[name.length - 1];
  }

  _getZodiac(birthday) {
    if (!birthday) return '未知';
    const date = new Date(birthday);
    if (isNaN(date.getTime())) return '未知';
    const month = date.getMonth() + 1;
    const day = date.getDate();

    for (const z of this.zodiacMap) {
      const [sm, sd] = z.start;
      const [em, ed] = z.end;
      if ((month === sm && day >= sd) || (month === em && day <= ed)) {
        return z.name;
      }
    }
    return '未知';
  }

  _calculateAge(birthday) {
    if (!birthday) return null;
    const birth = new Date(birthday);
    const now = new Date();
    if (isNaN(birth.getTime())) return null;
    let age = now.getFullYear() - birth.getFullYear();
    const monthDiff = now.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
      age--;
    }
    return age;
  }

  _loadExperiences(memberId, canViewFull) {
    try {
      const filePath = getDataPath('experiences.json');
      if (!fs.existsSync(filePath)) return [];
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const list = Array.isArray(data) ? data : [];
      const memberExps = list.filter(e => String(e.memberId) === String(memberId));

      return memberExps.map(exp => {
        const typeLabels = {
          competition: '竞赛获奖',
          activity: '活动参与',
          research: '科研经历'
        };
        return {
          type: typeLabels[exp.type] || exp.type,
          data: exp.data,
          date: canViewFull ? (exp.createdAt || '') : ''
        };
      });
    } catch (e) {
      return [];
    }
  }

  _generateSummary(info, canViewFull) {
    const parts = [];

    if (canViewFull) {
      parts.push(`${info.name}（${info.class}）`);
    } else {
      parts.push(`${info.name}（${info.class}）`);
    }

    if (info.mbti) {
      parts.push(`MBTI: ${info.mbti}${info.mbtiDesc ? `（${info.mbtiDesc}）` : ''}`);
    }

    if (info.zodiac && info.zodiac !== '未知') {
      parts.push(`星座: ${info.zodiac}`);
    }

    if (info.isBackbone && info.position) {
      parts.push(`骨干职务: ${info.position}`);
    }

    if (canViewFull && info.hobbies) {
      parts.push(`爱好: ${info.hobbies}`);
    }

    if (canViewFull && info.hometown) {
      parts.push(`籍贯: ${info.hometown}`);
    }

    if (canViewFull && info.age) {
      parts.push(`年龄: ${info.age}岁`);
    }

    if (info.experiences && info.experiences.length > 0) {
      parts.push(`经历: ${info.experiences.length}条记录`);
      info.experiences.forEach(exp => {
        if (exp.type === '竞赛获奖' && exp.data?.name) {
          parts.push(`  - ${exp.data.name}${exp.data.award ? `（${exp.data.award}）` : ''}`);
        } else if (exp.type === '科研经历' && exp.data?.name) {
          parts.push(`  - ${exp.data.name}`);
        } else if (exp.type === '活动参与' && exp.data?.name) {
          parts.push(`  - ${exp.data.name}${exp.data.award ? `（${exp.data.award}）` : ''}`);
        }
      });
    }

    return parts.join('\n');
  }
}

module.exports = MemberInfoTool;
