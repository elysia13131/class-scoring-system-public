import React, { useState, useEffect, useRef } from 'react';
import { getFullApiUrl } from '../apiConfig';
import axios from 'axios';

export default function DailyReportModal({ onClose }) {
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedReport, setSelectedReport] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [error, setError] = useState('');
  const contentRef = useRef(null);

  const fetchReports = async (p = 1) => {
    setLoading(true);
    setError('');
    try {
      const res = await axios.get(getFullApiUrl(`/api/admin/reports?page=${p}&limit=20`));
      setReports(res.data.reports || []);
      setTotalPages(res.data.totalPages || 1);
      setPage(res.data.page || 1);
    } catch (err) {
      console.error('Failed to fetch reports', err);
      setError('获取报告列表失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReports(1);
  }, []);

  const handleGenerate = async () => {
    setGenerating(true);
    setError('');
    try {
      const res = await axios.post(getFullApiUrl('/api/admin/reports/generate'));
      if (res.data.noData) {
        setError(res.data.message || '昨日无新增学员活动数据');
      } else {
        setReports(prev => [res.data, ...prev]);
        setSelectedReport(res.data);
      }
    } catch (err) {
      console.error('Failed to generate report', err);
      setError('报告生成失败: ' + (err.response?.data?.error || err.message));
    } finally {
      setGenerating(false);
    }
  };

  const handleDelete = async (id) => {
    try {
      await axios.delete(getFullApiUrl(`/api/admin/reports/${id}`));
      setReports(prev => prev.filter(r => r.id !== id));
      if (selectedReport?.id === id) setSelectedReport(null);
    } catch (err) {
      console.error('Failed to delete report', err);
    }
  };

  const typeLabels = {
    daily: '日报',
    monday: '周一报',
    manual: '手动',
    fitness_score: '体能',
    academic_score: '学业',
    bmi: 'BMI',
    notice: '通报',
    scheduled: '定时'
  };

  const typeColors = {
    daily: 'bg-blue-100 text-blue-700',
    monday: 'bg-purple-100 text-purple-700',
    manual: 'bg-green-100 text-green-700',
    fitness_score: 'bg-orange-100 text-orange-700',
    academic_score: 'bg-yellow-100 text-yellow-700',
    bmi: 'bg-pink-100 text-pink-700',
    notice: 'bg-red-100 text-red-700',
    scheduled: 'bg-blue-100 text-blue-700'
  };

  const renderMarkdown = (text) => {
    if (!text) return '';
    let html = text
      .replace(/### (.+)/g, '<h4 class="text-base font-bold text-gray-800 mt-4 mb-1">$1</h4>')
      .replace(/## (.+)/g, '<h3 class="text-lg font-bold text-gray-900 mt-4 mb-2">$1</h3>')
      .replace(/# (.+)/g, '<h2 class="text-xl font-bold text-gray-900 mt-4 mb-2">$1</h2>')
      .replace(/\*\*(.+?)\*\*/g, '<strong class="font-bold">$1</strong>')
      .replace(/- (.+)/g, '<li class="text-gray-700 ml-4">• $1</li>')
      .replace(/\n/g, '<br/>');
    return html;
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-70" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b border-gray-200 flex items-center justify-between">
          <h2 className="text-xl font-bold text-gray-900">管理日报</h2>
          <div className="flex items-center gap-3">
            <button
              onClick={handleGenerate}
              disabled={generating}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 text-sm font-medium"
            >
              {generating ? '生成中...' : '生成报告'}
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
          </div>
        </div>

        {error && (
          <div className="mx-5 mt-3 px-4 py-2 bg-red-50 text-red-600 rounded-lg text-sm">
            {error}
          </div>
        )}

        <div className="flex flex-1 overflow-hidden">
          <div className="w-80 border-r border-gray-200 overflow-y-auto flex-shrink-0">
            {loading ? (
              <div className="p-8 text-center text-gray-400">加载中...</div>
            ) : reports.length === 0 ? (
              <div className="p-8 text-center text-gray-400">
                <p className="mb-2">暂无报告</p>
                <p className="text-xs">点击"生成报告"创建第一份日报</p>
              </div>
            ) : (
              <>
                {reports.map(report => (
                  <div
                    key={report.id}
                    onClick={() => setSelectedReport(report)}
                    className={`p-4 cursor-pointer border-b border-gray-100 hover:bg-gray-50 transition-colors ${
                      selectedReport?.id === report.id ? 'bg-blue-50 border-l-2 border-l-blue-500' : ''
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-gray-500">
                        {new Date(report.generatedAt).toLocaleDateString('zh-CN')}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${typeColors[report.type] || 'bg-gray-100 text-gray-600'}`}>
                        {typeLabels[report.type] || report.type}
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-gray-800 truncate">{report.title}</h3>
                    {report.summary && (
                      <p className="text-xs text-gray-500 mt-1 line-clamp-2">{report.summary}</p>
                    )}
                    {report.sentTo && report.sentTo.length > 0 && (
                      <p className="text-xs text-green-600 mt-1">已推送 {report.sentTo.length} 位管理员</p>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(report.id); }}
                      className="text-xs text-red-400 hover:text-red-600 mt-1"
                    >
                      删除
                    </button>
                  </div>
                ))}
                {totalPages > 1 && (
                  <div className="p-3 flex justify-center gap-2">
                    <button
                      onClick={() => fetchReports(page - 1)}
                      disabled={page <= 1}
                      className="px-3 py-1 text-sm bg-gray-100 rounded disabled:opacity-30"
                    >
                      上一页
                    </button>
                    <span className="text-sm text-gray-500 py-1">{page}/{totalPages}</span>
                    <button
                      onClick={() => fetchReports(page + 1)}
                      disabled={page >= totalPages}
                      className="px-3 py-1 text-sm bg-gray-100 rounded disabled:opacity-30"
                    >
                      下一页
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-6" ref={contentRef}>
            {selectedReport ? (
              <div className="prose prose-sm max-w-none">
                <div className="mb-4">
                  <span className={`text-xs px-2 py-1 rounded-full ${typeColors[selectedReport.type] || 'bg-gray-100 text-gray-600'}`}>
                    {typeLabels[selectedReport.type] || selectedReport.type} · {new Date(selectedReport.generatedAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <div
                  className="text-gray-800 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedReport.content) }}
                />
              </div>
            ) : (
              <div className="h-full flex items-center justify-center text-gray-400">
                <div className="text-center">
                  <div className="text-4xl mb-3">选择一份报告查看</div>
                  <p className="text-sm">点击左侧列表中的报告查看详情</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
