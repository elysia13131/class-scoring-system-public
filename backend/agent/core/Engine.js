const crypto = require('crypto');
const DeepSeekClient = require('../llm/DeepSeekClient');
const PromptBuilder = require('../llm/PromptBuilder');
const ToolRegistry = require('../tools/ToolRegistry');
const MemoryManager = require('../memory/MemoryManager');
const conversationMemory = require('../memory/ConversationMemory');
const StopConversationTool = require('../tools/StopConversationTool');
const WeChatNotifyTool = require('../tools/WeChatNotifyTool');

class AgentEngine {
  constructor(config = {}) {
    this.llm = new DeepSeekClient(config.deepseek || {});
    this.promptBuilder = PromptBuilder;
    this.toolRegistry = new ToolRegistry();
    this.memoryManager = new MemoryManager(config.memory || {});
    
    this.adminSessions = new Map();
    this._pendingInjections = new Map();
    this._processingMembers = new Set();
    this.config = config;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    
    await this.memoryManager.init();
    this._registerDefaultTools();
    this.initialized = true;
    console.log('✅ AI Agent 引擎初始化完成');
  }

  injectUserMessage(memberId, message) {
    if (!memberId) return false;
    if (!this._processingMembers.has(memberId)) return false;
    if (!this._pendingInjections.has(memberId)) {
      this._pendingInjections.set(memberId, []);
    }
    this._pendingInjections.get(memberId).push(message);
    console.log(`[Engine] 注入待处理消息 ${memberId}: ${message.substring(0, 50)}`);
    return true;
  }

  isProcessing(memberId) {
    return this._processingMembers.has(memberId);
  }

  _registerDefaultTools() {
    this.toolRegistry.register(new (require('../tools/ScoreAnalysisTool'))());
    this.toolRegistry.register(new (require('../tools/PsychologyTool'))());
    this.toolRegistry.register(new (require('../tools/FileOperationTool'))());
    this.toolRegistry.register(new (require('../tools/ChartGenerator'))());
    this.toolRegistry.register(new (require('../tools/ScoreSubmitTool'))());
    this.toolRegistry.register(new (require('../tools/MoodRecordTool'))());
    this.toolRegistry.register(new (require('../tools/ChartExportTool'))());
    this.toolRegistry.register(new (require('../tools/MemberInfoTool'))());
    this.toolRegistry.register(new (require('../tools/AdminAnalysisTool'))());
    this.toolRegistry.register(new (require('../tools/DataQueryTool'))());
    this.toolRegistry.register(new (require('../tools/NotifyMemberTool'))());
    this.toolRegistry.register(new WeChatNotifyTool());
    this.toolRegistry.register(new StopConversationTool());
    this.toolRegistry.register(new (require('../tools/AdminCheckinTool'))());
    this.toolRegistry.register(new (require('../tools/AdminObservationTool'))());
    this.toolRegistry.register(new (require('../tools/PersonaUpdateTool'))());
    this.toolRegistry.register(new (require('../tools/ScheduleCreateTool'))());
    this.toolRegistry.register(new (require('../tools/ScheduleViewTool'))());
    this.toolRegistry.register(new (require('../tools/ScheduleDeleteTool'))());
    this.toolRegistry.register(new (require('../tools/AutomationCreateTool'))());
    this.toolRegistry.register(new (require('../tools/AutomationListTool'))());
    this.toolRegistry.register(new (require('../tools/AutomationDeleteTool'))());

    console.log(`🔧 已注册 ${this.toolRegistry.count()} 个工具`);
  }

  async processMessage(memberId, message, sessionId = null, context = {}) {
    return this._processMessageInternal(memberId, message, sessionId, context, null);
  }

  async processMessageStream(memberId, message, sessionId = null, context = {}, socket = null) {
    return this._processMessageInternal(memberId, message, sessionId, context, socket);
  }

