import { useState, useCallback, useEffect } from 'react';
import { loadAllPresets, normalizeBuiltinPreset, saveCustomPreset, deleteCustomPreset, getPresetCategory, getPresetDescription } from '../services/presetRepository';
import { getModule } from '../moduleRegistry';
import { touchPatientRecord } from '../services/patientRecords';
import { showAlert, showConfirm } from '../utils/platform';
import { FALLBACK_PRESETS } from '../../modules/knee/utils/data';

export function usePresetManagement({ activeId, activeModules, session, setPatients }) {
  const [presets, setPresets] = useState([]);
  const [presetMeta, setPresetMeta] = useState(null);
  const [presetError, setPresetError] = useState(null);
  const [presetModalJobId, setPresetModalJobId] = useState(null);
  const [presetEditingPreset, setPresetEditingPreset] = useState(null);
  const [presetBrowseJobId, setPresetBrowseJobId] = useState(null);

  const reloadPresets = useCallback(async () => {
    try {
      const { merged, builtinCount, customCount } = await loadAllPresets();
      setPresets(merged);
      setPresetMeta({ count: merged.length, builtinCount, customCount });
      setPresetError(null);
    } catch {
      const fallback = FALLBACK_PRESETS.map(normalizeBuiltinPreset);
      setPresets(fallback);
      setPresetMeta({ count: fallback.length, builtinCount: fallback.length, customCount: 0 });
      setPresetError('Preset 파일 로드 실패');
    }
  }, []);

  useEffect(() => { reloadPresets(); }, [reloadPresets]);

  const formatModuleNames = useCallback((moduleIds = []) => (
    moduleIds.map(moduleId => getModule(moduleId)?.name || moduleId).join(', ')
  ), []);

  const handlePresetSelect = useCallback(async (jobId, preset) => {
    const applicableModuleIds = (activeModules || []).filter(moduleId => {
      const mod = getModule(moduleId);
      return mod?.presetConfig?.applyToModule && preset.modules?.[moduleId];
    });

    setPatients(prev => prev.map(p => {
      if (p.id !== activeId) return p;
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
  }, [activeId, activeModules, formatModuleNames, session, setPatients]);

  const handleSaveCustomPreset = useCallback(async (preset, feedback = {}) => {
    const savedPreset = await saveCustomPreset(preset, { replaceModules: feedback.replaceModules });
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
  }, [formatModuleNames, reloadPresets]);

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

    const label = preset?.jobName
      ? getPresetDescription(preset)
        ? `${preset.jobName} / ${getPresetCategory(preset)} / ${getPresetDescription(preset)}`
        : `${preset.jobName} / ${getPresetCategory(preset)}`
      : null;

    const confirmed = await showConfirm(
      label ? `"${label}" 프리셋을 삭제하시겠습니까?` : '이 프리셋을 삭제하시겠습니까?'
    );
    if (!confirmed) return false;

    await deleteCustomPreset(id);
    await reloadPresets();
    return true;
  }, [presets, reloadPresets]);

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
