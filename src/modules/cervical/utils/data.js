import { getDiagnosisModuleHint } from '../../../core/utils/diagnosisMapping';

export const CERVICAL_SUBTYPE_LABELS = {
  cervical_disc_herniation: '경추간판 탈출증',
  cervical_stenosis: '경추 협착증',
  cervical_other: '경추 질환',
};

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

function clonePresetValue(value) {
  return Array.isArray(value) ? [...value] : value;
}

export function inferCervicalSubtypeFromDiagnosis(diagnosis = {}) {
  const code = String(diagnosis.code || '').trim().toUpperCase();
  const name = String(diagnosis.name || '').trim();

  if (/^M50/.test(code) || /경추.*탈출|목디스크|cervical.*disc|disc herniation/i.test(name)) {
    return 'cervical_disc_herniation';
  }

  if (/협착|stenosis|척수병|myelopathy/i.test(name)) {
    return 'cervical_stenosis';
  }

  return 'cervical_other';
}

export function createCervicalDiagnosisEntry(diagnosis = {}) {
  return {
    diagnosisId: diagnosis.id || '',
    main_task_name: '',
    exposure_types: [],
    load_weight_kg: '',
    carry_hours_per_shift: '',
    forced_neck_posture: '',
    neck_flexion_hours_per_day: '',
    combined_flexion_rotation_posture: '',
    precision_work: '',
    notes: '',
  };
}

export function createCervicalJobEvaluation(sharedJobId = '') {
  return {
    sharedJobId,
    diagnosisEntries: [],
  };
}

export function createCervicalModuleData() {
  return {
    returnConsiderations: '',
    jobEvaluations: [],
  };
}

export function isCervicalDiagnosis(diag) {
  const hint = getDiagnosisModuleHint(diag);
  return hint?.moduleId === 'cervical';
}

function normalizeDiagnosisEntry(existingEntry, diagnosis) {
  const baseEntry = {
    ...createCervicalDiagnosisEntry(diagnosis),
    ...(existingEntry || {}),
    diagnosisId: diagnosis.id,
  };

  baseEntry.exposure_types = (baseEntry.exposure_types || []).filter(value =>
    EXPOSURE_TYPE_OPTIONS.some(option => option.value === value)
  );

  return baseEntry;
}

export function syncCervicalModuleData(moduleData = {}, jobs = [], diagnoses = []) {
  const cervicalDiagnoses = (diagnoses || []).filter(isCervicalDiagnosis);
  const existingJobMap = new Map(
    (moduleData.jobEvaluations || []).map(jobEvaluation => [jobEvaluation.sharedJobId, jobEvaluation])
  );

  const nextJobEvaluations = (jobs || []).map(job => {
    const existingJobEvaluation = existingJobMap.get(job.id);
    const pendingPreset = existingJobEvaluation?._pendingPreset;
    const existingEntryMap = new Map(
      (existingJobEvaluation?.diagnosisEntries || []).map(entry => [entry.diagnosisId, entry])
    );

    const diagnosisEntries = cervicalDiagnoses.map(diagnosis => {
      const existingEntry = existingEntryMap.get(diagnosis.id);
      const entry = normalizeDiagnosisEntry(existingEntry, diagnosis);

      if (!existingEntry && pendingPreset) {
        for (const key of Object.keys(pendingPreset)) {
          if (key in entry && pendingPreset[key] !== undefined) {
            entry[key] = clonePresetValue(pendingPreset[key]);
          }
        }
      }

      return entry;
    });

    const { _pendingPreset, ...restJobEval } = (existingJobEvaluation || {});
    return {
      ...createCervicalJobEvaluation(job.id),
      ...restJobEval,
      sharedJobId: job.id,
      diagnosisEntries,
    };
  });

  const nextModuleData = {
    returnConsiderations: moduleData?.returnConsiderations || '',
    jobEvaluations: nextJobEvaluations,
  };

  const currentComparable = {
    returnConsiderations: moduleData?.returnConsiderations || '',
    jobEvaluations: (moduleData.jobEvaluations || []).map(jobEvaluation => ({
      ...jobEvaluation,
      diagnosisEntries: (jobEvaluation.diagnosisEntries || []).map(entry => ({ ...entry })),
    })),
  };

  return {
    cervicalDiagnoses,
    changed: serialize(currentComparable) !== serialize(nextModuleData),
    moduleData: nextModuleData,
  };
}
