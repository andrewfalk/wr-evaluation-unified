import { useState, useMemo } from 'react';
import { getAllModules, getModule } from '../moduleRegistry';

const CATEGORY_OPTIONS = ['건설업', '제조업', '사회복지업', '서비스업', '운수업', '농림어업', '기타'];

export function PresetManageModal({ jobId, patient, presets, onSave, onDelete, onClose }) {
  const job = (patient.data.shared.jobs || []).find(j => j.id === jobId);
  const activeModules = patient.data.activeModules || [];

  // 모듈별 현재 데이터 추출
  const moduleExtracts = useMemo(() => {
    const result = {};
    for (const moduleId of activeModules) {
      const mod = getModule(moduleId);
      if (!mod?.presetConfig?.extractFromModule) continue;
      const moduleData = patient.data.modules?.[moduleId];
      if (!moduleData) continue;
      const extracted = mod.presetConfig.extractFromModule(moduleData, jobId);
      if (extracted) result[moduleId] = extracted;
    }
    return result;
  }, [activeModules, patient, jobId]);

  // 기존 custom 프리셋 편집인지 확인
  const existingCustom = presets.find(p => p._customId && p.jobName === job?.jobName)
    || presets.find(p => p.source === 'custom' && p.jobName === job?.jobName);

  const [jobName, setJobName] = useState(job?.jobName || '');
  const [category, setCategory] = useState(existingCustom?.category || '');
  const [description, setDescription] = useState(existingCustom?.description || '');
  const [customCategory, setCustomCategory] = useState('');
  const [categoryMode, setCategoryMode] = useState(
    existingCustom?.category && !CATEGORY_OPTIONS.includes(existingCustom.category) ? 'custom' : 'select'
  );
  const [selectedModules, setSelectedModules] = useState(() => {
    const set = new Set(Object.keys(moduleExtracts));
    return set;
  });

  const toggleModule = (id) => {
    setSelectedModules(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const finalCategory = categoryMode === 'custom' ? customCategory : category;

  const canSave = jobName.trim() && selectedModules.size > 0;

  const handleSave = () => {
    if (!canSave) return;
    const modules = {};
    for (const moduleId of selectedModules) {
      if (moduleExtracts[moduleId]) {
        modules[moduleId] = moduleExtracts[moduleId];
      }
    }
    const preset = {
      id: existingCustom?._customId || existingCustom?.id || undefined,
      jobName: jobName.trim(),
      category: finalCategory.trim() || '미분류',
      description: description.trim(),
      modules,
    };
    onSave(preset);
  };

  const renderFieldPreview = (moduleId) => {
    const mod = getModule(moduleId);
    const data = moduleExtracts[moduleId];
    if (!mod?.presetConfig || !data) return null;

    if (mod.presetConfig.fields === 'tasks' && data.tasks) {
      return (
        <div className="preset-field-preview">
          {data.tasks.map((t, i) => (
            <div key={i} className="preset-preview-row">
              <span className="preset-preview-label">{t.name}</span>
              <span className="preset-preview-value">{t.posture} / {t.weight}kg / {t.frequency}회</span>
            </div>
          ))}
        </div>
      );
    }

    if (Array.isArray(mod.presetConfig.fields)) {
      return (
        <div className="preset-field-preview">
          {mod.presetConfig.fields.map(f => {
            const val = data[f.key];
            if (val === undefined || val === '' || val === null) return null;
            const display = f.type === 'boolean' ? (val ? 'Y' : 'N') : val;
            return (
              <div key={f.key} className="preset-preview-row">
                <span className="preset-preview-label">{f.label}</span>
                <span className="preset-preview-value">{display}</span>
              </div>
            );
          })}
        </div>
      );
    }
    return null;
  };

  // 프리셋 관리: 현재 목록에서 custom 프리셋만 표시
  const customPresets = presets.filter(p => p.source === 'custom' || p._customId);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preset-manage-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <h2>프리셋 저장</h2>
          <p className="modal-section-description">현재 입력된 신체부담 데이터를 프리셋으로 저장합니다.</p>
        </div>

        {/* 기본정보 */}
        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">기본 정보</div>
          <div className="form-row">
            <div className="form-group form-group-wide">
              <label>직종명</label>
              <input value={jobName} onChange={e => setJobName(e.target.value)} placeholder="직종명 입력" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>카테고리</label>
              {categoryMode === 'select' ? (
                <div className="preset-category-row">
                  <select value={category} onChange={e => setCategory(e.target.value)}>
                    <option value="">선택...</option>
                    {CATEGORY_OPTIONS.map(c => <option key={c} value={c}>{c}</option>)}
                  </select>
                  <button className="btn btn-xs btn-secondary" onClick={() => setCategoryMode('custom')}>직접입력</button>
                </div>
              ) : (
                <div className="preset-category-row">
                  <input value={customCategory} onChange={e => setCustomCategory(e.target.value)} placeholder="카테고리 직접 입력" />
                  <button className="btn btn-xs btn-secondary" onClick={() => setCategoryMode('select')}>목록선택</button>
                </div>
              )}
            </div>
          </div>
          <div className="form-row">
            <div className="form-group form-group-wide">
              <label>설명 (선택)</label>
              <input value={description} onChange={e => setDescription(e.target.value)} placeholder="직무 내용 간단 설명" />
            </div>
          </div>
        </div>

        {/* 모듈별 데이터 */}
        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">저장할 모듈 데이터</div>
          {activeModules.map(moduleId => {
            const mod = getModule(moduleId);
            if (!mod?.presetConfig) return null;
            const hasData = !!moduleExtracts[moduleId];
            const checked = selectedModules.has(moduleId);
            return (
              <div key={moduleId} className={`preset-module-section ${!hasData ? 'is-empty' : ''}`}>
                <label className="preset-module-header">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!hasData}
                    onChange={() => toggleModule(moduleId)}
                  />
                  <span className="preset-module-icon">{mod.icon}</span>
                  <span>{mod.presetConfig.label}</span>
                  {!hasData && <span className="preset-no-data">(데이터 없음)</span>}
                </label>
                {checked && hasData && renderFieldPreview(moduleId)}
              </div>
            );
          })}
          {activeModules.every(id => !getModule(id)?.presetConfig) && (
            <p className="preset-empty-notice">프리셋을 지원하는 활성 모듈이 없습니다.</p>
          )}
        </div>

        {/* 기존 커스텀 프리셋 목록 */}
        {customPresets.length > 0 && (
          <div className="settings-section modal-section pattern-surface">
            <div className="settings-section-title">저장된 커스텀 프리셋 ({customPresets.length})</div>
            <div className="preset-list">
              {customPresets.map(p => (
                <div key={p._customId || p.id} className="preset-list-item">
                  <div className="preset-list-info">
                    <span className="preset-list-name">{p.jobName}</span>
                    <span className="preset-list-category">{p.category}</span>
                    <span className="preset-list-modules">
                      {Object.keys(p.modules || {}).map(mid => getModule(mid)?.icon || mid).join(' ')}
                    </span>
                  </div>
                  {(p.source === 'custom' || p._customId) && (
                    <button className="btn btn-xs btn-danger" onClick={() => onDelete(p._customId || p.id)}>삭제</button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={!canSave} onClick={handleSave}>
            {existingCustom ? '프리셋 업데이트' : '프리셋 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
