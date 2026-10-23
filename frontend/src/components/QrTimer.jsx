import React, { useState, useEffect } from 'react';

const QR_TTL = 110;

export default function QrTimer({ timestamp }) {
  const [remaining, setRemaining] = useState(QR_TTL);

  useEffect(() => {
    const tick = () => {
      if (!timestamp) {
        setRemaining(0);
        return;
      }
      const elapsed = Math.floor((Date.now() - timestamp) / 1000);
      setRemaining(Math.max(0, QR_TTL - elapsed));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [timestamp]);

  if (!timestamp) return null;

  const pct = remaining / QR_TTL;
  const expired = remaining <= 0;
  const low = remaining <= 20;

  return (
    <div className="mt-2 flex items-center gap-2">
      {expired ? (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-50 text-red-600 text-xs rounded-full border border-red-100">
          <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          二维码已过期，自动刷新中...
        </span>
      ) : (
        <>
          <div className="w-16 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-1000 ${
                low ? 'bg-red-500' : pct > 0.5 ? 'bg-green-500' : 'bg-yellow-500'
              }`}
              style={{ width: `${pct * 100}%` }}
            />
          </div>
          <span className={`text-xs ${low ? 'text-red-500 font-medium' : 'text-gray-400'}`}>
            {remaining}秒
          </span>
        </>
      )}
    </div>
  );
}
