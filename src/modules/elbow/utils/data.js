import { getDiagnosisModuleHint } from '../../../core/utils/diagnosisMapping';

export const BK_TYPE_OPTIONS = [
  { value: '', label: '선택' },
  { value: 'BK2101', label: 'BK2101 상과병변/부착부 건병증' },
  { value: 'BK2103', label: 'BK2103 팔꿈치 골관절염/박리성 골연골염' },
  { value: 'BK2105', label: 'BK2105 팔꿈치 점액낭염' },
  { value: 'BK2106', label: 'BK2106 주관증후군/척골신경병변' },
];

export const BK_TYPE_LABELS = Object.fromEntries(
  BK_TYPE_OPTIONS.filter(option => option.value).map(option => [option.value, option.label])
);

export const EXPOSURE_TYPE_OPTIONS = [
  { value: 'repetition', label: '반복 동작' },
  { value: 'force', label: '힘 사용' },
  { value: 'awkward_posture', label: '비중립 자세' },
];

export const EXPOSURE_TYPE_LABELS = Object.fromEntries(
  EXPOSURE_TYPE_OPTIONS.map(option => [option.value, option.label])
);

export const PRESSURE_SOURCE_OPTIONS = [
  { value: 'hard_surface', label: '딱딱한 표면' },
  { value: 'tool_edge', label: '공구 모서리' },
  { value: 'ground_contact', label: '바닥 접촉' },
  { value: 'carrying_contact', label: '운반 접촉' },
  { value: 'other', label: '기타' },
];

export const PRESSURE_SOURCE_LABELS = Object.fromEntries(
  PRESSURE_SOURCE_OPTIONS.map(option => [option.value, option.label])
);

export const VIBRATION_TOOL_OPTIONS = [
  { value: 'jackhammer', label: '착암기' },
  { value: 'demolition_hammer', label: '파쇄 해머' },
  { value: 'chipping_hammer', label: '치핑 해머' },
  { value: 'tamping_machine', label: '탬핑 머신' },
  { value: 'rotary_hammer', label: '로터리 해머' },
  { value: 'compactor', label: '컴팩터' },
  { value: 'reciprocating_saw', label: '왕복톱' },
  { value: 'rivet_hammer', label: '리벳 해머' },
  { value: 'rust_hammer', label: '러스트 해머' },
  { value: 'powder_actuated_tool', label: '화약식 공구' },
  { value: 'forging_hammer', label: '단조 해머' },
  { value: 'other', label: '기타' },
];

export const VIBRATION_TOOL_LABELS = Object.fromEntries(
  VIBRATION_TOOL_OPTIONS.map(option => [option.value, option.label])
);

export const ELBOW_BRANCH_FIELDS = {
  BK2101: [
    'bk2101_cycle_seconds',
    'bk2101_monotony',
    'static_holding_level',
    'bk2101_forced_dorsal_extension',
    'bk2101_prosupination',
  ],
  BK2105: [
    'bk2105_elbow_leaning',
    'direct_pressure_level',
    'bk2105_pressure_source',
  ],
  BK2106: [
    'static_holding_level',
    'direct_pressure_level',
    'bk2106_pressure_source',
  ],
  BK2103: [
    'vibration_exposure',
    'bk2103_vibration_tool_type',
    'bk2103_daily_vibration_hours',
    'bk2103_tool_pressing',
  ],
};

function serialize(value) {
  return JSON.stringify(value || null);
}

export function createElbowTemporalSequence() {
  return {
    recent_task_change: '',
    task_change_date: '',
    symptom_onset_interval: '',
    improves_with_rest: '',
  };
}

export function createElbowTemporalRelation() {
  return createElbowTemporalSequence();
}

