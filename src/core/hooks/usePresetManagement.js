import { useState, useCallback, useEffect } from 'react';
import { loadAllPresets, normalizeBuiltinPreset, saveCustomPreset, deleteCustomPreset, getPresetCategory, getPresetDescription } from '../services/presetRepository';
import { getModule } from '../moduleRegistry';
import { touchPatientRecord } from '../services/patientRecords';
import { showAlert, showConfirm } from '../utils/platform';
import { canEditPatient } from '../utils/patientOwnership';
import { FALLBACK_PRESETS } from '../../modules/knee/utils/data';

export function usePresetManagement({ activeId, activePatient, activeModules, session, setPatients }) {
  const [presets, setPresets] = useState([]);
  const [presetMeta, setPresetMeta] = useState(null);
  const [presetError, setPresetError] = useState(null);
  const [presetModalJobId, setPresetModalJobId] = useState(null);
  const [presetEditingPreset, setPresetEditingPreset] = useState(null);
  const [presetBrowseJobId, setPresetBrowseJobId] = useState(null);

  const reloadPresets = useCallback(async () => {
    try {
      const { merged, builtinCount, customCount } = await loadAllPresets(session);
      setPresets(merged);
      setPresetMeta({ count: merged.length, builtinCount, customCount });
      setPresetError(null);
    } catch {
      const fallback = FALLBACK_PRESETS.map(normalizeBuiltinPreset);
      setPresets(fallback);
      setPresetMeta({ count: fallback.length, builtinCount: fallback.length, customCount: 0 });
      setPresetError('Preset 파일 로드 실패');
    }
  }, [session]);

  useEffect(() => { reloadPresets(); }, [reloadPresets]);

  const formatModuleNames = useCallback((moduleIds = []) => (
    moduleIds.map(moduleId => getModule(moduleId)?.name || moduleId).join(', ')
  ), []);

  const handlePresetSelect = useCallback(async (jobId, preset) => {
    // 1차 방어: 비담당 환자에는 프리셋을 적용하지 않는다. StepContent의 UI 차단(클릭/키보드)이
    // 정상 흐름에서 이 함수 호출 자체를 막지만, 여기 도달했다면(우회 경로) 조용히 무시하지 않고
    // 거짓 성공 알림("프리셋이 적용되었습니다") 없이 명확히 알린다.
    if (!canEditPatient(activePatient, session)) {
      await showAlert('담당 의사가 아니므로 프리셋을 적용할 수 없습니다.');
      return;
    }

    const applicableModuleIds = (activeModules || []).filter(moduleId => {
      const mod = getModule(moduleId);
      return mod?.presetConfig?.applyToModule && preset.modules?.[moduleId];
    });

    setPatients(prev => prev.map(p => {
      // 2차 방어: 초입 검사와 setState 실행 사이의 레이스(그 사이 환자 전환 등) 대비.
      if (p.id !== activeId || !canEditPatient(p, session)) return p;
      const newModules = { ...p.data.modules };
      for (const moduleId of (p.data.activeModules || [])) {
        const mod = getModule(moduleId);
        const presetModuleData = preset.modules?.[moduleId];
        if (mod?.presetConfig?.applyToModule && presetModuleData) {
          newModules[moduleId] = mod.presetConfig.applyToModule(
            newModules[moduleId] || mod.createModuleData(),
            jobId,
            presetModuleData
          );
        }
      }
      return touchPatientRecord(
        { ...p, data: { ...p.data, modules: newModules } },
        { session }
      );
    }));
    if (applicableModuleIds.length > 0) {
      await showAlert(`프리셋 "${preset.jobName}"이 적용되었습니다.\n적용 모듈: ${formatModuleNames(applicableModuleIds)}`);
    } else {
      await showAlert(`프리셋 "${preset.jobName}"을 선택했지만 현재 활성 모듈과 겹치는 저장 데이터가 없습니다.`);
    }
  }, [activeId, activePatient, activeModules, formatModuleNames, session, setPatients]);

  const handleSaveCustomPreset = useCallback(async (preset, feedback = {}) => {
    const savedPreset = await saveCustomPreset(preset, { replaceModules: feedback.replaceModules }, session);
    await reloadPresets();
    setPresetModalJobId(null);
    setPresetEditingPreset(null);
    const presetLabel = savedPreset.description
      ? `${savedPreset.jobName} / ${savedPreset.category} / ${savedPreset.description}`
      : `${savedPreset.jobName} / ${savedPreset.category}`;

    if (feedback.isUpdate) {
      const removedModulesLine = feedback.removedModuleIds?.length
        ? `\n제거된 모듈: ${formatModuleNames(feedback.removedModuleIds)}`
        : '';
      await showAlert(
        `기존 프리셋 업데이트 완료\n프리셋: ${presetLabel}\n기존 모듈: ${formatModuleNames(feedback.existingModuleIds)}\n이번 저장 모듈: ${formatModuleNames(feedback.selectedModuleIds)}\n저장 후 모듈: ${formatModuleNames(feedback.mergedModuleIds)}${removedModulesLine}`
      );
      return;
    }
    await showAlert(
      `새 프리셋 저장 완료\n프리셋: ${presetLabel}\n저장 모듈: ${formatModuleNames(feedback.selectedModuleIds || Object.keys(savedPreset.modules || {}))}`
    );
  }, [formatModuleNames, reloadPresets, session]);

  const closePresetManageModal = useCallback(() => {
    if (presetEditingPreset && presetModalJobId) {
      setPresetBrowseJobId(presetModalJobId);
    }
    setPresetModalJobId(null);
    setPresetEditingPreset(null);
  }, [presetEditingPreset, presetModalJobId]);

  const handleDeleteCustomPreset = useCallback(async (presetOrId) => {
    const preset =
      presetOrId && typeof presetOrId === 'object'
        ? presetOrId
        : presets.find(item => (item._customId || item.id) === presetOrId);
    const id = preset?._customId || preset?.id || presetOrId;
    if (!id) return false;
    const revision = preset?._customRevision ?? preset?.revision ?? null;

    const label = preset?.jobName
      ? getPresetDescription(preset)
        ? `${preset.jobName} / ${getPresetCategory(preset)} / ${getPresetDescription(preset)}`
        : `${preset.jobName} / ${getPresetCategory(preset)}`
      : null;

    const confirmed = await showConfirm(
      label ? `"${label}" 프리셋을 삭제하시겠습니까?` : '이 프리셋을 삭제하시겠습니까?'
    );
    if (!confirmed) return false;

    await deleteCustomPreset(id, session, revision);
    await reloadPresets();
    return true;
  }, [presets, reloadPresets, session]);

  return {
    presets,
    presetMeta,
    presetError,
    presetModalJobId,
    presetEditingPreset,
    presetBrowseJobId,
    setPresetModalJobId,
    setPresetEditingPreset,
    setPresetBrowseJobId,
    reloadPresets,
    handlePresetSelect,
    handleSaveCustomPreset,
    closePresetManageModal,
    handleDeleteCustomPreset,
  };
}
