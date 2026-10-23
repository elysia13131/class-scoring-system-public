import React, { useState, useRef, useEffect, useCallback } from 'react';
import { io } from 'socket.io-client';
import * as echarts from 'echarts';
import { getSocketUrl, getFullApiUrl } from '../../apiConfig';
import ChartRenderer from './ChartRenderer';
import InteractiveForm from './InteractiveForm';
import ParticleBackground from './ParticleBackground';

function parseMarkdown(text) {
  if (!text) return '';
  let html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.*$)/gm, '<h3 class="text-base font-bold mt-3 mb-1 text-gray-800">$1</h3>')
    .replace(/^## (.*$)/gm, '<h2 class="text-lg font-bold mt-4 mb-2 text-gray-800">$1</h2>')
    .replace(/^# (.*$)/gm, '<h1 class="text-xl font-bold mt-4 mb-2 text-gray-900">$1</h1>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/`(.*?)`/g, '<code class="px-1.5 py-0.5 bg-indigo-50 rounded text-sm font-mono text-indigo-700">$1</code>')
    .replace(/```([\s\S]*?)```/g, (_, code) => `<pre class="my-2 p-3 bg-slate-800 text-emerald-400 rounded-lg text-xs overflow-x-auto font-mono leading-relaxed"><code>${code.trim()}</code></pre>`)
    .replace(/^> (.*$)/gm, '<blockquote class="border-l-3 border-indigo-400 pl-3 my-1 text-slate-500 italic">$1</blockquote>')
    .replace(/^- (.*$)/gm, '<li class="ml-4 list-disc text-slate-600">$1</li>')
    .replace(/^(\d+)\. (.*$)/gm, '<li class="ml-4 list-decimal text-slate-600">$2</li>')
    .replace(/\n\n/g, '</p><p class="mt-2">')
    .replace(/\n/g, '<br/>');
  return `<p class="leading-relaxed">${html}</p>`;
}

const EXPORT_SUGGESTIONS = ['导出为图片', '导出图片', '导出图表', '保存图片', '下载图片'];

function buildContextMessage(ctx) {
  if (!ctx) return null;
  const { type, text, mood, tags, feedback, question } = ctx;
  const parts = [];
  if (type === 'checkin') {
    parts.push(`我刚填写了每日速记：${text || ''}`);
    if (mood) parts.push(`心情是${mood}`);
    if (tags?.length) parts.push(`选择了标签：${tags.join('、')}`);
  } else if (type === 'question') {
    parts.push(`我回答了每日一问"${question || ''}"：${text || ''}`);
  } else if (type === 'weeknote') {
    parts.push(`我提交了一句话周记：${text || ''}`);
  }
  parts.push(`AI给我的反馈是：${feedback || ''}`);
  parts.push('你觉得呢？能帮我再深入分析一下吗？');
  return parts.join('\n');
}

const ChatContainer = ({ memberId, isAdmin: initialIsAdmin = false, onBack, initialContext }) => {
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [isThinking, setIsThinking] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [isAdmin, setIsAdmin] = useState(initialIsAdmin);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolCallCount, setToolCallCount] = useState(0);
  const [activeForm, setActiveForm] = useState(null);
  const [members, setMembers] = useState([]);
  const [toast, setToast] = useState(null);
  const [mounted, setMounted] = useState(false);
  const messagesEndRef = useRef(null);
  const socketRef = useRef(null);
  const chartRefs = useRef({});
  const timeoutRef = useRef(null);

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2500);
  }, []);

  const clearTimeout_ = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    setMounted(true);
    return () => { document.body.style.overflow = ''; };
  }, []);

  useEffect(() => {
    const socketUrl = getSocketUrl();

    console.log('Connecting to socket:', socketUrl);
    socketRef.current = io(socketUrl, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });
    const socket = socketRef.current;

    socket.on('connect', () => {
      console.log('✅ Socket connected');
      setIsThinking(false);
    });

    socket.on('disconnect', (reason) => {
      console.log('❌ Socket disconnected:', reason);
    });

    socket.on('connect_error', (error) => {
      console.log('❌ Socket connection error:', error.message);
    });

    socket.on('error', (error) => {
      console.log('❌ Socket error:', error);
    });

    socket.on('agent:response', (response) => {
      clearTimeout_();
      setMessages(prev => [...prev, { ...response, role: 'assistant', timestamp: new Date() }]);
      setIsThinking(false);
      setIsStreaming(false);
      if (response.sessionId) setSessionId(response.sessionId);
      if (response.toolResults?.length > 0) {
        response.toolResults.forEach(tool => {
          if (tool.isForm || tool.data?.type === 'form') {
            setActiveForm({
              formType: tool.data.formType,
              formSchema: tool.data.formSchema,
              tool: tool.data.submitAction || tool.tool
            });
          } else if (tool.data?.config) {
            setMessages(prev => [...prev, { type: 'chart', chartConfig: tool.data.config, role: 'system', timestamp: new Date() }]);
          }
        });
      }
    });

    socket.on('agent:error', (error) => {
      clearTimeout_();
      setMessages(prev => [...prev, { content: error.message || error.error || '发生错误', role: 'error', timestamp: new Date() }]);
      setIsThinking(false);
      setIsStreaming(false);
      setStreamingContent('');
    });

    socket.on('agent:stream:error', (error) => {
      clearTimeout_();
      console.log('❌ Stream error:', error);
      setMessages(prev => prev.filter(msg => !msg.streaming));
      setMessages(prev => [...prev, { content: error.error || error.message || '处理失败，请重试', role: 'error', timestamp: new Date() }]);
      setIsThinking(false);
      setIsStreaming(false);
      setStreamingContent('');
    });

    socket.on('agent:stream:tool_result', (data) => {
      console.log('📦 Tool result received:', data.tool, data.result?.success);
    });

    socket.on('agent:stream:start', (data) => {
      clearTimeout_();
      setIsStreaming(true);
      setStreamingContent('');
      setIsThinking(false);
      if (data?.sessionId) setSessionId(data.sessionId);

      setMessages(prev => [...prev, {
        id: `stream-${Date.now()}`,
        role: 'assistant',
        content: '',
        streaming: true,
        timestamp: new Date()
      }]);
    });

    socket.on('agent:stream:token', ({ content }) => {
      setStreamingContent(prev => prev + content);
      setMessages(prev => {
        const hasStreaming = prev.some(msg => msg.streaming);
        if (!hasStreaming) {
          return [...prev, {
            id: `stream-${Date.now()}`,
            role: 'assistant',
            content,
            streaming: true,
            timestamp: new Date()
          }];
        }
        return prev.map(msg =>
          msg.streaming ? { ...msg, content: (msg.content || '') + content } : msg
        );
      });
    });

    socket.on('agent:stream:done', (response) => {
      clearTimeout_();
      setIsStreaming(false);
      setStreamingContent('');
      setToolCallCount(0);
      setMessages(prev => prev.map(msg =>
        msg.streaming ? { ...msg, streaming: false, ...response, toolResults: undefined } : msg
      ));
      if (response.toolResults?.length > 0) {
        response.toolResults.forEach(tool => {
          if (tool.isForm || tool.data?.type === 'form') {
            setActiveForm({
              formType: tool.data.formType,
              formSchema: tool.data.formSchema,
              tool: tool.data.submitAction || tool.tool
            });
          }
        });
      }
    });

    socket.on('agent:stream:tool_call', ({ tools }) => {
      setStreamingContent('');
      setToolCallCount(c => c + (tools?.length || 1));
    });

    socket.on('agent:stream:chart', ({ config }) => {
      setMessages(prev => [...prev, { type: 'chart', chartConfig: config, role: 'system', timestamp: new Date() }]);
    });

    socket.on('agent:stream:form', ({ formType, formSchema, tool }) => {
      clearTimeout_();
      setIsStreaming(false);
      setIsThinking(false);
      setStreamingContent('');
      setActiveForm({ formType, formSchema, tool });
      setMessages(prev => prev.filter(msg => !msg.streaming));
    });

    socket.on('agent:stream:thinking', () => {
      // Thinking phase between tool rounds (tracked by tool call counter)
    });

    socket.on('agent:form:result', (result) => {
      if (result.success) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: result.message || '操作成功！',
          timestamp: new Date()
        }]);
      } else {
        setMessages(prev => [...prev, {
          role: 'error',
          content: `${result.error || result.message || '操作失败'}`,
          timestamp: new Date()
        }]);
      }
      setActiveForm(null);
    });

    return () => { socket.disconnect(); };
  }, []);

  useEffect(() => {
    if (initialContext && socketRef.current?.connected) {
      const ctxMsg = buildContextMessage(initialContext);
      if (ctxMsg) {
        setMessages([{ content: ctxMsg, role: 'system', type: 'context_note', timestamp: new Date() }]);
        setTimeout(() => {
          socketRef.current.emit('agent:chat', { memberId, message: ctxMsg, sessionId, context: { isAdmin } });
        }, 300);
      }
    }
  }, [initialContext?.type]);

  useEffect(() => {
    if (messagesEndRef.current) messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingContent, activeForm]);

  useEffect(() => {
    const fetchMembers = async () => {
      try {
        const res = await fetch(getFullApiUrl('/api/members'));
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data.members || []);
        setMembers(list.map(m => ({ id: String(m.id || m.memberId || ''), name: m.name || m.nickname || '' })).filter(m => m.id));
      } catch (e) {
        console.warn('获取成员列表失败:', e);
      }
    };
    fetchMembers();
  }, []);

  const sendMessage = useCallback((text) => {
    const content = (text || inputValue).trim();
    if (!content || !socketRef.current) return;

    setMessages(prev => [...prev, { content, role: 'user', timestamp: new Date() }]);
    if (!text) setInputValue('');
    setIsThinking(true);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setIsThinking(false);
      setIsStreaming(false);
      setStreamingContent('');
      setMessages(prev => [...prev, { content: '请求超时，请检查网络连接后重试', role: 'error', timestamp: new Date() }]);
    }, 30000);

    socketRef.current.emit('agent:chat', { memberId, message: content, sessionId, context: { isAdmin } });
  }, [inputValue, memberId, sessionId, isAdmin]);

  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  const handleFormSubmit = useCallback((formData) => {
    if (!socketRef.current || !activeForm) return;

    const toolName = activeForm.tool;
    let params = { action: 'submit' };

    if (activeForm.formType === 'mood_record') {
      params = {
        action: 'submit',
        moodTag: formData.moodTag,
        selfAssessment: formData.selfAssessment,
        positiveNominations: formData.positiveNominations,
        negativeNominations: formData.negativeNominations
      };
    } else if (activeForm.formType === 'score_submit') {
      params = {
        action: 'submit',
        memberId: formData.targetMemberId || memberId,
        evaluatorId: memberId,
        week: formData.week,
        type: formData.scoreType,
        subItemScores: formData.subItemScores
      };
    }

    socketRef.current.emit('agent:form:submit', {
      tool: toolName,
      params,
      memberId,
      isAdmin,
      sessionId
    });

    setMessages(prev => [...prev, {
      role: 'system',
      type: 'form_submitting',
      content: activeForm.formType === 'mood_record' ? '正在提交心情记录...' : '正在提交评分...',
      timestamp: new Date()
    }]);
  }, [activeForm, memberId, isAdmin, sessionId]);

  const handleFormCancel = useCallback(() => {
    setActiveForm(null);
  }, []);

  const handleSuggestionClick = useCallback((suggestion) => {
    if (EXPORT_SUGGESTIONS.includes(suggestion)) {
      const chartMsgIdx = [...messages].reverse().findIndex(m => m.type === 'chart');
      if (chartMsgIdx === -1) {
        showToast('没有可导出的图表', 'error');
        return;
      }

      const realIdx = messages.length - 1 - chartMsgIdx;
      const chartMsg = messages[realIdx];
      const chartEl = document.querySelectorAll('.echart-container');
      const targetEl = chartEl[chartEl.length - 1];

      if (targetEl) {
        try {
          const instance = echarts.getInstanceByDom(targetEl);
          if (instance) {
            const dataURL = instance.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: '#fff' });
            const link = document.createElement('a');
            link.href = dataURL;
            const title = chartMsg?.chartConfig?.title?.text || 'chart';
            link.download = `${title}_${Date.now()}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            showToast('图片导出成功！', 'success');
            return;
          }
        } catch (e) {
          console.error('Export from suggestion failed:', e);
        }
      }

      const refKey = `chart-${realIdx}`;
      if (chartRefs.current[refKey]) {
        chartRefs.current[refKey].exportPNG();
        showToast('图片导出成功！', 'success');
        return;
      }

      showToast('图表实例未找到，请使用图表右上角导出按钮', 'error');
      return;
    }

    sendMessage(suggestion);
  }, [messages, sendMessage, showToast]);

  const quickSuggestion = (text) => { setInputValue(text); };

  const setChartRef = useCallback((idx) => (el) => {
    if (el) chartRefs.current[`chart-${idx}`] = el;
  }, []);

  return (
    <div className="chat-root" style={{ height: '100vh', overflow: 'hidden' }}>
      <ParticleBackground color="99, 102, 241" particleCount={30} speed={0.15} linkDistance={80} />

      <div className="chat-header glass-panel">
        {onBack && (
          <button onClick={onBack} className="header-back-btn" title="返回">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
        )}
        <div className="header-icon-wrap">
          <div className="header-icon-inner">AI</div>
          <div className="header-icon-ring" />
        </div>
        <div>
          <h1 className="header-title">智能助手</h1>
          <p className="header-subtitle">DeepSeek AI · 实时对话</p>
        </div>
        <div className="header-status">
          <span className="status-dot" />
          <span className="status-text">在线</span>
        </div>
      </div>

      <div className="chat-messages" style={{ minHeight: 0 }}>
        {messages.length === 0 && !activeForm && (
          <div className={`welcome-section ${mounted ? 'welcome-visible' : ''}`}>
            <div className="welcome-orb">
              <div className="orb-core" />
              <div className="orb-ring orb-ring-1" />
              <div className="orb-ring orb-ring-2" />
              <div className="orb-ring orb-ring-3" />
            </div>
            <p className="welcome-title">你好！我是AI智能助手</p>
            <p className="welcome-desc">可以帮你查询成绩、分析数据、管理信息</p>
            <div className="welcome-chips">
              {['查看我的本周评分', '生成雷达图分析', '填写心情记录', '填写评分'].map((s, i) => (
                <button key={i} onClick={() => quickSuggestion(s)}
                  className="welcome-chip"
                  style={{ animationDelay: `${0.1 + i * 0.08}s` }}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg, idx) => (
          <MessageBubble
            key={msg.id || idx}
            message={msg}
            messageIndex={idx}
            onSuggestionClick={handleSuggestionClick}
            chartRef={msg.type === 'chart' ? setChartRef(idx) : undefined}
          />
        ))}

        {activeForm && (
          <div className="flex justify-center my-2" style={{ position: 'relative', zIndex: 1 }}>
            <InteractiveForm
              formSchema={activeForm.formSchema}
              formType={activeForm.formType}
              onSubmit={handleFormSubmit}
              onCancel={handleFormCancel}
              members={members}
            />
          </div>
        )}

        {toolCallCount > 0 && (
          <div className="tool-counter-bar">
            <span className="tool-counter-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
              <span className="tool-counter-label">已调用 </span>
              <span className="tool-counter-digits">
                <span className="tool-digit" key={toolCallCount}>{toolCallCount}</span>
              </span>
              <span className="tool-counter-label"> 次工具</span>
            </span>
          </div>
        )}

        {(isThinking && !isStreaming) && (
          <div className="thinking-bubble">
            <div className="thinking-avatar">AI</div>
            <div className="thinking-dots glass-panel">
              <span className="dot dot-1" />
              <span className="dot dot-2" />
              <span className="dot dot-3" />
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      <div className="chat-footer glass-panel">
        <div className="footer-input-row">
          <textarea value={inputValue} onChange={(e) => setInputValue(e.target.value)} onKeyPress={handleKeyPress}
            placeholder="输入你的问题... (Enter发送，Shift+Enter换行)" rows={2}
            className="footer-textarea"
            disabled={isThinking || isStreaming} />
          <button onClick={() => sendMessage()} disabled={isThinking || isStreaming || !inputValue.trim()}
            className="footer-send-btn">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
        <div className="footer-chips">
          {['查看本周评分', '生成雷达图', '填写心情记录', '填写评分'].map((s, i) => (
            <button key={i} onClick={() => quickSuggestion(s)} className="footer-chip">{s}</button>
          ))}
        </div>
      </div>

      {toast && (
        <div className={`toast toast-${toast.type}`}>
          {toast.type === 'success' ? '✓' : toast.type === 'error' ? '✗' : 'ℹ'} {toast.msg}
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap');

        .chat-root {
          display: flex;
          flex-direction: column;
          height: 100vh;
          overflow: hidden;
          background: linear-gradient(135deg, #f8faff 0%, #eef2ff 40%, #e8ecf8 100%);
          font-family: 'Noto Sans SC', system-ui, sans-serif;
          color: #1e293b;
          position: relative;
        }

        .glass-panel {
          background: rgba(255, 255, 255, 0.7);
          backdrop-filter: blur(20px);
          -webkit-backdrop-filter: blur(20px);
          border: 1px solid rgba(99, 102, 241, 0.08);
        }

        .chat-header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 20px;
          border-bottom: 1px solid rgba(99, 102, 241, 0.08);
          flex-shrink: 0;
          position: relative;
          z-index: 2;
        }

        .header-icon-wrap {
          position: relative;
          width: 36px;
          height: 36px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .header-back-btn {
          width: 36px;
          height: 36px;
          border-radius: 10px;
          background: rgba(99, 102, 241, 0.06);
          border: 1px solid rgba(99, 102, 241, 0.12);
          color: #6366f1;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: all 0.2s ease;
          flex-shrink: 0;
        }

        .header-back-btn:hover {
          background: rgba(99, 102, 241, 0.12);
          color: #4f46e5;
          border-color: rgba(99, 102, 241, 0.25);
        }

        .header-icon-inner {
          width: 36px;
          height: 36px;
          border-radius: 10px;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 13px;
          font-weight: 700;
          position: relative;
          z-index: 1;
        }

        .header-icon-ring {
          position: absolute;
          inset: -4px;
          border-radius: 14px;
          border: 2px solid rgba(99, 102, 241, 0.2);
          animation: ring-pulse 3s ease-in-out infinite;
        }

        @keyframes ring-pulse {
          0%, 100% { transform: scale(1); opacity: 0.3; }
          50% { transform: scale(1.15); opacity: 0; }
        }

        .header-title {
          font-size: 15px;
          font-weight: 600;
          color: #1e293b;
          letter-spacing: 0.5px;
        }

        .header-subtitle {
          font-size: 11px;
          color: #94a3b8;
          margin-top: 1px;
        }

        .header-status {
          margin-left: auto;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .status-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #22c55e;
          box-shadow: 0 0 8px rgba(34, 197, 94, 0.4);
          animation: status-blink 2s ease-in-out infinite;
        }

        @keyframes status-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        .status-text {
          font-size: 11px;
          color: #22c55e;
          font-weight: 500;
        }

        .chat-messages {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          position: relative;
          z-index: 1;
        }

        .chat-messages::-webkit-scrollbar {
          width: 4px;
        }
        .chat-messages::-webkit-scrollbar-track {
          background: transparent;
        }
        .chat-messages::-webkit-scrollbar-thumb {
          background: rgba(99, 102, 241, 0.2);
          border-radius: 4px;
        }

        .welcome-section {
          text-align: center;
          padding: 40px 20px;
          opacity: 0;
          transform: translateY(20px);
          transition: all 0.8s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .welcome-visible {
          opacity: 1;
          transform: translateY(0);
        }

        .welcome-orb {
          position: relative;
          width: 80px;
          height: 80px;
          margin: 0 auto 24px;
        }

        .orb-core {
          position: absolute;
          inset: 15px;
          border-radius: 50%;
          background: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
          box-shadow: 0 0 30px rgba(99, 102, 241, 0.25), 0 0 60px rgba(139, 92, 246, 0.1);
          animation: orb-float 4s ease-in-out infinite;
        }

        @keyframes orb-float {
          0%, 100% { transform: translateY(0) scale(1); }
          50% { transform: translateY(-6px) scale(1.05); }
        }

        .orb-ring {
          position: absolute;
          border-radius: 50%;
          border: 1px solid rgba(99, 102, 241, 0.15);
        }

        .orb-ring-1 {
          inset: 0;
          animation: orb-ring-spin 8s linear infinite;
        }

        .orb-ring-2 {
          inset: -10px;
          animation: orb-ring-spin 12s linear infinite reverse;
          border-color: rgba(139, 92, 246, 0.1);
        }

        .orb-ring-3 {
          inset: -20px;
          animation: orb-ring-spin 16s linear infinite;
          border-color: rgba(167, 139, 250, 0.08);
        }

        @keyframes orb-ring-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        .welcome-title {
          font-size: 20px;
          font-weight: 600;
          color: #1e293b;
          margin-bottom: 6px;
        }

        .welcome-desc {
          font-size: 13px;
          color: #94a3b8;
          margin-bottom: 24px;
        }

        .welcome-chips {
          display: flex;
          flex-wrap: wrap;
          justify-content: center;
          gap: 8px;
          max-width: 420px;
          margin: 0 auto;
        }

        .welcome-chip {
          padding: 8px 16px;
          background: rgba(99, 102, 241, 0.06);
          border: 1px solid rgba(99, 102, 241, 0.15);
          border-radius: 20px;
          color: #6366f1;
          font-size: 12px;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          opacity: 0;
          animation: chip-in 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }

        .welcome-chip:hover {
          background: rgba(99, 102, 241, 0.12);
          border-color: rgba(99, 102, 241, 0.3);
          color: #4f46e5;
          transform: translateY(-2px);
          box-shadow: 0 4px 15px rgba(99, 102, 241, 0.1);
        }

        @keyframes chip-in {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .msg-row {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          animation: msg-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .msg-row-user {
          flex-direction: row-reverse;
        }

        @keyframes msg-in {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }

        .msg-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-weight: 600;
          flex-shrink: 0;
        }

        .msg-avatar-ai {
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: white;
          box-shadow: 0 2px 10px rgba(99, 102, 241, 0.2);
        }

        .msg-avatar-user {
          background: linear-gradient(135deg, #3b82f6, #2563eb);
          color: white;
          box-shadow: 0 2px 10px rgba(59, 130, 246, 0.2);
        }

        .msg-bubble {
          max-width: 80%;
          padding: 10px 14px;
          border-radius: 16px;
          font-size: 13px;
          line-height: 1.6;
          position: relative;
        }

        .msg-bubble-ai {
          background: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(99, 102, 241, 0.08);
          color: #334155;
          border-top-left-radius: 4px;
          box-shadow: 0 1px 6px rgba(0, 0, 0, 0.04);
        }

        .msg-bubble-user {
          background: linear-gradient(135deg, #4f46e5, #6366f1);
          color: white;
          border-top-right-radius: 4px;
          box-shadow: 0 2px 12px rgba(79, 70, 229, 0.2);
        }

        .msg-bubble-error {
          background: rgba(239, 68, 68, 0.06);
          border: 1px solid rgba(239, 68, 68, 0.15);
          color: #dc2626;
          border-top-left-radius: 4px;
        }

        .msg-system-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 14px;
          border-radius: 20px;
          font-size: 11px;
          font-weight: 500;
        }

        .badge-tool {
          background: rgba(99, 102, 241, 0.06);
          color: #6366f1;
          border: 1px solid rgba(99, 102, 241, 0.12);
        }

        .badge-thinking {
          background: rgba(168, 85, 247, 0.06);
          color: #7c3aed;
          border: 1px solid rgba(168, 85, 247, 0.1);
        }

        .badge-submit {
          background: rgba(34, 197, 94, 0.06);
          color: #16a34a;
          border: 1px solid rgba(34, 197, 94, 0.1);
        }

        .badge-submit .pulse-icon {
          animation: pulse-glow 1.5s ease-in-out infinite;
        }

        .tool-counter-bar {
          display: flex;
          justify-content: center;
          margin: 6px 0;
        }

        .tool-counter-badge {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 16px;
          border-radius: 20px;
          background: rgba(99, 102, 241, 0.08);
          color: #818cf8;
          border: 1px solid rgba(99, 102, 241, 0.15);
          font-size: 12px;
          font-weight: 500;
          animation: none;
        }

        .tool-counter-badge svg {
          flex-shrink: 0;
          animation: tool-counter-spin 2s linear infinite;
        }

        .tool-counter-label {
          opacity: 0.7;
        }

        .tool-counter-digits {
          display: inline-flex;
          overflow: hidden;
          height: 20px;
          align-items: center;
        }

        .tool-digit {
          font-variant-numeric: tabular-nums;
          font-weight: 700;
          font-size: 16px;
          color: #a5b4fc;
          animation: tool-digit-roll 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        @keyframes tool-counter-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        @keyframes tool-digit-roll {
          0% { transform: translateY(60%); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }

        @keyframes pulse-glow {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }

        .chart-card {
          width: 100%;
          max-width: 640px;
          margin: 0 auto;
          background: rgba(255, 255, 255, 0.85);
          backdrop-filter: blur(12px);
          border: 1px solid rgba(99, 102, 241, 0.08);
          border-radius: 14px;
          padding: 12px;
          animation: msg-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
          box-shadow: 0 1px 6px rgba(0, 0, 0, 0.04);
        }

        .thinking-bubble {
          display: flex;
          align-items: flex-start;
          gap: 10px;
          animation: msg-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        }

        .thinking-avatar {
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          display: flex;
          align-items: center;
          justify-content: center;
          color: white;
          font-size: 11px;
          font-weight: 600;
          flex-shrink: 0;
          box-shadow: 0 2px 10px rgba(99, 102, 241, 0.2);
        }

        .thinking-dots {
          padding: 12px 16px;
          border-radius: 16px;
          border-top-left-radius: 4px;
          display: flex;
          gap: 5px;
          background: rgba(255, 255, 255, 0.7);
          border: 1px solid rgba(99, 102, 241, 0.08);
        }

        .dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: #6366f1;
        }

        .dot-1 { animation: dot-bounce 1.4s ease-in-out infinite; }
        .dot-2 { animation: dot-bounce 1.4s ease-in-out 0.15s infinite; }
        .dot-3 { animation: dot-bounce 1.4s ease-in-out 0.3s infinite; }

        @keyframes dot-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-8px); opacity: 1; }
        }

        .chat-footer {
          padding: 14px 16px;
          border-top: 1px solid rgba(99, 102, 241, 0.08);
          flex-shrink: 0;
          position: relative;
          z-index: 2;
        }

        .footer-input-row {
          display: flex;
          align-items: flex-end;
          gap: 10px;
        }

        .footer-textarea {
          flex: 1;
          resize: none;
          padding: 10px 14px;
          background: rgba(255, 255, 255, 0.8);
          border: 1px solid rgba(99, 102, 241, 0.12);
          border-radius: 12px;
          color: #1e293b;
          font-size: 13px;
          font-family: inherit;
          line-height: 1.5;
          outline: none;
          transition: all 0.3s ease;
        }

        .footer-textarea:focus {
          border-color: rgba(99, 102, 241, 0.35);
          box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.08);
          background: rgba(255, 255, 255, 0.95);
        }

        .footer-textarea::placeholder {
          color: #94a3b8;
        }

        .footer-textarea:disabled {
          opacity: 0.5;
        }

        .footer-send-btn {
          width: 42px;
          height: 42px;
          border-radius: 12px;
          background: linear-gradient(135deg, #6366f1, #8b5cf6);
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          border: none;
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          flex-shrink: 0;
        }

        .footer-send-btn:hover:not(:disabled) {
          transform: scale(1.05);
          box-shadow: 0 4px 15px rgba(99, 102, 241, 0.3);
        }

        .footer-send-btn:active:not(:disabled) {
          transform: scale(0.95);
        }

        .footer-send-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .footer-chips {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 8px;
        }

        .footer-chip {
          padding: 4px 10px;
          background: rgba(99, 102, 241, 0.04);
          border: 1px solid rgba(99, 102, 241, 0.1);
          border-radius: 14px;
          color: #6366f1;
          font-size: 11px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .footer-chip:hover {
          background: rgba(99, 102, 241, 0.1);
          border-color: rgba(99, 102, 241, 0.2);
          color: #4f46e5;
        }

        .toast {
          position: fixed;
          bottom: 100px;
          left: 50%;
          transform: translateX(-50%);
          padding: 8px 18px;
          border-radius: 12px;
          font-size: 13px;
          font-weight: 500;
          z-index: 100;
          animation: toast-in 0.3s cubic-bezier(0.16, 1, 0.3, 1);
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.1);
        }

        .toast-success { background: rgba(34, 197, 94, 0.9); color: white; }
        .toast-error { background: rgba(239, 68, 68, 0.9); color: white; }
        .toast-info { background: rgba(99, 102, 241, 0.9); color: white; }

        @keyframes toast-in {
          from { opacity: 0; transform: translateX(-50%) translateY(10px); }
          to { opacity: 1; transform: translateX(-50%) translateY(0); }
        }

        .streaming-cursor::after {
          content: '▌';
          animation: pulse-cursor 1s infinite;
          color: #6366f1;
          font-weight: bold;
          margin-left: 2px;
        }

        @keyframes pulse-cursor {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }

        .markdown-content p { margin-bottom: 0.25em; }
        .markdown-content h1, .markdown-content h2, .markdown-content h3 { margin-top: 0.75em; margin-bottom: 0.25em; line-height: 1.3; }
        .markdown-content ul, .markdown-content ol { padding-left: 1em; margin: 0.25em 0; }
        .markdown-content li { margin: 0.15em 0; }
        .markdown-content blockquote { margin: 0.5em 0; }
        .markdown-content pre { white-space: pre-wrap; word-break: break-word; }
        .markdown-content strong { color: #1e293b; }
        .markdown-content h1, .markdown-content h2, .markdown-content h3 { color: #1e293b; }

        .suggestion-row {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
          margin-top: 6px;
        }

        .suggestion-btn {
          padding: 4px 10px;
          background: rgba(99, 102, 241, 0.06);
          border: 1px solid rgba(99, 102, 241, 0.12);
          border-radius: 14px;
          color: #6366f1;
          font-size: 11px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .suggestion-btn:hover {
          background: rgba(99, 102, 241, 0.12);
          border-color: rgba(99, 102, 241, 0.25);
          transform: translateY(-1px);
        }

        .tool-result-divider {
          margin-top: 6px;
          padding-top: 6px;
          border-top: 1px solid rgba(99, 102, 241, 0.08);
        }

        .tool-result-label {
          font-size: 11px;
          opacity: 0.5;
        }
      `}</style>
    </div>
  );
};

const MessageBubble = ({ message, messageIndex, onSuggestionClick, chartRef }) => {
  const isUser = message.role === 'user';
  const isError = message.role === 'error';

  if (message.type === 'chart') {
    return (
      <div className="chart-card">
        <ChartRenderer ref={chartRef} config={message.chartConfig} height={320} showExport />
      </div>
    );
  }

  if (message.type === 'form_submitting') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
        <span className="msg-system-badge badge-submit">
          <span className="pulse-icon">⏳</span> {message.content}
        </span>
      </div>
    );
  }

  return (
    <div className={`msg-row ${isUser ? 'msg-row-user' : ''}`}>
      {!isUser && (
        <div className="msg-avatar msg-avatar-ai">AI</div>
      )}

      <div className={`msg-bubble ${isUser ? 'msg-bubble-user' : isError ? 'msg-bubble-error' : 'msg-bubble-ai'} ${message.streaming ? 'streaming-cursor' : ''}`}>
        {typeof message.content === 'string' ? (
          <div className="markdown-content" dangerouslySetInnerHTML={{ __html: parseMarkdown(message.content) }} />
        ) : (
          <span>{JSON.stringify(message.content)}</span>
        )}
      </div>

      {isUser && (
        <div className="msg-avatar msg-avatar-user">我</div>
      )}

      {!isUser && message.suggestions?.length > 0 && (
        <div className="suggestion-row" style={{ position: 'relative', zIndex: 1 }}>
          {message.suggestions.map((s, i) => (
            <button key={i} onClick={() => onSuggestionClick?.(s)} className="suggestion-btn">
              {EXPORT_SUGGESTIONS.includes(s) ? '📥' : '→'} {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default ChatContainer;
