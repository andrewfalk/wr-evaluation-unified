import { useState, useEffect } from 'react';
import { showAlert } from '../utils/platform';
import { resolveAssessment } from '../utils/emrReport';

// hasInvalidOverride는 generatedB8과 무관하게 오버라이드 객체 자체의 형태만 본다
// (resolveAssessment 참고) — 배치 내보내기에서 대상마다 무거운 b8 생성을 피하기 위해
// 빈 문자열을 자리표시자로 넘긴다.
function hasInvalidAssessmentOverride(patient) {
  return resolveAssessment(patient, '').hasInvalidOverride;
}

// 내보내기 차단 판정은 "실제 export 대상 배열" 전체를 검사한다 — 핸들러마다 대상 범위가
// 다르므로(Single=활성 환자, Selected=선택 집합, Batch/All=전체) 활성 환자만 보면 선택·
// 전체 내보내기에 dirty·깨진 오버라이드가 섞여 나갈 수 있다.
async function guardExportTargets(targets, dirtyAssessmentPatientId) {
  if (dirtyAssessmentPatientId && targets.some(p => p.id === dirtyAssessmentPatientId)) {
    await showAlert('저장하지 않은 종합소견 편집 내용이 있습니다.\n"편집 완료" 또는 "취소"로 마무리한 뒤 다시 시도하세요.');
    return true;
  }
  if (targets.some(hasInvalidAssessmentOverride)) {
    await showAlert('손상된 종합소견 편집 데이터가 포함되어 있어 내보낼 수 없습니다.\n종합평가 화면에서 "깨진 편집 데이터 삭제" 후 다시 시도하세요.');
    return true;
  }
  return false;
}

export function useExportHandlers({ activePatient, patients, selectedIds, dirtyAssessmentPatientId }) {
  const [exportDropdown, setExportDropdown] = useState(null);

  useEffect(() => {
    if (!exportDropdown) return;
    const close = () => setExportDropdown(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [exportDropdown]);

  const handleExportSingle = async () => {
    if (!activePatient) return;
    if (await guardExportTargets([activePatient], dirtyAssessmentPatientId)) return;
    try {
      const { exportSingle } = await import('../utils/exportService');
      exportSingle(activePatient);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportSelected = async () => {
    const targets = patients.filter(p => selectedIds.has(p.id));
    if (await guardExportTargets(targets, dirtyAssessmentPatientId)) return;
    try {
      const { exportSelected } = await import('../utils/exportService');
      await exportSelected(patients, selectedIds);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatch = async () => {
    if (await guardExportTargets(patients, dirtyAssessmentPatientId)) return;
    try {
      const { exportBatch } = await import('../utils/exportService');
      await exportBatch(patients);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatSingle = async () => {
    if (!activePatient) return;
    if (await guardExportTargets([activePatient], dirtyAssessmentPatientId)) return;
    try {
      const { exportBatchFormatSingle } = await import('../utils/exportService');
      exportBatchFormatSingle(activePatient);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatSelected = async () => {
    const targets = patients.filter(p => selectedIds.has(p.id));
    if (await guardExportTargets(targets, dirtyAssessmentPatientId)) return;
    try {
      const { exportBatchFormatSelected } = await import('../utils/exportService');
      await exportBatchFormatSelected(patients, selectedIds);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatAll = async () => {
    if (await guardExportTargets(patients, dirtyAssessmentPatientId)) return;
    try {
      const { exportBatchFormatAll } = await import('../utils/exportService');
      await exportBatchFormatAll(patients);
    } catch (err) { await showAlert(err.message); }
  };

  // 헤더만 있는 빈 일괄입력 양식 — 환자 데이터를 전혀 담지 않으므로 dirty·invalid 차단에서 예외.
  const handleExportBatchTemplate = async () => {
    try {
      const { exportBatchTemplate } = await import('../utils/exportService');
      exportBatchTemplate();
    } catch (err) { await showAlert(err.message); }
  };

  return {
    exportDropdown,
    setExportDropdown,
    handleExportSingle,
    handleExportSelected,
    handleExportBatch,
    handleExportBatchFormatSingle,
    handleExportBatchFormatSelected,
    handleExportBatchFormatAll,
    handleExportBatchTemplate,
  };
}
