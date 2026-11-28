import { useMemo, useState } from 'react';
import { getModule } from '../moduleRegistry';
import {
  buildPresetIdentity,
  DEFAULT_CATEGORY,
  getPresetCategory,
  getPresetDescription,
  getPresetOwnerName,
  getPresetVisibility,
  isOwnPreset,
} from '../services/presetRepository';

import { hasIntranetSession } from '../../platform/dataMode';
import type { SessionLike } from '../../platform/dataMode';
import { PresetFieldPreview } from './preset/PresetFieldPreview';
import { getKeywordMatchScore, getPresetDraft, normalizeSearchText } from './preset/presetSearch';
import type { PresetRecord } from './preset/presetSearch';

/** 환자 — 이 창이 읽는 데이터 필드(부모는 PatientRecord를 넘긴다). */
interface PresetPatientData {
  shared: { jobs?: Array<{ id: string; jobName?: string }> };
  modules?: Record<string, unknown>;
  activeModules?: string[];
}

export interface PresetManageModalProps {
  jobId: string;
  patient: { data?: PresetPatientData };
  /** 부모(ModalHost)는 unknown[]으로 들고 있다. */
  presets: readonly unknown[];
  editingPreset?: PresetRecord | null;
  // 메서드 꼴 — 부모가 넘기는 전달 핸들러(`(...args: never[]) => unknown`)를 받는다.
  onSave(preset: Record<string, unknown>, meta: Record<string, unknown>): void;
  onClose(): void;
  session: SessionLike | null | undefined;
}
const CATEGORY_OPTIONS = ['건설업', '제조업', '사회복지업', '서비스업', '운수업', '농림어업', '기타'];

export function PresetManageModal({ jobId, patient, presets, editingPreset = null, onSave, onClose, session }: PresetManageModalProps) {
  const job = ((patient.data as PresetPatientData).shared.jobs || []).find(item => item.id === jobId);
  const activeModules = (patient.data as PresetPatientData).activeModules || [];

  const moduleExtracts = useMemo(() => {
    const result: Record<string, unknown> = {};
    for (const moduleId of activeModules) {
      const mod = getModule(moduleId);
      if (!mod?.presetConfig?.extractFromModule) continue;
      const moduleData = (patient.data as PresetPatientData).modules?.[moduleId];
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
    () => (presets as PresetRecord[]).filter(preset => preset.source === 'custom' || preset._customId),
    [presets]
  );

  // Only my own presets count for "update vs create" — a colleague's shared
  // preset with the same identity must never become the PATCH target (403).
  const ownCustomPresets = useMemo(
    () => customPresets.filter(preset => isOwnPreset(preset, session)),
    [customPresets, session]
  );

  const sameNameCustomPresets = useMemo(
    () => ownCustomPresets.filter(
      preset => normalizeSearchText(preset.jobName) === normalizeSearchText(job?.jobName || '')
    ),
    [ownCustomPresets, job?.jobName]
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

  const isIntranet = hasIntranetSession(session);
  const defaultVisibility = isIntranet ? 'organization' : 'private';
  const [visibility, setVisibility] = useState(
    editingPreset ? (getPresetVisibility(editingPreset) ?? defaultVisibility) : defaultVisibility
  );
  // Editing a preset that isn't mine (shouldn't normally be reachable via UI) —
  // show read-only and block save; the server would reject it with 403 anyway.
  const isReadOnly = Boolean(editingPreset) && isIntranet && !isOwnPreset(editingPreset, session);

  const toggleModule = (moduleId: string) => {
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
    return ownCustomPresets.find(preset => buildPresetIdentity(getPresetDraft(preset)) === draftIdentity);
  }, [ownCustomPresets, draftIdentity, editingPreset]);

  const storedModules: Record<string, unknown> = existingCustom?.modules || {};
  const moduleIdsToRender = useMemo(
    () => Array.from(new Set([...activeModules, ...Object.keys(storedModules)])),
    [activeModules, storedModules]
  );
  const getModuleSnapshot = (moduleId: string) => moduleExtracts[moduleId] || storedModules[moduleId] || null;

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

  const canSave = normalizedJobName && selectedModuleIds.length > 0 && !isReadOnly;

  const renderModuleSummary = (moduleIds: string[]) => {
    if (!moduleIds.length) return '없음';
    return moduleIds
      .map(moduleId => getModule(moduleId)?.name || moduleId)
      .join(', ');
  };

  const handleSave = () => {
    if (!canSave) return;

    const modules: Record<string, unknown> = {};
    for (const moduleId of selectedModuleIds) {
      modules[moduleId] = getModuleSnapshot(moduleId);
    }

    onSave({
      id:          existingCustom?._customId || existingCustom?.id || undefined,
      revision:    existingCustom?._customRevision || existingCustom?.revision || undefined,
      visibility,
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

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preset-manage-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <h2>프리셋 저장</h2>
          <p className="modal-section-description">현재 입력한 직무 부담 데이터를 직업 프리셋으로 저장합니다.</p>
        </div>

        {isIntranet && (
          <div className="form-meta-card preset-phi-notice">
            이 프리셋은 기본적으로 같은 조직 사용자에게 공유됩니다(아래에서 변경 가능).
            환자 식별 정보가 아닌 직업 노출 정보만 포함하세요.
          </div>
        )}

        {isReadOnly && (
          <div className="form-meta-card preset-match-card">
            <strong>다른 사용자가 공유한 프리셋입니다.</strong>
            <div className="preset-match-copy">
              조직에 공유된 프리셋이라 적용은 할 수 있지만 수정·삭제는 소유자만 가능합니다.
            </div>
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

          {isIntranet && (
            <div className="form-row">
              <div className="form-group form-group-wide">
                <label>공개 범위</label>
                <div className="preset-visibility-options">
                  <label className="preset-visibility-option">
                    <input
                      type="radio"
                      name="preset-visibility"
                      value="organization"
                      checked={visibility === 'organization'}
                      disabled={isReadOnly}
                      onChange={() => setVisibility('organization')}
                    />
                    <span>
                      <strong>조직 공유</strong>
                      <span className="settings-inline-hint">같은 조직 사용자가 검색·적용할 수 있습니다. 수정/삭제는 나만 가능합니다.</span>
                    </span>
                  </label>
                  <label className="preset-visibility-option">
                    <input
                      type="radio"
                      name="preset-visibility"
                      value="private"
                      checked={visibility === 'private'}
                      disabled={isReadOnly}
                      onChange={() => setVisibility('private')}
                    />
                    <span>
                      <strong>나만 보기</strong>
                      <span className="settings-inline-hint">내 계정에서만 검색됩니다.</span>
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}

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
                      {!isOwnPreset(preset, session) && (preset.source === 'custom' || preset._customId) && (
                        <span className="preset-list-description">
                          조직 공유 · {getPresetOwnerName(preset) || '알 수 없음'} (참고용)
                        </span>
                      )}
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
                {checked && hasData && (
                  <PresetFieldPreview moduleId={moduleId} data={getModuleSnapshot(moduleId)} storedOnly={!hasCurrentData && hasStoredData} />
                )}
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
