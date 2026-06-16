// Provenance 저장 및 적용/되돌리기 (§8.11), 6.0-2.
// 기존 입력 필드는 객체로 바꾸지 않고 숫자/원자값을 유지하며(계산 엔진 호환),
// 출처·원제안값·이전값은 data.shared.videoAnalysis.appliedInputs[]에 별도 보존한다.
// 모듈별 write/coerce는 각 모듈 videoMappingConfig가 제공(jobExtras vs tasks, String vs number).
import { getModule } from '../moduleRegistry';
import { VIDEO_FEATURE_TARGETS } from '@contracts/index';

const cloneVideoAnalysis = (patient) => {
  const va = patient.data.shared.videoAnalysis || {};
  return {
    ...va,
    appliedInputs: [...(va.appliedInputs || [])],
    candidateFeatures: [...(va.candidateFeatures || [])],
  };
};

const withModuleData = (patient, moduleId, moduleData) => ({
  ...patient,
  data: {
    ...patient.data,
    modules: { ...patient.data.modules, [moduleId]: moduleData },
  },
});

const withVideoAnalysis = (patient, videoAnalysis) => ({
  ...patient,
  data: { ...patient.data, shared: { ...patient.data.shared, videoAnalysis } },
});

/**
 * VideoFeatureMap에서 한 모듈이 소비하는 "자동제안 가능" 제안 목록을 만든다(candidate 제외).
 * 모듈/필드/단위는 VIDEO_FEATURE_TARGETS(계약)이 단일 진실.
 * @returns {Array<{featureKey,targetField,unit,suggestedValue,confidence,autoSuggestAllowed,requiresManualReview,mode}>}
 */
export function getModuleSuggestions(featureMap, moduleId) {
  const suggestions = [];
  for (const [featureKey, fv] of Object.entries(featureMap || {})) {
    const target = VIDEO_FEATURE_TARGETS[featureKey];
    if (!target || target.moduleId !== moduleId) continue;
    if (target.mode === 'candidate') continue; // 모듈 필드 미기입 — candidateFeatures로만
    suggestions.push({
      featureKey,
      targetField: target.targetField,
      unit: target.unit,
      suggestedValue: fv.value,
      confidence: fv.confidence,
      autoSuggestAllowed: fv.autoSuggestAllowed,
      requiresManualReview: fv.requiresManualReview,
      mode: target.mode,
    });
  }
  return suggestions;
}

/**
 * candidate-mode feature들을 candidateFeatures 엔트리로 추출(모듈 필드에 쓰지 않음).
 */
export function collectCandidateFeatures(featureMap, { processIds = [], clipIds = [] } = {}) {
  const out = [];
  for (const [featureKey, fv] of Object.entries(featureMap || {})) {
    if (fv.kind !== 'candidate') continue;
    out.push({ ...fv, featureKey, processIds, clipIds });
  }
  return out;
}

/**
 * 영상 제안값을 모듈 입력에 적용하고 provenance(appliedInputs)를 기록한다.
 * 모듈 필드에는 원자값만 기입(모듈별 coerce). 환자 객체를 새로 만들어 반환(불변).
 * @returns {{patient: object, appliedInput: object}}
 */
