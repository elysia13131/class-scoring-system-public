# AI Agent 智能助手 - 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一个全能综合型AI Agent智能助手，集成到现有班级评分系统中，具备三级记忆、个性化适应、图表渲染和权限隔离能力。

**Architecture:** 分层Agent架构 - 前端(React) → 后端(Express) → Agent Core → Memory System + Tool Kit → DeepSeek API

**Tech Stack:** Node.js, Express, React 18, Vite, TailwindCSS, ECharts 5.x, Socket.io, DeepSeek API, JSON文件存储(gzip压缩)

**Design Spec:** [2026-05-06-ai-agent-design.md](./specs/2026-05-06-ai-agent-design.md)

---

## Phase 1: 基础架构搭建

### Task 1: 创建Agent模块目录结构

**Files:**
- Create: `backend/agent/index.js`
- Create: `backend/agent/package.json`
- Create: `backend/agent/.gitkeep` (for subdirectories)

- [ ] **Step 1: 创建目录结构**

```bash
cd backend
mkdir -p agent/{core,memory,tools,llm,auth}
mkdir -p agent/tools
touch agent/core/.gitkeep agent/memory/.gitkeep agent/tools/.gitkeep agent/llm/.gitkeep agent/auth/.gitkeep
```

- [ ] **Step 2: 创建 package.json**

```json
{
  "name": "class-score-agent",
  "version": "1.0.0",
  "description": "AI Agent智能助手模块",
  "main": "index.js",
  "dependencies": {
    "openai": "^4.20.0",
    "uuid": "^9.0.0"
  }
}
```

- [ ] **Step 3: 安装依赖**

Run: `cd backend && npm install openai uuid`

Expected: Dependencies installed successfully

- [ ] **Step 4: 验证目录结构**

Run: `ls -la backend/agent/`

Expected: Show all subdirectories created

- [ ] **Step 5: Commit**

```bash
git add backend/agent/
git commit -m "feat(agent): create module directory structure"
```

---

### Task 2: 实现 DeepSeek API 客户端

**Files:**
- Create: `backend/agent/llm/DeepSeekClient.js`

- [ ] **Step 1: 编写 DeepSeekClient 实现**

```javascript
const OpenAI = require('openai');

class DeepSeekClient {
  constructor(config = {}) {
    this.client = new OpenAI({
      apiKey: config.apiKey || process.env.DEEPSEEK_API_KEY,
      baseURL: config.baseUrl || 'https://api.deepseek.com/v1',
      timeout: config.timeout || 30000,
    });
    
    this.defaultModel = config.model || 'deepseek-chat';
    this.defaultTemperature = config.temperature ?? 0.7;
    this.defaultMaxTokens = config.maxTokens || 2000;
  }

  async chat(messages, options = {}) {
    const {
      model = this.defaultModel,
      temperature = this.defaultTemperature,
      maxTokens = this.defaultMaxTokens,
      stream = false,
      tools = [],
    } = options;

    const completionParams = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream,
    };

    if (tools.length > 0) {
      completionParams.tools = tools;
      completionParams.tool_choice = 'auto';
    }

    try {
      if (stream) {
        return await this._streamChat(completionParams);
      }
      
      const response = await this.client.chat.completions.create(completionParams);
      return {
        content: response.choices[0]?.message?.content || '',
        toolCalls: response.choices[0]?.message?.tool_calls || [],
        usage: response.usage,
        model: response.model,
      };
    } catch (error) {
      console.error('DeepSeek API Error:', error.message);
      throw new Error(`AI服务调用失败: ${error.message}`);
    }
  }

  async *_streamChat(params) {
    const stream = await this.client.chat.completions.create({
      ...params,
      stream: true,
    });

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      
      if (delta?.content) {
        yield { type: 'token', content: delta.content };
      }
      
      if (delta?.tool_calls) {
        yield { type: 'tool_call', toolCalls: delta.tool_calls };
      }
    }

    yield { type: 'done' };
  }

  async generateEmbedding(text) {
    try {
      const response = await this.client.embeddings.create({
        model: 'deepseek-embedding',
        input: text,
      });
      return response.data[0].embedding;
    } catch (error) {
      console.error('Embedding generation error:', error.message);
      return null;
    }
  }

  testConnection() {
    return this.chat([{ role: 'user', content: 'Hi' }], { maxTokens: 5 });
  }
}

module.exports = DeepSeekClient;
```

- [ ] **Step 2: 编写单元测试**

Create: `backend/agent/llm/__tests__/DeepSeekClient.test.js`

```javascript
const DeepSeekClient = require('../DeepSeekClient');

describe('DeepSeekClient', () => {
  let client;

  beforeEach(() => {
    client = new DeepSeekClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/v1',
    });
  });

  test('should initialize with default config', () => {
    expect(client.defaultModel).toBe('deepseek-chat');
    expect(client.defaultTemperature).toBe(0.7);
    expect(client.defaultMaxTokens).toBe(2000);
  });

  test('should accept custom config', () => {
    const customClient = new DeepSeekClient({
      model: 'custom-model',
      temperature: 0.5,
      maxTokens: 1000,
    });
    expect(customClient.defaultModel).toBe('custom-model');
    expect(customClient.defaultTemperature).toBe(0.5);
    expect(customClient.defaultMaxTokens).toBe(1000);
  });

  test('should have chat method', () => {
    expect(typeof client.chat).toBe('function');
  });

  test('should have stream support', () => {
    expect(typeof client._streamChat).toBe('function');
  });

  test('should have embedding method', () => {
    expect(typeof client.generateEmbedding).toBe('function');
  });
});
```

- [ ] **Step 3: 运行测试验证基本功能**

Run: `cd backend && npx jest agent/llm/__tests__/DeepSeekClient.test.js --verbose`

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/agent/llm/
git commit -m "feat(agent): implement DeepSeek API client"
```

---

### Task 3: 实现提示词构建器

**Files:**
- Create: `backend/agent/llm/PromptBuilder.js`

- [ ] **Step 1: 编写 PromptBuilder 实现**

```javascript
class PromptBuilder {
  constructor() {
    this.baseSystemPrompt = `你是一个专业的班级评分系统AI助手，名称叫"小智"。

你的能力包括：
1. 成绩查询与分析（评分数据、雷达图、趋势分析）
2. 心理气象站（关系提名、心情标签、社交地图）
3. 文件操作（导入Excel、导出Word/PDF）
4. 系统管理（仅管理员可用）

沟通原则：
- 使用用户偏好的语言风格
- 回复要简洁但有帮助
- 涉及数据时主动提供可视化建议
- 不确定时主动询问澄清`;

    this.toolDescriptionPrompt = `你可以使用以下工具来帮助用户：

{tool_descriptions}

当需要调用工具时，请使用以下JSON格式：
{"tool": "工具名", "params": {"参数名": "参数值"}}`;
  }

  buildSystemPrompt(context = {}) {
    const {
      userProfile = null,
      shortTermMemory = null,
      longTermMemory = null,
      availableTools = [],
      isAdmin = false,
    } = context;

    let prompt = this.baseSystemPrompt;

    if (isAdmin) {
      prompt += '\n\n【管理员模式已启用】你可以访问系统管理功能和查看所有成员数据。';
    }

    if (userProfile) {
      prompt += this._buildUserProfileSection(userProfile);
    }

    if (shortTermMemory && shortTermMemory.messages?.length > 0) {
      prompt += this._buildShortTermContext(shortTermMemory);
    }

    if (longTermMemory) {
      prompt += this._buildLongTermContext(longTermMemory);
    }

    if (availableTools.length > 0) {
      prompt += this._buildToolDescriptions(availableTools);
    }

    return prompt;
  }

