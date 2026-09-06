// src/modules/wrist/utils/data.js::syncWristModuleData(252-349)의 결정적 부분만 독립적으로
// 새로 옮겨 적은 것(§1-3, elbow와 동일 패턴) — 레거시 엔트리 매핑(buildLegacyEntryMap),
// 신규 엔트리 생성(normalizeDiagnosisEntry), BK유형 자동추론(inferWristBkTypeFromDiagnosis),
// BK군 대표값 자동복사(scoreDiagnosisEntry 기반 donor 선택). `_pendingPreset` 주입과
// `changed` 플래그는 UI 전용 쓰기 트리거라 여기 없다(src/의 원본 syncWristModuleData는
// 그대로 잔류).
//
// 원본 syncWristModuleData는 pendingPreset 적용이 BK 대표값 복사 로직과 같은 루프에
// 인터리브되어 있어 리팩터링(공용 함수 추출) 시 순서를 바꾸면 회귀 위험이 있다 — 그래서
// 코드를 공유하는 대신 이 파일을 원본과 별개로 새로 작성했다. golden characterization
// 테스트(derived.test.ts)가 두 구현의 실제 출력이 일치함을 고정한다.
//
// elbow 이관(2026-09-05) 리뷰에서 잡힌 함정 — jobEvaluations/diagnosisEntries 배열
// 원소가 plain object가 아니거나 exposure_types가 배열이 아니면 예외가 난다 — 을
// 처음부터 반영한다(isPlainObject 필터 + Array.isArray 가드).

import type { DiagnosisLike } from '../../diagnosisMapping';
import { resolveDiagnosisModule } from '../../diagnosisMapping';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { EXPOSURE_TYPE_OPTIONS } from './constants';

export interface WristDiagnosisEntry {
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
  bk2113_repetitive_wrist_motion?: string;
  bk2101_cycle_seconds?: string | number;
  bk2101_repetition_per_hour?: string | number;
  bk2101_monotony?: string;
  bk2101_forced_dorsal_extension?: string;
  bk2101_prosupination?: string;
  bk2106_pressure_source?: string[];
  bk2103_vibration_tool_type?: string[];
  bk2103_daily_vibration_hours?: string | number;
  bk2103_tool_pressing?: string;
  bk2103_frequent_high_force_grip?: string;
  [key: string]: unknown;
}

export interface WristJobEvaluation {
  sharedJobId?: string;
  diagnosisEntries?: WristDiagnosisEntry[];
  [key: string]: unknown;
}

export interface WristTemporalSequence {
  recent_task_change?: string;
  task_change_date?: string;
  symptom_onset_interval?: string;
  improves_with_rest?: string;
  [key: string]: unknown;
}

export interface WristModuleShape {
  returnConsiderations?: string;
  temporalSequence?: WristTemporalSequence;
  temporalRelation?: WristTemporalSequence; // legacy alias
  jobEvaluations?: WristJobEvaluation[];
  // legacy(구형식): job별이 아니라 진단별로 flat하게 저장되던 시절의 잔재
  diagnosisEvaluations?: Array<WristDiagnosisEntry & { linkedJobId?: string }>;
  [key: string]: unknown;
}

export interface WristDiagnosis extends DiagnosisLike {
  id?: string;
  side?: string;
  confirmedRight?: string;
  confirmedLeft?: string;
  assessmentRight?: string;
  assessmentLeft?: string;
  reasonRight?: unknown[];
  reasonLeft?: unknown[];
}

export interface WristJobLike {
  id?: string;
  jobName?: string;
  [key: string]: unknown;
}

export function createWristTemporalSequence(): WristTemporalSequence {
  return {
    recent_task_change: '',
    task_change_date: '',
    symptom_onset_interval: '',
    improves_with_rest: '',
  };
}

