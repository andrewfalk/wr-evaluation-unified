import { resolveDiagnosisModule } from '../../../core/utils/diagnosisMapping';
import { stableStringify } from '../../../core/utils/common';

/** 상병(공용 shared.diagnoses 항목) 가운데 이 파일이 읽는 필드. */
export interface WristDiagnosisLike {
  id?: string;
  code?: string;
  name?: string;
  moduleId?: string | null;
}

/** 직력(shared.jobs 항목) 가운데 이 파일이 읽는 필드. */
export interface WristJobLike {
  id: string;
}

/** 직력 × 상병 한 칸의 입력값(createWristDiagnosisEntry의 모양 + 옛 데이터·자동 복사가 더하는 필드). */
export interface WristDiagnosisEntry {
  diagnosisId: string;
  selectedBkType: string;
  bkSelectionMode: string;
  bkAutoSyncedFrom?: string;
  exposure_types: string[];
  bk2103_tool_pressing: string;
  bk2103_frequent_high_force_grip: string;
  [field: string]: unknown;
}

export interface WristTemporalSequence {
  recent_task_change: string;
  task_change_date: string;
  symptom_onset_interval: string;
  improves_with_rest: string;
}

export interface WristJobEvaluation {
  sharedJobId: string;
  diagnosisEntries: WristDiagnosisEntry[];
  _pendingPreset?: Record<string, unknown>;
  [field: string]: unknown;
}

/** 저장된 모듈 데이터(옛 형식 포함 — temporalRelation·diagnosisEvaluations). */
export interface WristModuleDataInput {
  returnConsiderations?: string;
  temporalSequence?: Partial<WristTemporalSequence>;
  temporalRelation?: Partial<WristTemporalSequence>;
  jobEvaluations?: WristJobEvaluation[];
  diagnosisEvaluations?: Array<Partial<WristDiagnosisEntry> & { diagnosisId: string; linkedJobId?: string }>;
}

export interface WristModuleData {
  returnConsiderations: string;
  temporalSequence: WristTemporalSequence;
  jobEvaluations: WristJobEvaluation[];
}

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

function serialize(value: unknown) {
  return stableStringify(value || null);
}

export function createWristTemporalSequence(): WristTemporalSequence {
  return {
    recent_task_change: '',
    task_change_date: '',
    symptom_onset_interval: '',
    improves_with_rest: '',
  };
}

export function inferWristBkTypeFromDiagnosis(diagnosis: WristDiagnosisLike = {}): string {
  const code = String(diagnosis.code || '').trim().toUpperCase();
  const name = String(diagnosis.name || '').trim();

  if (code === 'G56.0' || /수근관|carpal tunnel|cts/i.test(name)) return 'BK2113';

  if (code === 'M65.3' || code === 'M65.4') return 'BK2101';
  if (/방아쇠|trigger finger|trigger thumb|드퀘르벵|de quervain|건초염|tenosynovitis|tendovaginitis/i.test(name)) {
    return 'BK2101';
  }

  if (/kienb[oö]ck|월상골|손목.*관절|wrist arthrosis|wrist arthropathy|손가락.*관절|finger arthrosis|finger arthropathy|hand arthropathy|손가락.*관절염|수지.*관절염|수부.*관절염|finger arthritis|hand arthritis|DIP arthritis|PIP arthritis/i.test(name)) {
    return 'BK2103';
  }

  if (/guyon|기용관|ulnar neuropathy at wrist|손목.*척골신경/i.test(name)) return 'BK2106';
  if (code === 'G56.2' && /손목|기용관|guyon|wrist/i.test(name)) return 'BK2106';

  return '';
}