export function inferElbowBkTypeFromDiagnosis(diagnosis = {}) {
  const code = String(diagnosis.code || '').trim().toUpperCase();
  const name = String(diagnosis.name || '').trim();

  if (/^M77\.0/.test(code) || /^M77\.1/.test(code)) return 'BK2101';
  if (/^T75\.2/.test(code)) return 'BK2103';

  if (/점액낭염/.test(name)) return 'BK2105';
  if (/주관증후군|척골신경|압박성\s*단신경병증|단신경병증/.test(name)) return 'BK2106';
  if (/진동성\s*팔꿈치\s*관절병증|팔꿈치\s*골관절염|박리성\s*골연골염/.test(name)) return 'BK2103';
  if (/외측\s*상과염|내측\s*상과염|상과염|테니스\s*엘보|골프\s*엘보|부착부\s*건병증|삽입건병증/.test(name)) return 'BK2101';

  return '';
}

export function createElbowDiagnosisEntry(diagnosis = {}) {
  const inferredBkType = inferElbowBkTypeFromDiagnosis(diagnosis);

  return {
    diagnosisId: diagnosis.id || '',
    selectedBkType: inferredBkType,
    bkSelectionMode: 'auto',
    main_task_name: '',
    direct_anatomic_link: '',
    exposure_types: [],
    repetition_level: '',
    daily_exposure_hours: '',
    shift_share_percent: '',
    days_per_week: '',
    work_pattern: '',
    rest_distribution: '',
    force_level: '',
    awkward_posture_level: '',
    static_holding_level: '',
    direct_pressure_level: '',
    vibration_exposure: '',
    bk2101_cycle_seconds: '',
    bk2101_repetition_per_hour: '',
    bk2101_monotony: '',
    bk2101_forced_dorsal_extension: '',
    bk2101_prosupination: '',
    bk2105_elbow_leaning: '',
    bk2105_repeated_friction_impact: '',
    bk2105_pressure_source: [],
    bk2106_repeated_mechanical_exposure: '',
    bk2106_noncorrectable_posture: '',
    bk2106_prolonged_joint_position: '',
    bk2106_pressure_source: [],
    bk2103_vibration_tool_type: [],
    bk2103_daily_vibration_hours: '',
    bk2103_handheld_or_guided: '',
    bk2103_tool_pressing: '',
    bk2103_frequent_high_force_grip: '',
  };
}

export function createElbowDiagnosisEvaluation(diagnosisId = '') {
  return createElbowDiagnosisEntry({ id: diagnosisId });
}

export function createElbowJobEvaluation(sharedJobId = '') {
  return {
    sharedJobId,
    diagnosisEntries: [],
  };
}

export function createElbowModuleData() {
  return {
    returnConsiderations: '',
    temporalSequence: createElbowTemporalSequence(),
    jobEvaluations: [],
  };
}

export function isElbowDiagnosis(diag) {
  return getDiagnosisModuleHint(diag)?.moduleId === 'elbow';
}

export function resetElbowBranchFields(entry = {}, nextBkType = '') {
  const nextEntry = { ...entry, selectedBkType: nextBkType };

  Object.values(ELBOW_BRANCH_FIELDS).flat().forEach(fieldName => {
    nextEntry[fieldName] = Array.isArray(nextEntry[fieldName]) ? [] : '';
  });

  return nextEntry;
}

function normalizeTemporalSequence(moduleData = {}) {
  return {
    ...createElbowTemporalSequence(),
    ...(moduleData.temporalSequence || moduleData.temporalRelation || {}),
  };
}

function buildLegacyEntryMap(moduleData = {}, jobs = [], diagnoses = []) {
  const legacyMap = new Map();
  const firstJobId = jobs[0]?.id || '';
  const legacyDiagnoses = Array.isArray(moduleData.diagnosisEvaluations)
    ? moduleData.diagnosisEvaluations
    : [];

  legacyDiagnoses.forEach(legacyEntry => {
    const diagnosis = diagnoses.find(item => item.id === legacyEntry.diagnosisId) || { id: legacyEntry.diagnosisId };
    const sharedJobId = legacyEntry.linkedJobId || firstJobId;
    if (!sharedJobId || !legacyEntry.diagnosisId) return;

    const nextEntry = {
      ...createElbowDiagnosisEntry(diagnosis),
      ...legacyEntry,
      diagnosisId: legacyEntry.diagnosisId,
      bkSelectionMode: legacyEntry.selectedBkType ? 'manual' : 'auto',
    };
    legacyMap.set(`${sharedJobId}:${legacyEntry.diagnosisId}`, nextEntry);
  });

  return legacyMap;
}

