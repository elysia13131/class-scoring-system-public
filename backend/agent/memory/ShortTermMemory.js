const crypto = require('crypto');

class ShortTermMemory {
  constructor(options = {}) {
    this.maxMessages = options.maxMessages || 20;
    this.sessions = new Map();
    this.ttl = options.ttl || 30 * 60 * 1000;
  }

  createSession(memberId) {
    const sessionId = crypto.randomUUID();
    const session = {
      memberId,
      sessionId,
      messages: [],
      context: {
        currentTask: null,
        lastQuery: null,
        pendingActions: []
      },
      metadata: {
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        messageCount: 0
      }
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    if (this._isExpired(session)) {
      this.sessions.delete(sessionId);
      return null;
    }

    return session;
  }

  getSessionByMember(memberId) {
    for (const [, session] of this.sessions) {
      if (session.memberId === memberId && !this._isExpired(session)) {
        return session;
      }
    }
    return null;
  }

  addMessage(sessionId, role, content, extra = {}) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    const message = {
      role,
      content,
      timestamp: new Date().toISOString(),
      ...extra
    };

    session.messages.push(message);

    while (session.messages.length > this.maxMessages) {
      session.messages.shift();
    }

    session.metadata.lastActivityAt = new Date().toISOString();
    session.metadata.messageCount = session.messages.length;

    return message;
  }

  updateContext(sessionId, contextUpdate) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');

    session.context = { ...session.context, ...contextUpdate };
    return session.context;
  }

  getRecentMessages(sessionId, count = 10) {
    const session = this.getSession(sessionId);
    if (!session) return [];
    return session.messages.slice(-count);
  }

  getContext(sessionId) {
    const session = this.getSession(sessionId);
    if (!session) return null;
    return session.context;
  }

  clearSession(sessionId) {
    this.sessions.delete(sessionId);
  }

  clearAll() {
    this.sessions.clear();
  }

  cleanup() {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      const lastActivity = new Date(session.metadata.lastActivityAt).getTime();
      if (now - lastActivity > this.ttl) {
        this.sessions.delete(sessionId);
      }
    }
  }

  getStats() {
    let totalMessages = 0;
    for (const [, session] of this.sessions) {
      totalMessages += session.messages.length;
    }
    return {
      activeSessions: this.sessions.size,
      totalMessages,
      maxMessagesPerSession: this.maxMessages
    };
  }

  _isExpired(session) {
    const lastActivity = new Date(session.metadata.lastActivityAt).getTime();
    return Date.now() - lastActivity > this.ttl;
  }

  serialize() {
    const data = {};
    for (const [sessionId, session] of this.sessions) {
      data[sessionId] = session;
    }
    return data;
  }

  deserialize(data) {
    this.sessions.clear();
    if (data) {
      for (const [sessionId, session] of Object.entries(data)) {
        if (!this._isExpired(session)) {
          this.sessions.set(sessionId, session);
        }
      }
    }
  }
}

module.exports = ShortTermMemory;