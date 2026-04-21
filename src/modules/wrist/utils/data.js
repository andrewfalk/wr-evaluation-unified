import { getDiagnosisModuleHint } from '../../../core/utils/diagnosisMapping';

export const BK_TYPE_OPTIONS = [
  { value: '', label: '선택' },
  { value: 'BK2113', label: 'BK2113 수근관증후군' },
  { value: 'BK2101', label: 'BK2101 건초염/드퀘르벵/방아쇠수지' },
  { value: 'BK2103', label: 'BK2103 손목/손가락 관절병증' },
  { value: 'BK2106', label: 'BK2106 Guyon canal 압박성 신경병증' },
];

export const BK_TYPE_LABELS = Object.fromEntries(
  BK_TYPE_OPTIONS.filter(option => option.value).map(option => [option.value, option.label])
);

export const EXPOSURE_TYPE_OPTIONS = [
  { value: 'repetition', label: '반복 동작' },
  { value: 'force', label: '힘 사용' },
  { value: 'awkward_posture', label: '부자연스러운 자세' },
];

export const EXPOSURE_TYPE_LABELS = Object.fromEntries(
  EXPOSURE_TYPE_OPTIONS.map(option => [option.value, option.label])
);

export const PRESSURE_SOURCE_OPTIONS = [
  { value: 'hard_surface', label: '딱딱한 표면' },
  { value: 'tool_edge', label: '공구 모서리' },
  { value: 'palm_contact', label: '손바닥 접촉' },
  { value: 'carrying_contact', label: '운반물 접촉' },
  { value: 'other', label: '기타' },
];

export const PRESSURE_SOURCE_LABELS = Object.fromEntries(
  PRESSURE_SOURCE_OPTIONS.map(option => [option.value, option.label])
);

export const VIBRATION_TOOL_OPTIONS = [
  { value: 'grinder', label: '그라인더' },
  { value: 'impact_wrench', label: '임팩트 렌치' },
  { value: 'hammer_drill', label: '해머 드릴' },
  { value: 'jackhammer', label: '착암기' },
  { value: 'polisher', label: '폴리셔' },
  { value: 'sander', label: '샌더' },
  { value: 'other', label: '기타' },
];

export const VIBRATION_TOOL_LABELS = Object.fromEntries(
  VIBRATION_TOOL_OPTIONS.map(option => [option.value, option.label])
);

export const WRIST_BRANCH_FIELDS = {
  BK2113: ['bk2113_repetitive_wrist_motion'],
  BK2101: [
    'bk2101_cycle_seconds',
    'bk2101_monotony',
    'static_holding_level',
    'bk2101_forced_dorsal_extension',
    'bk2101_prosupination',
  ],
  BK2103: [
    'vibration_exposure',
    'bk2103_vibration_tool_type',
    'bk2103_daily_vibration_hours',
    'bk2103_tool_pressing',
  ],
  BK2106: [
    'static_holding_level',
    'direct_pressure_level',
    'bk2106_pressure_source',
  ],
};

function serialize(value) {
  return JSON.stringify(value || null);
}

export function createWristTemporalSequence() {
  return {
    recent_task_change: '',
    task_change_date: '',
    symptom_onset_interval: '',
    improves_with_rest: '',
  };
}

export function inferWristBkTypeFromDiagnosis(diagnosis = {}) {
  const code = String(diagnosis.code || '').trim().toUpperCase();
  const name = String(diagnosis.name || '').trim();

  if (code === 'G56.0' || /수근관|carpal tunnel|cts/i.test(name)) return 'BK2113';

  if (code === 'M65.3' || code === 'M65.4') return 'BK2101';
  if (/방아쇠|trigger finger|trigger thumb|드퀘르벵|de quervain|건초염|tenosynovitis|tendovaginitis/i.test(name)) {
    return 'BK2101';
  }

  if (/kienb[oö]ck|월상골|손목.*관절|wrist arthrosis|wrist arthropathy|손가락.*관절|finger arthrosis|finger arthropathy|hand arthropathy/i.test(name)) {
    return 'BK2103';
  }

  if (/guyon|기용관|ulnar neuropathy at wrist|손목.*척골신경/i.test(name)) return 'BK2106';
  if (code === 'G56.2' && /손목|기용관|guyon|wrist/i.test(name)) return 'BK2106';

  return '';
}

