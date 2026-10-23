import React, { useState } from 'react';
import { getFullApiUrl } from '../apiConfig';
import FeedbackCard from './FeedbackCard';

const WEEKLY_PROMPTS = [
  '这周最大的变化是___',
  '这周最开心的一件事是___',
  '这周有没有觉得"比上周进步了"的地方？',
  '这周你最感谢谁？为什么？',
  '这周有没有哪个瞬间让你觉得"做对了"？',
  '这周有没有什么想做但没做成的事？',
  '这周学到的新东西里，哪个最有用？',
  '这周和战友关系有什么变化吗？',
  '这周的身体状态怎么样？训练有进步吗？',
  '这周最有成就感的一件事是什么？',
];

function getWeeklyPrompt(memberId) {
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const idx = (weekNum + (memberId || '').length) % WEEKLY_PROMPTS.length;
  return WEEKLY_PROMPTS[idx];
}

export default function WeeklyNote({ memberId, onClose, onSwitchToAgent }) {
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [notifySent, setNotifySent] = useState(false);

  const today = new Date().toISOString().substring(0, 10);
  const hasWritten = typeof window !== 'undefined' && localStorage.getItem(`weeknote_${memberId}_${today}`) === 'done';
  const prompt = getWeeklyPrompt(memberId);

  const handleSubmit = async () => {
    if (!text.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(getFullApiUrl('/api/checkin/feedback'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, type: 'weeknote', text: text.trim() })
      });
      const data = await res.json();
      setFeedback(data);
      if (typeof window !== 'undefined') localStorage.setItem(`weeknote_${memberId}_${today}`, 'done');
    } catch (e) { console.error(e); }
    setSubmitting(false);
  };

  const handleNotifyAdmin = async (anonymous) => {
    try {
      await fetch(getFullApiUrl('/api/checkin/notify-admin'), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({memberId,text:text.trim(),feedback:feedback?.feedback,anonymous})
      });
      setNotifySent(true);
    } catch(e){}
  };

  const handleChatWithAI = () => {
    const ctx = { type: 'weeknote', text: text.trim(), feedback: feedback?.feedback };
    onClose();
    onSwitchToAgent?.(ctx);
  };

  if (hasWritten && !feedback) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 text-center" onClick={e=>e.stopPropagation()}>
          <div className="text-5xl mb-3">📝</div>
          <div className="text-lg font-bold text-gray-800 mb-2">本周已记录</div>
          <div className="text-sm text-gray-500">每个周末的回顾，都是给自己的礼物</div>
          <button onClick={onClose} className="mt-4 px-6 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors">关闭</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-800">一句话周记</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl transition-colors">&times;</button>
          </div>

          {!feedback ? (
            <>
              <p className="text-sm text-gray-500 mb-4">评分完了，花10秒回顾这一周</p>
              <div className="p-3.5 rounded-xl mb-3 bg-violet-50 border border-violet-200 text-sm text-violet-700">
                💡 {prompt}
              </div>
              <textarea value={text} onChange={e=>setText(e.target.value)}
                placeholder="一句话就好..."
                rows={2}
                className="w-full px-3.5 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 text-sm resize-none outline-none focus:border-violet-300 focus:ring-1 focus:ring-violet-200 font-sans transition-colors"
              />
              <button onClick={handleSubmit} disabled={submitting||!text.trim()}
                className="w-full py-3 mt-3 rounded-xl font-medium text-white text-sm transition-all bg-violet-500 hover:bg-violet-600 disabled:bg-gray-300 disabled:cursor-default"
              >
                {submitting?'正在生成...':'提交周记'}
              </button>
            </>
          ) : (
            <>
              <div className="text-center py-3"><div className="text-3xl mb-2">📋</div></div>
              <FeedbackCard feedback={feedback.feedback} feedbackTier={feedback.feedbackTier}
                anomalyDetected={feedback.anomalyDetected} anomalySignals={feedback.anomalySignals}
                onNotifyAdmin={handleNotifyAdmin} onChatWithAI={handleChatWithAI} notifySent={notifySent} />
              <button onClick={onClose} className="w-full mt-4 py-2.5 rounded-xl text-sm text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors">关闭</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
