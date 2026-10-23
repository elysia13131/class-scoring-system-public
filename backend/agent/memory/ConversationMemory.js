const fs = require('fs').promises;
const path = require('path');
const { getDataPath } = require('../../utils/dataPath');
const DATA_DIR = getDataPath('conversation_memory');

async function ensureDir() {
  try { await fs.mkdir(DATA_DIR, { recursive: true }); } catch (e) {}
}

function getFilePath(memberId) {
  return path.join(DATA_DIR, `${memberId}.json`);
}

function generateId() {
  return 'f_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

const MAX_ROUNDS = 100;
const COMPRESS_COUNT = 50;
const FACTS_THRESHOLD = 50;

const DEFAULT_STORE = {
  memberId: '',
  messages: [],
  compressedSummary: null,
  facts: [],
  reflections: [],
  personaPrompt: null,
  stats: {
    userMessageCount: 0,
    _lastExtractedUserCount: 0,
    lastCompressedAt: null,
    lastFactsExtractedAt: null,
    lastUpdated: null
  }
};

class ConversationMemory {
  constructor() {
    this._cache = new Map();
    this._dirty = new Set();
    this._initPromise = ensureDir();
  }

  async _read(memberId) {
    const fp = getFilePath(memberId);
    try {
      await fs.access(fp);
      const raw = await fs.readFile(fp, 'utf-8');
      const data = JSON.parse(raw);
      return { ...DEFAULT_STORE, ...data, memberId };
    } catch (e) {
      return { ...DEFAULT_STORE, memberId };
    }
  }

  async _write(memberId, store) {
    store.memberId = memberId;
    store.stats.lastUpdated = new Date().toISOString();
    const fp = getFilePath(memberId);
    await fs.writeFile(fp, JSON.stringify(store, null, 2));
  }

  _getCached(memberId) {
    if (this._cache.has(memberId)) return this._cache.get(memberId);
    return null;
  }

  async _load(memberId) {
    let store = this._cache.get(memberId);
    if (!store) {
      store = await this._read(memberId);
      this._cache.set(memberId, store);
    }
    return store;
  }

  addMessage(memberId, role, content, toolName) {
    if (!memberId) return null;
    let store = this._getCached(memberId);
    if (store) {
      store.messages.push({ role, content, toolName: toolName || null, timestamp: new Date().toISOString() });
      if (role === 'user') store.stats.userMessageCount++;
      this._dirty.add(memberId);
      return store;
    }
    const syncFs = require('fs');
    const fp = getFilePath(memberId);
    let s;
    try {
      if (syncFs.existsSync(fp)) {
        s = JSON.parse(syncFs.readFileSync(fp, 'utf-8'));
        s = { ...DEFAULT_STORE, ...s, memberId };
      } else {
        s = { ...DEFAULT_STORE, memberId };
      }
    } catch (e) {
      s = { ...DEFAULT_STORE, memberId };
    }
    s.messages.push({ role, content, toolName: toolName || null, timestamp: new Date().toISOString() });
    if (role === 'user') s.stats.userMessageCount++;
    this._cache.set(memberId, s);
    this._dirty.add(memberId);
    return s;
  }

  async flush(memberId) {
    if (!memberId) return;
    if (this._dirty.has(memberId)) {
      const store = this._cache.get(memberId);
      if (store) {
        await this._write(memberId, store);
      }
      this._dirty.delete(memberId);
    }
  }

  async setPersona(memberId, personaPrompt) {
    if (!memberId) return;
    const store = await this._load(memberId);
    store.personaPrompt = personaPrompt;
    this._dirty.add(memberId);
    return store;
  }

  async getPersona(memberId) {
    if (!memberId) return null;
    const store = await this._load(memberId);
    return store.personaPrompt || null;
  }

  async getContextPrefix(memberId) {
    if (!memberId) return null;
    const store = await this._load(memberId);
    const parts = [];

    if (store.compressedSummary) {
      parts.push('【历史对话压缩摘要】');
      parts.push(store.compressedSummary);
      parts.push('');
    }

    if (store.facts.length > 0) {
      parts.push('【已提取的事实记忆】');
      store.facts.forEach((f, i) => {
        parts.push(`${i + 1}. ${f.content}`);
      });
      parts.push('');
    }

    if (store.reflections.length > 0) {
      parts.push('【记忆变化记录】');
      store.reflections.forEach((r, i) => {
        parts.push(`${i + 1}. ${r.content}`);
      });
      parts.push('');
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  async shouldCompress(memberId) {
    if (!memberId) return false;
    let store = this._getCached(memberId);
    if (!store) store = await this._read(memberId);
    const uncompressedUserCount = store.messages.filter(m => m.role === 'user').length;
    return uncompressedUserCount >= MAX_ROUNDS && store.messages.length > COMPRESS_COUNT;
  }

  async compress(memberId, llm) {
    if (!memberId || !llm) return;
    let store = this._getCached(memberId);
    if (!store) store = await this._read(memberId);
    if (store.messages.length <= COMPRESS_COUNT) return;

    const oldestMsgs = store.messages.slice(0, COMPRESS_COUNT);
    const remainingMsgs = store.messages.slice(COMPRESS_COUNT);

    const dialogText = oldestMsgs.map(m => {
      const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? '助手' : '系统');
      const tool = m.toolName ? ` [调用: ${m.toolName}]` : '';
      return `${role}${tool}: ${(m.content || '(空)').substring(0, 200)}`;
    }).join('\n');

    try {
      const prompt = `请将以下${COMPRESS_COUNT}轮对话压缩为一段中文摘要（150字以内），保留关键信息：
- 用户提问了什么、关心什么
- 助手做了哪些查询和分析
- 得出的重要结论或数据
- 用户的情绪变化

对话内容：
${dialogText}

只输出摘要文本：`;

      const response = await llm.chat(
        [{ role: 'system', content: '你是一个对话摘要助手，请简洁准确地总结对话。' }, { role: 'user', content: prompt }],
        { stream: false, max_tokens: 400 }
      );

      const summary = (response.content || '').trim();
      if (summary) {
        const prevSummary = store.compressedSummary;
        if (prevSummary) {
          store.compressedSummary = `[早期: ${prevSummary.substring(0, 200)}]\n[近期] ${summary}`;
        } else {
          store.compressedSummary = summary;
        }
      }
    } catch (e) {
      console.error(`[ConversationMemory] 压缩失败 ${memberId}:`, e.message);
    }

    store.messages = remainingMsgs;
    store.stats.lastCompressedAt = new Date().toISOString();
    store.stats.userMessageCount = remainingMsgs.filter(m => m.role === 'user').length;
    store.stats._lastExtractedUserCount = store.stats.userMessageCount;
    this._cache.set(memberId, store);
    this._dirty.add(memberId);
    await this.flush(memberId);
    console.log(`[ConversationMemory] 压缩完成 ${memberId}，保留 ${remainingMsgs.length} 条消息`);
  }

  async shouldExtractFacts(memberId) {
    if (!memberId) return false;
    let store = this._getCached(memberId);
    if (!store) store = await this._read(memberId);
    const lastExtractedCount = store.stats._lastExtractedUserCount || 0;
    const messages = store.messages || [];
    const currentUserCount = messages.filter(m => m.role === 'user').length;
    const newUserMessagesSince = currentUserCount - lastExtractedCount;
    return newUserMessagesSince >= FACTS_THRESHOLD;
  }

  async extractFactsAndReflections(memberId, llm) {
    if (!memberId || !llm) return;
    let store = this._getCached(memberId);
    if (!store) store = await this._read(memberId);
    const messages = store.messages.slice(-FACTS_THRESHOLD * 2);

    // 按用户消息为准截取最后 50 轮
    const rounds = [];
    let userCount = 0;
    for (let i = messages.length - 1; i >= 0 && userCount < FACTS_THRESHOLD; i--) {
      rounds.unshift(messages[i]);
      if (messages[i].role === 'user') userCount++;
    }

    const dialogText = rounds.map(m => {
      const role = m.role === 'user' ? '用户' : (m.role === 'assistant' ? '助手' : '系统');
      const tool = m.toolName ? ` [调用: ${m.toolName}]` : '';
      return `${role}${tool}: ${(m.content || '').substring(0, 300)}`;
    }).join('\n');

    const existingFacts = store.facts.map(f => f.content).join('\n');
    const existingReflections = store.reflections.map(r => r.content).join('\n');

    try {
      const prompt = `请从以下对话中提取两类记忆，以严格 JSON 格式返回：

### 1. 事实记忆（facts）
从对话中提取可验证的事实信息，如：
- 某月某日学员汇报了异常情况
- 某月某日管理员进行了谈话，效果如何
- 学员的某项数据变化
- 提到的重要事件或决策

已有的事实记忆：
${existingFacts || '(无)'}

请检查新旧事实是否涉及同一事件，若是则合并去重（保留更新后的事实）。

每条事实格式：{ "content": "事实描述" }

### 2. 反思记忆（reflections）
捕捉用户意图、想法、计划的变化，如：
- "用户想举办篮球赛" → "用户决定取消篮球赛，改为羽毛球赛"
- "用户担心某学员状态" → "经谈话后学员好转，用户不再担心"
重点体现变化过程，新旧状态都要保留。

已有的反思记忆：
${existingReflections || '(无)'}

请检查新旧反思是否涉及同一主题，若是则融合更新。

每条反思格式：{ "content": "变化前状态 → 变化后状态" }

对话内容：
${dialogText}

请返回严格 JSON：{ "facts": [...], "reflections": [...] }
如果没有值得提取的内容，返回空数组。`;

      const response = await llm.chat(
        [{ role: 'system', content: '你是一个记忆提取助手，擅长从对话中提取关键事实和意图变化。' }, { role: 'user', content: prompt }],
        { stream: false, max_tokens: 1500 }
      );

      const text = (response.content || '').trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const extracted = JSON.parse(jsonMatch[0]);
        if (extracted.facts && extracted.facts.length > 0) {
          for (const f of extracted.facts) {
            if (!f.content) continue;
            const existing = store.facts.find(ef =>
              ef.content.includes(f.content.substring(0, 10)) || f.content.includes(ef.content.substring(0, 10))
            );
            if (existing) {
              existing.content = f.content;
              existing.extractedAt = new Date().toISOString();
              existing.version = (existing.version || 1) + 1;
            } else {
              store.facts.push({
                id: generateId(),
                content: f.content,
                extractedAt: new Date().toISOString(),
                mergedFrom: [],
                version: 1
              });
            }
          }
          if (store.facts.length > 50) {
            store.facts = store.facts.slice(-50);
          }
          console.log(`[ConversationMemory] 事实提取完成 ${memberId}，共 ${store.facts.length} 条`);
        }

        if (extracted.reflections && extracted.reflections.length > 0) {
          for (const r of extracted.reflections) {
            if (!r.content) continue;
            const existing = store.reflections.find(er =>
              er.content.includes(r.content.substring(0, 10)) || r.content.includes(er.content.substring(0, 10))
            );
            if (existing) {
              existing.previousContent = existing.content;
              existing.content = r.content;
              existing.extractedAt = new Date().toISOString();
            } else {
              store.reflections.push({
                id: generateId(),
                content: r.content,
                previousContent: null,
                extractedAt: new Date().toISOString(),
                type: 'change'
              });
            }
          }
          if (store.reflections.length > 30) {
            store.reflections = store.reflections.slice(-30);
          }
          console.log(`[ConversationMemory] 反思提取完成 ${memberId}，共 ${store.reflections.length} 条`);
        }
      }
    } catch (e) {
      console.error(`[ConversationMemory] 事实/反思提取失败 ${memberId}:`, e.message);
    }

    store.stats.lastFactsExtractedAt = new Date().toISOString();
    store.stats._lastExtractedUserCount = store.messages.filter(m => m.role === 'user').length;
    this._cache.set(memberId, store);
    this._dirty.add(memberId);
    await this.flush(memberId);
  }

  async maintenance(memberId, llm) {
    if (!memberId || !llm) return;
    if (await this.shouldCompress(memberId)) {
      await this.compress(memberId, llm);
    }
    if (await this.shouldExtractFacts(memberId)) {
      await this.extractFactsAndReflections(memberId, llm);
    }
  }
}

module.exports = new ConversationMemory();
