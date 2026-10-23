const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const AgentEngine = require('./core/Engine');
const path = require('path');
const { getDataDir, getDataPath } = require('../utils/dataPath');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { 
    origin: '*',
    methods: ['GET', 'POST']
  }
});

app.use(express.json({ limit: '10mb' }));

const WeChatBot = require('../wechat/index');

const engine = new AgentEngine({
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1'
  },
  memory: {
    dataDir: getDataDir()
  }
});

let wechatBot = null;

(async () => {
  try {
    await engine.initialize();
    console.log('✅ AI Agent 引擎初始化完成');

    if (process.env.WECHAT_BOT_ENABLED !== 'false') {
      wechatBot = new WeChatBot({
        engine,
        dataDir: getDataPath('wechat')
      });
      wechatBot.start().catch(err => {
        console.warn('[WeChat] 启动失败（可忽略，不影响主服务）:', err.message);
      });
    } else {
      console.log('[WeChat] 微信Bot已禁用 (WECHAT_BOT_ENABLED=false)');
    }
  } catch (err) {
    console.error('Agent初始化失败:', err.message);
  }
})();

io.on('connection', (socket) => {
  console.log('🔗 AI Agent Client connected:', socket.id);

  socket.on('agent:chat', async (data) => {
    const { memberId, message, sessionId, context } = data;
    
    if (!memberId || !message) {
      socket.emit('agent:error', { message: '缺少必要参数: memberId, message' });
      return;
    }

    // 如果上轮对话仍在迭代中，将新消息注入当前迭代
    if (engine.isProcessing(memberId)) {
      engine.injectUserMessage(memberId, message);
      socket.emit('agent:injected', { message: '消息已注入当前对话' });
      return;
    }

    try {
      socket.emit('agent:thinking');

      const result = await engine.processMessage(
        memberId,
        message,
        sessionId,
        context || {}
      );

      socket.emit('agent:response', result);
    } catch (error) {
      console.error('Chat error:', error);
      socket.emit('agent:error', { message: error.message });
    }
  });

  socket.on('agent:admin:verify', async (data) => {
    try {
      const result = await engine.verifyAdmin(data.memberId, data.password);
      socket.emit('admin:verified', result);
    } catch (error) {
      socket.emit('admin:verified', { success: false, error: error.message });
    }
  });

  socket.on('agent:admin:logout', (data) => {
    engine.logoutAdmin(data.memberId);
    socket.emit('admin:logged_out', { success: true });
  });

  socket.on('agent:memory:get', async (data) => {
    try {
      const state = await engine.memoryManager.getFullMemoryState(data.memberId);
      socket.emit('memory:state', state);
    } catch (error) {
      socket.emit('memory:error', { message: error.message });
    }
  });

  socket.on('agent:preferences:update', async (data) => {
    try {
      await engine.memoryManager.updateUserPreferences(data.memberId, data.updates);
      const prefs = await engine.memoryManager.getUserPreferences(data.memberId);
      socket.emit('preferences:updated', prefs);
    } catch (error) {
      socket.emit('preferences:error', { message: error.message });
    }
  });

  socket.on('agent:tools:list', () => {
    const isAdmin = data => data?.isAdmin || false;
    const tools = engine.toolRegistry.getAvailableTools(false);
    socket.emit('tools:list', tools);
  });

  socket.on('agent:stats', () => {
    socket.emit('agent:stats', engine.getStats());
  });

  socket.on('disconnect', () => {
    console.log('❌ AI Agent Client disconnected:', socket.id);
  });
});

app.get('/api/agent/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    initialized: engine.initialized,
    tools: engine.toolRegistry.count(),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/agent/chat', async (req, res) => {
  try {
    const { memberId, message, sessionId, context } = req.body;
    
    if (!memberId || !message) {
      return res.status(400).json({ error: '缺少必要参数' });
    }

    if (engine.isProcessing(memberId)) {
      engine.injectUserMessage(memberId, message);
      return res.json({ injected: true, message: '消息已注入当前对话' });
    }

    const result = await engine.processMessage(memberId, message, sessionId, context);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/agent/admin/verify', async (req, res) => {
  try {
    const result = await engine.verifyAdmin(req.body.memberId, req.body.password);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent/memory/:memberId', async (req, res) => {
  try {
    const state = await engine.memoryManager.getFullMemoryState(req.params.memberId);
    res.json(state);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/agent/preferences/:memberId', async (req, res) => {
  try {
    await engine.memoryManager.updateUserPreferences(req.params.memberId, req.body);
    const prefs = await engine.memoryManager.getUserPreferences(req.params.memberId);
    res.json(prefs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/agent/tools', (req, res) => {
  res.json(engine.toolRegistry.getSchemas());
});

app.get('/api/agent/stats', (req, res) => {
  res.json(engine.getStats());
});

app.get('/api/agent/wechat/status', (req, res) => {
  if (!wechatBot) {
    return res.json({ enabled: false, running: false, bindings: 0 });
  }
  res.json({
    enabled: true,
    running: wechatBot.running,
    bindings: wechatBot.bindings.size
  });
});

app.post('/api/agent/wechat/bind', (req, res) => {
  if (!wechatBot) return res.status(400).json({ error: 'WeChat bot not initialized' });
  const { wechatUserId, memberId } = req.body;
  if (!wechatUserId || !memberId) return res.status(400).json({ error: '缺少 wechatUserId 或 memberId' });
  wechatBot.bind(wechatUserId, memberId);
  res.json({ success: true });
});

app.post('/api/agent/wechat/unbind', (req, res) => {
  if (!wechatBot) return res.status(400).json({ error: 'WeChat bot not initialized' });
  const { wechatUserId } = req.body;
  if (!wechatUserId) return res.status(400).json({ error: '缺少 wechatUserId' });
  const ok = wechatBot.unbind(wechatUserId);
  res.json({ success: ok });
});

const PORT = process.env.AGENT_PORT || 3001;

server.listen(PORT, () => {
  console.log(`\n🚀 AI Agent 服务启动成功!`);
  console.log(`   地址: http://localhost:${PORT}`);
  console.log(`   WebSocket: ws://localhost:${PORT}`);
  console.log(`   工具数量: ${engine.toolRegistry.count()}`);
  console.log('');
});

module.exports = { app, server, io, engine };