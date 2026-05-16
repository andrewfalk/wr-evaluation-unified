import { useMemo, useState } from 'react';
import { getModule } from '../moduleRegistry';
import {
  buildPresetIdentity,
  DEFAULT_CATEGORY,
  getPresetCategory,
  getPresetDescription,
  normalizePresetIdentityPart,
} from '../services/presetRepository';

const CATEGORY_OPTIONS = ['건설업', '제조업', '사회복지업', '서비스업', '운수업', '농림어업', '기타'];

function getPresetDraft(preset) {
  return {
    jobName: preset?.jobName || '',
    category: getPresetCategory(preset) || DEFAULT_CATEGORY,
    description: getPresetDescription(preset),
  };
}

function normalizeSearchText(value) {
  return normalizePresetIdentityPart(value).toLowerCase();
}

function tokenize(value) {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter(token => token.length >= 2);
}

function formatPresetFieldValue(value, type) {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[객체]';
    }
  }
  if (type === 'boolean') {
    return value ? 'Y' : 'N';
  }
  return value;
}

function getKeywordMatchScore(preset, draft) {
  const presetJob = normalizeSearchText(preset.jobName);
  const presetCategory = normalizeSearchText(getPresetCategory(preset));
  const presetDescription = normalizeSearchText(getPresetDescription(preset));
  const presetBlob = [presetJob, presetCategory, presetDescription].join(' ');

  const draftJob = normalizeSearchText(draft.jobName);
  const draftCategory = normalizeSearchText(draft.category);
  const draftDescription = normalizeSearchText(draft.description);
  const draftTokens = new Set([
    ...tokenize(draft.jobName),
    ...tokenize(draft.category),
    ...tokenize(draft.description),
  ]);

  let score = 0;

  if (draftJob) {
    if (presetJob === draftJob) score += 6;
    else if (presetJob.includes(draftJob) || draftJob.includes(presetJob)) score += 4;
  }

  if (draftCategory) {
    if (presetCategory === draftCategory) score += 4;
    else if (presetCategory.includes(draftCategory) || draftCategory.includes(presetCategory)) score += 2;
  }

  if (draftDescription) {
    if (presetDescription === draftDescription) score += 3;
    else if (presetDescription.includes(draftDescription) || draftDescription.includes(presetDescription)) score += 2;
  }

  for (const token of draftTokens) {
    if (presetBlob.includes(token)) score += 1;
  }

  return score;
}

