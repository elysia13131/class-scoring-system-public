import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { getFullApiUrl } from '../apiConfig';

export default function WeChatPasswordVerify({ memberId, wechatStatus, onBack, onDone }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [bindResult, setBindResult] = useState(null);
  const [error, setError] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const pollRef = useRef(null);

  const stoppedRef = useRef(false);

  useEffect(() => {
    const stopBot = () => {
      if (!stoppedRef.current && bindResult && !bindResult.loggedIn && !loggedIn && !stoppedRef._sent) {
        stoppedRef._sent = true;
        const url = getFullApiUrl('/api/wechat/stop-bot');
        const body = JSON.stringify({ memberId });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        } else {
          axios.post(url, { memberId }).catch(() => {});
        }
      }
    };

    window.addEventListener('beforeunload', stopBot);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && bindResult && !bindResult.loggedIn && !loggedIn) {
        stopBot();
      }
    });

    return () => {
      window.removeEventListener('beforeunload', stopBot);
      document.removeEventListener('visibilitychange', stopBot);
      if (pollRef.current) clearInterval(pollRef.current);
      if (!stoppedRef.current && bindResult && !bindResult.loggedIn && !loggedIn) {
        axios.post(getFullApiUrl('/api/wechat/stop-bot'), { memberId }).catch(() => {});
      }
    };
  }, [memberId, bindResult, loggedIn]);

  const startPolling = (memberId) => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const res = await axios.get(getFullApiUrl('/api/wechat/status'), { params: { memberId } });
        if (res.data.loggedIn) {
          setLoggedIn(true);
          stoppedRef.current = true;
          if (pollRef.current) clearInterval(pollRef.current);
        }
      } catch {
      }
    }, 3000);
  };

  const handleSubmit = async () => {
    if (!password || password.length < 4) {
      setError('密码至少4位');
      return;
    }
    setLoading(true);
    setError('');
    setBindResult(null);

    try {
      const res = await axios.post(getFullApiUrl('/api/wechat/create-bot'), {
        memberId,
        password
      });
      setBindResult(res.data);
      if (res.data.qrcodeUrl) {
        startPolling(memberId);
      }
    } catch (err) {
      const msg = err.response?.data?.error || err.message;
      if (msg === 'PASSWORD_NOT_SET') {
        setError('该成员尚未设置密码，请先在班级评分系统中登录设置密码');
      } else if (msg === '密码错误') {
        setError('密码错误，请重试');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  };

  if ((bindResult && bindResult.loggedIn) || loggedIn) {
    return (
      <div className="text-center space-y-4">
        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-sm font-medium text-green-700">绑定成功</p>
        <p className="text-xs text-gray-500">你的微信 Bot 已上线，可以直接与Bot对话</p>
        <button onClick={onDone} className="px-6 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors">
          完成
        </button>
      </div>
    );
  }

  if (bindResult && bindResult.qrcodeUrl) {
    return (
      <div className="text-center space-y-4">
        <div className="bg-gradient-to-br from-green-50 to-emerald-50 rounded-2xl p-6 border border-green-100">
          <div className="w-12 h-12 mx-auto mb-3 flex items-center justify-center">
            <svg className="w-8 h-8 text-green-500" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.046.246.246 0 0 0 .242-.246c0-.06-.024-.12-.04-.178l-.325-1.233a.492.492 0 0 1 .178-.553C23.028 18.333 24 16.592 24 14.628c0-3.299-3.063-5.77-7.062-5.77zm-2.18 3.452c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983zm4.844 0c.535 0 .969.44.969.983a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.983.97-.983z"/>
            </svg>
          </div>
          <p className="text-sm text-gray-600 mb-1">密码验证成功</p>
          <p className="text-xs text-gray-500 mb-4">成员 {memberId}</p>

          <div className="bg-white rounded-xl p-4 border border-gray-200 inline-block mx-auto">
            {bindResult.qrcodeUrl ? (
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(bindResult.qrcodeUrl)}`}
                alt="微信连接二维码"
                className="w-48 h-48 mx-auto"
                key={bindResult.qrcodeUrl}
              />
            ) : (
              <div className="w-48 h-48 mx-auto flex items-center justify-center bg-gray-50 rounded-lg">
                <p className="text-xs text-gray-400">二维码加载中...</p>
              </div>
            )}
          </div>

          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium text-gray-700">
              请用<strong className="text-green-600">微信</strong>扫描上方二维码
            </p>
            <p className="text-xs text-gray-500">
              扫描后你的专属 Bot 将上线，可直接对话
            </p>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs text-gray-400 mb-2">状态：</p>
            <div className="flex items-center justify-center gap-2">
              {loggedIn ? (
                <span className="inline-flex items-center gap-1 px-3 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                  <span className="w-2 h-2 bg-green-500 rounded-full"></span>
                  Bot在线
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-3 py-1 bg-yellow-100 text-yellow-700 text-xs font-medium rounded-full">
                  <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  等待扫码...
                </span>
              )}
            </div>
          </div>
        </div>

        {loggedIn && (
          <button
            onClick={onDone}
            className="px-6 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors"
          >
            完成
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-800">
          ← 返回
        </button>
        <p className="text-sm font-medium text-gray-600">验证密码</p>
      </div>

      <div className="p-4 bg-gray-50 rounded-xl space-y-3">
        <p className="text-sm text-gray-600">
          成员ID: <span className="font-medium text-gray-800">{memberId}</span>
        </p>
        <div>
          <label className="block text-xs text-gray-500 mb-1">请输入密码</label>
          <input
            type="password"
            value={password}
            onChange={(e) => { setPassword(e.target.value); setError(''); }}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="输入密码..."
            className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400"
            autoFocus
          />
        </div>
        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}
      </div>

      <button
        onClick={handleSubmit}
        disabled={loading || !password}
        className="w-full px-4 py-2.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
      >
        {loading ? (
          <>
            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            验证中...
          </>
        ) : '验证并绑定'}
      </button>
    </div>
  );
}