  _buildUserProfileSection(profile) {
    const style = profile.communicationStyle || {};
    const prefs = profile.preferences || [];

    let section = '\n\n【用户偏好画像】';
    
    if (style.formality !== undefined) {
      const formalityLevel = style.formality > 0.7 ? '正式' : style.formality > 0.4 ? '适中' : '随意';
      section += `\n- 语言风格: ${formalityLevel}`;
    }

    if (style.responseLength) {
      const lengthMap = { short: '简洁', medium: '中等详细', detailed: '非常详细' };
      section += `\n- 回复长度: ${lengthMap[style.responseLength] || style.responseLength}`;
    }

    if (style.humorLevel !== undefined && style.humorLevel > 0.5) {
      section += '\n- 可以适当使用幽默';
    }

    if (style.technicalDepth !== undefined && style.technicalDepth > 0.7) {
      section += '\n- 用户喜欢专业术语和深度分析';
    }

    if (prefs.favoriteFeatures?.length > 0) {
      section += `\n- 常用功能: ${prefs.favoriteFeatures.join(', ')}`;
    }

    return section;
  }

  _buildShortTermContext(memory) {
    const recentMessages = memory.messages.slice(-6);
    let context = '\n\n【当前会话上下文】最近几轮对话:';
    
    recentMessages.forEach(msg => {
      const role = msg.role === 'user' ? '用户' : '助手';
      context += `\n${role}: ${msg.content.slice(0, 100)}${msg.content.length > 100 ? '...' : ''}`;
    });

    if (memory.context?.currentTask) {
      context += `\n当前任务: ${memory.context.currentTask}`;
    }

    return context;
  }

  _buildLongTermContext(memory) {
    let context = '';

    if (memory.summaries?.length > 0) {
      const recentSummaries = memory.summaries.slice(-3);
      context += '\n\n【历史记忆摘要】';
      recentSummaries.forEach(s => {
        context += `\n- (${s.date}) ${s.summary}`;
      });
    }

    if (memory.importantFacts?.length > 0) {
      const topFacts = memory.importantFacts
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 5);
      context += '\n\n【重要信息】';
      topFacts.forEach(f => {
        context += `\n- ${f.fact} (置信度: ${(f.confidence * 100).toFixed(0)}%)`;
      });
    }

    if (memory.learningProgress) {
      context += '\n\n【学习进度】';
      if (memory.learningProgress.goals?.length > 0) {
        context += `\n目标: ${memory.learningProgress.goals.join(', ')}`;
      }
      if (memory.learningProgress.recentConcerns?.length > 0) {
        context += `\n近期关注: ${memory.learningProgress.recentConcerns.join(', ')}`;
      }
    }

    return context;
  }

  _buildToolDescriptions(tools) {
    const descriptions = tools.map(tool => {
      return `- ${tool.name}: ${tool.description}`;
    }).join('\n');

    return this.toolDescriptionPrompt.replace('{tool_descriptions}', descriptions);
  }

  buildToolCallPrompt(toolName, params, result) {
    return JSON.stringify({
      type: 'tool_result',
      tool: toolName,
      params,
      result: typeof result === 'object' ? JSON.stringify(result).slice(0, 2000) : String(result).slice(0, 1000),
    }, null, 2);
  }

  extractToolCalls(responseContent) {
    const toolCallPattern = /\{[\s\S]*?"tool"\s*:\s*"[^"]+"[\s\S]*?\}/g;
    const matches = responseContent.match(toolCallPattern) || [];
    
    return matches.map(match => {
      try {
        return JSON.parse(match);
      } catch {
        return null;
      }
    }).filter(Boolean);
  }
}

module.exports = new PromptBuilder();
```

- [ ] **Step 2: 编写单元测试**

Create: `backend/agent/llm/__tests__/PromptBuilder.test.js`

```javascript
const PromptBuilder = require('../PromptBuilder');

