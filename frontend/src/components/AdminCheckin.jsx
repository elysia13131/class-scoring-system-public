import React, { useState } from 'react';
import { getFullApiUrl } from '../apiConfig';
import FeedbackCard from './FeedbackCard';

export default function AdminCheckin({ memberId, members, onClose }) {
  const [targetMemberId, setTargetMemberId] = useState('');
  const [observation, setObservation] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState(null);

  const handleSubmit = async () => {
    if (!observation.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(getFullApiUrl('/api/checkin/feedback'), {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ 
          memberId: targetMemberId || 'admin', 
          type: 'admin_observation', 
          text: `观察对象：${targetMemberId || '班级整体'}\n${observation}${note ? '\n\n备注：'+note : ''}` 
        })
      });
      const data = await res.json();
      setFeedback(data);
    }catch(e){console.error(e);}
    setSubmitting(false);
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-gray-800">管理记录</h2>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl transition-colors">&times;</button>
          </div>

          {!feedback ? (
            <>
              <div className="mb-3">
                <label className="text-xs text-gray-400 mb-1.5 block">观察对象</label>
                <select value={targetMemberId} onChange={e=>setTargetMemberId(e.target.value)}
                  className="w-full px-3.5 py-2.5 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 text-sm outline-none focus:border-orange-300 focus:ring-1 focus:ring-orange-200 transition-colors"
                >
                  <option value="">班级整体</option>
                  {members.map(m => (
                    <option key={m.id} value={m.id}>{m.name} ({m.class})</option>
                  ))}
                </select>
              </div>

              <div className="mb-3">
                <label className="text-xs text-gray-400 mb-1.5 block">观察记录</label>
                <textarea value={observation} onChange={e=>setObservation(e.target.value)}
                  placeholder="记录观察到的行为、状态、事件..."
                  rows={3}
                  className="w-full px-3.5 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 text-sm resize-none outline-none focus:border-orange-300 focus:ring-1 focus:ring-orange-200 font-sans transition-colors"
                />
              </div>

              <div className="mb-4">
                <label className="text-xs text-gray-400 mb-1.5 block">备注（选填）</label>
                <textarea value={note} onChange={e=>setNote(e.target.value)}
                  placeholder="补充说明..."
                  rows={2}
                  className="w-full px-3.5 py-3 rounded-xl bg-gray-50 border border-gray-200 text-gray-800 text-sm resize-none outline-none focus:border-orange-300 focus:ring-1 focus:ring-orange-200 font-sans transition-colors"
                />
              </div>

              <button onClick={handleSubmit} disabled={submitting||!observation.trim()}
                className="w-full py-3 rounded-xl font-medium text-white text-sm transition-all bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 disabled:cursor-default"
              >
                {submitting?'分析中...':'提交记录'}
              </button>
            </>
          ) : (
            <>
              <div className="text-center py-3"><div className="text-3xl mb-2">📊</div></div>
              <FeedbackCard feedback={feedback.feedback} feedbackTier={feedback.feedbackTier}
                anomalyDetected={feedback.anomalyDetected} anomalySignals={feedback.anomalySignals} />
              <button onClick={onClose} className="w-full mt-4 py-2.5 rounded-xl text-sm text-gray-500 hover:text-gray-700 bg-gray-100 hover:bg-gray-200 transition-colors">关闭</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
