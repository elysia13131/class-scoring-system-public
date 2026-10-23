const ShortTermMemory = require('./ShortTermMemory');
const LongTermMemory = require('./LongTermMemory');
const UserProfile = require('./UserProfile');

class MemoryManager {
  constructor(options = {}) {
    this.shortTerm = new ShortTermMemory(options.shortTerm || {});
    this.longTerm = new LongTermMemory(options.longTerm || {});
    this.userProfile = new UserProfile(options.userProfile || {});
    
    this.autoSummarizeThreshold = options.autoSummarizeThreshold || 8;
    this.sensitivePatterns = [
      /密码/i, /password/i, /身份证/i, /id_card/i, /银行卡/i, /bank/i
    ];
  }

  async init() {
    await this.longTerm.init();
    await this.userProfile.init();
    
    if (typeof setInterval !== 'undefined') {
      setInterval(() => {
        this.shortTerm.cleanup();
      }, 5 * 60 * 1000);
    }
  }

  async startSession(memberId) {
    const session = this.shortTerm.createSession(memberId);
    await this.longTerm.recordInteraction(memberId);
    
    const profile = await this.userProfile.getOrCreate(memberId);
    
    return {
      session,
      longTermMemory: await this.longTerm.get(memberId),
      profile
    };
  }

  async addUserMessage(sessionId, memberId, message) {
    const msg = this.shortTerm.addMessage(sessionId, 'user', message);
    this.shortTerm.updateContext(sessionId, { lastQuery: { type: 'chat', content: message } });
    
    await this.longTerm.recordInteraction(memberId);
    // 老画像系统仅维护 totalInteractions 和 matchScore，不再自动提取风格
    await this.userProfile.adaptFromInteraction(memberId, {});
    
    return msg;
  }

  async addAssistantMessage(sessionId, content, extra = {}) {
    return this.shortTerm.addMessage(sessionId, 'assistant', content, extra);
  }

  async buildMemoryContext(memberId, sessionId) {
    const shortTerm = this.shortTerm.getSession(sessionId);
    const longTerm = await this.longTerm.get(memberId);
    const profile = await this.userProfile.get(memberId);

    return {
      shortTerm: shortTerm ? {
        messageCount: shortTerm.messages.length,
        currentTopic: shortTerm.context?.currentTask,
        lastInteraction: shortTerm.metadata?.lastActivityAt
      } : null,
      longTerm: longTerm ? {
        totalFacts: longTerm.importantFacts?.length || 0,
        summaries: (longTerm.summaries || []).slice(-3),
        learningProgress: longTerm.learningProgress
      } : null,
      preferences: profile ? {
        communicationStyle: profile.communicationStyle,
        preferences: {
          favoriteFeatures: profile.preferences?.favoriteFeatures || [],
          responseLength: profile.communicationStyle?.responseLength || 'medium'
        },
        matchScore: profile.metadata?.matchScore || 0,
        totalInteractions: profile.usageStats?.totalInteractions || 0
      } : null
    };
  }

  async endSession(sessionId, memberId) {
    const session = this.shortTerm.getSession(sessionId);
    if (!session) return;

    if (session.messages.length >= this.autoSummarizeThreshold) {
      await this._summarizeAndStore(session, memberId);
    }

    this.shortTerm.clearSession(sessionId);
  }

  async extractAndStoreFact(memberId, fact, confidence = 0.7, category = 'general') {
    if (this._containsSensitiveInfo(fact)) {
      console.warn('Blocked sensitive information in fact:', fact.slice(0, 50));
      return null;
    }

    return await this.longTerm.addFact(memberId, {
      fact,
      confidence: Math.min(1, confidence),
      category
    });
  }

  async getUserPreferences(memberId) {
    return await this.userProfile.getOrCreate(memberId);
  }

  async updateUserPreferences(memberId, updates) {
    if (updates.communicationStyle) {
      return await this.userProfile.updateStyle(memberId, updates.communicationStyle);
    }
    if (updates.preferences) {
      return await this.userProfile.updatePreferences(memberId, updates.preferences);
    }
    return await this.getUserPreferences(memberId);
  }

  async getFullMemoryState(memberId) {
    const longTerm = await this.longTerm.get(memberId);
    const profile = await this.userProfile.get(memberId);
    const stats = this.shortTerm.getStats();

    return {
      shortTerm: {
        ...stats,
        sessions: Array.from(this.shortTerm.sessions.entries())
          .filter(([_, s]) => s.memberId === memberId)
          .map(([id, s]) => ({
            sessionId: id,
            messageCount: s.messages.length,
            currentTopic: s.context?.currentTask
          }))
      },
      longTerm: longTerm || null,
      preferences: profile || null
    };
  }

  async clearAllMemberData(memberId) {
    await this.longTerm.delete(memberId);
    await this.userProfile.delete(memberId);
    
    for (const [sessionId, session] of this.shortTerm.sessions) {
      if (session.memberId === memberId) {
        this.shortTerm.clearSession(sessionId);
      }
    }
  }

  async _summarizeAndStore(session, memberId) {
    const messages = session.messages;
    const userMessages = messages.filter(m => m.role === 'user').map(m => m.content);

    const topics = this._extractTopics(userMessages);
    const summary = this._generateSimpleSummary(userMessages);

    await this.longTerm.addSummary(memberId, {
      summary,
      keywords: topics,
      importanceScore: Math.min(1, messages.length / 20)
    });
  }

  _extractTopics(messages) {
    const topicKeywords = {
      '成绩': /成绩|评分|分数|排名/,
      '体能': /体能|跑步|训练|BMI|体脂/,
      '学习': /学习|考试|复习|预习|课程/,
      '心理': /心理|情绪|心情|压力|焦虑/,
      '文件': /导出|下载|Excel|Word|PDF/
    };

    const allText = messages.join(' ');
    const foundTopics = [];

    for (const [topic, pattern] of Object.entries(topicKeywords)) {
      if (pattern.test(allText)) {
        foundTopics.push(topic);
      }
    }

    return foundTopics;
  }

  _generateSimpleSummary(userMsgs) {
    const topics = this._extractTopics(userMsgs);
    const topicStr = topics.length > 0 ? topics.join('、') : '通用咨询';
    return `用户关注${topicStr}相关内容，进行了${userMsgs.length}轮对话`;
  }

  _containsSensitiveInfo(text) {
    for (const pattern of this.sensitivePatterns) {
      if (pattern.test(text)) return true;
    }
    return false;
  }
}

module.exports = MemoryManager;