describe('PromptBuilder', () => {
  test('should create instance', () => {
    expect(PromptBuilder).toBeDefined();
    expect(typeof PromptBuilder.buildSystemPrompt).toBe('function');
  });

  test('should build base system prompt', () => {
    const prompt = PromptBuilder.buildSystemPrompt();
    expect(prompt).toContain('班级评分系统AI助手');
    expect(prompt).toContain('成绩查询与分析');
  });

  test('should include user profile in prompt', () => {
    const prompt = PromptBuilder.buildSystemPrompt({
      userProfile: {
        communicationStyle: { formality: 0.8, responseLength: 'detailed' },
        preferences: { favoriteFeatures: ['成绩分析'] }
      }
    });
    expect(prompt).toContain('用户偏好画像');
    expect(prompt).toContain('正式');
    expect(prompt).toContain('非常详细');
  });

  test('should include admin mode indicator', () => {
    const prompt = PromptBuilder.buildSystemPrompt({ isAdmin: true });
    expect(prompt).toContain('管理员模式已启用');
  });

  test('should include tool descriptions', () => {
    const prompt = PromptBuilder.buildSystemPrompt({
      availableTools: [
        { name: 'query_scores', description: '查询评分数据' }
      ]
    });
    expect(prompt).toContain('query_scores');
    expect(prompt).toContain('查询评分数据');
  });

  test('should extract tool calls from response', () => {
    const response = '我来帮你查询 {"tool": "query_scores", "params": {"memberId": "101"}}';
    const calls = PromptBuilder.extractToolCalls(response);
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe('query_scores');
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `cd backend && npx jest agent/llm/__tests__/PromptBuilder.test.js --verbose`

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/agent/llm/
git commit -m "feat(agent): implement prompt builder with user context support"
```

---

## Phase 2: 三级记忆系统

### Task 4: 实现短期记忆 (ShortTermMemory)

**Files:**
- Create: `backend/agent/memory/ShortTermMemory.js`

- [ ] **Step 1: 编写 ShortTermMemory 实现**

```javascript
const crypto = require('crypto');

class ShortTermMemory {
  constructor(options = {}) {
    this.maxMessages = options.maxMessages || 20;
    this.sessions = new Map();
    this.ttl = options.ttl || 30 * 60 * 1000; // 30分钟过期
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
```

- [ ] **Step 2: 编写测试**

Create: `backend/agent/memory/__tests__/ShortTermMemory.test.js`

```javascript
const ShortTermMemory = require('../ShortTermMemory');

describe('ShortTermMemory', () => {
  let memory;

  beforeEach(() => {
    memory = new ShortTermMemory({ maxMessages: 5, ttl: 60000 });
  });

  test('should create session', () => {
    const session = memory.createSession('101');
    expect(session.memberId).toBe('101');
    expect(session.sessionId).toBeDefined();
    expect(session.messages).toEqual([]);
  });

  test('should add and retrieve messages', () => {
    const session = memory.createSession('101');
    memory.addMessage(session.sessionId, 'user', 'Hello');
    memory.addMessage(session.sessionId, 'assistant', 'Hi there');

    const messages = memory.getRecentMessages(session.sessionId);
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].content).toBe('Hi there');
  });

  test('should enforce max messages limit', () => {
    const session = memory.createSession('101');
    for (let i = 0; i < 8; i++) {
      memory.addMessage(session.sessionId, 'user', `Message ${i}`);
    }
    const messages = memory.getRecentMessages(session.sessionId);
    expect(messages.length).toBeLessThanOrEqual(5);
  });

  test('should update context', () => {
    const session = memory.createSession('101');
    memory.updateContext(session.sessionId, { currentTask: 'query_scores' });
    
    const ctx = memory.getContext(session.sessionId);
    expect(ctx.currentTask).toBe('query_scores');
  });

  test('should clean up expired sessions', () => {
    const session = memory.createSession('101');
    memory.metadata.lastActivityAt = new Date(Date.now() - 120000).toISOString();
    
    // Force expiration check
    const retrieved = memory.getSession(session.sessionId);
    expect(retrieved).toBeNull();
  });

  test('should get stats', () => {
    memory.createSession('101');
    memory.createSession('102');
    
    const stats = memory.getStats();
    expect(stats.activeSessions).toBe(2);
  });
});
```

- [ ] **Step 3: 运行测试**

Run: `cd backend && npx jest agent/memory/__tests__/ShortTermMemory.test.js --verbose`

Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/agent/memory/ShortTermMemory.js
git commit -m "feat(agent): implement short-term session memory"
```

---

### Task 5: 实现长期记忆 (LongTermMemory)

**Files:**
- Create: `backend/agent/memory/LongTermMemory.js`

- [ ] **Step 1: 编写 LongTermMemory 实现**

```javascript
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

class LongTermMemory {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data', 'agent_memories');
    this.maxSummaries = options.maxSummaries || 50;
    this.maxFacts = options.maxFacts || 200;
    this.retentionDays = options.retentionDays || 90;
  }

  async init() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  async getOrCreate(memberId) {
    const existing = await this.get(memberId);
    if (existing) return existing;

    const newMemory = {
      memberId,
      summaries: [],
      importantFacts: [],
      learningProgress: {},
      interactionPatterns: {
        peakUsageHours: Array(24).fill(0),
        averageSessionLength: 0,
        favoriteDays: {}
      },
      metadata: {
        totalInteractions: 0,
        firstInteractionDate: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      }
    };

    await this.save(memberId, newMemory);
    return newMemory;
  }

  async get(memberId) {
    try {
      const filePath = this._getFilePath(memberId);
      const compressed = await fs.readFile(filePath);
      const buffer = await promisify(zlib.unzip)(compressed);
      return JSON.parse(buffer.toString());
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(memberId, memory) {
    memory.metadata.lastUpdated = new Date().toISOString();
    
    const filePath = this._getFilePath(memberId);
    const jsonStr = JSON.stringify(memory, null, 2);
    const compressed = await promisify(zlib.deflate)(jsonStr);
    
    await fs.writeFile(filePath, compressed);
  }

  async addSummary(memberId, summaryData) {
    const memory = await this.getOrCreate(memberId);
    
    memory.summaries.unshift({
      date: summaryData.date || new Date().toISOString().split('T')[0],
      summary: summaryData.summary,
      keywords: summaryData.keywords || [],
      importanceScore: summaryData.importanceScore || 0.5,
      createdAt: new Date().toISOString()
    });

    if (memory.summaries.length > this.maxSummaries) {
      memory.summaries = memory.summaries.slice(0, this.maxSummaries);
    }

    await this.save(memberId, memory);
    return memory.summaries[0];
  }

  async addFact(memberId, factData) {
    const memory = await this.getOrCreate(memberId);

    memory.importantFacts.push({
      fact: factData.fact,
      category: factData.category || 'general',
      confidence: factData.confidence || 0.5,
      sourceSession: factData.sourceSession,
      createdAt: new Date().toISOString()
    });

    if (memory.importantFacts.length > this.maxFacts) {
      this._pruneLowConfidenceFacts(memory);
    }

    await this.save(memberId, memory);
    return memory.importantFacts[memory.importantFacts.length - 1];
  }

  async updateLearningProgress(memberId, progress) {
    const memory = await this.getOrCreate(memberId);
    memory.learningProgress = { ...memory.learningProgress, ...progress };
    await this.save(memberId, memory);
    return memory.learningProgress;
  }

  async recordInteraction(memberId, hour = null) {
    const memory = await this.getOrCreate(memberId);
    memory.metadata.totalInteractions++;
    
    const h = hour !== null ? hour : new Date().getHours();
    memory.interactionPatterns.peakUsageHours[h]++;
    
    const dayOfWeek = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()];
    memory.interactionPatterns.favoriteDays[dayOfWeek] = 
      (memory.interactionPatterns.favoriteDays[dayOfWeek] || 0) + 1;

    await this.save(memberId, memory);
  }

  async searchFacts(memberId, query, limit = 10) {
    const memory = await this.get(memberId);
    if (!memory || !memory.importantFacts) return [];

    const queryLower = query.toLowerCase();
    const scored = memory.importantFacts
      .map(fact => ({
        ...fact,
        score: this._calculateRelevance(fact.fact, queryLower)
      }))
      .filter(f => f.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  async getRecentSummaries(memberId, count = 5) {
    const memory = await this.get(memberId);
    if (!memory) return [];
    return memory.summaries.slice(0, count);
  }

  async cleanup() {
    try {
      const files = await fs.readdir(this.dataDir);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - this.retentionDays);

      for (const file of files) {
        if (file.endsWith('.gz')) {
          const filePath = path.join(this.dataDir, file);
          const stat = await fs.stat(filePath);
          
          if (stat.mtime < cutoffDate) {
            await fs.unlink(filePath);
          }
        }
      }
    } catch (err) {
      console.error('Cleanup error:', err.message);
    }
  }

  async delete(memberId) {
    try {
      const filePath = this._getFilePath(memberId);
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw err;
    }
  }

  _getFilePath(memberId) {
    return path.join(this.dataDir, `memory_${memberId}.json.gz`);
  }

  _calculateRelevance(fact, query) {
    const factLower = fact.toLowerCase();
    const words = query.split(/\s+/);
    let matchCount = 0;
    
    for (const word of words) {
      if (factLower.includes(word)) matchCount++;
    }
    
    return matchCount / Math.max(words.length, 1);
  }

  _pruneLowConfidenceFacts(memory) {
    memory.importantFacts.sort((a, b) => b.confidence - a.confidence);
    memory.importantFacts = memory.importantFacts.slice(0, this.maxFacts);
  }
}

const promisify = (fn) => (...args) => new Promise((resolve, reject) => {
  fn(...args, (err, result) => err ? reject(err) : resolve(result));
});

module.exports = LongTermMemory;
```

- [ ] **Step 2: 运行测试并验证**

Run: 手动创建测试文件或跳过（此模块依赖文件系统）

- [ ] **Step 3: Commit**

```bash
git add backend/agent/memory/LongTermMemory.js
git commit -m "feat(agent): implement long-term persistent memory with gzip compression"
```

---

### Task 6: 实现偏好画像 (UserProfile)

**Files:**
- Create: `backend/agent/memory/UserProfile.js`

- [ ] **Step 1: 编写 UserProfile 实现**

```javascript
const fs = require('fs').promises;
const path = require('path');
const zlib = require('zlib');

const DEFAULT_PROFILE = {
  memberId: '',
  communicationStyle: {
    formality: 0.5,
    responseLength: 'medium',
    humorLevel: 0.3,
    technicalDepth: 0.5,
    emojiUsage: true
  },
  preferences: {
    favoriteFeatures: [],
    quickActions: [],
    language: 'zh-CN',
    chartPreferences: {
      defaultChartType: 'radar',
      colorTheme: 'purple',
      showDataLabels: true
    }
  },
  adaptationHistory: [],
  privacySettings: {
    allowDataCollection: true,
    shareAnonymizedInsights: false,
    retainHistoryDuration: 90
  },
  usageStats: {
    featureUsage: {},
    totalInteractions: 0,
    avgResponseTime: 0
  },
  metadata: {
    matchScore: 0,
    profileMaturity: 0,
    lastAdaptedAt: null,
    createdAt: null
  }
};

class UserProfile {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(process.cwd(), 'data', 'agent_profiles');
  }

  async init() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }

  async getOrCreate(memberId) {
    const existing = await this.get(memberId);
    if (existing) return existing;

    const newProfile = JSON.parse(JSON.stringify(DEFAULT_PROFILE));
    newProfile.memberId = memberId;
    newProfile.metadata.createdAt = new Date().toISOString();

    await this.save(memberId, newProfile);
    return newProfile;
  }

  async get(memberId) {
    try {
      const filePath = this._getFilePath(memberId);
      const compressed = await fs.readFile(filePath);
      const buffer = await promisify(zlib.unzip)(compressed);
      return JSON.parse(buffer.toString());
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async save(memberId, profile) {
    profile.metadata.lastAdaptedAt = new Date().toISOString();
    
    const filePath = this._getFilePath(memberId);
    const jsonStr = JSON.stringify(profile, null, 2);
    const compressed = await promisify(zlib.deflate)(jsonStr);
    
    await fs.writeFile(filePath, compressed);
  }

  async updateStyle(memberId, styleUpdates) {
    const profile = await this.getOrCreate(memberId);
    const previousValues = { ...profile.communicationStyle };
    
    profile.communicationStyle = {
      ...profile.communicationStyle,
      ...styleUpdates
    };

    this._recordAdaptation(profile, 'communicationStyle', styleUpdates, previousValues);
    await this.save(memberId, profile);
    return profile.communicationStyle;
  }

  async updatePreferences(memberId, prefUpdates) {
    const profile = await this.getOrCreate(memberId);
    profile.preferences = { ...profile.preferences, ...prefUpdates };
    await this.save(memberId, profile);
    return profile.preferences;
  }

  async recordFeatureUsage(memberId, featureName) {
    const profile = await this.getOrCreate(memberId);
    
    profile.usageStats.featureUsage[featureName] = 
      (profile.usageStats.featureUsage[featureName] || 0) + 1;
    profile.usageStats.totalInteractions++;

    if (!profile.preferences.favoriteFeatures.includes(featureName)) {
      if (profile.preferences.favoriteFeatures.length < 6) {
        profile.preferences.favoriteFeatures.push(featureName);
      }
    }

    this._updateMatchScore(profile);
    await this.save(memberId, profile);
  }

  async adaptFromInteraction(memberId, interactionData) {
    const profile = await this.getOrCreate(memberId);
    
    if (interactionData.messageLength) {
      const avgLength = interactionData.messageLength;
      if (avgLength < 20 && profile.communicationStyle.responseLength !== 'short') {
        await this.updateStyle(memberId, { responseLength: 'short' });
      } else if (avgLength > 100 && profile.communicationStyle.responseLength !== 'detailed') {
        await this.updateStyle(memberId, { responseLength: 'detailed' });
      }
    }

    if (interactionData.usesTechnicalTerms) {
      const newDepth = Math.min(1, profile.communicationStyle.technicalDepth + 0.05);
      await this.updateStyle(memberId, { technicalDepth: parseFloat(newDepth.toFixed(2)) });
    }

    if (interactionData.formalLanguageDetected) {
      const newFormality = Math.min(1, profile.communicationStyle.formality + 0.05);
      await this.updateStyle(memberId, { formality: parseFloat(newFormality.toFixed(2)) });
    }

    this._updateMaturity(profile);
    await this.save(memberId, profile);
  }

  getMatchScore(profile) {
    return profile.metadata.matchScore || 0;
  }

  async delete(memberId) {
    try {
      const filePath = this._getFilePath(memberId);
      await fs.unlink(filePath);
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      throw err;
    }
  }

  _getFilePath(memberId) {
    return path.join(this.dataDir, `profile_${memberId}.json.gz`);
  }

  _recordAdaptation(profile, category, changes, previousValues) {
    profile.adaptationHistory.push({
      date: new Date().toISOString().split('T')[0],
      change: `调整了${category}`,
      reason: '基于用户交互行为',
      previousValue: previousValues,
      newValue: changes
    });

    if (profile.adaptationHistory.length > 50) {
      profile.adaptationHistory = profile.adaptationHistory.slice(-30);
    }
  }

  _updateMatchScore(profile) {
    const interactions = profile.usageStats.totalInteractions;
    const featuresUsed = Object.keys(profile.usageStats.featureUsage).length;
    
    let score = 0;
    score += Math.min(interactions / 50, 0.4); // 最多40%来自交互次数
    score += Math.min(featuresUsed / 6, 0.3);   // 最多30%来自功能多样性
    score += (profile.adaptationHistory.length / 20) * 0.3; // 最多30%来自适应历史
    
    profile.metadata.matchScore = Math.min(1, parseFloat(score.toFixed(2)));
  }

  _updateMaturity(profile) {
    const adaptations = profile.adaptationHistory.length;
    profile.metadata.profileMaturity = Math.min(1, adaptations / 15);
  }
}

const promisify = (fn) => (...args) => new Promise((resolve, reject) => {
  fn(...args, (err, result) => err ? reject(err) : resolve(result));
});

module.exports = UserProfile;
```

- [ ] **Step 2: Commit**

```bash
git add backend/agent/memory/UserProfile.js
git commit -m "feat(agent): implement user preference profile with auto-adaptation"
```

---

### Task 7: 实现记忆管理器 (MemoryManager)

**Files:**
- Create: `backend/agent/memory/MemoryManager.js`

- [ ] **Step 1: 编写 MemoryManager 实现**

```javascript
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
    
    setInterval(() => {
      this.shortTerm.cleanup();
    }, 5 * 60 * 1000); // 每5分钟清理过期会话
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
    await this.userProfile.adaptFromInteraction(memberId, {
      messageLength: message.length,
      usesTechnicalTerms: /(?:算法|架构|API|数据库|维度|指标)/.test(message),
      formalLanguageDetected: /(?:请|您|感谢|麻烦)/.test(message)
    });
    
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
        favoriteFeatures: profile.preferences?.favoriteFeatures || [],
        matchScore: profile.metadata?.matchScore || 0
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
    const assistantMessages = messages.filter(m => m.role === 'assistant').map(m => m.content);

    const topics = this._extractTopics(userMessages);
    const summary = this._generateSimpleSummary(userMessages, assistantMessages);

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

  _generateSimpleSummary(userMsgs, assistantMsgs) {
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
```

- [ ] **Step 2: Commit**

```bash
git add backend/agent/memory/MemoryManager.js
git commit -m "feat(agent): implement memory manager coordinating three-level memory system"
```

---

## Phase 3: 工具集实现

### Task 8: 实现工具基类和注册中心

**Files:**
- Create: `backend/agent/tools/BaseTool.js`
- Create: `backend/agent/tools/ToolRegistry.js`

- [ ] **Step 1: 编写 BaseTool 基类**

```javascript
class BaseTool {
  constructor(config = {}) {
    this.name = config.name;
    this.description = config.description || '';
    this.parameters = config.parameters || {};
    this.requireAuth = config.requireAuth || false;
    this.category = config.category || 'general';
  }

  async execute(params, context) {
    throw new Error(`子类 ${this.name} 必须实现 execute 方法`);
  }

  validateParams(params) {
    const errors = [];
    const requiredParams = Object.entries(this.parameters)
      .filter(([, schema]) => schema.required)
      .map(([name]) => name);

    for (const param of requiredParams) {
      if (!(param in params)) {
        errors.push(`缺少必需参数: ${param}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  getSchema() {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
      requireAuth: this.requireAuth,
      category: this.category
    };
  }

  formatResult(result) {
    return {
      success: true,
      tool: this.name,
      data: result,
      timestamp: new Date().toISOString()
    };
  }

  formatError(error) {
    return {
      success: false,
      tool: this.name,
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

module.exports = BaseTool;
```

- [ ] **Step 2: 编写 ToolRegistry 注册中心**

```javascript
class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.categories = new Map();
  }

  register(tool) {
    if (!(tool instanceof require('./BaseTool'))) {
      throw new Error('工具必须是 BaseTool 的实例');
    }

    if (this.tools.has(tool.name)) {
      console.warn(`工具 ${tool.name} 已存在，将被覆盖`);
    }

    this.tools.set(tool.name, tool);

    if (!this.categories.has(tool.category)) {
      this.categories.set(tool.category, []);
    }
    this.categories.get(tool.category).push(tool.name);
  }

  get(name) {
    return this.tools.get(name) || null;
  }

  getAll() {
    return Array.from(this.tools.values());
  }

  getByCategory(category) {
    const names = this.categories.get(category) || [];
    return names.map(name => this.tools.get(name)).filter(Boolean);
  }

  getCategories() {
    return Array.from(this.categories.keys());
  }

  getSchemas() {
    return this.getAll().map(tool => tool.getSchema());
  }

  getAvailableTools(isAdmin = false) {
    return this.getAll().filter(tool => {
      if (tool.requireAuth && !isAdmin) return false;
      return true;
    }).map(tool => ({
      name: tool.name,
      description: tool.description,
      requireAuth: tool.requireAuth,
      category: tool.category
    }));
  }

  async execute(name, params, context = {}) {
    const tool = this.get(name);
    if (!tool) {
      throw new Error(`工具 "${name}" 不存在`);
    }

    const validation = tool.validateParams(params);
    if (!validation.valid) {
      throw new Error(`参数验证失败: ${validation.errors.join(', ')}`);
    }

    if (tool.requireAuth && !context.isAdmin) {
      throw new Error(`工具 "${name}" 需要管理员权限`);
    }

    const startTime = Date.now();
    try {
      const result = await tool.execute(params, context);
      const executionTime = Date.now() - startTime;
      
      return {
        ...tool.formatResult(result),
        executionTime: `${executionTime}ms`
      };
    } catch (error) {
      return tool.formatError(error);
    }
  }

  has(name) {
    return this.tools.has(name);
  }

  count() {
    return this.tools.size;
  }
}

module.exports = ToolRegistry;
```

- [ ] **Step 3: Commit**

```bash
git add backend/agent/tools/BaseTool.js backend/agent/tools/ToolRegistry.js
git commit -m "feat(agent): implement base tool class and tool registry"
```

---

### Task 9: 实现成绩分析工具

**Files:**
- Create: `backend/agent/tools/ScoreAnalysisTool.js`

- [ ] **Step 1: 编写 ScoreAnalysisTool 实现**

```javascript
const BaseTool = require('./BaseTool');
const path = require('path');
const fs = require('fs').promises;
const zlib = require('zlib');

class ScoreAnalysisTool extends BaseTool {
  constructor(scoreService) {
    super({
      name: 'query_scores',
      description: '查询指定成员的评分数据，支持按周次、维度筛选',
      parameters: {
        memberId: { type: 'string', description: '成员ID', required: true },
        week: { type: 'number', description: '周次（可选，默认当前周）' },
        dimension: { type: 'string', description: '维度筛选（study/fitness/literacy/discipline/contribution/management）' }
      },
      requireAuth: false,
      category: 'scores'
    });
    this.scoreService = scoreService;
  }

  async execute(params, context) {
    const { memberId, week, dimension } = params;
    
    this._checkAccessPermission(memberId, context);

    const scores = await this._loadScores(memberId, week);
    
    if (dimension) {
      return this._filterByDimension(scores, dimension);
    }

    return {
      member: memberId,
      week: week || 'current',
      scores: scores,
      summary: this._generateSummary(scores)
    };
  }

  async getRadarConfig(memberId, week) {
    const scores = await this._loadScores(memberId, week);
    const dimensions = ['study', 'fitness', 'literacy', 'discipline', 'contribution', 'management'];
    const dimensionNames = {
      study: '学习成绩',
      fitness: '体能素质',
      literacy: '人文素养',
      discipline: '遵章守纪',
      contribution: '班级贡献',
      management: '管理能力'
    };

    const values = dimensions.map(dim => {
      const dimScores = scores[dim] || {};
      const subItems = Object.values(dimScores);
      return subItems.length > 0 
        ? (subItems.reduce((a, b) => a + b, 0) / subItems.length)
        : 0;
    });

    return {
      type: 'radar',
      title: `${memberId} 六维评分雷达图`,
      indicators: dimensions.map((dim, i) => ({
        name: dimensionNames[dim],
        max: 2,
        value: parseFloat(values[i].toFixed(2))
      })),
      rawData: scores
    };
  }

  async analyzeTrend(memberId, dimension, weeks = 8) {
    const trendData = [];
    
    for (let w = weeks; w >= 1; w--) {
      try {
        const scores = await this._loadScores(memberId, w);
        if (dimension) {
          const dimScores = scores[dimension] || {};
          const values = Object.values(dimScores);
          const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
          trendData.push({ week: w, value: parseFloat(avg.toFixed(2)) });
        }
      } catch (err) {
        break;
      }
    }

    return {
      type: 'trend',
      member: memberId,
      dimension,
      data: trendData.reverse()
    };
  }

  _checkAccessPermission(targetMemberId, context) {
    if (context.isAdmin) return;
    if (context.memberId !== targetMemberId) {
      throw new Error('无权查看其他成员的评分数据');
    }
  }

  async _loadScores(memberId, week) {
    const dataDir = path.join(process.cwd(), 'data', 'scores');
    
    if (week) {
      const filePath = path.join(dataDir, `scores_week_${week}.json.gz`);
      try {
        const compressed = await fs.readFile(filePath);
        const buffer = await promisify(zlib.unzip)(compressed);
        const allScores = JSON.parse(buffer.toString());
        return allScores.find(s => s.memberId === memberId)?.scores || {};
      } catch (err) {
        return {};
      }
    }

    return {};
  }

  _filterByDimension(scores, dimension) {
    return {
      dimension,
      data: scores[dimension] || {},
      summary: this._generateDimensionSummary(scores[dimension])
    };
  }

  _generateSummary(scores) {
    const totals = {};
    for (const [dim, subScores] of Object.entries(scores)) {
      const values = Object.values(subScores);
      totals[dim] = values.length > 0 
        ? parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2))
        : 0;
    }
    return totals;
  }

  _generateDimensionSummary(dimScores) {
    if (!dimScores || Object.keys(dimScores).length === 0) {
      return { message: '暂无该维度数据' };
    }
    const values = Object.values(dimScores);
    return {
      avg: parseFloat((values.reduce((a, b) => a + b, 0) / values.length).toFixed(2)),
      max: Math.max(...values),
      min: Math.min(...values),
      itemCount: values.length
    };
  }
}

const promisify = (fn) => (...args) => new Promise((resolve, reject) => {
  fn(...args, (err, result) => err ? reject(err) : resolve(result));
});

module.exports = ScoreAnalysisTool;
```

- [ ] **Step 2: Commit**

```bash
git add backend/agent/tools/ScoreAnalysisTool.js
git commit -m "feat(agent): implement score analysis tool with radar chart and trend analysis"
```

---

### Task 10: 实现心理气象站工具

**Files:**
- Create: `backend/agent/tools/PsychologyTool.js`

- [ ] **Step 1: 编写 PsychologyTool 实现**

```javascript
const BaseTool = require('./BaseTool');
const path = require('path');
const fs = require('fs').promises;

class PsychologyTool extends BaseTool {
  constructor() {
    super({
      name: 'psychology_station',
      description: '心理气象站功能：关系提名、心情标签追踪、社交地图生成',
      parameters: {
        action: { 
          type: 'string', 
          description: '操作类型: relationship/mood_tracker/social_map',
          required: true 
        },
        memberId: { type: 'string', description: '成员ID' },
        classId: { type: 'string', description: '班级ID（社交地图需要）' }
      },
      requireAuth: false,
      category: 'psychology'
    });
  }

  async execute(params, context) {
    const { action, memberId, classId } = params;

    switch (action) {
      case 'relationship':
        return await this._getRelationshipNominations(memberId, context);
      case 'mood_tracker':
        return await this._getMoodHistory(memberId, context);
      case 'social_map':
        return await this._generateSocialMap(classId || context.classId, context);
      default:
        throw new Error(`未知操作类型: ${action}`);
    }
  }

  async _getRelationshipNominations(memberId, context) {
    this._checkPermission(memberId, context);

    const dataPath = path.join(process.cwd(), 'data', 'psychology', `${memberId}.json`);
    
    try {
      const data = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
      return {
        type: 'relationship',
        memberId,
        positiveNominations: data.positive || [],
        negativeNominations: data.negative || [],
        summary: this._analyzeRelationships(data)
      };
    } catch (err) {
      return { type: 'relationship', memberId, message: '暂无关系提名数据' };
    }
  }

  async _getMoodHistory(memberId, context) {
    this._checkPermission(memberId, context);

    const dataPath = path.join(process.cwd(), 'data', 'psychology', 'moods.json');
    
    try {
      const allMoods = JSON.parse(await fs.readFile(dataPath, 'utf-8'));
      const userMoods = allMoods.filter(m => m.memberId === memberId);
      
      return {
        type: 'mood_history',
        memberId,
        records: userMoods.slice(-30),
        statistics: this._calculateMoodStats(userMoods),
        recentTrend: this._detectMoodTrend(userMoods.slice(-7))
      };
    } catch (err) {
      return { type: 'mood_history', memberId, message: '暂无心情记录' };
    }
  }

  async _generateSocialMap(classId, context) {
    if (!context.isAdmin) {
      throw new Error('生成社交地图需要管理员权限');
    }

    const psychologyDir = path.join(process.cwd(), 'data', 'psychology');
    
    try {
      const files = await fs.readdir(psychologyDir);
      const relationships = {};

      for (const file of files.filter(f => f.endsWith('.json') && f !== 'moods.json')) {
        const data = JSON.parse(await fs.readFile(path.join(psychologyDir, file), 'utf-8'));
        const mid = file.replace('.json', '');
        
        (data.positive || []).forEach(target => {
          if (!relationships[mid]) relationships[mid] = { positive: [], negative: [] };
          relationships[mid].positive.push(target);
        });
        
        (data.negative || []).forEach(target => {
          if (!relationships[mid]) relationships[mid] = { positive: [], negative: [] };
          relationships[mid].negative.push(target);
        });
      }

      return {
        type: 'social_map',
        classId,
        nodes: Object.keys(relationships).map(id => ({ id, connections: (relationships[id].positive || []).length })),
        edges: this._extractEdges(relationships),
        insights: this._generateSocialInsights(relationships)
      };
    } catch (err) {
      return { type: 'social_map', classId, message: '无法生成社交地图' };
    }
  }

  _checkPermission(targetMemberId, context) {
    if (context.isAdmin) return;
    if (context.memberId !== targetMemberId) {
      throw new Error('无权查看其他成员的心理数据');
    }
  }

  _analyzeRelationships(data) {
    const posCount = (data.positive || []).length;
    const negCount = (data.negative || []).length;
    
    return {
      totalPositive: posCount,
      totalNegative: negCount,
      ratio: negCount > 0 ? (posCount / negCount).toFixed(2) : '∞',
      assessment: posCount > negCount * 2 ? '人际关系良好' : 
                  posCount > negCount ? '人际关系正常' : '需关注人际交往'
    };
  }

  _calculateMoodStats(moods) {
    if (moods.length === 0) return null;

    const moodCounts = {};
    moods.forEach(m => {
      moodCounts[m.mood] = (moodCounts[m.mood] || 0) + 1;
    });

    const sorted = Object.entries(moodCounts).sort((a, b) => b[1] - a[1]);
    
    return {
      totalRecords: moods.length,
      mostCommonMood: sorted[0]?.[0],
      moodDistribution: Object.fromEntries(sorted)
    };
  }

  _detectMoodTrend(recentMoods) {
    if (recentMoods.length < 3) return 'insufficient_data';

    const positiveMoods = ['开心', '平静', '满足', '兴奋'];
    const recentPositive = recentMoods.filter(m => positiveMoods.includes(m.mood)).length;
    const ratio = recentPositive / recentMoods.length;

    if (ratio > 0.7) return 'improving';
    if (ratio < 0.3) return 'declining';
    return 'stable';
  }

  _extractEdges(relationships) {
    const edges = [];
    const seen = new Set();

    for (const [source, targets] of Object.entries(relationships)) {
      (targets.positive || []).forEach(target => {
        const key = [source, target].sort().join('-');
        if (!seen.has(key)) {
          seen.add(key);
          edges.push({ source, target, type: 'positive', weight: 1 });
        }
      });
    }

    return edges;
  }

  _generateSocialInsights(relationships) {
    const members = Object.keys(relationships);
    const mostConnected = members
      .map(id => ({ id, count: (relationships[id].positive || []).length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);

    return {
      totalMembers: members.length,
      mostConnectedMembers: mostConnected,
      suggestion: mostConnected.length > 0 
        ? `${mostConnected[0].id} 是最活跃的成员`
        : '暂无足够数据'
    };
  }
}

module.exports = PsychologyTool;
```

- [ ] **Step 2: Commit**

```bash
git add backend/agent/tools/PsychologyTool.js
git commit -m "feat(agent): implement psychology station tool with relationship and mood tracking"
```

---

### Task 11: 实现文件操作工具

**Files:**
- Create: `backend/agent/tools/FileOperationTool.js`

- [ ] **Step 1: 编写 FileOperationTool 实现**

```javascript
const BaseTool = require('./BaseTool');
const XLSX = require('xlsx');
const DocxTemplate = require('docx');
const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel } = DocxTemplate;
const fs = require('fs').promises;
const path = require('path');

class FileOperationTool extends BaseTool {
  constructor() {
    super({
      name: 'file_operations',
      description: '文件操作：导入Excel、导出Word/PDF文档',
      parameters: {
        action: { type: 'string', description: 'import_excel/export_docx/export_pdf', required: true },
        fileType: { type: 'string', description: '文件类型: scores/academic/fitness/members' },
        data: { type: 'object', description: '导出的数据（export操作需要）' },
        filePath: { type: 'string', description: '文件路径（import操作需要）' }
      },
      requireAuth: false,
      category: 'files'
    });
  }

  async execute(params, context) {
    const { action, fileType, data, filePath } = params;

    switch (action) {
      case 'import_excel':
        return await this._importExcel(filePath || params.path, fileType);
      case 'export_docx':
        return await this._exportDocx(fileType, data);
      case 'export_pdf':
        return await this._exportPdf(fileType, data);
      default:
        throw new Error(`未知操作: ${action}`);
    }
  }

  async _importExcel(filePath, fileType) {
    try {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = XLSX.utils.sheet_to_json(worksheet);

      return {
        type: 'import_result',
        fileType,
        rowCount: jsonData.length,
        columns: Object.keys(jsonData[0] || {}),
        preview: jsonData.slice(0, 5),
        data: jsonData
      };
    } catch (error) {
      throw new Error(`Excel导入失败: ${error.message}`);
    }
  }

  async _exportDocx(fileType, data) {
    const outputPath = path.join(
      process.cwd(), 
      'exports', 
      `${fileType}_${Date.now()}.docx`
    );

    await fs.mkdir(path.dirname(outputPath), { recursive: true });

    const children = [
      new Paragraph({
        text: `${fileType} 数据报告`,
        heading: HeadingLevel.HEADING_1,
      }),
      new Paragraph({
        text: `生成时间: ${new Date().toLocaleString('zh-CN')}`,
        spacing: { after: 200 },
      })
    ];

    if (Array.isArray(data) && data.length > 0) {
      const headers = Object.keys(data[0]);
      const tableRows = [
        new TableRow({
          children: headers.map(h => 
            new TableCell({ children: [new Paragraph({ text: h, bold: true })] })
          )
        }),
        ...data.slice(0, 100).map(row =>
          new TableRow({
            children: headers.map(h => 
              new TableCell({ children: [new Paragraph({ text: String(row[h] ?? '') })] })
            )
          })
        )
      ];

      children.push(new Table({ rows: tableRows }));
    }

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    await fs.writeFile(outputPath, buffer);

    return {
      type: 'export_result',
      format: 'docx',
      filePath: outputPath,
      fileName: path.basename(outputPath),
      size: buffer.length
    };
  }

  async _exportPdf(fileType, data) {
    const docxResult = await this._exportDocx(fileType, data);
    return {
      ...docxResult,
      note: 'PDF导出功能需要额外配置PDF转换库'
    };
  }
}

module.exports = FileOperationTool;
```

- [ ] **Step 2: Commit**

```bash
git add backend/agent/tools/FileOperationTool.js
git commit -m "feat(agent): implement file operations tool with Excel import and Word export"
```

---

### Task 12: 实现图表生成器

**Files:**
- Create: `backend/agent/tools/ChartGenerator.js`

- [ ] **Step 1: 编写 ChartGenerator 实现**

```javascript
const BaseTool = require('./BaseTool');

class ChartGenerator extends BaseTool {
  constructor() {
    super({
      name: 'chart_generator',
      description: '生成各种图表配置（雷达图、折线图、柱状图等），返回ECharts配置',
      parameters: {
        chartType: { type: 'string', description: '雷达图/折线图/柱状图/饼图/散点图/热力图', required: true },
        data: { type: 'object', description: '图表数据', required: true },
        options: { type: 'object', description: '可选配置（标题、颜色主题等）' }
      },
      requireAuth: false,
      category: 'charts'
    });
  }

  async execute(params, context) {
    const { chartType, data, options = {} } = params;

    const generators = {
      radar: () => this._generateRadarChart(data, options),
      line: () => this._generateLineChart(data, options),
      bar: () => this._generateBarChart(data, options),
      pie: () => this._generatePieChart(data, options),
      scatter: () => this._generateScatterChart(data, options),
      heatmap: () => this._generateHeatmap(data, options)
    };

    const generator = generators[chartType];
    if (!generator) {
      throw new Error(`不支持的图表类型: ${chartType}`);
    }

    const config = generator();
    return {
      type: 'echarts_config',
      chartType,
      config,
      renderHint: this._getRenderHint(chartType)
    };
  }

  _generateRadarChart(data, options) {
    const { indicators = [], values = [], title = '雷达图' } = data;
    
    return {
      title: { text: options.title || title, left: 'center' },
      tooltip: { trigger: 'item' },
      legend: { data: [options.seriesName || '数据'] },
      radar: {
        indicator: indicators.map(name => ({
          name,
          max: options.maxValue || 2
        }))
      },
      series: [{
        type: 'radar',
        data: [{
          value: values,
          name: options.seriesName || '数据'
        }]
      }],
      color: [options.colorTheme || '#667eea']
    };
  }

  _generateLineChart(data, options) {
    const { xData = [], yData = [], series = [] } = data;
    
    return {
      title: { text: options.title || '趋势图', left: 'center' },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: xData, boundaryGap: false },
      yAxis: { type: 'value' },
      series: series.length > 0 ? series : [{
        type: 'line',
        data: yData,
        smooth: true,
        areaStyle: { opacity: 0.3 }
      }],
      color: options.colors || ['#667eea', '#764ba2']
    };
  }

  _generateBarChart(data, options) {
    const { categories = [], values = [], series = [] } = data;
    
    return {
      title: { text: options.title || '柱状图', left: 'center' },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: categories },
      yAxis: { type: 'value' },
      series: series.length > 0 ? series : [{
        type: 'bar',
        data: values,
        itemStyle: { borderRadius: [4, 4, 0, 0] }
      }]
    };
  }

  _generatePieChart(data, options) {
    const { items = [] } = data;
    
    return {
      title: { text: options.title || '分布图', left: 'center' },
      tooltip: { trigger: 'item', formatter: '{b}: {c} ({d}%)' },
      legend: { orient: 'vertical', left: 'left' },
      series: [{
        type: 'pie',
        radius: options.donut ? ['40%', '70%'] : '70%',
        data: items,
        emphasis: { itemStyle: { shadowBlur: 10, shadowOffsetX: 0, shadowColor: 'rgba(0, 0, 0, 0.5)' } }
      }]
    };
  }

  _generateScatterChart(data, options) {
    const { points = [] } = data;
    
    return {
      title: { text: options.title || '散点图', left: 'center' },
      tooltip: { trigger: 'item' },
      xAxis: { type: 'value', splitLine: { show: true } },
      yAxis: { type: 'value', splitLine: { show: true } },
      series: [{
        type: 'scatter',
        data: points,
        symbolSize: options.symbolSize || 10
      }]
    };
  }

  _generateHeatmap(data, options) {
    const { matrix = [], xLabels = [], yLabels = [] } = data;
    
    return {
      title: { text: options.title || '热力图', left: 'center' },
      tooltip: { position: 'top' },
      grid: { height: '50%', top: '10%' },
      xAxis: { type: 'category', data: xLabels, splitArea: { show: true } },
      yAxis: { type: 'category', data: yLabels, splitArea: { show: true } },
      visualMap: {
        min: 0,
        max: options.maxValue || 1,
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: '0%'
      },
      series: [{
        type: 'heatmap',
        data: matrix,
        label: { show: true }
      }]
    };
  }

  _getRenderHint(chartType) {
    const hints = {
      radar: { recommendedWidth: 500, recommendedHeight: 400 },
      line: { recommendedWidth: 800, recommendedHeight: 400 },
      bar: { recommendedWidth: 700, recommendedHeight: 400 },
      pie: { recommendedWidth: 400, recommendedHeight: 400 },
      scatter: { recommendedWidth: 600, recommendedHeight: 450 },
      heatmap: { recommendedWidth: 600, recommendedHeight: 500 }
    };
    return hints[chartType] || { recommendedWidth: 600, recommendedHeight: 400 };
  }
}