export function createWristDiagnosisEntry(diagnosis = {}) {
  const inferredBkType = inferWristBkTypeFromDiagnosis(diagnosis);

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
    bk2113_repetitive_wrist_motion: '',
    bk2101_cycle_seconds: '',
    bk2101_repetition_per_hour: '',
    bk2101_monotony: '',
    bk2101_forced_dorsal_extension: '',
    bk2101_prosupination: '',
    bk2106_pressure_source: [],
    bk2103_vibration_tool_type: [],
    bk2103_daily_vibration_hours: '',
    bk2103_tool_pressing: '',
    bk2103_frequent_high_force_grip: '',
  };
}

export function createWristDiagnosisEvaluation(diagnosisId = '') {
  return createWristDiagnosisEntry({ id: diagnosisId });
}

export function createWristJobEvaluation(sharedJobId = '') {
  return {
    sharedJobId,
    diagnosisEntries: [],
  };
}

export function createWristModuleData() {
  return {
    returnConsiderations: '',
    temporalSequence: createWristTemporalSequence(),
    jobEvaluations: [],
  };
}

export function isWristDiagnosis(diag) {
  const hint = getDiagnosisModuleHint(diag);
  if (hint?.moduleId === 'wrist') return true;
  return Boolean(inferWristBkTypeFromDiagnosis(diag));
}

export function resetWristBranchFields(entry = {}, nextBkType = '') {
  const nextEntry = { ...entry, selectedBkType: nextBkType };

  Object.values(WRIST_BRANCH_FIELDS).flat().forEach(fieldName => {
    nextEntry[fieldName] = Array.isArray(nextEntry[fieldName]) ? [] : '';
  });

  return nextEntry;
}

function normalizeTemporalSequence(moduleData = {}) {
  return {
    ...createWristTemporalSequence(),
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
      ...createWristDiagnosisEntry(diagnosis),
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
    ...createWristDiagnosisEntry(diagnosis),
    ...(existingEntry || {}),
    diagnosisId: diagnosis.id,
  };

  baseEntry.exposure_types = (baseEntry.exposure_types || []).filter(value =>
    EXPOSURE_TYPE_OPTIONS.some(option => option.value === value)
  );

  const inferredBkType = inferWristBkTypeFromDiagnosis(diagnosis);
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

  if (!baseEntry.bk2103_tool_pressing && baseEntry.bk2103_frequent_high_force_grip === 'yes') {
    baseEntry.bk2103_tool_pressing = 'yes';
  }

  return baseEntry;
}

export function syncWristModuleData(moduleData = {}, jobs = [], diagnoses = []) {
  const wristDiagnoses = (diagnoses || []).filter(isWristDiagnosis);
  const temporalSequence = normalizeTemporalSequence(moduleData);
  const legacyEntryMap = buildLegacyEntryMap(moduleData, jobs, wristDiagnoses);
  const existingJobMap = new Map(
    (moduleData.jobEvaluations || []).map(jobEvaluation => [jobEvaluation.sharedJobId, jobEvaluation])
  );

  const nextJobEvaluations = (jobs || []).map(job => {
    const existingJobEvaluation = existingJobMap.get(job.id);
    const pendingPreset = existingJobEvaluation?._pendingPreset;
    const existingEntryMap = new Map(
      (existingJobEvaluation?.diagnosisEntries || []).map(entry => [entry.diagnosisId, entry])
    );

    const diagnosisEntries = wristDiagnoses.map(diagnosis => {
      const existingEntry = existingEntryMap.get(diagnosis.id) || legacyEntryMap.get(`${job.id}:${diagnosis.id}`);
      const entry = normalizeDiagnosisEntry(existingEntry, diagnosis);

      if (!existingEntry && pendingPreset) {
        for (const key of Object.keys(pendingPreset)) {
          if (key in entry && pendingPreset[key] !== undefined) {
            entry[key] = pendingPreset[key];
          }
        }
      }

      return entry;
    });

    const { _pendingPreset, ...restJobEval } = (existingJobEvaluation || {});
    return {
      ...createWristJobEvaluation(job.id),
      ...restJobEval,
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
        const legacyEntries = wristDiagnoses
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
    wristDiagnoses,
    changed: serialize(currentComparable) !== serialize(nextModuleData),
    moduleData: nextModuleData,
  };
}
