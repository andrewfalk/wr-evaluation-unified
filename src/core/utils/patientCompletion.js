import { getModule } from '../moduleRegistry';
import { APP_BUILD_VERSION, COMPLETION_SCHEMA_VERSION } from '../constants/appVersion';

export function isPatientComplete(patient) {
  const moduleIds = patient?.data?.activeModules || [];
  if (moduleIds.length === 0) return false;

  return moduleIds.every(moduleId => {
    try {
      const mod = getModule(moduleId);
      return mod?.isComplete?.({
        shared: patient?.data?.shared,
        module: patient?.data?.modules?.[moduleId] || {},
        activeModules: moduleIds,
      }) ?? false;
    } catch {
      return false;
    }
  });
}

export function getLocalDateString(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${year}-${month}-${day}`;
}

export function getSyncedEvaluationDate(patient, today = new Date()) {
  const current = patient?.data?.shared?.evaluationDate || '';
  if (isPatientComplete(patient)) return current || getLocalDateString(today);
  return '';
}

// PR0-A: patient_records를 직접 갱신하는 모든 서버 쓰기 경로(PATCH/POST, workspace 저장,
// 영상분석 결과 적용)가 공유하는 완료 보고 필드 — 한 곳에서만 붙이면 나머지 경로로 저장된
// 환자는 completion_status가 갱신되지 않는다. 서버 쪽 대응은 server/src/completionTracking.ts.
export function completionReportFields(patient) {
  return {
    modulesCompleteObserved:       isPatientComplete(patient),
    completionClientBuildVersion:  APP_BUILD_VERSION,
    completionClientSchemaVersion: COMPLETION_SCHEMA_VERSION,
  };
}