module.exports = ChartGenerator;
```

- [ ] **Step 2: Commit**

```bash
git add backend/agent/tools/ChartGenerator.js
git commit -m "feat(agent): implement chart generator supporting 6 chart types"
```

---

## Phase 4: 核心引擎

### Task 13-16: 实现Agent核心引擎

**Files:**
- Create: `backend/agent/core/Engine.js`
- Create: `backend/agent/index.js` (主入口)

由于篇幅限制，这里提供Engine的核心框架：

- [ ] **Step 1: 编写 Engine.js 核心引擎**

```javascript
const DeepSeekClient = require('../llm/DeepSeekClient');
const PromptBuilder = require('../llm/PromptBuilder');
const ToolRegistry = require('../tools/ToolRegistry');
const MemoryManager = require('../memory/MemoryManager');

class AgentEngine {
  constructor(config = {}) {
    this.llm = new DeepSeekClient(config.deepseek || {});
    this.promptBuilder = PromptBuilder;
    this.toolRegistry = new ToolRegistry();
    this.memoryManager = new MemoryManager(config.memory || {});
    
    this.adminSessions = new Map();
    this.config = config;
  }

  async initialize() {
    await this.memoryManager.init();
    this._registerDefaultTools();
  }

  _registerDefaultTools() {
    const ScoreAnalysisTool = require('../tools/ScoreAnalysisTool');
    const PsychologyTool = require('../tools/PsychologyTool');
    const FileOperationTool = require('../tools/FileOperationTool');
    const ChartGenerator = require('../tools/ChartGenerator');

    this.toolRegistry.register(new ScoreAnalysisTool());
    this.toolRegistry.register(new PsychologyTool());
    this.toolRegistry.register(new FileOperationTool());
    this.toolRegistry.register(new ChartGenerator());
  }

