import React, { useState } from 'react';
import { getFullApiUrl } from '../apiConfig';
import FeedbackCard from './FeedbackCard';

const MOODS = ['😊', '😂', '😐', '😤', '😢', '💪', '🥱', '😰'];
const TAG_GROUPS = [
  { label: '体能状态', tags: ['精力充沛', '正常', '疲惫', '酸痛', '受伤'] },
  { label: '学习状态', tags: ['收获很大', '正常', '跟不上', '没学进去'] },
  { label: '社交状态', tags: ['很融洽', '正常', '有小摩擦', '感到孤立'] },
  { label: '情绪底色', tags: ['积极', '平静', '低落', '烦躁', '焦虑'] },
  { label: '压力源', tags: ['考核临近', '人际矛盾', '想家', '学业压力', '无'] },
];

export default function DailyCheckinModal({ memberId, memberName, isAdmin, onClose, onSwitchToAgent }) {
  const [mood, setMood] = useState(null);
  const [tags, setTags] = useState([]);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [notifySent, setNotifySent] = useState(false);

  const today = new Date().toISOString().substring(0, 10);
  const hasCheckedIn = localStorage.getItem(`checkin_${memberId}_${today}`) === 'done';

  const toggleTag = (tag) => {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const handleSubmit = async () => {
    if (!mood && tags.length === 0 && !text.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(getFullApiUrl('/api/checkin/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, type: 'checkin', mood, tags, text: text.trim(), isAdmin: isAdmin || false })
      });
      const data = await res.json();
      setFeedback(data);
      localStorage.setItem(`checkin_${memberId}_${today}`, 'done');
    } catch (e) {
      console.error('Checkin failed:', e);
    }
    setSubmitting(false);
  };

  const handleNotifyAdmin = async (anonymous) => {
    try {
      await fetch(getFullApiUrl('/api/checkin/notify-admin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, text: text.trim(), feedback: feedback?.feedback, anonymous })
      });
      setNotifySent(true);
    } catch (e) { console.error(e); }
  };

  const handleChatWithAI = () => {
    const ctx = { type: 'checkin', text: text.trim(), mood, tags, feedback: feedback?.feedback };
    onClose();
    onSwitchToAgent?.(ctx);
  };

  if (hasCheckedIn && !feedback) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 text-center" onClick={e => e.stopPropagation()}>
          <div className="text-5xl mb-3">✅</div>
          <div className="text-lg font-bold text-gray-800 mb-2">今日已记录</div>
          <div className="text-sm text-gray-500">每一天的记录都在帮你认识自己</div>
          <button onClick={onClose} className="mt-4 px-6 py-2 rounded-xl bg-blue-500 text-white text-sm font-medium hover:bg-blue-600 transition-colors">关闭</button>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-800">每日速记</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl transition-colors">&times;</button>
          </div>
          <div className="text-sm text-gray-500 mb-4">
            {memberName}，今天过得怎么样？
          </div>

          {!feedback ? (
            <>
              {/* Mood selection */}
              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-2 block">今日心情</label>
                <div className="flex gap-2 flex-wrap">
                  {MOODS.map(m => (
                    <button key={m} onClick={() => setMood(m === mood ? null : m)}
                      className={`w-11 h-11 rounded-xl text-xl flex items-center justify-center transition-all ${
                        mood === m
                          ? 'bg-blue-100 border-2 border-blue-400 shadow-sm'
                          : 'bg-gray-50 border-2 border-transparent hover:bg-gray-100'
                      }`}
                    >{m}</button>
                  ))}
                </div>
              </div>

              {/* Tag groups */}
              {TAG_GROUPS.map(group => (
                <div key={group.label} className="mb-3">
                  <label className="text-xs text-gray-400 mb-1.5 block">{group.label}</label>
                  <div className="flex gap-1.5 flex-wrap">
                    {group.tags.map(tag => (
                      <button key={tag} onClick={() => toggleTag(tag)}
                        className={`px-2.5 py-1 rounded-full text-xs transition-all ${
                          tags.includes(tag)
                            ? 'bg-blue-100 border border-blue-300 text-blue-700 font-medium'
                            : 'bg-gray-50 border border-gray-100 text-gray-500 hover:bg-gray-100'
                        }`}
                      >{tag}</button>
                    ))}
                  </div>
                </div>
              ))}

              {/* One sentence */}
              <div className="mb-4">
                <textarea value={text} onChange={e => setText(e.target.value)}
                  placeholder="补充一句话（选填）"
                  rows={2}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 text-sm resize-none outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 font-sans transition-colors"
                />
              </div>

              <button onClick={handleSubmit} disabled={submitting}
                className="w-full py-3 rounded-xl font-medium text-white text-sm transition-all bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 disabled:cursor-default"
              >
                {submitting ? '正在分析...' : '完成记录'}
              </button>
            </>
          ) : (
            <>
              <div className="text-center py-3">
                <div className="text-3xl mb-2">✨</div>
              </div>
              <FeedbackCard
                feedback={feedback.feedback}
                feedbackTier={feedback.feedbackTier}
                anomalyDetected={feedback.anomalyDetected}
                anomalySignals={feedback.anomalySignals}
                onNotifyAdmin={handleNotifyAdmin}
                onChatWithAI={handleChatWithAI}
                notifySent={notifySent}
              />
              <button onClick={onClose}
                className="w-full mt-4 py-2.5 rounded-xl text-sm text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors"
              >关闭</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
