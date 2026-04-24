import { getDiagnosisModuleHint } from '../../../core/utils/diagnosisMapping';

export const EXPOSURE_TYPE_OPTIONS = [
  { value: 'shoulder_heavy_load', label: '어깨에 무거운 하중 운반' },
  { value: 'awkward_static_neck_load', label: '장시간 비중립·정적 목 부하' },
];

export const EXPOSURE_TYPE_LABELS = Object.fromEntries(
  EXPOSURE_TYPE_OPTIONS.map(option => [option.value, option.label])
);

function serialize(value) {
  return JSON.stringify(value || null);
}

function normalizeExposureTypes(exposureTypes = []) {
  return (exposureTypes || []).filter(value =>
    EXPOSURE_TYPE_OPTIONS.some(option => option.value === value)
  );
}

export function createCervicalTask(index = 0, sharedJobId = '') {
  return {
    id: Date.now() + Math.random(),
    sharedJobId,
    name: `작업 ${index + 1}`,
    exposure_types: [],
    load_weight_kg: '',
    carry_hours_per_shift: '',
    forced_neck_posture: '',
    neck_nonneutral_hours_per_day: '',
    combined_flexion_rotation_posture: '',
    precision_work: '',
    notes: '',
  };
}

export function createCervicalModuleData() {
  return {
    returnConsiderations: '',
    tasks: [],
  };
}

export function isCervicalDiagnosis(diag) {
  const hint = getDiagnosisModuleHint(diag);
  return hint?.moduleId === 'cervical';
}

export function normalizeCervicalTask(task = {}, index = 0, sharedJobId = '') {
  const normalized = {
    ...createCervicalTask(index, sharedJobId),
    ...(task || {}),
  };

  normalized.sharedJobId = normalized.sharedJobId || sharedJobId;
  normalized.exposure_types = normalizeExposureTypes(normalized.exposure_types);

  return normalized;
}

export function syncCervicalModuleData(moduleData = {}, jobs = []) {
  const firstJobId = jobs[0]?.id || '';
  const jobIds = new Set(jobs.map(job => job.id).filter(Boolean));
  const shouldPrune = jobIds.size > 0;
  const rawTasks = (moduleData.tasks || []).filter(task => {
    if (!shouldPrune) return true;
    if (!task?.sharedJobId) return true;
    return jobIds.has(task.sharedJobId);
  });
  const normalizedTasks = rawTasks.map((task, index) =>
    normalizeCervicalTask(task, index, firstJobId)
  );

  const nextModuleData = {
    returnConsiderations: moduleData?.returnConsiderations || '',
    tasks: normalizedTasks,
  };

  const currentComparable = {
    returnConsiderations: moduleData?.returnConsiderations || '',
    tasks: (moduleData.tasks || []).map(task => ({ ...task })),
  };

  return {
    changed: serialize(currentComparable) !== serialize(nextModuleData),
    moduleData: nextModuleData,
  };
}