export function createWristDiagnosisEntry(diagnosis: WristDiagnosisLike = {}): WristDiagnosisEntry {
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

export function createWristDiagnosisEvaluation(diagnosisId = ''): WristDiagnosisEntry {
  return createWristDiagnosisEntry({ id: diagnosisId });
}

export function createWristJobEvaluation(sharedJobId = ''): WristJobEvaluation {
  return {
    sharedJobId,
    diagnosisEntries: [],
  };
}

export function createWristModuleData(): WristModuleData {
  return {
    returnConsiderations: '',
    temporalSequence: createWristTemporalSequence(),
    jobEvaluations: [],
  };
}

export function isWristDiagnosis(diag: WristDiagnosisLike, activeModules: string[] = []): boolean {
  const resolved = resolveDiagnosisModule(diag, activeModules);
  if (resolved?.moduleId === 'wrist') return true;
  if (diag?.moduleId === '__none__' || resolved) return false;
  return Boolean(inferWristBkTypeFromDiagnosis(diag));
}

export function resetWristBranchFields(entry: Partial<WristDiagnosisEntry> = {}, nextBkType = ''): Partial<WristDiagnosisEntry> {
  const nextEntry: Partial<WristDiagnosisEntry> = { ...entry, selectedBkType: nextBkType };

  Object.values(WRIST_BRANCH_FIELDS).flat().forEach(fieldName => {
    nextEntry[fieldName] = Array.isArray(nextEntry[fieldName]) ? [] : '';
  });

  return nextEntry;
}

function normalizeTemporalSequence(moduleData: WristModuleDataInput = {}): WristTemporalSequence {
  return {
    ...createWristTemporalSequence(),
    ...(moduleData.temporalSequence || moduleData.temporalRelation || {}),
  };
}

function buildLegacyEntryMap(moduleData: WristModuleDataInput = {}, jobs: WristJobLike[] = [], diagnoses: WristDiagnosisLike[] = []) {
  const legacyMap = new Map<string, WristDiagnosisEntry>();
  const firstJobId = jobs[0]?.id || '';
  const legacyDiagnoses = Array.isArray(moduleData.diagnosisEvaluations)
    ? moduleData.diagnosisEvaluations
    : [];

  legacyDiagnoses.forEach(legacyEntry => {
    const diagnosis = diagnoses.find(item => item.id === legacyEntry.diagnosisId) || { id: legacyEntry.diagnosisId };
    const sharedJobId = legacyEntry.linkedJobId || firstJobId;
    if (!sharedJobId || !legacyEntry.diagnosisId) return;

    const nextEntry: WristDiagnosisEntry = {
      ...createWristDiagnosisEntry(diagnosis),
      ...legacyEntry,
      diagnosisId: legacyEntry.diagnosisId,
      bkSelectionMode: legacyEntry.selectedBkType ? 'manual' : 'auto',
    };
    legacyMap.set(`${sharedJobId}:${legacyEntry.diagnosisId}`, nextEntry);
  });

  return legacyMap;
}

function normalizeDiagnosisEntry(existingEntry: WristDiagnosisEntry | undefined, diagnosis: WristDiagnosisLike & { id: string }): WristDiagnosisEntry {
  const baseEntry: WristDiagnosisEntry = {
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

const BK_GROUP_META_FIELDS = new Set(['diagnosisId', 'selectedBkType', 'bkSelectionMode', 'bkAutoSyncedFrom']);

function scoreDiagnosisEntry(entry: WristDiagnosisEntry | undefined): number {
  if (!entry) return 0;
  return Object.entries(entry).filter(([key, value]) =>
    !BK_GROUP_META_FIELDS.has(key) &&
    value !== '' && value !== null &&
    !(Array.isArray(value) && value.length === 0)
  ).length;
}

export function syncWristModuleData(
  moduleData: WristModuleDataInput = {},
  jobs: WristJobLike[] = [],
  diagnoses: Array<WristDiagnosisLike & { id: string }> | null = [],
  activeModules: string[] = [],
) {
  const wristDiagnoses = (diagnoses || []).filter(diag => isWristDiagnosis(diag, activeModules));
  const temporalSequence = normalizeTemporalSequence(moduleData);
  const legacyEntryMap = buildLegacyEntryMap(moduleData, jobs, wristDiagnoses);
  const existingJobMap = new Map<string, WristJobEvaluation>(
    (moduleData.jobEvaluations || []).map(jobEvaluation => [jobEvaluation.sharedJobId, jobEvaluation])
  );

  const nextJobEvaluations = (jobs || []).map(job => {
    const existingJobEvaluation = existingJobMap.get(job.id);
    const pendingPreset = existingJobEvaluation?._pendingPreset;
    const existingEntryMap = new Map<string, WristDiagnosisEntry>(
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

      // 신규 생성 entry뿐 아니라, 진단 코드 변경으로 자동추론 BK유형이 바뀐 기존 entry도 동기화 대상에 포함한다.
      const bkTypeJustChanged = !!existingEntry && existingEntry.selectedBkType !== entry.selectedBkType;
      return { entry, autoSyncEligible: !existingEntry || bkTypeJustChanged };
    });

    // 아직 아무 값도 입력되지 않은 entry가 이미 값이 채워진 동일 BK유형 entry와 같은 그룹으로 묶이면
    // (화면엔 대표값이 채워진 것처럼 보이지만 실제 저장값은 비어있는 상태를 방지하기 위해) 대표값을 즉시 복사한다.
    diagnosisEntries.forEach(({ entry, autoSyncEligible }) => {
      if (!autoSyncEligible || !entry.selectedBkType || scoreDiagnosisEntry(entry) > 0) return;
      const donor = diagnosisEntries.reduce<(typeof diagnosisEntries)[number] | null>((best, other) => {
        if (other.entry === entry || other.entry.selectedBkType !== entry.selectedBkType) return best;
        const score = scoreDiagnosisEntry(other.entry);
        if (score === 0) return best;
        if (!best || score > scoreDiagnosisEntry(best.entry)) return other;
        return best;
      }, null);
      if (!donor) return;
      Object.entries(donor.entry).forEach(([key, value]) => {
        if (BK_GROUP_META_FIELDS.has(key)) return;
        entry[key] = Array.isArray(value) ? [...value] : value;
      });
      entry.bkAutoSyncedFrom = donor.entry.diagnosisId;
    });

    const { _pendingPreset, ...restJobEval } = (existingJobEvaluation || {}) as Partial<WristJobEvaluation>;
    return {
      ...createWristJobEvaluation(job.id),
      ...restJobEval,
      sharedJobId: job.id,
      diagnosisEntries: diagnosisEntries.map(({ entry }) => entry),
    };
  });

  const nextModuleData: WristModuleData = {
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