  async processMessage(memberId, message, sessionId = null, context = {}) {
    let session;
    if (sessionId) {
      session = this.memoryManager.shortTerm.getSession(sessionId);
    }
    
    if (!session) {
      const sessionData = await this.memoryManager.startSession(memberId);
      session = sessionData.session;
      sessionId = session.sessionId;
    }

    await this.memoryManager.addUserMessage(sessionId, memberId, message);

    const isAdmin = this.adminSessions.has(memberId);
    const memoryContext = await this.memoryManager.buildMemoryContext(memberId, sessionId);
    
    const systemPrompt = this.promptBuilder.buildSystemPrompt({
      userProfile: memoryContext.preferences,
      shortTermMemory: { 
        messages: this.memoryManager.shortTerm.getRecentMessages(sessionId, 6),
        context: this.memoryManager.shortTerm.getContext(sessionId)
      },
      longTermMemory: memoryContext.longTerm,
      availableTools: this.toolRegistry.getSchemas(),
      isAdmin
    });

    const messages = [
      { role: 'system', content: systemPrompt },
      ...this.memoryManager.shortTerm.getRecentMessages(sessionId, 10).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }))
    ];

    let response = await this.llm.chat(messages, { stream: false });
    
    const toolCalls = this.promptBuilder.extractToolCalls(response.content || '');
    
    if (toolCalls.length > 0) {
      const toolResults = [];
      for (const call of toolCalls) {
        try {
          const result = await this.toolRegistry.execute(call.tool, call.params, {
            memberId,
            isAdmin
          });
          toolResults.push(result);
          
          if (result.success && result.data) {
            await this.memoryManager.extractAndStoreFact(
              memberId, 
              `通过${call.tool}查询到: ${JSON.stringify(result.data).slice(0, 200)}`,
              0.6,
              'tool_result'
            );
          }
        } catch (err) {
          toolResults.push({ success: false, error: err.message });
        }
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: JSON.stringify(toolResults) });
      
      response = await this.llm.chat(messages);
    }

    await this.memoryManager.addAssistantMessage(sessionId, response.content, {
      toolsUsed: toolCalls.map(t => t.tool)
    });

    if (context.featureUsed) {
      await this.memoryManager.userProfile.recordFeatureUsage(memberId, context.featureUsed);
    }

    return {
      responseId: require('crypto')..randomUUID(),
      content: response.content,
      sessionId,
      toolResults: toolCalls.length > 0 ? toolResults : undefined,
      memoryUpdated: true,
      suggestions: this._generateSuggestions(message, toolCalls)
    };
  }

  async verifyAdmin(memberId, password) {
    const config = require(path.join(process.cwd(), 'data', 'config.json'));
    if (!config.adminPasswords?.includes(password)) {
      return { success: false, error: '密码错误' };
    }
    this.adminSessions.set(memberId, { verifiedAt: Date.now() });
    return { success: true, isAdmin: true };
  }

  logoutAdmin(memberId) {
    this.adminSessions.delete(memberId);
  }

  _generateSuggestions(message, toolCalls) {
    const suggestions = [];
    const lowerMsg = message.toLowerCase();
    
    if (lowerMsg.includes('成绩') && !lowerMsg.includes('对比')) {
      suggestions.push('对比上周成绩');
    }
    if (lowerMsg.includes('图表') || lowerMsg.includes('图')) {
      suggestions.push('导出为图片');
    }
    if (toolCalls.some(t => t.tool === 'query_scores')) {
      suggestions.push('查看详细评分', '生成雷达图');
    }
    
    return suggestions.slice(0, 3);
  }
}

