// src/modules/elbow/utils/data.js::syncElbowModuleData(266-362)의 결정적 부분만 독립적으로
// 새로 옮겨 적은 것(§1-3) — 레거시 엔트리 매핑(buildLegacyEntryMap), 신규 엔트리 생성
// (normalizeDiagnosisEntry), BK유형 자동추론(inferElbowBkTypeFromDiagnosis), BK군 대표값
// 자동복사(scoreDiagnosisEntry 기반 donor 선택). `_pendingPreset` 주입과 `changed` 플래그는
// UI 전용 쓰기 트리거라 여기 없다(src/의 원본 syncElbowModuleData는 그대로 잔류).
//
// 원본 syncElbowModuleData는 pendingPreset 적용이 BK 대표값 복사 로직과 같은 루프에
// 인터리브되어 있어 리팩터링(공용 함수 추출) 시 순서를 바꾸면 회귀 위험이 있다 — 그래서
// 코드를 공유하는 대신 이 파일을 원본과 별개로 새로 작성했다. golden characterization
// 테스트(derived.test.ts)가 두 구현의 실제 출력이 일치함을 고정한다.

import type { DiagnosisLike } from '../../diagnosisMapping';
import { resolveDiagnosisModule } from '../../diagnosisMapping';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { EXPOSURE_TYPE_OPTIONS } from './constants';

export interface ElbowDiagnosisEntry {
  diagnosisId?: string;
  selectedBkType?: string;
  bkSelectionMode?: string;
  bkAutoSyncedFrom?: string;
  main_task_name?: string;
  direct_anatomic_link?: string;
  exposure_types?: string[];
  repetition_level?: string;
  daily_exposure_hours?: string | number;
  shift_share_percent?: string | number;
  days_per_week?: string | number;
  work_pattern?: string;
  rest_distribution?: string;
  force_level?: string;
  awkward_posture_level?: string;
  static_holding_level?: string;
  direct_pressure_level?: string;
  vibration_exposure?: string;
  bk2101_cycle_seconds?: string | number;
  bk2101_repetition_per_hour?: string | number;
  bk2101_monotony?: string;
  bk2101_forced_dorsal_extension?: string;
  bk2101_prosupination?: string;
  bk2105_elbow_leaning?: string;
  bk2105_repeated_friction_impact?: string;
  bk2105_pressure_source?: string[];
  bk2106_repeated_mechanical_exposure?: string;
  bk2106_noncorrectable_posture?: string;
  bk2106_prolonged_joint_position?: string;
  bk2106_pressure_source?: string[];
  bk2103_vibration_tool_type?: string[];
  bk2103_daily_vibration_hours?: string | number;
  bk2103_handheld_or_guided?: string;
  bk2103_tool_pressing?: string;
  bk2103_frequent_high_force_grip?: string;
  [key: string]: unknown;
}

export interface ElbowJobEvaluation {
  sharedJobId?: string;
  diagnosisEntries?: ElbowDiagnosisEntry[];
  [key: string]: unknown;
}

export interface ElbowTemporalSequence {
  recent_task_change?: string;
  task_change_date?: string;
  symptom_onset_interval?: string;
  improves_with_rest?: string;
  [key: string]: unknown;
}

export interface ElbowModuleShape {
  returnConsiderations?: string;
  temporalSequence?: ElbowTemporalSequence;
  temporalRelation?: ElbowTemporalSequence; // legacy alias
  jobEvaluations?: ElbowJobEvaluation[];
  // legacy(구형식): job별이 아니라 진단별로 flat하게 저장되던 시절의 잔재
  diagnosisEvaluations?: Array<ElbowDiagnosisEntry & { linkedJobId?: string }>;
  [key: string]: unknown;
}

export interface ElbowDiagnosis extends DiagnosisLike {
  id?: string;
  side?: string;
  confirmedRight?: string;
  confirmedLeft?: string;
  assessmentRight?: string;
  assessmentLeft?: string;
  reasonRight?: unknown[];
  reasonLeft?: unknown[];
}

export interface ElbowJobLike {
  id?: string;
  jobName?: string;
  [key: string]: unknown;
}

export function createElbowTemporalSequence(): ElbowTemporalSequence {
  return {
    recent_task_change: '',
    task_change_date: '',
    symptom_onset_interval: '',
    improves_with_rest: '',
  };
}