export function inferWristBkTypeFromDiagnosis(diagnosis: WristDiagnosis = {}): string {
  const code = String(diagnosis.code || '').trim().toUpperCase();
  const name = String(diagnosis.name || '').trim();

  if (code === 'G56.0' || /수근관|carpal tunnel|cts/i.test(name)) return 'BK2113';

  if (code === 'M65.3' || code === 'M65.4') return 'BK2101';
  if (/방아쇠|trigger finger|trigger thumb|드퀘르벵|de quervain|건초염|tenosynovitis|tendovaginitis/i.test(name)) {
    return 'BK2101';
  }

  if (
    /kienb[oö]ck|월상골|손목.*관절|wrist arthrosis|wrist arthropathy|손가락.*관절|finger arthrosis|finger arthropathy|hand arthropathy|손가락.*관절염|수지.*관절염|수부.*관절염|finger arthritis|hand arthritis|DIP arthritis|PIP arthritis/i.test(
      name,
    )
  ) {
    return 'BK2103';
  }

  if (/guyon|기용관|ulnar neuropathy at wrist|손목.*척골신경/i.test(name)) return 'BK2106';
  if (code === 'G56.2' && /손목|기용관|guyon|wrist/i.test(name)) return 'BK2106';

  return '';
}

export function createWristDiagnosisEntry(diagnosis: WristDiagnosis = {}): WristDiagnosisEntry {
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

// 원본과 동일 — resolveDiagnosisModule이 결정하지 못하면(코드/이름 매핑 없음, moduleId
// 미지정) BK유형 자동추론 성공 여부로 wrist 소속을 판단한다(elbow보다 한 단계 더 있음).
export function isWristDiagnosis(diag: WristDiagnosis, activeModules: string[] = []): boolean {
  const resolved = resolveDiagnosisModule(diag, activeModules);
  if (resolved?.moduleId === 'wrist') return true;
  if (diag?.moduleId === '__none__' || resolved) return false;
  return Boolean(inferWristBkTypeFromDiagnosis(diag));
}

function normalizeTemporalSequence(moduleData: WristModuleShape = {}): WristTemporalSequence {
  return {
    ...createWristTemporalSequence(),
    ...(moduleData.temporalSequence || moduleData.temporalRelation || {}),
  };
}

function buildLegacyEntryMap(
  moduleData: WristModuleShape = {},
  jobs: WristJobLike[] = [],
  diagnoses: WristDiagnosis[] = [],
): Map<string, WristDiagnosisEntry> {
  const legacyMap = new Map<string, WristDiagnosisEntry>();
  const firstJobId = jobs[0]?.id || '';
  // 배열 원소가 plain object가 아니면(레거시/외부 입력의 null 등) legacyEntry.diagnosisId
  // 접근에서 예외가 나므로 걸러낸다.
  const legacyDiagnoses = (Array.isArray(moduleData.diagnosisEvaluations) ? moduleData.diagnosisEvaluations : []).filter(
    isPlainObject,
  ) as unknown as Array<WristDiagnosisEntry & { linkedJobId?: string }>;

  legacyDiagnoses.forEach((legacyEntry) => {
    const diagnosis = diagnoses.find((item) => item.id === legacyEntry.diagnosisId) || { id: legacyEntry.diagnosisId };
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

function normalizeDiagnosisEntry(
  existingEntry: WristDiagnosisEntry | undefined,
  diagnosis: WristDiagnosis,
): WristDiagnosisEntry {
  const baseEntry: WristDiagnosisEntry = {
    ...createWristDiagnosisEntry(diagnosis),
    ...(existingEntry || {}),
    diagnosisId: diagnosis.id,
  };

  // exposure_types는 배열이어야 하는데 저장 값이 손상됐거나 다른 타입이면 배열 메서드
  // 호출에서 예외가 난다 — 배열이 아니면 빈 배열로 취급한다.
  const rawExposureTypes = Array.isArray(baseEntry.exposure_types) ? baseEntry.exposure_types : [];
  baseEntry.exposure_types = rawExposureTypes.filter((value) =>
    EXPOSURE_TYPE_OPTIONS.some((option) => option.value === value),
  );

  // bk2103_vibration_tool_type/bk2106_pressure_source도 배열이어야 한다 — derived.ts의
  // formatList가 이 값에 .map()을 호출하는데, 손상된 저장값(예: 배열 대신 문자열)이면
  // "arr.map is not a function"으로 예외가 난다(§리뷰 지적). exposure_types와 달리
  // 원본 코드가 이 두 필드를 열거값으로 필터링하지 않으므로(계산 로직 재구현 금지) 배열
  // 여부만 보정하고 값 자체는 손대지 않는다.
  const ARRAY_ONLY_FIELDS: Array<keyof WristDiagnosisEntry> = ['bk2103_vibration_tool_type', 'bk2106_pressure_source'];
  for (const field of ARRAY_ONLY_FIELDS) {
    if (!Array.isArray(baseEntry[field])) {
      baseEntry[field] = [];
    }
  }

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

function scoreDiagnosisEntry(entry: WristDiagnosisEntry | null | undefined): number {
  if (!entry) return 0;
  return Object.entries(entry).filter(
    ([key, value]) =>
      !BK_GROUP_META_FIELDS.has(key) && value !== '' && value !== null && !(Array.isArray(value) && value.length === 0),
  ).length;
}

export interface NormalizedWristModuleData {
  wristDiagnoses: WristDiagnosis[];
  moduleData: {
    returnConsiderations: string;
    temporalSequence: WristTemporalSequence;
    jobEvaluations: WristJobEvaluation[];
  };
}

// 원본 syncWristModuleData와 동일한 정규화(대표값 자동복사 포함) — `_pendingPreset` 주입과
// `changed` 플래그(UI 쓰기 트리거)만 제외한다. 이 둘은 계산 결과에 영향을 주지 않는다
// (`_pendingPreset`은 기존 entry가 없을 때만 적용되는데, extractor가 보는 저장된 patient
// 데이터는 항상 클라이언트가 이미 한 번 sync를 거친 뒤의 상태라 이 시점엔 존재하지 않는다).
export function normalizeWristModuleData(
  moduleData: WristModuleShape = {},
  jobs: WristJobLike[] = [],
  diagnoses: WristDiagnosis[] = [],
  activeModules: string[] = [],
): NormalizedWristModuleData {
  const wristDiagnoses = (diagnoses || []).filter((diag) => isWristDiagnosis(diag, activeModules));
  const temporalSequence = normalizeTemporalSequence(moduleData);
  const legacyEntryMap = buildLegacyEntryMap(moduleData, jobs, wristDiagnoses);
  // 배열 원소가 plain object가 아니면(레거시/외부 입력의 null, 혹은 jobEvaluations 자체가
  // 손상된 경우) sharedJobId/diagnosisEntries 접근에서 예외가 나므로 걸러낸다.
  const rawJobEvaluations = Array.isArray(moduleData.jobEvaluations) ? moduleData.jobEvaluations : [];
  const sanitizedJobEvaluations = rawJobEvaluations.filter(isPlainObject) as unknown as WristJobEvaluation[];
  const existingJobMap = new Map(sanitizedJobEvaluations.map((jobEvaluation) => [jobEvaluation.sharedJobId, jobEvaluation]));

  const nextJobEvaluations: WristJobEvaluation[] = (jobs || []).map((job) => {
    const existingJobEvaluation = existingJobMap.get(job.id);
    const rawDiagnosisEntries = Array.isArray(existingJobEvaluation?.diagnosisEntries)
      ? (existingJobEvaluation!.diagnosisEntries as unknown[])
      : [];
    const sanitizedDiagnosisEntries = rawDiagnosisEntries.filter(isPlainObject) as unknown as WristDiagnosisEntry[];
    const existingEntryMap = new Map(sanitizedDiagnosisEntries.map((entry) => [entry.diagnosisId, entry]));

    const diagnosisEntries = wristDiagnoses.map((diagnosis) => {
      const existingEntry = existingEntryMap.get(diagnosis.id) || legacyEntryMap.get(`${job.id}:${diagnosis.id}`);
      const entry = normalizeDiagnosisEntry(existingEntry, diagnosis);
      const bkTypeJustChanged = !!existingEntry && existingEntry.selectedBkType !== entry.selectedBkType;
      return { entry, autoSyncEligible: !existingEntry || bkTypeJustChanged };
    });

    diagnosisEntries.forEach(({ entry, autoSyncEligible }) => {
      if (!autoSyncEligible || !entry.selectedBkType || scoreDiagnosisEntry(entry) > 0) return;
      const donor = diagnosisEntries.reduce<{ entry: WristDiagnosisEntry } | null>((best, other) => {
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
    wristDiagnoses,
    moduleData: {
      returnConsiderations: moduleData?.returnConsiderations || '',
      temporalSequence,
      jobEvaluations: nextJobEvaluations,
    },
  };
}