export function applyFeatureToModule(patient, {
  moduleId,
  ctx,            // { sharedJobId } (job-scope) | { taskId } (task-scope)
  featureKey,
  appliedValue,   // 전문의 확정값(미지정 시 suggestedValue 사용)
  suggestedValue,
  confidence,
  analysisBundleVersion = 'mock-6.0-2',
  appliedBy = 'unknown',
  processIds = [],
  clipIds = [],
  analysisJobIds = [],   // 이 제안을 만든 원본 분석 job id(서버 실분석 시). 추론 출처 추적(PR D1).
  editReason,
}) {
  const mod = getModule(moduleId);
  const cfg = mod?.videoMappingConfig;
  if (!cfg?.writeField) {
    throw new Error(`module '${moduleId}' has no videoMappingConfig.writeField`);
  }
  const target = VIDEO_FEATURE_TARGETS[featureKey];
  if (!target || target.moduleId !== moduleId) {
    throw new Error(`featureKey '${featureKey}' does not map to module '${moduleId}'`);
  }

  const finalValue = appliedValue ?? suggestedValue;
  const coerced = cfg.coerce ? cfg.coerce(featureKey, finalValue) : finalValue;

  const moduleData = patient.data.modules[moduleId] || (mod.createModuleData ? mod.createModuleData() : {});
  const { moduleData: nextModuleData, previousValue, targetPath, applied } =
    cfg.writeField(moduleData, ctx, featureKey, coerced);

  // 적용 대상(task 등)이 없으면 모듈 값이 안 바뀌므로 provenance를 남기지 않는다(빈 적용 방지).
  if (applied === false) {
    throw new Error(`apply target not found: ${targetPath}`);
  }

  const appliedInput = {
    moduleId,
    targetPath,
    suggestedValue: suggestedValue ?? null,
    appliedValue: coerced,
    previousValue: previousValue ?? null,
    ...(editReason ? { editReason } : {}),
    unit: target.unit,
    source: 'video',
    processIds,
    clipIds,
    analysisJobIds,
    confidence: confidence ?? 0,
    analysisBundleVersion,
    appliedAt: new Date().toISOString(),
    appliedBy,
  };

  const va = cloneVideoAnalysis(patient);
  va.appliedInputs.push(appliedInput);

  let next = withModuleData(patient, moduleId, nextModuleData);
  next = withVideoAnalysis(next, va);
  return { patient: next, appliedInput };
}

/**
 * appliedInputs 엔트리를 되돌린다(previousValue 복원 + 엔트리 제거). 로컬 rollback(M1).
 * @param {object} patient
 * @param {object|number} ref - appliedInput 엔트리 객체 또는 index
 */
export function rollbackAppliedInput(patient, ref) {
  const list = patient.data.shared.videoAnalysis?.appliedInputs || [];
  const index = typeof ref === 'number' ? ref : list.indexOf(ref);
  if (index < 0 || index >= list.length) return patient;
  const entry = list[index];

  const mod = getModule(entry.moduleId);
  const cfg = mod?.videoMappingConfig;
  let next = patient;

  if (cfg?.writeField) {
    const featureKey = featureKeyFromTargetPath(entry);
    const moduleData = patient.data.modules[entry.moduleId];
    if (moduleData && featureKey) {
      // previousValue를 그대로(coerce 없이) 복원 — 적용 전 값은 이미 모듈 타입.
      const { moduleData: restored } = cfg.writeField(
        moduleData, ctxFromTargetPath(entry), featureKey, entry.previousValue
      );
      next = withModuleData(patient, entry.moduleId, restored);
    }
  }

  const va = cloneVideoAnalysis(next);
  va.appliedInputs.splice(index, 1);
  return withVideoAnalysis(next, va);
}

// targetPath에서 ctx(sharedJobId/taskId) 복원. 형식:
//  modules.<m>.jobExtras[sharedJobId=<id>].<field>  |  modules.<m>.tasks[id=<id>].<field>
function ctxFromTargetPath(entry) {
  const jm = /jobExtras\[sharedJobId=([^\]]+)\]/.exec(entry.targetPath);
  if (jm) return { sharedJobId: jm[1] };
  const tm = /tasks\[id=([^\]]+)\]/.exec(entry.targetPath);
  if (tm) return { taskId: tm[1] };
  return {};
}

// targetPath의 마지막 필드명 → featureKey 역매핑(VIDEO_FEATURE_TARGETS).
function featureKeyFromTargetPath(entry) {
  const field = entry.targetPath.split('.').pop();
  const found = Object.entries(VIDEO_FEATURE_TARGETS).find(
    ([, t]) => t.moduleId === entry.moduleId && t.targetField === field
  );
  return found ? found[0] : null;
}