export function inferElbowBkTypeFromDiagnosis(diagnosis: ElbowDiagnosis = {}): string {
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

export function createElbowDiagnosisEntry(diagnosis: ElbowDiagnosis = {}): ElbowDiagnosisEntry {
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

export function isElbowDiagnosis(diag: ElbowDiagnosis, activeModules: string[] = []): boolean {
  return resolveDiagnosisModule(diag, activeModules)?.moduleId === 'elbow';
}

function normalizeTemporalSequence(moduleData: ElbowModuleShape = {}): ElbowTemporalSequence {
  return {
    ...createElbowTemporalSequence(),
    ...(moduleData.temporalSequence || moduleData.temporalRelation || {}),
  };
}

function buildLegacyEntryMap(
  moduleData: ElbowModuleShape = {},
  jobs: ElbowJobLike[] = [],
  diagnoses: ElbowDiagnosis[] = [],
): Map<string, ElbowDiagnosisEntry> {
  const legacyMap = new Map<string, ElbowDiagnosisEntry>();
  const firstJobId = jobs[0]?.id || '';
  // 배열 원소가 plain object가 아니면(레거시/외부 입력의 null 등) legacyEntry.diagnosisId
  // 접근에서 예외가 나므로 걸러낸다(§리뷰 지적 — deterministicMigrate는 이 중첩 구조까지
  // 깊이 검증하지 않는다).
  const legacyDiagnoses = (Array.isArray(moduleData.diagnosisEvaluations) ? moduleData.diagnosisEvaluations : []).filter(
    isPlainObject,
  ) as unknown as Array<ElbowDiagnosisEntry & { linkedJobId?: string }>;

  legacyDiagnoses.forEach((legacyEntry) => {
    const diagnosis = diagnoses.find((item) => item.id === legacyEntry.diagnosisId) || { id: legacyEntry.diagnosisId };
    const sharedJobId = legacyEntry.linkedJobId || firstJobId;
    if (!sharedJobId || !legacyEntry.diagnosisId) return;

    const nextEntry: ElbowDiagnosisEntry = {
      ...createElbowDiagnosisEntry(diagnosis),
      ...legacyEntry,
      diagnosisId: legacyEntry.diagnosisId,
      bkSelectionMode: legacyEntry.selectedBkType ? 'manual' : 'auto',
    };
    legacyMap.set(`${sharedJobId}:${legacyEntry.diagnosisId}`, nextEntry);
  });

  return legacyMap;
}

function normalizeDiagnosisEntry(
  existingEntry: ElbowDiagnosisEntry | undefined,
  diagnosis: ElbowDiagnosis,
): ElbowDiagnosisEntry {
  const baseEntry: ElbowDiagnosisEntry = {
    ...createElbowDiagnosisEntry(diagnosis),
    ...(existingEntry || {}),
    diagnosisId: diagnosis.id,
  };
  // exposure_types는 배열이어야 하는데 저장 값이 손상됐거나(예: 문자열 하나만 들어간
  // 레거시 입력) 다른 타입이면 배열 메서드 호출에서 예외가 난다(§리뷰 지적) — 배열이
  // 아니면 빈 배열로 취급한다.
  const rawExposureTypes = Array.isArray(baseEntry.exposure_types) ? baseEntry.exposure_types : [];
  baseEntry.exposure_types = rawExposureTypes.filter((value) =>
    EXPOSURE_TYPE_OPTIONS.some((option) => option.value === value),
  );

  // bk2105_pressure_source/bk2106_pressure_source/bk2103_vibration_tool_type도 배열이어야
  // 한다 — derived.ts의 formatList가 이 값에 .map()을 호출하는데, 손상된 저장값(예: 배열
  // 대신 문자열)이면 "arr.map is not a function"으로 예외가 난다(§리뷰 지적, wrist에서
  // 먼저 발견되어 elbow에도 동일하게 적용). exposure_types와 달리 원본 코드가 이 필드들을
  // 열거값으로 필터링하지 않으므로(계산 로직 재구현 금지) 배열 여부만 보정하고 값 자체는
  // 손대지 않는다.
  const ARRAY_ONLY_FIELDS: Array<keyof ElbowDiagnosisEntry> = [
    'bk2105_pressure_source',
    'bk2106_pressure_source',
    'bk2103_vibration_tool_type',
  ];
  for (const field of ARRAY_ONLY_FIELDS) {
    if (!Array.isArray(baseEntry[field])) {
      baseEntry[field] = [];
    }
  }

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
    if (
      baseEntry.bk2103_frequent_high_force_grip === 'yes' ||
      baseEntry.bk2106_tool_pressing === 'yes' ||
      baseEntry.bk2106_frequent_high_force_grip === 'yes'
    ) {
      baseEntry.bk2103_tool_pressing = 'yes';
    }
  }

  return baseEntry;
}

const BK_GROUP_META_FIELDS = new Set(['diagnosisId', 'selectedBkType', 'bkSelectionMode', 'bkAutoSyncedFrom']);

function scoreDiagnosisEntry(entry: ElbowDiagnosisEntry | null | undefined): number {
  if (!entry) return 0;
  return Object.entries(entry).filter(
    ([key, value]) =>
      !BK_GROUP_META_FIELDS.has(key) && value !== '' && value !== null && !(Array.isArray(value) && value.length === 0),
  ).length;
}

export interface NormalizedElbowModuleData {
  elbowDiagnoses: ElbowDiagnosis[];
  moduleData: {
    returnConsiderations: string;
    temporalSequence: ElbowTemporalSequence;
    jobEvaluations: ElbowJobEvaluation[];
  };
}

// 원본 syncElbowModuleData와 동일한 정규화(대표값 자동복사 포함) — `_pendingPreset` 주입과
// `changed` 플래그(UI 쓰기 트리거)만 제외한다. 이 둘은 계산 결과에 영향을 주지 않는다
// (`_pendingPreset`은 기존 entry가 없을 때만 적용되는데, extractor가 보는 저장된 patient
// 데이터는 항상 클라이언트가 이미 한 번 sync를 거친 뒤의 상태라 이 시점엔 존재하지 않는다).
export function normalizeElbowModuleData(
  moduleData: ElbowModuleShape = {},
  jobs: ElbowJobLike[] = [],
  diagnoses: ElbowDiagnosis[] = [],
  activeModules: string[] = [],
): NormalizedElbowModuleData {
  const elbowDiagnoses = (diagnoses || []).filter((diag) => isElbowDiagnosis(diag, activeModules));
  const temporalSequence = normalizeTemporalSequence(moduleData);
  const legacyEntryMap = buildLegacyEntryMap(moduleData, jobs, elbowDiagnoses);
  // 배열 원소가 plain object가 아니면(레거시/외부 입력의 null, 혹은 jobEvaluations 자체가
  // 손상된 경우) sharedJobId/diagnosisEntries 접근에서 예외가 나므로 걸러낸다(§리뷰 지적).
  const rawJobEvaluations = Array.isArray(moduleData.jobEvaluations) ? moduleData.jobEvaluations : [];
  const sanitizedJobEvaluations = rawJobEvaluations.filter(isPlainObject) as unknown as ElbowJobEvaluation[];
  const existingJobMap = new Map(sanitizedJobEvaluations.map((jobEvaluation) => [jobEvaluation.sharedJobId, jobEvaluation]));

  const nextJobEvaluations: ElbowJobEvaluation[] = (jobs || []).map((job) => {
    const existingJobEvaluation = existingJobMap.get(job.id);
    const rawDiagnosisEntries = Array.isArray(existingJobEvaluation?.diagnosisEntries)
      ? (existingJobEvaluation!.diagnosisEntries as unknown[])
      : [];
    const sanitizedDiagnosisEntries = rawDiagnosisEntries.filter(isPlainObject) as unknown as ElbowDiagnosisEntry[];
    const existingEntryMap = new Map(sanitizedDiagnosisEntries.map((entry) => [entry.diagnosisId, entry]));

    const diagnosisEntries = elbowDiagnoses.map((diagnosis) => {
      const existingEntry = existingEntryMap.get(diagnosis.id) || legacyEntryMap.get(`${job.id}:${diagnosis.id}`);
      const entry = normalizeDiagnosisEntry(existingEntry, diagnosis);
      const bkTypeJustChanged = !!existingEntry && existingEntry.selectedBkType !== entry.selectedBkType;
      return { entry, autoSyncEligible: !existingEntry || bkTypeJustChanged };
    });

    diagnosisEntries.forEach(({ entry, autoSyncEligible }) => {
      if (!autoSyncEligible || !entry.selectedBkType || scoreDiagnosisEntry(entry) > 0) return;
      const donor = diagnosisEntries.reduce<{ entry: ElbowDiagnosisEntry } | null>((best, other) => {
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

    const { _pendingPreset: _unused, ...restJobEval } = existingJobEvaluation || {};
    return {
      ...restJobEval,
      sharedJobId: job.id,
      diagnosisEntries: diagnosisEntries.map(({ entry }) => entry),
    };
  });

  return {
    elbowDiagnoses,
    moduleData: {
      returnConsiderations: moduleData?.returnConsiderations || '',
      temporalSequence,
      jobEvaluations: nextJobEvaluations,
    },
  };
}
