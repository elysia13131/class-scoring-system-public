import React, { useState } from 'react';
import axios from 'axios';
import { getFullApiUrl } from '../apiConfig';

export default function AdminPasswordInput({ onBack, onSuccess }) {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!password) {
      setError('请输入管理员密码');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await axios.post(getFullApiUrl('/api/wechat/create-admin-bot'), { password });
      onSuccess(res.data);
    } catch (err) {
      setError(err.response?.data?.error || '密码错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-800">← 返回</button>
        <p className="text-sm font-medium text-gray-600">管理员密码</p>
      </div>
      <div className="p-3 bg-gray-50 rounded-xl space-y-2">
        <label className="block text-xs text-gray-500">请输入管理员密码</label>
        <input
          type="password"
          value={password}
          onChange={(e) => { setPassword(e.target.value); setError(''); }}
          onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
          placeholder="管理员密码..."
          className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-blue-400"
          autoFocus
        />
        {error && <p className="text-xs text-red-500">{error}</p>}
      </div>
      <button
        onClick={handleSubmit}
        disabled={loading || !password}
        className="w-full px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
      >
        {loading ? '验证中...' : '验证并绑定'}
      </button>
    </div>
  );
}