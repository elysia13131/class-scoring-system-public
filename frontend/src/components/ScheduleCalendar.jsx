import React, { useState, useEffect } from 'react';
import { getFullApiUrl } from '../apiConfig';
import axios from 'axios';

export default function ScheduleCalendar({ memberId, isAdmin, members }) {
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [schedules, setSchedules] = useState([]);
  const [selectedDate, setSelectedDate] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    title: '', description: '', dueAt: '', targetMemberIds: [], isGlobal: false
  });

  const fetchSchedules = async () => {
    if (!memberId) return;
    setLoading(true);
    try {
      const res = await axios.get(getFullApiUrl(`/api/schedules/${memberId}?date=${selectedDate || ''}`));
      setSchedules(res.data.schedules || []);
    } catch (e) {
      console.error('获取日程失败', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchSchedules(); }, [memberId, selectedDate]);

  const daysInMonth = (date) => {
    const y = date.getFullYear();
    const m = date.getMonth();
    return new Date(y, m + 1, 0).getDate();
  };

  const firstDayOfMonth = (date) => {
    const d = new Date(date.getFullYear(), date.getMonth(), 1);
    return d.getDay();
  };

  const goMonth = (delta) => {
    const d = new Date(currentMonth);
    d.setMonth(d.getMonth() + delta);
    setCurrentMonth(d);
    setSelectedDate(null);
  };

  const dateStr = (y, m, d) => {
    return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };

  const todayStr = () => {
    const d = new Date();
    return dateStr(d.getFullYear(), d.getMonth(), d.getDate());
  };

  const getSchedulesForDay = (ds) => {
    return schedules.filter(s => (s.dueAt || '').substring(0, 10) === ds);
  };

  const y = currentMonth.getFullYear();
  const m = currentMonth.getMonth();
  const days = daysInMonth(currentMonth);
  const firstDay = firstDayOfMonth(currentMonth);

  const calendarDays = [];
  for (let i = 0; i < firstDay; i++) calendarDays.push(null);
  for (let d = 1; d <= days; d++) calendarDays.push(d);

  const weeks = [];
  for (let i = 0; i < calendarDays.length; i += 7) weeks.push(calendarDays.slice(i, i + 7));

  const handleDateClick = (d) => {
    if (!d) return;
    const ds = dateStr(y, m, d);
    setSelectedDate(ds);
    setShowForm(false);
  };

  const handleCreate = () => {
    const ds = selectedDate || todayStr();
    setForm({ title: '', description: '', dueAt: `${ds}T09:00`, targetMemberIds: [], isGlobal: false });
    setEditingSchedule(null);
    setShowForm(true);
  };

  const handleSubmit = async () => {
    try {
      const payload = {
        title: form.title,
        description: form.description,
        dueAt: new Date(form.dueAt).toISOString(),
        createdBy: memberId,
        targetMemberIds: form.isGlobal ? ['__all__'] : (form.targetMemberIds.length > 0 ? form.targetMemberIds : [memberId]),
        isGlobal: form.isGlobal
      };
      await axios.post(getFullApiUrl('/api/schedules'), payload);
      setShowForm(false);
      fetchSchedules();
    } catch (e) {
      console.error('创建日程失败', e);
    }
  };

  const handleDelete = async (scheduleId) => {
    if (!confirm('确定删除此日程？')) return;
    try {
      await axios.delete(getFullApiUrl(`/api/schedules/${scheduleId}?memberId=${memberId}`));
      fetchSchedules();
    } catch (e) {
      console.error('删除日程失败', e);
    }
  };

  const toggleMember = (mid) => {
    setForm(prev => ({
      ...prev,
      targetMemberIds: prev.targetMemberIds.includes(mid)
        ? prev.targetMemberIds.filter(x => x !== mid)
        : [...prev.targetMemberIds, mid]
    }));
  };

  const selectAllMembers = () => {
    const allIds = members.map(m => String(m.id));
    setForm(prev => ({ ...prev, targetMemberIds: allIds }));
  };

  return (
    <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-gray-800">日程日历</h2>
        <button
          onClick={handleCreate}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium transition-colors"
        >
          + 新建日程
        </button>
      </div>

      {/* Month header */}
      <div className="flex items-center justify-between mb-3">
        <button onClick={() => goMonth(-1)} className="p-1 hover:bg-gray-100 rounded">◀</button>
        <span className="font-bold text-gray-700">{y}年{m + 1}月</span>
        <button onClick={() => goMonth(1)} className="p-1 hover:bg-gray-100 rounded">▶</button>
      </div>

      {/* Calendar grid */}
      <div className="grid grid-cols-7 gap-1">
        {['日', '一', '二', '三', '四', '五', '六'].map(w => (
          <div key={w} className="text-center text-xs font-medium text-gray-400 py-1">{w}</div>
        ))}
        {weeks.flat().map((d, i) => {
          if (!d) return <div key={`e${i}`} className="aspect-square" />;
          const ds = dateStr(y, m, d);
          const isToday = ds === todayStr();
          const isSelected = ds === selectedDate;
          const daySchedules = getSchedulesForDay(ds);
          return (
            <div
              key={ds}
              onClick={() => handleDateClick(d)}
              className={`aspect-square flex flex-col items-center justify-center rounded-lg cursor-pointer text-sm transition-colors
                ${isSelected ? 'bg-blue-600 text-white' : isToday ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'hover:bg-gray-50 text-gray-700'}
              `}
            >
              <span>{d}</span>
              {daySchedules.length > 0 && (
                <div className="flex gap-0.5 mt-0.5">
                  {daySchedules.slice(0, 3).map((_, i) => (
                    <div key={i} className={`w-1 h-1 rounded-full ${isSelected ? 'bg-white' : 'bg-blue-500'}`} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Selected date schedules */}
      {selectedDate && (
        <div className="mt-4 border-t pt-3">
          <h3 className="font-semibold text-gray-700 mb-2">{selectedDate} 的日程</h3>
          {loading ? (
            <p className="text-gray-400 text-sm">加载中...</p>
          ) : getSchedulesForDay(selectedDate).length === 0 ? (
            <p className="text-gray-400 text-sm">暂无日程</p>
          ) : (
            getSchedulesForDay(selectedDate).map(s => (
              <div key={s.id} className="flex items-start justify-between py-2 border-b border-gray-50">
                <div>
                  <p className="font-medium text-gray-800 text-sm">{s.title}</p>
                  {s.description && <p className="text-gray-500 text-xs mt-0.5">{s.description}</p>}
                  <p className="text-gray-400 text-xs mt-0.5">{new Date(s.dueAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</p>
                </div>
                <button
                  onClick={() => handleDelete(s.id)}
                  className="text-red-400 hover:text-red-600 text-xs ml-2 flex-shrink-0"
                >
                  删除
                </button>
              </div>
            ))
          )}
        </div>
      )}

      {/* Create form modal */}
      {showForm && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl p-6 w-full max-w-md mx-4" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-gray-800 mb-4">
              {editingSchedule ? '修改日程' : '新建日程'}
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm text-gray-600">标题</label>
                <input
                  type="text" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}
                  className="w-full mt-1 px-3 py-2 border rounded-lg text-sm" placeholder="日程标题"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">描述</label>
                <textarea
                  value={form.description} onChange={e => setForm({ ...form, description: e.target.value })}
                  className="w-full mt-1 px-3 py-2 border rounded-lg text-sm" rows={2} placeholder="详细描述"
                />
              </div>
              <div>
                <label className="text-sm text-gray-600">日期时间</label>
                <input
                  type="datetime-local" value={form.dueAt} onChange={e => setForm({ ...form, dueAt: e.target.value })}
                  className="w-full mt-1 px-3 py-2 border rounded-lg text-sm"
                />
              </div>
              {isAdmin && (
                <>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox" checked={form.isGlobal}
                      onChange={e => setForm({ ...form, isGlobal: e.target.checked, targetMemberIds: [] })}
                    />
                    <label className="text-sm text-gray-600">全选群发（所有成员）</label>
                  </div>
                  {!form.isGlobal && members.length > 0 && (
                    <div>
                      <label className="text-sm text-gray-600 mb-1 block">
                        选择成员
                        <button onClick={selectAllMembers} className="ml-2 text-xs text-blue-600 underline">全选</button>
                      </label>
                      <div className="max-h-32 overflow-y-auto border rounded-lg p-2 space-y-1">
                        {members.map(m => (
                          <label key={m.id} className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox" checked={form.targetMemberIds.includes(String(m.id))}
                              onChange={() => toggleMember(String(m.id))}
                            />
                            {m.name} ({m.class || '-'})
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              <div className="flex gap-2 pt-2">
                <button onClick={handleSubmit} className="flex-1 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">
                  保存
                </button>
                <button onClick={() => setShowForm(false)} className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm">
                  取消
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