module.exports = AgentEngine;
```

- [ ] **Step 2: 编写主入口 index.js**

```javascript
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const AgentEngine = require('./core/Engine');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.json());

const engine = new AgentEngine({
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    model: 'deepseek-chat'
  },
  memory: {
    dataDir: path.join(__dirname, '..', 'data')
  }
});

(async () => {
  await engine.initialize();
  console.log('✅ AI Agent 引擎初始化完成');
})();

io.on('connection', (socket) => {
  console.log('🔗 Client connected:', socket.id);

  socket.on('agent:chat', async (data) => {
    try {
      socket.emit('agent:thinking');

      const result = await engine.processMessage(
        data.memberId,
        data.message,
        data.sessionId,
        data.context || {}
      );

      socket.emit('agent:response', result);
    } catch (error) {
      socket.emit('agent:error', { message: error.message });
    }
  });

  socket.on('agent:admin:verify', async (data) => {
    const result = await engine.verifyAdmin(data.memberId, data.password);
    socket.emit('admin:verified', result);
  });

  socket.on('disconnect', () => {
    console.log('❌ Client disconnected:', socket.id);
  });
});

app.use('/api/agent', require('./routes'));

const PORT = process.env.AGENT_PORT || 3001;
server.listen(PORT, () => {
  console.log(`🚀 AI Agent 服务启动在端口 ${PORT}`);
});

