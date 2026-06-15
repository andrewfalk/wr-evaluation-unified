// videoMappingConfig 공용 헬퍼 (6.0-2). 모듈별 writeField/coerce 중복 제거.
// 대상 필드명·단위는 VIDEO_FEATURE_TARGETS(계약)이 단일 진실.
import { VIDEO_FEATURE_TARGETS } from '@contracts/index';

// job-scope(무릎·어깨): jobExtras[sharedJobId] 위치에 원자값 기입. {moduleData, previousValue, targetPath}.
export function jobScopeWriteField(moduleId, createExtras, moduleData, ctx, featureKey, value) {
  const field = VIDEO_FEATURE_TARGETS[featureKey].targetField;
  const extras = [...(moduleData.jobExtras || [])];
  let idx = extras.findIndex((e) => e.sharedJobId === ctx.sharedJobId);
  let previousValue = null;
  if (idx < 0) {
    const created = createExtras(ctx.sharedJobId);
    previousValue = created[field] ?? null;
    extras.push({ ...created, [field]: value });
  } else {
    previousValue = extras[idx][field] ?? null;
    extras[idx] = { ...extras[idx], [field]: value };
  }
  return {
    moduleData: { ...moduleData, jobExtras: extras },
    previousValue,
    targetPath: `modules.${moduleId}.jobExtras[sharedJobId=${ctx.sharedJobId}].${field}`,
    applied: true, // job-scope는 jobExtras를 생성하므로 항상 적용됨
  };
}

// task-scope(척추·경추, 공정≈task 1:1): tasks[id] 위치에 기입.
// task가 없으면 applied:false(모듈 미변경) — provenance 기록을 막아야 한다(빈 적용 방지).
export function taskScopeWriteField(moduleId, moduleData, ctx, featureKey, value, sideEffects) {
  const field = VIDEO_FEATURE_TARGETS[featureKey].targetField;
  const tasks = [...(moduleData.tasks || [])];
  const idx = tasks.findIndex((t) => String(t.id) === String(ctx.taskId));
  const targetPath = `modules.${moduleId}.tasks[id=${ctx.taskId}].${field}`;
  if (idx < 0) return { moduleData, previousValue: null, targetPath, applied: false };
  const previousValue = tasks[idx][field] ?? null;
  const patch = { [field]: value, ...(sideEffects ? sideEffects(featureKey) : {}) };
  tasks[idx] = { ...tasks[idx], ...patch };
  return { moduleData: { ...moduleData, tasks }, previousValue, targetPath, applied: true };
}

// 문자열 저장 모듈(무릎·어깨·경추) coerce.
export const stringCoerce = (_featureKey, value) => (value == null ? '' : String(value));

// 숫자 저장 모듈(척추 frequency/timeValue) coerce — 정수 반올림(§8.10.2-1 timeValue=Math.round(sec)).
export const numberCoerce = (_featureKey, value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
