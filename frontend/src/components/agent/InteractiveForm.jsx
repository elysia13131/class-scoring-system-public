import React, { useState, useMemo } from 'react';

function InteractiveForm({ formSchema, formType, onSubmit, onCancel, members = [] }) {
  const [targetMemberId, setTargetMemberId] = useState('');
  const [scoreType, setScoreType] = useState('self');
  const [week, setWeek] = useState(1);
  const [subItemScores, setSubItemScores] = useState({});

  const [selectedMoodTag, setSelectedMoodTag] = useState('');
  const [selfAssessment, setSelfAssessment] = useState({});
  const [selectedCoping, setSelectedCoping] = useState([]);
  const [positiveNominations, setPositiveNominations] = useState([]);
  const [negativeNominations, setNegativeNominations] = useState([]);

  const isScoreForm = formType === 'score_submit';

  const scoreDimensions = useMemo(() => {
    if (!isScoreForm || !formSchema) return [];
    const dims = formSchema.dimensions || [];
    return dims.map(dim => ({
      ...dim,
      name: dim.name || dim.label,
      items: (dim.items || dim.subItems || []).map(item => ({
        ...item,
        key: item.key,
        label: item.label,
        max: item.max || 2
      }))
    }));
  }, [formSchema, isScoreForm]);

  const moodSections = useMemo(() => {
    if (isScoreForm || !formSchema) return null;
    return formSchema.sections || [];
  }, [formSchema, isScoreForm]);

  const tagSection = moodSections?.find(s => s.type === 'tag_select');
  const sliderSection = moodSections?.find(s => s.type === 'sliders');
  const copingSection = moodSections?.find(s => s.type === 'multi_select');
  const nominationSection = moodSections?.find(s => s.type === 'dual_list');

  const memberList = useMemo(() => {
    if (nominationSection?.members?.length > 0) return nominationSection.members;
    if (isScoreForm && formSchema?.fields) {
      const field = formSchema.fields.find(f => f.key === 'targetMemberId');
      if (field?.options?.length > 0) {
        return field.options.map(o => ({ id: o.value, name: o.label }));
      }
    }
    return members;
  }, [nominationSection, isScoreForm, formSchema, members]);

  const scoreFields = formSchema?.fields || [];

  const weekField = scoreFields.find(f => f.key === 'week') || {};
  const weekOptions = weekField.type === 'select' ? (weekField.options || []) : [];

  const defaultTargetMember = (() => {
    const field = scoreFields.find(f => f.key === 'targetMemberId');
    return field?.default || members[0]?.id || '';
  })();

  const defaultWeek = weekField.default || weekOptions[0]?.value || 1;

  React.useEffect(() => {
    if (isScoreForm) {
      setTargetMemberId(String(defaultTargetMember));
      setWeek(defaultWeek);
    }
    if (sliderSection?.fields) {
      const defaults = {};
      sliderSection.fields.forEach(f => { defaults[f.key] = f.default || 5; });
      setSelfAssessment(defaults);
    }
  }, [isScoreForm, defaultTargetMember, defaultWeek, sliderSection]);

  const handleSubItemChange = (dimKey, subKey, value) => {
    const fullKey = `${dimKey}_${subKey}`;
    setSubItemScores(prev => ({ ...prev, [fullKey]: parseFloat(value) }));
  };

  const getDimensionTotal = (dimension) => {
    if (!dimension?.items) return { total: 0, max: 0 };
    let total = 0;
    let maxTotal = 0;
    dimension.items.forEach(item => {
      const val = subItemScores[`${dimension.key}_${item.key}`] ?? 0;
      total += val;
      maxTotal += item.max || 2;
    });
    return { total, max: maxTotal };
  };

  const toggleCoping = (option) => {
    setSelectedCoping(prev =>
      prev.includes(option) ? prev.filter(o => o !== option) : [...prev, option]
    );
  };

  const addNomination = (type, memberId) => {
    if (!memberId) return;
    const setter = type === 'positive' ? setPositiveNominations : setNegativeNominations;
    const current = type === 'positive' ? positiveNominations : negativeNominations;
    if (!current.find(m => m.id === memberId)) {
      const member = memberList.find(m => m.id === memberId);
      if (member) setter(prev => [...prev, member]);
    }
  };

  const removeNomination = (type, memberId) => {
    const setter = type === 'positive' ? setPositiveNominations : setNegativeNominations;
    setter(prev => prev.filter(m => m.id !== memberId));
  };

  const handleSubmit = () => {
    if (isScoreForm) {
      onSubmit({ targetMemberId, scoreType, week, subItemScores });
    } else {
      const assessment = {};
      if (sliderSection?.fields) {
        sliderSection.fields.forEach(f => {
          assessment[f.key] = selfAssessment[f.key] ?? f.default ?? 5;
        });
      }
      onSubmit({
        moodTag: selectedMoodTag,
        selfAssessment: assessment,
        copingStyle: selectedCoping,
        positiveNominations: positiveNominations.map(m => m.id),
        negativeNominations: negativeNominations.map(m => m.id)
      });
    }
  };

  const getWeekBadge = (optionValue) => {
    const opt = weekOptions.find(w => w.value === optionValue);
    if (!opt) return null;
    if (opt.isCurrent) return <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-blue-100 text-blue-600 rounded font-medium">本周</span>;
    if (opt.isMakeup) return <span className="ml-1.5 px-1.5 py-0.5 text-[10px] bg-orange-100 text-orange-600 rounded font-medium">补评</span>;
    return null;
  };

  const renderScoreForm = () => (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3">
        {scoreFields.map(field => {
          if (field.type === 'select' && field.key === 'targetMemberId') {
            const options = field.options || memberList.map(m => ({ value: m.id, label: m.name }));
            return (
              <div key={field.key} className="flex-1 min-w-[140px]">
                <label className="block text-xs font-medium text-gray-600 mb-1">{field.label}</label>
                <select value={targetMemberId} onChange={e => setTargetMemberId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                  {options.map(opt =>
                    <option key={opt.value || opt.id} value={opt.value || opt.id}>{opt.label || opt.name}</option>
                  )}
                </select>
              </div>
            );
          }
          if (field.type === 'select' && field.key === 'scoreType') {
            return (
              <div key={field.key} className="w-28">
                <label className="block text-xs font-medium text-gray-600 mb-1">{field.label}</label>
                <select value={scoreType} onChange={e => setScoreType(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                  {(field.options || []).map(opt =>
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  )}
                </select>
              </div>
            );
          }
          if (field.key === 'week') {
            if (field.type === 'select') {
              return (
                <div key={field.key} className="flex-1 min-w-[120px]">
                  <label className="block text-xs font-medium text-gray-600 mb-1">{field.label}</label>
                  <select value={week} onChange={e => setWeek(parseInt(e.target.value))}
                    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400 bg-white">
                    {(field.options || []).map(opt =>
                      <option key={opt.value} value={opt.value}>
                        {opt.label}{getWeekBadge(opt.value) ? '' : ''}
                      </option>
                    )}
                  </select>
                  {getWeekBadge(week)}
                </div>
              );
            }
            return (
              <div key={field.key} className="w-24">
                <label className="block text-xs font-medium text-gray-600 mb-1">{field.label}</label>
                <input type="number" min={field.min || 1} max={field.max || 20}
                  value={week} onChange={e => setWeek(parseInt(e.target.value) || 1)}
                  className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-400" />
              </div>
            );
          }
          return null;
        })}
      </div>

      <div className="space-y-3">
        {scoreDimensions.map(dim => {
          const { total, max } = getDimensionTotal(dim);
          return (
            <div key={dim.key} className="bg-gray-50 rounded-lg p-3 mb-3">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-sm font-semibold text-indigo-600">◆</span>
                <span className="font-semibold text-gray-800 text-sm">{dim.name}</span>
              </div>
              <div className="space-y-3">
                {dim.items.map(item => {
                  const fullKey = `${dim.key}_${item.key}`;
                  const val = subItemScores[fullKey] ?? 0;
                  const itemMax = item.max || 2;
                  return (
                    <div key={item.key}>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs text-gray-600">{item.label}</label>
                        <span className="text-sm font-bold text-indigo-600">{val}/{itemMax}</span>
                      </div>
                      <input type="range" min="0" max={itemMax} step="0.5" value={val}
                        onChange={e => handleSubItemChange(dim.key, item.key, e.target.value)}
                        className="w-full h-2 rounded-lg appearance-none cursor-pointer
                          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                          [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-indigo-500
                          [&::-webkit-slider-runnable-track]:rounded-lg"
                        style={{
                          background: `linear-gradient(to right, #818cf8 0%, #818cf8 ${(val / itemMax) * 100}%, #e5e7eb ${(val / itemMax) * 100}%, #e5e7eb 100%)`
                        }} />
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 pt-2 border-t border-gray-200 text-right">
                <span className="text-xs text-gray-500">维度小计: </span>
                <span className="text-sm font-bold text-indigo-600">{total}/{max}</span>
              </div>
            </div>
          );
        })}
      </div>

      {formSchema?.validation?.rules && (
        <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-2">
          {formSchema.validation.rules.map((rule, i) => (
            <div key={i}>• {rule}</div>
          ))}
        </div>
      )}

      {formSchema?.meta && !formSchema.meta.fallbackMode && (
        <div className="text-[11px] text-gray-300 text-center">
          当前第{formSchema.meta.currentWeek}周 · 可填周次{formSchema.meta.availableWeekCount}个（含补评{formSchema.meta.makeupWeekCount}个）· 班级成员{formSchema.meta.memberCount}人
        </div>
      )}
    </div>
  );

  const renderMoodForm = () => (
    <div className="space-y-4">
      {tagSection && (
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-2">{tagSection.label}</label>
          <div className="flex flex-wrap gap-2">
            {(tagSection.tags || []).map(tag => {
              const isNegative = (tagSection.negativeTags || []).includes(tag);
              const isSelected = selectedMoodTag === tag;
              return (
                <button key={tag} onClick={() => setSelectedMoodTag(tag)}
                  className={`px-3 py-1.5 rounded-full text-xs font-medium transition
                    ${isSelected
                      ? (isNegative ? 'bg-red-500 text-white' : 'bg-emerald-500 text-white')
                      : (isNegative ? 'border border-red-300 text-red-600 hover:bg-red-50' : 'border border-emerald-300 text-emerald-600 hover:bg-emerald-50')
                    }`}>
                  {tag}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {sliderSection && (
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-2">{sliderSection.label}</label>
          <div className="space-y-3">
            {sliderSection.fields.map(item => {
              const val = selfAssessment[item.key] ?? item.default ?? 5;
              const itemMin = item.min || 1;
              const itemMax = item.max || 10;
              return (
                <div key={item.key}>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-gray-600">{item.label}</label>
                    <span className={`text-sm font-bold ${val <= 3 ? 'text-red-500' : val >= 8 ? 'text-emerald-500' : 'text-indigo-600'}`}>{val}/{itemMax}</span>
                  </div>
                  <input type="range" min={itemMin} max={itemMax} step="1" value={val}
                    onChange={e => setSelfAssessment(prev => ({ ...prev, [item.key]: parseInt(e.target.value) }))}
                    className="w-full h-2 rounded-lg appearance-none cursor-pointer
                      [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4
                      [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow-md
                      [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-indigo-500"
                    style={{
                      background: `linear-gradient(to right, #f87171 0%, #fbbf24 40%, #34d399 70%, #10b981 100%)`
                    }} />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {copingSection && (
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-2">{copingSection.label}</label>
          <div className="flex flex-wrap gap-2">
            {(copingSection.options || []).map(option => (
              <button key={option} onClick={() => toggleCoping(option)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition
                  ${selectedCoping.includes(option)
                    ? 'bg-purple-600 text-white'
                    : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
                  }`}>
                {option}
              </button>
            ))}
          </div>
        </div>
      )}

      {nominationSection && (
        <div className="grid grid-cols-2 gap-3">
          {[
            { type: 'positive', label: nominationSection.positiveLabel || '正向提名', color: 'emerald', list: positiveNominations },
            { type: 'negative', label: nominationSection.negativeLabel || '负向提名', color: 'red', list: negativeNominations }
          ].map(({ type, label, color, list }) => (
            <div key={type}>
              <label className={`block text-xs font-semibold mb-2 text-${color}-600`}>{label}</label>
              <div className="flex flex-wrap gap-1.5 mb-2 min-h-[32px]">
                {list.map(member => (
                  <span key={member.id} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-${color}-100 text-${color}-700`}>
                    {member.name}
                    <button onClick={() => removeNomination(type, member.id)} className="hover:opacity-70 font-bold">×</button>
                  </span>
                ))}
              </div>
              <select onChange={e => addNomination(type, e.target.value)} value=""
                className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-indigo-400 bg-white">
                <option value="">+ 添加成员</option>
                {memberList.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="bg-white rounded-xl shadow-md border border-gray-100 p-4 max-w-lg mx-auto animate-in">
      <div className="flex items-center gap-2 mb-4 pb-3 border-b border-gray-100">
        <span className="text-lg">{isScoreForm ? '📝' : '💭'}</span>
        <h3 className="font-bold text-gray-800 text-base">{formSchema?.title || (isScoreForm ? '填写评分' : '心情记录')}</h3>
      </div>

      <div className="mb-4 max-h-[55vh] overflow-y-auto pr-1">
        {isScoreForm ? renderScoreForm() : renderMoodForm()}
      </div>

      <div className="flex justify-between items-center pt-3 border-t border-gray-100">
        <button onClick={onCancel}
          className="px-3 py-2 rounded-lg text-sm font-medium text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition">
          ✕ 暂时不填
        </button>
        <div className="flex gap-2">
          <button onClick={onCancel}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-100 hover:bg-gray-200 text-gray-600 transition">
              取消
          </button>
          <button onClick={handleSubmit}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition">
            ✓ 确认提交
          </button>
        </div>
      </div>

      <style>{`
        .animate-in {
          animation: slideUp 0.3s ease-out;
        }
        @keyframes slideUp {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

export default InteractiveForm;