export function PresetManageModal({ jobId, patient, presets, editingPreset = null, onSave, onClose, session }) {
  const job = (patient.data.shared.jobs || []).find(item => item.id === jobId);
  const activeModules = patient.data.activeModules || [];

  const moduleExtracts = useMemo(() => {
    const result = {};
    for (const moduleId of activeModules) {
      const mod = getModule(moduleId);
      if (!mod?.presetConfig?.extractFromModule) continue;
      const moduleData = patient.data.modules?.[moduleId];
      if (!moduleData) continue;
      try {
        const extracted = mod.presetConfig.extractFromModule(moduleData, jobId);
        if (extracted) result[moduleId] = extracted;
      } catch (error) {
        console.error(`Preset extract failed for module: ${moduleId}`, error);
      }
    }
    return result;
  }, [activeModules, patient, jobId]);

  const customPresets = useMemo(
    () => presets.filter(preset => preset.source === 'custom' || preset._customId),
    [presets]
  );

  const sameNameCustomPresets = useMemo(
    () => customPresets.filter(
      preset => normalizeSearchText(preset.jobName) === normalizeSearchText(job?.jobName || '')
    ),
    [customPresets, job?.jobName]
  );

  const initialPreset = editingPreset || (sameNameCustomPresets.length === 1 ? sameNameCustomPresets[0] : null);
  const initialCategory = getPresetCategory(initialPreset) || '';
  const initialDescription = getPresetDescription(initialPreset);
  const initialCategoryIsCustom = initialCategory && !CATEGORY_OPTIONS.includes(initialCategory);

  const [jobName, setJobName] = useState(initialPreset?.jobName || job?.jobName || '');
  const [category, setCategory] = useState(initialCategoryIsCustom ? '' : initialCategory);
  const [description, setDescription] = useState(initialDescription);
  const [customCategory, setCustomCategory] = useState(initialCategoryIsCustom ? initialCategory : '');
  const [categoryMode, setCategoryMode] = useState(initialCategoryIsCustom ? 'custom' : 'select');
  const [selectedModules, setSelectedModules] = useState(() => (
    new Set(editingPreset ? Object.keys(editingPreset.modules || {}) : Object.keys(moduleExtracts))
  ));

  const toggleModule = (moduleId) => {
    setSelectedModules(prev => {
      const next = new Set(prev);
      if (next.has(moduleId)) next.delete(moduleId);
      else next.add(moduleId);
      return next;
    });
  };

  const finalCategory = (categoryMode === 'custom' ? customCategory : category).trim();
  const normalizedJobName = jobName.trim();
  const normalizedDescription = description.trim();

  const draftPreset = useMemo(() => ({
    jobName: normalizedJobName,
    category: finalCategory || DEFAULT_CATEGORY,
    description: normalizedDescription,
  }), [normalizedJobName, finalCategory, normalizedDescription]);

  const draftIdentity = useMemo(() => buildPresetIdentity(draftPreset), [draftPreset]);

  const existingCustom = useMemo(() => {
    if (editingPreset) return editingPreset;
    return customPresets.find(preset => buildPresetIdentity(getPresetDraft(preset)) === draftIdentity);
  }, [customPresets, draftIdentity, editingPreset]);

  const storedModules = existingCustom?.modules || {};
  const moduleIdsToRender = useMemo(
    () => Array.from(new Set([...activeModules, ...Object.keys(storedModules)])),
    [activeModules, storedModules]
  );
  const getModuleSnapshot = (moduleId) => moduleExtracts[moduleId] || storedModules[moduleId] || null;

  const selectedModuleIds = useMemo(
    () => Array.from(selectedModules).filter(moduleId => Boolean(getModuleSnapshot(moduleId))),
    [selectedModules, moduleExtracts, storedModules]
  );

  const existingModuleIds = Object.keys(existingCustom?.modules || {});
  const mergedModuleIds = editingPreset
    ? [...selectedModuleIds]
    : Array.from(new Set([...existingModuleIds, ...selectedModuleIds]));
  const overlappingModuleIds = selectedModuleIds.filter(moduleId => existingModuleIds.includes(moduleId));
  const addedModuleIds = selectedModuleIds.filter(moduleId => !existingModuleIds.includes(moduleId));
  const removedModuleIds = existingModuleIds.filter(moduleId => !selectedModuleIds.includes(moduleId));

  const similarPresets = useMemo(() => {
    if (!normalizedJobName && !finalCategory && !normalizedDescription) return [];

    return customPresets
      .filter(preset => {
        if (editingPreset && (preset._customId || preset.id) === (editingPreset._customId || editingPreset.id)) {
          return false;
        }
        return buildPresetIdentity(getPresetDraft(preset)) !== draftIdentity;
      })
      .map(preset => ({
        preset,
        score: getKeywordMatchScore(preset, draftPreset),
      }))
      .filter(item => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        return String(left.preset.jobName || '').localeCompare(String(right.preset.jobName || ''), 'ko');
      })
      .slice(0, 5);
  }, [customPresets, draftIdentity, draftPreset, editingPreset, finalCategory, normalizedDescription, normalizedJobName]);

  const canSave = normalizedJobName && selectedModuleIds.length > 0;

  const renderModuleSummary = (moduleIds) => {
    if (!moduleIds.length) return '없음';
    return moduleIds
      .map(moduleId => getModule(moduleId)?.name || moduleId)
      .join(', ');
  };

  const handleSave = () => {
    if (!canSave) return;

    const modules = {};
    for (const moduleId of selectedModuleIds) {
      modules[moduleId] = getModuleSnapshot(moduleId);
    }

    onSave({
      id:          existingCustom?._customId || existingCustom?.id || undefined,
      revision:    existingCustom?._customRevision || existingCustom?.revision || undefined,
      visibility:  'private',
      jobName:     normalizedJobName,
      category:    finalCategory || DEFAULT_CATEGORY,
      description: normalizedDescription,
      modules,
    }, {
      isUpdate: Boolean(existingCustom),
      existingModuleIds,
      selectedModuleIds,
      mergedModuleIds,
      addedModuleIds,
      overlappingModuleIds,
      removedModuleIds,
      replaceModules: Boolean(editingPreset),
    });
  };

  const renderFieldPreview = (moduleId) => {
    const mod = getModule(moduleId);
    const data = getModuleSnapshot(moduleId);
    if (!mod?.presetConfig || !data) return null;

    if (mod.presetConfig.fields === 'tasks' && data.tasks) {
      return (
        <div className="preset-field-preview">
          {data.tasks.map((task, index) => (
            <div key={index} className="preset-preview-row">
              <span className="preset-preview-label">{task.name}</span>
              <span className="preset-preview-value">
                {[
                  task.posture,
                  `${task.weight}kg`,
                  `${task.frequency}회`,
                  task.timeValue ? `${task.timeValue}${task.timeUnit || ''}` : null,
                  task.correctionFactor ? `보정 ${task.correctionFactor}` : null,
                ].filter(Boolean).join(' / ')}
              </span>
            </div>
          ))}
        </div>
      );
    }

    if (Array.isArray(mod.presetConfig.fields)) {
      return (
        <div className="preset-field-preview">
          {mod.presetConfig.fields.map(field => {
            const value = data[field.key];
            if (value === undefined || value === '' || value === null) return null;
            const display = formatPresetFieldValue(value, field.type);
            return (
              <div key={field.key} className="preset-preview-row">
                <span className="preset-preview-label">{field.label}</span>
                <span className="preset-preview-value">{display}</span>
              </div>
            );
          })}
        </div>
      );
    }

    return null;
  };

  const renderReadableFieldPreview = (moduleId, options = {}) => {
    const mod = getModule(moduleId);
    const data = getModuleSnapshot(moduleId);
    if (!mod?.presetConfig || !data) return null;

    const { storedOnly = false } = options;

    if (mod.presetConfig.fields === 'tasks' && data.tasks) {
      return (
        <div className="preset-field-preview">
          {storedOnly && (
            <div className="preset-preview-source">{"\uAE30\uC874 \uD504\uB9AC\uC14B\uC5D0 \uC800\uC7A5\uB41C \uAC12\uC744 \uADF8\uB300\uB85C \uC720\uC9C0 \uC911\uC785\uB2C8\uB2E4."}</div>
          )}
          {data.tasks.map((task, index) => (
            <div key={index} className="preset-task-card">
              <div className="preset-task-title">{task.name}</div>
              <div className="preset-task-meta">
                {task.posture && <span className="preset-task-chip">{task.posture}</span>}
                {task.weight !== undefined && task.weight !== null && (
                  <span className="preset-task-chip">{`${task.weight}kg`}</span>
                )}
                {task.frequency !== undefined && task.frequency !== null && (
                  <span className="preset-task-chip">{`${task.frequency}\uD68C`}</span>
                )}
                {task.timeValue ? (
                  <span className="preset-task-chip">{`${task.timeValue}${task.timeUnit || ''}`}</span>
                ) : null}
                {task.correctionFactor ? (
                  <span className="preset-task-chip">{`\uBCF4\uC815 ${task.correctionFactor}`}</span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      );
    }

    if (Array.isArray(mod.presetConfig.fields)) {
      return (
        <div className="preset-field-preview">
          {storedOnly && (
            <div className="preset-preview-source">{"\uAE30\uC874 \uD504\uB9AC\uC14B\uC5D0 \uC800\uC7A5\uB41C \uAC12\uC744 \uADF8\uB300\uB85C \uC720\uC9C0 \uC911\uC785\uB2C8\uB2E4."}</div>
          )}
          {mod.presetConfig.fields.map(field => {
            const value = data[field.key];
            if (value === undefined || value === '' || value === null) return null;
            const display = formatPresetFieldValue(value, field.type);
            return (
              <div key={field.key} className="preset-preview-row">
                <span className="preset-preview-label">{field.label}</span>
                <span className="preset-preview-value">{display}</span>
              </div>
            );
          })}
        </div>
      );
    }

    return renderFieldPreview(moduleId);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preset-manage-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <h2>프리셋 저장</h2>
          <p className="modal-section-description">현재 입력한 직무 부담 데이터를 직업 프리셋으로 저장합니다.</p>
        </div>

        {session?.mode === 'intranet' && (
          <div className="form-meta-card preset-phi-notice">
            이 프리셋은 현재 로그인한 계정의 내 프리셋으로 서버에 저장됩니다.
            환자 식별 정보가 아닌 직업 노출 정보만 포함하세요.
          </div>
        )}

        {editingPreset && (
          <div className="form-meta-card preset-match-card">
            <strong>현재 저장된 프리셋을 수정하는 중입니다.</strong>
            <div className="preset-match-copy">
              조회 화면에서 선택한 프리셋을 불러왔습니다. 이름, 카테고리, 설명을 바꿔도 같은 프리셋을 수정합니다.
            </div>
          </div>
        )}

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">기본 정보</div>
          <div className="form-row">
            <div className="form-group form-group-wide">
              <label>직종명</label>
              <input value={jobName} onChange={e => setJobName(e.target.value)} placeholder="직종명을 입력하세요" />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label>카테고리</label>
              {categoryMode === 'select' ? (
                <div className="preset-category-row">
                  <select value={category} onChange={e => setCategory(e.target.value)}>
                    <option value="">선택...</option>
                    {CATEGORY_OPTIONS.map(option => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                  <button className="btn btn-xs btn-secondary" onClick={() => setCategoryMode('custom')}>직접입력</button>
                </div>
              ) : (
                <div className="preset-category-row">
                  <input value={customCategory} onChange={e => setCustomCategory(e.target.value)} placeholder="카테고리를 직접 입력하세요" />
                  <button className="btn btn-xs btn-secondary" onClick={() => setCategoryMode('select')}>목록선택</button>
                </div>
              )}
            </div>
          </div>
          <div className="form-row">
            <div className="form-group form-group-wide">
              <label>설명 (선택)</label>
              <input value={description} onChange={e => setDescription(e.target.value)} placeholder="작업 맥락이나 특징을 간단히 적어주세요" />
            </div>
          </div>

          {existingCustom && !editingPreset && (
            <div className="form-meta-card preset-match-card">
              <strong>같은 프리셋이 이미 있습니다.</strong>
              <div className="preset-match-copy">
                저장하면 기존 프리셋에 선택한 모듈이 추가되거나 같은 모듈 데이터가 갱신됩니다.
              </div>
              <div className="preset-match-copy">기존 모듈: {renderModuleSummary(existingModuleIds)}</div>
              <div className="preset-match-copy">이번 저장 모듈: {renderModuleSummary(selectedModuleIds)}</div>
              <div className="preset-match-copy">저장 후 모듈: {renderModuleSummary(mergedModuleIds)}</div>
              {addedModuleIds.length > 0 && (
                <div className="settings-inline-hint">새로 추가될 모듈: {renderModuleSummary(addedModuleIds)}</div>
              )}
              {overlappingModuleIds.length > 0 && (
                <div className="settings-inline-hint">갱신될 모듈: {renderModuleSummary(overlappingModuleIds)}</div>
              )}
            </div>
          )}

          {!existingCustom && similarPresets.length > 0 && (
            <div className="settings-diagnostic-card preset-match-card">
              <div className="settings-section-title preset-inline-title">비슷한 프리셋이 있습니다</div>
              <div className="preset-list">
                {similarPresets.map(({ preset, score }) => (
                  <div key={preset._customId || preset.id} className="preset-list-item preset-similar-item">
                    <div className="preset-list-info preset-list-info-column">
                      <span className="preset-list-name">{preset.jobName}</span>
                      <span className="preset-list-category">{getPresetCategory(preset)}</span>
                      {!!getPresetDescription(preset) && (
                        <span className="preset-list-description">{getPresetDescription(preset)}</span>
                      )}
                      <span className="preset-list-modules">
                        {Object.keys(preset.modules || {}).map(moduleId => getModule(moduleId)?.icon || moduleId).join(' ')}
                      </span>
                    </div>
                    <span className="preset-badge">유사도 {score}</span>
                  </div>
                ))}
              </div>
              <div className="settings-inline-hint">같은 직종명이거나 입력한 카테고리, 설명과 키워드가 겹치는 프리셋을 먼저 보여줍니다.</div>
            </div>
          )}
        </div>

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">저장할 모듈 데이터</div>
          {moduleIdsToRender.map(moduleId => {
            const mod = getModule(moduleId);
            if (!mod?.presetConfig) return null;

            const hasCurrentData = Boolean(moduleExtracts[moduleId]);
            const hasStoredData = Boolean(storedModules[moduleId]);
            const hasData = hasCurrentData || hasStoredData;
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
                  {!hasData && <span className="preset-no-data">{"\uB370\uC774\uD130 \uC5C6\uC74C"}</span>}
                  {hasData && !hasCurrentData && hasStoredData && (
                    <span className="preset-module-note">{"\uAE30\uC874 \uD504\uB9AC\uC14B \uB370\uC774\uD130 \uC720\uC9C0"}</span>
                  )}
                </label>
                {checked && hasData && renderReadableFieldPreview(moduleId, {
                  storedOnly: !hasCurrentData && hasStoredData,
                })}
              </div>
            );
          })}
          {moduleIdsToRender.every(moduleId => !getModule(moduleId)?.presetConfig) && (
            <p className="preset-empty-notice">프리셋 저장을 지원하는 활성 모듈이 없습니다.</p>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className="btn btn-primary" disabled={!canSave} onClick={handleSave}>
            {editingPreset ? '프리셋 수정 저장' : existingCustom ? '프리셋 업데이트' : '프리셋 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}
