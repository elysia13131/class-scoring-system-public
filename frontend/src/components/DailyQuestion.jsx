import React, { useState, useEffect } from 'react';
import { getFullApiUrl } from '../apiConfig';
import FeedbackCard from './FeedbackCard';

const DEFAULT_STUDENT_QUESTION = '今天有什么让你觉得值得记住的事？';
const DEFAULT_ADMIN_QUESTION = '今天你们班最需要你关注的一个学员是谁？为什么？';

export default function DailyQuestion({ memberId, isAdmin: adminMode, adminDeviceId, onClose, onSwitchToAgent }) {
  const [answer, setAnswer] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [notifySent, setNotifySent] = useState(false);
  const [currentQuestion, setCurrentQuestion] = useState('');
  const [questionKey, setQuestionKey] = useState('');
  const [loadingQuestion, setLoadingQuestion] = useState(false);

  const today = new Date().toISOString().substring(0, 10);
  const hasAnswered = questionKey ? localStorage.getItem(`question_${memberId}_${questionKey}`) === 'done' : false;

  useEffect(() => {
    if (currentQuestion || loadingQuestion || hasAnswered) return;
    setLoadingQuestion(true);

    const url = adminMode ? '/api/checkin/admin-question' : '/api/checkin/student-question';
    const body = adminMode 
      ? { adminId: adminDeviceId || memberId }
      : { memberId };

    fetch(getFullApiUrl(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(r => r.json())
      .then(data => {
        setCurrentQuestion(data.question || (adminMode ? DEFAULT_ADMIN_QUESTION : DEFAULT_STUDENT_QUESTION));
        setQuestionKey(data.key || (adminMode ? `aq_${today}` : `sq_${today}`));
      })
      .catch(() => {
        setCurrentQuestion(adminMode ? DEFAULT_ADMIN_QUESTION : DEFAULT_STUDENT_QUESTION);
        setQuestionKey(adminMode ? `aq_${today}` : `sq_${today}`);
      })
      .finally(() => setLoadingQuestion(false));
  }, [adminMode, currentQuestion, loadingQuestion, hasAnswered, adminDeviceId, memberId, today]);

  const handleSubmit = async () => {
    if (!answer.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(getFullApiUrl('/api/checkin/feedback'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, type: 'question', text: answer.trim(), isAdmin: adminMode })
      });
      const data = await res.json();
      setFeedback(data);
      localStorage.setItem(`question_${memberId}_${questionKey}`, 'done');
    } catch (e) { console.error(e); }
    setSubmitting(false);
  };

  const handleNotifyAdmin = async (anonymous) => {
    try {
      await fetch(getFullApiUrl('/api/checkin/notify-admin'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, text: answer.trim(), feedback: feedback?.feedback, anonymous })
      });
      setNotifySent(true);
    } catch (e) { console.error(e); }
  };

  const handleChatWithAI = () => {
    const ctx = { type: 'question', question: currentQuestion, text: answer.trim(), feedback: feedback?.feedback, isAdmin: adminMode };
    onClose();
    onSwitchToAgent?.(ctx);
  };

  const accentColor = adminMode ? 'amber' : 'blue';

  if (hasAnswered && !feedback) {
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6 text-center" onClick={e => e.stopPropagation()}>
          <div className="text-5xl mb-3">✅</div>
          <div className="text-lg font-bold text-gray-800 mb-2">今日已回答</div>
          <div className="text-sm text-gray-500">明天见，新的问题在等你</div>
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
            <h2 className="text-lg font-bold text-gray-800">
              {adminMode ? '管理反思' : '每日一问'}
            </h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl transition-colors">&times;</button>
          </div>
          <div className="text-sm text-gray-500 mb-2">
            {new Date().toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>

          {!feedback ? (
            <>
              <div className={`p-4 rounded-xl mb-4 text-base leading-relaxed border ${
                adminMode 
                  ? 'bg-amber-50 border-amber-200 text-amber-900' 
                  : 'bg-blue-50 border-blue-200 text-blue-900'
              }`}>
                {loadingQuestion ? (
                  <span className="text-gray-500">正在生成你的专属问题...</span>
                ) : (
                  <>{adminMode ? '🎯 ' : '💡 '}{currentQuestion}</>
                )}
              </div>
              <textarea value={answer} onChange={e => setAnswer(e.target.value)}
                placeholder={adminMode ? "写下你的管理思考..." : "说说你的想法..."}
                rows={3}
                className="w-full px-3.5 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 text-sm resize-none outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 font-sans transition-colors"
              />
              <button onClick={handleSubmit} disabled={submitting || !answer.trim()}
                className={`w-full py-3 mt-3 rounded-xl font-medium text-white text-sm transition-all ${
                  submitting || !answer.trim()
                    ? 'bg-gray-300 cursor-default'
                    : adminMode
                      ? 'bg-amber-500 hover:bg-amber-600'
                      : 'bg-blue-500 hover:bg-blue-600'
                }`}
              >
                {submitting ? '正在思考...' : '提交回答'}
              </button>
            </>
          ) : (
            <>
              <div className="text-center py-3">
                <div className="text-3xl mb-2">{adminMode ? '📋' : '💭'}</div>
              </div>
              <FeedbackCard
                feedback={feedback.feedback}
                feedbackTier={feedback.feedbackTier}
                anomalyDetected={feedback.anomalyDetected}
                anomalySignals={feedback.anomalySignals}
                onNotifyAdmin={adminMode ? null : handleNotifyAdmin}
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