function normalizeDiagnosisEntry(existingEntry, diagnosis) {
  const baseEntry = {
    ...createElbowDiagnosisEntry(diagnosis),
    ...(existingEntry || {}),
    diagnosisId: diagnosis.id,
  };
  baseEntry.exposure_types = (baseEntry.exposure_types || []).filter(value =>
    EXPOSURE_TYPE_OPTIONS.some(option => option.value === value)
  );

  const inferredBkType = inferElbowBkTypeFromDiagnosis(diagnosis);
  const selectionMode = baseEntry.bkSelectionMode === 'manual' ? 'manual' : 'auto';

  if (selectionMode === 'auto') {
    baseEntry.selectedBkType = inferredBkType;
    baseEntry.bkSelectionMode = 'auto';
  } else if (!baseEntry.selectedBkType) {
    baseEntry.selectedBkType = inferredBkType;
    baseEntry.bkSelectionMode = 'auto';
  } else {
    baseEntry.bkSelectionMode = 'manual';
  }

  if (!baseEntry.bk2103_tool_pressing) {
    if (baseEntry.bk2103_frequent_high_force_grip === 'yes'
      || baseEntry.bk2106_tool_pressing === 'yes'
      || baseEntry.bk2106_frequent_high_force_grip === 'yes') {
      baseEntry.bk2103_tool_pressing = 'yes';
    }
  }

  return baseEntry;
}

export function syncElbowModuleData(moduleData = {}, jobs = [], diagnoses = []) {
  const elbowDiagnoses = (diagnoses || []).filter(isElbowDiagnosis);
  const temporalSequence = normalizeTemporalSequence(moduleData);
  const legacyEntryMap = buildLegacyEntryMap(moduleData, jobs, elbowDiagnoses);
  const existingJobMap = new Map(
    (moduleData.jobEvaluations || []).map(jobEvaluation => [jobEvaluation.sharedJobId, jobEvaluation])
  );

  const nextJobEvaluations = (jobs || []).map(job => {
    const existingJobEvaluation = existingJobMap.get(job.id);
    const existingEntryMap = new Map(
      (existingJobEvaluation?.diagnosisEntries || []).map(entry => [entry.diagnosisId, entry])
    );

    const diagnosisEntries = elbowDiagnoses.map(diagnosis => {
      const existingEntry = existingEntryMap.get(diagnosis.id) || legacyEntryMap.get(`${job.id}:${diagnosis.id}`);
      return normalizeDiagnosisEntry(existingEntry, diagnosis);
    });

    return {
      ...createElbowJobEvaluation(job.id),
      ...(existingJobEvaluation || {}),
      sharedJobId: job.id,
      diagnosisEntries,
    };
  });

  const nextModuleData = {
    returnConsiderations: moduleData?.returnConsiderations || '',
    temporalSequence,
    jobEvaluations: nextJobEvaluations,
  };

  const currentJobEvaluations = Array.isArray(moduleData.jobEvaluations)
    ? moduleData.jobEvaluations.map(jobEvaluation => ({
      ...jobEvaluation,
      diagnosisEntries: (jobEvaluation.diagnosisEntries || []).map(entry => ({ ...entry })),
    }))
    : jobs
      .map(job => {
        const legacyEntries = elbowDiagnoses
          .map(diagnosis => legacyEntryMap.get(`${job.id}:${diagnosis.id}`))
          .filter(Boolean);

        if (legacyEntries.length === 0) return null;

        return {
          sharedJobId: job.id,
          diagnosisEntries: legacyEntries.map(entry => ({ ...entry })),
        };
      })
      .filter(Boolean);

  const currentComparable = {
    returnConsiderations: moduleData?.returnConsiderations || '',
    temporalSequence,
    jobEvaluations: currentJobEvaluations,
  };

  return {
    elbowDiagnoses,
    changed: serialize(currentComparable) !== serialize(nextModuleData),
    moduleData: nextModuleData,
  };
}