module.exports = { app, server, io, engine };
```

- [ ] **Step 3: Commit**

```bash
git add backend/agent/
git commit -m "feat(agent): implement core engine with full request processing pipeline"
```

---

## Phase 5: 前端组件

### Task 17-19: 实现前端React组件

**Files:**
- Create: `frontend/src/components/agent/ChatContainer.jsx`
- Create: `frontend/src/components/agent/ChartRenderer.jsx`
- Create: `frontend/src/components/agent/MemoryDashboard.jsx`

- [ ] **Step 1: ChatContainer 对话容器（独立滚动）**

```jsx
import React, { useState, useRef, useEffect } from 'react';
import { io } from 'socket.io-client';
import ChatMessage from './ChatMessage';
import ChatInput from './ChatInput';

const ChatContainer = ({ memberId, isAdmin = false }) => {
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [isThinking, setIsThinking] = useState(false);
  const messagesEndRef = useRef(null);
  const socketRef = useRef(null);

  useEffect(() => {
    socketRef.current = io(window.location.origin, {
      path: '/socket.io',
      transports: ['websocket']
    });

    socketRef.current.on('connect', () => {
      console.log('Socket connected');
    });

    socketRef.current.on('agent:response', (response) => {
      setMessages(prev => [...prev, { ...response, role: 'assistant', timestamp: new Date() }]);
      setIsThinking(false);
      if (response.sessionId) setSessionId(response.sessionId);
    });

    socketRef.current.on('agent:error', (error) => {
      setMessages(prev => [...prev, { content: error.message, role: 'error', timestamp: new Date() }]);
      setIsThinking(false);
    });

    return () => {
      socketRef.current?.disconnect();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = (content) => {
    if (!content.trim()) return;

    const userMessage = { content, role: 'user', timestamp: new Date() };
    setMessages(prev => [...prev, userMessage]);
    setIsThinking(true);

    socketRef.current?.emit('agent:chat', {
      memberId,
      message: content,
      sessionId,
      context: { isAdmin }
    });
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="flex-1 overflow-y-auto p-4 space-y-4" style={{ maxHeight: 'calc(100vh - 200px)' }}>
        {messages.length === 0 && (
          <div className="text-center text-gray-400 py-12">
            <p>👋 你好！我是AI智能助手</p>
            <p className="text-sm mt-2">可以帮你查询成绩、分析数据、管理信息</p>
          </div>
        )}
        {messages.map((msg, idx) => (
          <ChatMessage key={idx} message={msg} />
        ))}
        {isThinking && (
          <div className="flex items-center space-x-2 text-gray-500">
            <div className="typing-indicator flex space-x-1">
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }} />
              <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: '0.4s' }} />
            </div>
            <span className="text-sm">思考中...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      
      <ChatInput onSend={sendMessage} disabled={isThinking} />
    </div>
  );
};

export default ChatContainer;
```

- [ ] **Step 2: ChartRenderer 图表渲染组件**

```jsx
import React, { useEffect, useRef } from 'react';
import * as echarts from 'echarts';

const ChartRenderer = ({ config, style = {} }) => {
  const chartRef = useRef(null);
  const chartInstance = useRef(null);

  useEffect(() => {
    if (!chartRef.current || !config) return;

    if (!chartInstance.current) {
      chartInstance.current = echarts.init(chartRef.current);
    }

    chartInstance.current.setOption(config, true);

    const handleResize = () => chartInstance.current?.resize();
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [config]);

  useEffect(() => {
    return () => {
      chartInstance.current?.dispose();
    };
  }, []);

  if (!config) return null;

  return (
    <div 
      ref={chartRef} 
      className="bg-white rounded-lg shadow-sm p-4"
      style={{ width: '100%', height: style.height || 350, ...style }}
    />
  );
};

export default ChartRenderer;
```

- [ ] **Step 3: Commit前端组件**

```bash
git add frontend/src/components/agent/
git commit -m "feat(frontend): implement AI agent chat container with independent scroll and chart renderer"
```

---

## Phase 6: 集成与部署

### Task 20: 集成到现有系统

**Files:**
- Modify: `backend/index.js` (添加Agent路由)
- Modify: `frontend/src/App.jsx` (添加Agent页面入口)

- [ ] **Step 1: 在后端主文件集成Agent**

在 `backend/index.js` 中添加：
```javascript
// 在文件顶部引入
const agentApp = require('./agent');

// 在HTTP服务器创建后挂载
agentApp.server.listen(3001); // Agent独立端口
```

- [ ] **Step 2: 在前端App中添加Agent入口**

在导航菜单中添加"AI助手"选项，链接到 `/agent` 路由。

- [ ] **Step 3: 最终测试**

Run: `cd backend && node index.js & cd frontend && npm run dev`

Expected: 系统正常启动，可以访问AI Agent界面

- [ ] **Step 4: Final Commit**

```bash
git add .
git commit -m "feat: complete AI Agent integration with main application"
```

---

## 执行顺序总结

```
Phase 1: 基础架构 (Task 1-3)
  ↓
Phase 2: 记忆系统 (Task 4-7)
  ↓
Phase 3: 工具集 (Task 8-12)
  ↓
Phase 4: 核心引擎 (Task 13-16)
  ↓
Phase 5: 前端组件 (Task 17-19)
  ↓
Phase 6: 集成部署 (Task 20)
```

**预计总任务数:** 20个任务  
**预计开发时间:** 3-5天（单人全职）

---

## 验收标准

- [ ] Agent可以接收用户消息并回复
- [ ] 三级记忆系统正常工作
- [ ] 工具调用成功（至少3个工具）
- [ ] 图表正确渲染
- [ ] 权限隔离有效
- [ ] WebSocket实时通信正常
- [ ] 对话区域独立滚动

---

**Plan created:** 2026-05-06  
**Based on spec:** [2026-05-06-ai-agent-design.md](./specs/2026-05-06-ai-agent-design.md)