  async processMessageStreamWithCallback(memberId, message, sessionId = null, context = {}, callbacks = {}) {
    const mockSocket = {
      emit: (event, data) => {
        switch (event) {
          case 'agent:stream:token': callbacks.onToken?.(data.content); break;
          case 'agent:stream:done': callbacks.onDone?.(data); break;
          case 'agent:stream:error': callbacks.onError?.(data.error || data); break;
          case 'agent:stream:tool_call': callbacks.onToolCall?.(data); break;
          case 'agent:stream:tool_result': callbacks.onToolResult?.(data); break;
          case 'agent:stream:chart': callbacks.onChart?.(data); break;
          case 'agent:stream:form': callbacks.onForm?.(data); break;
          case 'agent:stream:thinking': break;
          default: break;
        }
      },
      disconnected: false,
    };
    return this._processMessageInternal(memberId, message, sessionId, context, mockSocket);
  }

  async _processMessageInternal(memberId, message, sessionId = null, context = {}, socket = null) {
    await this._ensureInitialized();

    let session;
    if (sessionId) {
      session = this.memoryManager.shortTerm.getSession(sessionId);
    }

    if (!session && memberId) {
      session = this.memoryManager.shortTerm.getSessionByMember(memberId);
      if (session) sessionId = session.sessionId;
    }

    if (!session) {
      const sessionData = await this.memoryManager.startSession(memberId);
      session = sessionData.session;
      sessionId = session.sessionId;
    }

    await this.memoryManager.addUserMessage(sessionId, memberId, message);

    // 持久化会话记忆：记录用户消息
    if (memberId) {
      conversationMemory.addMessage(memberId, 'user', message);
    }

    const isAdmin = context.isAdmin !== undefined ? context.isAdmin : (!memberId || this.adminSessions.has(memberId));
    console.log(`[Engine] memberId=${memberId}, context.isAdmin=${context.isAdmin}, final isAdmin=${isAdmin}`);
    const memoryContext = await this.memoryManager.buildMemoryContext(memberId, sessionId);

    // 获取事实/反思上下文前缀 + 角色风格
    const convContextPrefix = await conversationMemory.getContextPrefix(memberId);
    const personaPrompt = await conversationMemory.getPersona(memberId);

    const systemPrompt = this.promptBuilder.buildSystemPrompt({
      personaPrompt,
      userProfile: memoryContext.preferences,
      shortTermMemory: {
        messages: this.memoryManager.shortTerm.getRecentMessages(sessionId, 6),
        context: this.memoryManager.shortTerm.getContext(sessionId)
      },
      longTermMemory: memoryContext.longTerm,
      conversationMemoryPrefix: convContextPrefix,
      availableTools: this.toolRegistry.getSchemas(),
      isAdmin,
      memberId
    });

    const chatMessages = [
      { role: 'system', content: systemPrompt },
      ...this.memoryManager.shortTerm.getRecentMessages(sessionId, 10).map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }))
    ];

    const toolsSchema = this.promptBuilder.buildToolsSchema(this.toolRegistry.getSchemas());

    try {
      if (memberId) this._processingMembers.add(memberId);
      const isStream = !!socket;
      
      if (isStream) {
        socket.emit('agent:stream:start', { sessionId });
      }

      let toolResults = [];
      let finalContent = '';

      if (isStream) {
        const streamResult = await this._streamChatWithToolLoop(chatMessages, toolsSchema, socket, memberId, isAdmin);
        finalContent = streamResult.content;
        toolResults = streamResult.toolResults;
      } else {
        const result = await this._nonStreamChatWithToolLoop(chatMessages, toolsSchema, memberId, isAdmin);
        finalContent = result.content;
        toolResults = result.toolResults;
      }

      await this.memoryManager.addAssistantMessage(sessionId, finalContent, {
        toolsUsed: toolResults.map(t => t.tool || t.name)
      });

      // 持久化会话记忆：记录助手回复
      if (memberId) {
        const lastToolName = toolResults.length > 0 ? toolResults[toolResults.length - 1].tool || toolResults[toolResults.length - 1].name : null;
        conversationMemory.addMessage(memberId, 'assistant', finalContent, lastToolName);
      }

      // 执行记忆维护（压缩/事实提取）并刷盘
      if (memberId && this.llm) {
        Promise.all([
          conversationMemory.maintenance(memberId, this.llm),
          conversationMemory.flush(memberId)
        ]).catch(e =>
          console.warn(`[Engine] 记忆维护/刷盘失败 ${memberId}:`, e.message)
        );
      }

      if (memberId && toolResults.length > 0) {
        for (const tr of toolResults) {
          const featureName = tr.tool || tr.name;
          if (featureName && tr.success) {
            try {
              await this.memoryManager.userProfile.recordFeatureUsage(memberId, featureName);
            } catch (e) {
              console.warn(`[Engine] recordFeatureUsage failed for ${featureName}:`, e.message);
            }
          }
        }
      }

      const result = {
        responseId: crypto.randomUUID(),
        content: finalContent,
        sessionId,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        memoryUpdated: true,
        suggestions: this._generateSuggestions(message, toolResults)
      };

      if (isStream) {
        socket.emit('agent:stream:done', result);
      }

      return result;
    } catch (error) {
      console.error('Agent process error:', error);
      
      const fallbackResponse = this._generateFallbackResponse(message, error);
      await this.memoryManager.addAssistantMessage(sessionId, fallbackResponse);

      const errorResult = {
        responseId: crypto.randomUUID(),
        content: fallbackResponse,
        sessionId,
        error: error.message,
        suggestions: []
      };

      if (socket) {
        socket.emit('agent:stream:error', { error: error.message });
        socket.emit('agent:stream:done', errorResult);
      }

      return errorResult;
    } finally {
      if (memberId) {
        this._processingMembers.delete(memberId);
        this._pendingInjections.delete(memberId);
      }
    }
  }

  async _nonStreamChatWithToolLoop(chatMessages, toolsSchema, memberId, isAdmin) {
    let toolResults = [];
    let finalContent = '';

    for (let round = 0; ; round++) {
      console.log(`[Engine] === Non-stream Round ${round + 1} ===`);

      // 注入待处理消息到当前迭代
      if (memberId && this._pendingInjections.has(memberId)) {
        const injections = this._pendingInjections.get(memberId);
        while (injections.length > 0) {
          const injectedMsg = injections.shift();
          chatMessages.push({ role: 'user', content: `[用户补充] ${injectedMsg}` });
          console.log(`[Engine] 注入消息到Round ${round + 1}: ${injectedMsg.substring(0, 40)}`);
        }
      }

      const response = await this.llm.chat(chatMessages, {
        stream: false,
        tools: toolsSchema,
      });

      const msg = response.content || '';
      const nativeToolCalls = response.toolCalls || [];

      if (nativeToolCalls.length > 0) {
        if (nativeToolCalls.length > 1) {
          console.log(`[Engine] 多工具调用${nativeToolCalls.length}个，仅执行第一个: ${nativeToolCalls[0].function.name}`);
          nativeToolCalls.splice(1);
        }

        for (const tc of nativeToolCalls) {
          const fn = tc.function;
          if (!fn) continue;
          const toolName = fn.name;
          let params = {};
          try { params = JSON.parse(fn.arguments || '{}'); } catch(e) { params = {}; }

          console.log(`[Engine] 原生工具调用: ${toolName}`, params);
          const result = await this.toolRegistry.execute(toolName, params, { memberId, isAdmin });
          console.log(`[Engine] 工具结果:`, result.success ? 'success' : result.error);
          toolResults.push(result);

          if (result.success && result.data?.type === 'stop_conversation') {
            finalContent = result.data?.message || '';
            return { content: finalContent, toolResults };
          }

          if (result.isForm || (result.success && result.data?.type === 'form')) {
            console.log(`[Engine] 工具返回交互表单: ${result.data?.formType}`);
          } else if (result.success && result.data) {
            await this.memoryManager.extractAndStoreFact(memberId, `通过${toolName}查询到数据`, 0.6, 'tool_result');
          }

          let toolResultContent = JSON.stringify(result.data || { error: result.error || '请求失败' });
          if (toolResultContent.length > 30000) {
            toolResultContent = toolResultContent.substring(0, 30000) + '...[数据已截断，共' + toolResultContent.length + '字符]';
          }

          chatMessages.push({
            role: 'assistant',
            content: null,
            tool_calls: [{
              id: tc.id || `call_${Date.now()}`,
              type: 'function',
              function: { name: toolName, arguments: fn.arguments || '{}' }
            }]
          });
          chatMessages.push({
            role: 'tool',
            tool_call_id: tc.id || `call_${Date.now()}`,
            content: toolResultContent
          });
        }

        const hasForm = toolResults.some(r => r.isForm || (r.success && r.data?.type === 'form'));
        if (hasForm) {
          const formResult = toolResults.find(r => r.isForm || (r.success && r.data?.type === 'form'));
          finalContent = formResult.data?.formType === 'mood_record'
            ? '请填写心情记录表单：'
            : formResult.data?.formType === 'score_submit'
              ? '请填写评分表单：'
              : '请填写以下表单：';
          break;
        }

        continue;
      }

      const textToolCalls = this.promptBuilder.extractToolCalls(msg);
      if (textToolCalls.length > 0) {
        for (const call of textToolCalls) {
          try {
            console.log('[Engine] 文本工具调用:', call.tool, '参数:', call.params);
            const result = await this.toolRegistry.execute(call.tool, call.params || {}, { memberId, isAdmin });
            toolResults.push(result);

            if (result.isForm || (result.success && result.data?.type === 'form')) {
              console.log('[Engine] 工具返回交互表单:', result.data?.formType);
            } else if (result.success && result.data) {
              await this.memoryManager.extractAndStoreFact(memberId, `通过${call.tool}查询到数据`, 0.6, 'tool_result');
            }
          } catch (err) {
            console.error('[Engine] 工具执行错误:', err);
            toolResults.push({ success: false, error: err.message });
          }
        }

        const hasForm = toolResults.some(r => r.isForm || (r.success && r.data?.type === 'form'));
        if (hasForm) {
          const formResult = toolResults.find(r => r.isForm || (r.success && r.data?.type === 'form'));
          finalContent = formResult.data?.formType === 'mood_record'
            ? '请填写心情记录表单：'
            : formResult.data?.formType === 'score_submit'
              ? '请填写评分表单：'
              : '请填写以下表单：';
        } else {
          chatMessages.push({ role: 'assistant', content: msg });
          chatMessages.push({ role: 'user', content: JSON.stringify(toolResults.map(r => r.success ? r.data : r.error)) });
          const followUp = await this.llm.chat(chatMessages);
          finalContent = followUp.content || '';
        }
        break;
      }

      finalContent = msg;
      break;
    }

    return { content: finalContent, toolResults };
  }

  async _streamChatWithToolLoop(chatMessages, toolsSchema, socket, memberId, isAdmin) {
    let fullContent = '';
    let toolResults = [];
    const STREAM_TIMEOUT = 60000;

    for (let round = 0; ; round++) {
      if (socket.disconnected) break;

      // 注入待处理消息到当前迭代
      if (memberId && this._pendingInjections.has(memberId)) {
        const injections = this._pendingInjections.get(memberId);
        while (injections.length > 0) {
          const injectedMsg = injections.shift();
          chatMessages.push({ role: 'user', content: `[用户补充] ${injectedMsg}` });
          console.log(`[Stream] 注入消息到Round ${round + 1}: ${injectedMsg.substring(0, 40)}`);
        }
      }

      console.log(`[Stream] Round ${round + 1}: 发起LLM调用`);

      let nativeToolCalls = [];

      try {
        fullContent = '';

        const stream = this.llm._streamChat({
          model: this.llm.defaultModel,
          messages: chatMessages,
          temperature: this.llm.defaultTemperature,
          max_tokens: this.llm.defaultMaxTokens,
          tools: toolsSchema,
        });

        const iterator = stream[Symbol.asyncIterator]();
        let currentToolCall = null;

        while (true) {
          // 每个 chunk 一个 60s 看门狗；竞态一结束立刻清掉——旧实现只 race 不 clear，
          // 长回答会持续堆 60s 定时器，且输掉竞态的 iterator.next() 一直悬挂（连接不释放）。
          let chunkTimer = null;
          const race = await Promise.race([
            iterator.next(),
            new Promise((resolve) => {
              chunkTimer = setTimeout(() => resolve({ value: undefined, done: true, timedOut: true }), STREAM_TIMEOUT);
            })
          ]);
          clearTimeout(chunkTimer);

          if (race.done) {
            // 超时（而非流自然结束）时显式关闭生成器，让悬挂的 next() 收尾、底层连接释放
            if (race.timedOut) iterator.return?.();
            break;
          }

          const chunk = race.value;

          if (chunk?.type === 'token' && chunk?.content) {
            fullContent += chunk.content;
            socket.emit('agent:stream:token', { content: chunk.content });
          }

          if (chunk?.type === 'tool_call' && chunk?.toolCalls) {
            for (const tc of chunk.toolCalls) {
              if (tc.function?.name) {
                if (currentToolCall) {
                  nativeToolCalls.push(currentToolCall);
                }
                currentToolCall = {
                  id: tc.id || `call_${Date.now()}_${nativeToolCalls.length}`,
                  type: 'function',
                  function: {
                    name: tc.function.name,
                    arguments: tc.function.arguments || '',
                  },
                };
              } else if (currentToolCall && tc.function?.arguments) {
                currentToolCall.function.arguments += tc.function.arguments;
              }
            }
          }

          if (chunk?.type === 'done') {
            if (currentToolCall) {
              nativeToolCalls.push(currentToolCall);
              currentToolCall = null;
            }
          }

          if (socket.disconnected) {
            iterator.return?.();
            return { content: fullContent, toolResults };
          }
        }

        if (nativeToolCalls.length === 0) {
          console.log(`[Stream] Round ${round + 1}: 无工具调用，输出最终内容 (长度:${fullContent.length})`);
          if (fullContent) console.log(`[Stream] 最终内容预览: ${fullContent.substring(0, 200)}`);
          break;
        }

        if (nativeToolCalls.length > 1) {
          console.log(`[Stream] 多工具调用${nativeToolCalls.length}个，仅执行第一个: ${nativeToolCalls[0].function.name}`);
          nativeToolCalls.splice(1);
        }

        socket.emit('agent:stream:tool_call', {
          tools: nativeToolCalls.map(tc => ({ tool: tc.function.name, params: tc.function.arguments })),
          round: round + 1
        });

        const tc = nativeToolCalls[0];
        const toolName = tc.function.name;
        let params = {};
        try { params = JSON.parse(tc.function.arguments || '{}'); } catch (e) { params = {}; }

        console.log(`[Stream] 执行工具: ${toolName}`, JSON.stringify(params));
        const result = await this.toolRegistry.execute(toolName, params, { memberId, isAdmin });
        console.log(`[Stream] 工具 ${toolName} 结果: success=${result.success}`, result.data ? (Array.isArray(result.data) ? `data[${result.data.length}]` : result.data.dataType || result.data.type || Object.keys(result.data).slice(0,3).join(',')) : 'no data');
        toolResults.push(result);
        socket.emit('agent:stream:tool_result', { tool: toolName, result });

        if (result.success && result.data?.type === 'stop_conversation') {
          if (result.data?.message) {
            fullContent = result.data.message;
            socket.emit('agent:stream:token', { content: fullContent });
          }
          break;
        }

        if (result.success && result.data?.config) {
          socket.emit('agent:stream:chart', { config: result.data.config });
        }

        if (result.isForm || (result.success && result.data?.type === 'form')) {
          socket.emit('agent:stream:form', {
            formType: result.data.formType,
            formSchema: result.data.formSchema,
            tool: result.data.submitAction || toolName
          });
          return { content: '', toolResults };
        }

        if (result.success && result.data) {
          await this.memoryManager.extractAndStoreFact(memberId, `通过${toolName}查询到数据`, 0.6, 'tool_result');
        }

        let toolResultContent = JSON.stringify(result.data || { error: result.error || '请求失败' });
        if (toolResultContent.length > 30000) {
          toolResultContent = toolResultContent.substring(0, 30000) + '...[数据已截断，共' + toolResultContent.length + '字符]';
        }

        chatMessages.push({
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: tc.id || `call_${Date.now()}`,
            type: 'function',
            function: { name: toolName, arguments: tc.function.arguments || '{}' }
          }]
        });
        chatMessages.push({
          role: 'tool',
          tool_call_id: tc.id || `call_${Date.now()}`,
          content: toolResultContent
        });

        socket.emit('agent:stream:thinking', { message: `Round ${round + 2}：继续分析...` });

      } catch (err) {
        console.error(`[Stream] Round ${round + 1} error:`, err.message);
        socket.emit('agent:stream:error', { error: err.message });

        if (round === 0) {
          fullContent = fullContent || '抱歉，处理请求时遇到错误，请稍后重试。';
          break;
        }

        chatMessages.push({ role: 'assistant', content: fullContent || '处理请求时遇到错误。' });
        chatMessages.push({ role: 'user', content: `[系统错误]\n${err.message}\n\n请尝试其他方式回答用户问题。` });

        socket.emit('agent:stream:thinking', { message: '重试中...' });
      }
    }

    return { content: fullContent, toolResults };
  }

  async verifyAdmin(memberId, password) {
    try {
      const bcrypt = require('bcryptjs');
      const fs = require('fs').promises;
      const path = require('path');
      const { getDataPath } = require('../../utils/dataPath');
      const configPath = getDataPath('config.json');
      const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));

      const matched = (config.adminPasswords || []).some(hash => bcrypt.compareSync(password, hash));
      if (!matched) {
        return { success: false, error: '密码错误' };
      }
      this.adminSessions.set(memberId, { verifiedAt: Date.now() });
      return { success: true, isAdmin: true };
    } catch (err) {
      return { success: false, error: '验证失败' };
    }
  }

  logoutAdmin(memberId) {
    this.adminSessions.delete(memberId);
  }

  isAdmin(memberId) {
    return this.adminSessions.has(memberId);
  }

  endAdminSession(memberId) {
    this.adminSessions.delete(memberId);
  }

  getAvailableTools(isAdmin = false) {
    return this.toolRegistry.getAvailableTools(isAdmin);
  }

  async getFullMemoryState(memberId) {
    await this._ensureInitialized();
    return this.memoryManager.getFullMemoryState(memberId);
  }

  async updateUserPreferences(memberId, preferences) {
    await this._ensureInitialized();
    return this.memoryManager.updateUserPreferences(memberId, preferences);
  }

  getStats(memberId) {
    return {
      initialized: this.initialized,
      toolCount: this.toolRegistry.count(),
      activeSessions: this.memoryManager.shortTerm.getStats(),
      adminSessions: this.adminSessions.size
    };
  }

  _ensureInitialized() {
    if (!this.initialized) {
      throw new Error('引擎尚未初始化，请先调用 initialize()');
    }
  }

  _generateFallbackResponse(message, error) {
    if (error.message.includes('API') || error.message.includes('AI')) {
      return `抱歉，AI服务暂时不可用。不过我可以告诉你：\n\n你的消息已记录"${message.slice(0, 50)}"，你可以稍后重试，或者使用其他功能（如查看成绩、心理气象站等）。`;
    }
    return `处理请求时出现问题：${error.message}。请稍后重试或联系管理员。`;
  }

  _generateSuggestions(message, toolCalls) {
    const suggestions = [];
    const lowerMsg = message.toLowerCase();
    
    if (lowerMsg.includes('成绩') && !lowerMsg.includes('对比')) {
      suggestions.push('对比上周成绩');
    }
    if (lowerMsg.includes('图表') || lowerMsg.includes('图') || lowerMsg.includes('雷达')) {
      suggestions.push('导出为图片');
    }
    if (toolCalls.some(t => (t.tool || t.name) === 'query_scores')) {
      suggestions.push('查看详细评分', '生成雷达图');
    }
    if (lowerMsg.includes('心理') || lowerMsg.includes('心情')) {
      suggestions.push('填写心情记录');
    }
    if (lowerMsg.includes('导出') || lowerMsg.includes('下载')) {
      suggestions.push('生成Word报告');
    }
    
    return suggestions.slice(0, 3);
  }
}

module.exports = AgentEngine;
