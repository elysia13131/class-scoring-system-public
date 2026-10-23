import React, { useState } from 'react';

export default function FeedbackCard({ feedback, feedbackTier, anomalyDetected, anomalySignals, onNotifyAdmin, onChatWithAI, notifySent }) {
  const [anonymous, setAnonymous] = useState(false);
  if (!feedback) return null;
  
  const tierColors = {
    warmth: { bg: 'rgba(59,130,246,0.04)', border: 'rgba(59,130,246,0.12)', accent: '#93c5fd' },
    connection: { bg: 'rgba(99,102,241,0.04)', border: 'rgba(99,102,241,0.15)', accent: '#a5b4fc' },
    insight: { bg: 'rgba(139,92,246,0.04)', border: 'rgba(139,92,246,0.15)', accent: '#c4b5fd' },
  };
  const colors = tierColors[feedbackTier] || tierColors.warmth;

  const handleNotify = () => {
    if (onNotifyAdmin) onNotifyAdmin(anonymous);
  };
  
  return (
    <div className="feedback-card animate-fadeIn" style={{
      margin: '12px 0 0',
      padding: '16px 20px',
      borderRadius: '16px',
      background: colors.bg,
      border: `1px solid ${colors.border}`,
      position: 'relative',
      overflow: 'hidden'
    }}>
      <div style={{
        position: 'absolute', top: 0, left: 0, width: '3px', height: '100%',
        background: `linear-gradient(180deg, ${colors.accent}, transparent)`
      }} />
      <div style={{ 
        fontSize: '15px', lineHeight: '1.7', color: '#e2e8f0', 
        paddingLeft: '8px', whiteSpace: 'pre-wrap' 
      }}>
        {feedback}
      </div>
      
      {/* Anomaly badge */}
      {anomalyDetected && (
        <div style={{
          display: 'inline-flex', alignItems: 'center', gap: '6px',
          margin: '10px 0 0 8px', padding: '6px 12px', borderRadius: '8px',
          background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)',
          fontSize: '12px', color: '#fca5a5'
        }}>
          <span>⚠️</span>
          {anomalySignals?.includes('consecutive_negative_mood') && '连续负面情绪'}
          {anomalySignals?.includes('injury') && '伤病情信号'}
          {anomalySignals?.includes('social_risk') && '社交风险'}
          <span style={{ color: '#f87171' }}>· 已通知管理员关注</span>
        </div>
      )}
      
      {/* Action buttons */}
      <div style={{ display: 'flex', gap: '10px', margin: '12px 0 0 8px', flexWrap: 'wrap', alignItems: 'center' }}>
        {onNotifyAdmin && (
          <>
            <button 
              onClick={handleNotify}
              disabled={notifySent}
              style={{
                padding: '6px 14px', borderRadius: '20px', border: '1px solid rgba(99,102,241,0.2)',
                background: notifySent ? 'rgba(99,102,241,0.12)' : 'transparent',
                color: notifySent ? '#818cf8' : '#94a3b8', fontSize: '12px', cursor: notifySent ? 'default' : 'pointer',
                transition: 'all 0.2s'
              }}
            >
              {notifySent ? '✓ 已告知管理员' : '📢 告知管理员'}
            </button>
            {!notifySent && (
              <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '11px', color: '#64748b', cursor: 'pointer' }}>
                <input type="checkbox" checked={anonymous} onChange={e => setAnonymous(e.target.checked)}
                  style={{ accentColor: '#6366f1', cursor: 'pointer' }} />
                匿名
              </label>
            )}
          </>
        )}
        {onChatWithAI && (
          <button 
            onClick={onChatWithAI}
            style={{
              padding: '6px 14px', borderRadius: '20px', border: '1px solid rgba(99,102,241,0.2)',
              background: 'transparent', color: '#818cf8', fontSize: '12px', cursor: 'pointer',
              transition: 'all 0.2s'
            }}
          >
            💬 和AI聊聊
          </button>
        )}
      </div>
    </div>
  );
}
