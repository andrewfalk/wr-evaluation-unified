// Raw extractor — elbow.assessment.burdenGradeMax 1개(§1-1). §1-1a 공통 0단계 + elbow 전용
// 우선순위(모듈 비활성 → 진단/직력 없음 → missing 필드 존재 → 정상 계산)를 구현한다.
// anyFlagged(boolean)에서 burdenGradeMax(ordinal)로 대표 변수 교체(2026-09-05 리뷰) —
// diagnosisSummaries[].burdenGrade 중 가장 심각한 등급을 case 값으로 롤업한다.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag, RepeatedObservation } from '../../types';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { computeElbowCalc, type ElbowDiagnosis, type ElbowDiagnosisEntry, type ElbowJobLike, type ElbowModuleShape } from './derived';
import { normalizeElbowModuleData } from './legacyNormalize';
import { ELBOW_BURDEN_GRADE_ORDER } from './metadata';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';
import { enumerateJobDiagnosisEntities, type JobDiagnosisCommonEntry, type JobDiagnosisSource } from '../../grainEntities';
import type { GrainEntity } from '../../types';
import { normalizeJobName } from '../job/extractors';
import { parseStrictIsoDate } from '../../dates';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// null·undefined·공백 문자열만 빈 값으로 본다(9차 검토에서 확립 — isBlank는 String(x)
// 강제변환 때문에 []·[null] 같은 배열도 빈 문자열로 오인해 typeof 검사보다 먼저 걸리면
// 손상값이 invalid 없이 조용히 not_entered로 빠진다).
function isBlankScalar(x: unknown): boolean {
  return x === null || x === undefined || (typeof x === 'string' && x.trim() === '');
}

// §1-1a 공통 0단계 숫자 파싱 규칙이 적용되는 원본 필드 4종(toNumber()로 읽는 값,
// computeDiagnosisFlags/getBk2101RepetitionPerHour가 사용).
const NUMERIC_ENTRY_FIELDS: Array<keyof ElbowDiagnosisEntry> = [
  'daily_exposure_hours',
  'shift_share_percent',
  'bk2101_cycle_seconds',
  'bk2101_repetition_per_hour',
];

export function extractElbowBurdenGradeMax(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const { payload } = migrationResult;

  // 순서 1(공통 0단계): 모듈 비활성 또는 data.modules.elbow가 plain object가 아님.
  const activeModules = payload.data.activeModules ?? [];
  const elbowModule = (payload.data.modules as Record<string, unknown> | undefined)?.elbow;
  if (!activeModules.includes('elbow') || !isPlainObject(elbowModule)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as ElbowJobLike[];
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as ElbowDiagnosis[];

  const synced = normalizeElbowModuleData(elbowModule as ElbowModuleShape, jobs, diagnoses, activeModules);

  // 순서 2: 팔꿈치 진단이 없거나 직력 정보 자체가 없음.
  if (synced.elbowDiagnoses.length === 0 || jobs.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  const sanitizedShared = { ...shared, jobs, diagnoses };
  const result = computeElbowCalc({ shared: sanitizedShared, module: synced.moduleData, activeModules });

  // 순서 3: 시간적 선후관계 공통 필드 미입력, 또는 어느 진단 entry든 필수 필드 미입력.
  const hasMissingDiagnosisFields = result.diagnosisSummaries.some((summary) => summary.missingFields.length > 0);
  if (result.missingCommonFields.length > 0 || hasMissingDiagnosisFields) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 3b(공통 0단계 숫자 파싱, 정상 계산 경로에서만 부가): coercion 이전 원본 문자열을
  // 먼저 본다 — 비어있지 않은데 parseFloat가 NaN이면 invalid qualityFlag. 값 자체는 기존
  // 계산기(toNumber, ||0)와 동일하게 그대로 0으로 계산되도록 둔다(계산 로직 재구현 금지).
  const qualityFlagSet = new Set<QualityFlag>();
  for (const jobEvaluation of synced.moduleData.jobEvaluations) {
    for (const entry of jobEvaluation.diagnosisEntries || []) {
      for (const field of NUMERIC_ENTRY_FIELDS) {
        const raw = entry[field];
        if (isBlank(raw)) continue;
        if (!Number.isFinite(parseFloat(String(raw)))) {
          qualityFlagSet.add('invalid');
        }
      }
    }
  }

  // 순서 4: 정상 계산 — 이 case의 모든 job×진단 조합 중 가장 심각한 등급을 대표값으로 낸다.
  // diagnosisSummaries는 이 시점에 반드시 1개 이상 있다(순서 2에서 진단·직력 없음을 걸렀고,
  // 각 진단은 모든 job에 대해 요약을 만들므로).
  const worstGrade = result.diagnosisSummaries.reduce((worst, summary) => {
    const worstIndex = ELBOW_BURDEN_GRADE_ORDER.indexOf(worst as (typeof ELBOW_BURDEN_GRADE_ORDER)[number]);
    const currentIndex = ELBOW_BURDEN_GRADE_ORDER.indexOf(summary.burdenGrade as (typeof ELBOW_BURDEN_GRADE_ORDER)[number]);
    return currentIndex > worstIndex ? summary.burdenGrade : worst;
  }, result.diagnosisSummaries[0].burdenGrade);

  return { value: worstGrade, missing: null, qualityFlags: Array.from(qualityFlagSet) };
}

// ── PR0-B4 Slice 8a — temporal 4개(case grain). normalizeElbowModuleData가 이미 계산해둔
// temporalSequence ?? temporalRelation 병합 결과(moduleData.temporalSequence)를 그대로
// 읽는다(재구현 금지 — 계획 §6 "temporalSequence/temporalRelation 각각 변수화 금지").
function getElbowTemporalSequence(migrationResult: MigrationResult<AnalysisPatient>) {
  const { payload } = migrationResult;
  const activeModules = payload.data.activeModules ?? [];
  const elbowModule = (payload.data.modules as Record<string, unknown> | undefined)?.elbow;
  if (!activeModules.includes('elbow') || !isPlainObject(elbowModule)) return null;

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as ElbowJobLike[];
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as ElbowDiagnosis[];

  return normalizeElbowModuleData(elbowModule as ElbowModuleShape, jobs, diagnoses, activeModules).moduleData.temporalSequence;
}

const RECENT_TASK_CHANGE_VALUES = ['none', 'increased_load', 'process_change', 'new_task'];

export function extractElbowTemporalRecentTaskChange(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const temporal = getElbowTemporalSequence(migrationResult);
  if (!temporal) return { value: null, missing: 'structural_missing', qualityFlags: [] };
  const raw = temporal.recent_task_change;
  if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string' || !RECENT_TASK_CHANGE_VALUES.includes(raw)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractElbowTemporalTaskChangeDate(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const temporal = getElbowTemporalSequence(migrationResult);
  if (!temporal) return { value: null, missing: 'structural_missing', qualityFlags: [] };
  const raw = temporal.task_change_date;
  if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string' || !parseStrictIsoDate(raw)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractElbowTemporalSymptomOnsetInterval(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const temporal = getElbowTemporalSequence(migrationResult);
  if (!temporal) return { value: null, missing: 'structural_missing', qualityFlags: [] };
  const raw = temporal.symptom_onset_interval;
  if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string') return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractElbowTemporalImprovesWithRest(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<boolean> {
  const temporal = getElbowTemporalSequence(migrationResult);
  if (!temporal) return { value: null, missing: 'structural_missing', qualityFlags: [] };
  const raw = temporal.improves_with_rest;
  if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (raw === 'yes') return { value: true, missing: null, qualityFlags: [] };
  if (raw === 'no') return { value: false, missing: null, qualityFlags: [] };
  return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
}

// ── PR0-B4 Slice 8b — job_diagnosis grain 공통 필드 14개. elbow/wrist가 공유하는 단일
// grain(enumerateJobDiagnosisEntities)이므로, wrist origin entity를 받으면 무조건
// not_applicable을 반환한다(§job_diagnosis 계약 — wrist 쪽도 동일하게 elbow origin에
// not_applicable을 반환).
function extractElbowJobDiagnosisField<T>(
  migrationResult: MigrationResult<AnalysisPatient>,
  compute: (entry: JobDiagnosisCommonEntry) => { value: T | null; missing: MissingReason | null; qualityFlags?: QualityFlag[] },
): RepeatedObservation<T>[] {
  return enumerateJobDiagnosisEntities(migrationResult).map((entity: GrainEntity<JobDiagnosisSource>) => {
    if (entity.source.moduleId !== 'elbow') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    const result = compute(entity.source.entry);
    return {
      entityKey: entity.entityKey,
      value: result.value,
      missing: result.missing,
      qualityFlags: [...entity.qualityFlags, ...(result.qualityFlags || [])],
    };
  });
}

function isDirectAnatomicLinkYes(entry: JobDiagnosisCommonEntry): boolean {
  return entry.direct_anatomic_link === 'yes';
}

// TaskEditor류와 동일한 실제 런타임 게이트 판정(ExposureForm.jsx의
// `(entry.exposure_types || []).includes(value)`) — 손상된 exposure_types도 빈 배열과
// 동일하게 게이트가 닫힌 것으로 본다.
function isExposureTypeSelected(entry: JobDiagnosisCommonEntry, option: string): boolean {
  return Array.isArray(entry.exposure_types) && entry.exposure_types.includes(option);
}

// bkAutoSyncedFrom이 있으면 "자동 복사 표식이 아직 남아있다"는 뜻 — 현재 값이 도너 값과
// 100% 동일하다는 보장은 아니지만(§job_diagnosis 계약 "auto-copy(donor) provenance"),
// BK_GROUP_META_FIELDS(diagnosisId/selectedBkType/bkSelectionMode/bkAutoSyncedFrom)는
// 도너 복사에서 제외되므로 selectedBkType 자체에는 이 플래그를 붙이지 않는다.
function inferredLinkFlags(entry: JobDiagnosisCommonEntry): QualityFlag[] {
  return entry.bkAutoSyncedFrom ? ['inferred_link'] : [];
}

const ELBOW_BK_TYPE_VALUES = ['BK2101', 'BK2103', 'BK2105', 'BK2106'];

export function extractElbowJobDiagnosisSelectedBkType(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    const raw = entry.selectedBkType;
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered' };
    if (typeof raw !== 'string' || !ELBOW_BK_TYPE_VALUES.includes(raw)) {
      return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
    }
    return { value: raw, missing: null };
  });
}

export function extractElbowJobDiagnosisMainTaskName(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry.main_task_name;
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (typeof raw !== 'string') return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    // job.identity.jobNameNormalized 선례 재사용(quasi_identifier 정규화, 재구현 금지).
    return { value: normalizeJobName(raw), missing: null, qualityFlags: flags };
  });
}

export function extractElbowJobDiagnosisDirectAnatomicLink(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<boolean>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    const raw = entry.direct_anatomic_link;
    const flags = inferredLinkFlags(entry);
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (raw === 'yes') return { value: true, missing: null, qualityFlags: flags };
    if (raw === 'no') return { value: false, missing: null, qualityFlags: flags };
    return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
  });
}

function extractElbowExposureTypeOption(
  mr: MigrationResult<AnalysisPatient>,
  option: string,
): RepeatedObservation<boolean>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry)) return { value: null, missing: 'not_applicable' };
    return { value: isExposureTypeSelected(entry, option), missing: null, qualityFlags: inferredLinkFlags(entry) };
  });
}

export function extractElbowJobDiagnosisExposureTypeRepetition(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowExposureTypeOption(mr, 'repetition');
}
export function extractElbowJobDiagnosisExposureTypeForce(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowExposureTypeOption(mr, 'force');
}
export function extractElbowJobDiagnosisExposureTypeAwkwardPosture(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowExposureTypeOption(mr, 'awkward_posture');
}

// repetition_level/awkward_posture_level(occasional/frequent)·force_level(mild/moderate/
// high) — 이중 게이트: direct_anatomic_link!=='yes' 또는 exposure_types에 해당 옵션이
// 없으면 not_applicable.
function extractElbowLevelField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'repetition_level' | 'force_level' | 'awkward_posture_level',
  gateOption: string,
  domain: readonly string[],
): RepeatedObservation<string>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isExposureTypeSelected(entry, gateOption)) {
      return { value: null, missing: 'not_applicable' };
    }
    const flags = inferredLinkFlags(entry);
    const raw = entry[field];
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (typeof raw !== 'string' || !domain.includes(raw)) {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    return { value: raw, missing: null, qualityFlags: flags };
  });
}

const FREQUENCY_LEVEL_VALUES = ['occasional', 'frequent'] as const;
const FORCE_LEVEL_VALUES = ['mild', 'moderate', 'high'] as const;

export function extractElbowJobDiagnosisRepetitionLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowLevelField(mr, 'repetition_level', 'repetition', FREQUENCY_LEVEL_VALUES);
}
export function extractElbowJobDiagnosisForceLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowLevelField(mr, 'force_level', 'force', FORCE_LEVEL_VALUES);
}
export function extractElbowJobDiagnosisAwkwardPostureLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowLevelField(mr, 'awkward_posture_level', 'awkward_posture', FREQUENCY_LEVEL_VALUES);
}

// work_pattern/rest_distribution — direct_anatomic_link 하나만 게이트(exposure_types와
// 무관하게 항상 노출되는 필드, ExposureForm.jsx).
function extractElbowAnatomicGatedStringField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'work_pattern' | 'rest_distribution',
  domain: readonly string[],
): RepeatedObservation<string>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry[field];
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (typeof raw !== 'string' || !domain.includes(raw)) {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    return { value: raw, missing: null, qualityFlags: flags };
  });
}

const WORK_PATTERN_VALUES = ['continuous', 'intermittent', 'mixed'] as const;
const REST_DISTRIBUTION_VALUES = ['adequate', 'moderate', 'insufficient'] as const;

export function extractElbowJobDiagnosisWorkPattern(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowAnatomicGatedStringField(mr, 'work_pattern', WORK_PATTERN_VALUES);
}
export function extractElbowJobDiagnosisRestDistribution(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowAnatomicGatedStringField(mr, 'rest_distribution', REST_DISTRIBUTION_VALUES);
}

// dailyExposureHours(시간, min 0)·shiftSharePercent(%, 0~100)·daysPerWeek(일/주, 0~7) —
// direct_anatomic_link 게이트 + typeof 사전검증(9차 검토 원칙) + 비음수(+상한).
function extractElbowAnatomicGatedNumericField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'daily_exposure_hours' | 'shift_share_percent' | 'days_per_week',
  max?: number,
): RepeatedObservation<number>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry[field];
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || n < 0 || (max !== undefined && n > max)) {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    return { value: n, missing: null, qualityFlags: flags };
  });
}

export function extractElbowJobDiagnosisDailyExposureHours(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowAnatomicGatedNumericField(mr, 'daily_exposure_hours');
}
export function extractElbowJobDiagnosisShiftSharePercent(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowAnatomicGatedNumericField(mr, 'shift_share_percent', 100);
}
export function extractElbowJobDiagnosisDaysPerWeek(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowAnatomicGatedNumericField(mr, 'days_per_week', 7);
}

// ── PR0-B4 Slice 8c — BK유형별 세부 분기 필드. 전부 direct_anatomic_link==='yes'(외곽
// 게이트) + selectedBkType이 해당 유형(내곽 게이트)일 때만 의미가 있다
// (DiseaseSpecificFields.jsx가 selectedBkType별로 완전히 다른 UI를 렌더링). 일부는 그
// 안에서 한 단계 더(direct_pressure_level/vibration_exposure) 게이트된다.
function isBkType(entry: JobDiagnosisCommonEntry, types: readonly string[]): boolean {
  return typeof entry.selectedBkType === 'string' && types.includes(entry.selectedBkType);
}

// direct_pressure_level이 없거나(공백) 'none'이면 압박 원인(pressure_source) 다중선택은
// not_applicable(DiseaseSpecificFields.jsx:65,67 showBk2105/2106PressureSource).
function isPressureGateOpen(entry: JobDiagnosisCommonEntry): boolean {
  const raw = entry.direct_pressure_level;
  return typeof raw === 'string' && raw !== '' && raw !== 'none';
}

// vibration_exposure!=='present'면 진동 공구 세부항목은 not_applicable(:66).
function isVibrationPresent(entry: JobDiagnosisCommonEntry): boolean {
  return entry.vibration_exposure === 'present';
}

const BK2101_TYPES = ['BK2101'] as const;
const BK2103_TYPES = ['BK2103'] as const;
const BK2105_TYPES = ['BK2105'] as const;
const BK2106_TYPES = ['BK2106'] as const;
const STATIC_HOLDING_BK_TYPES = ['BK2101', 'BK2106'] as const;
const ELBOW_PRESSURE_LEVEL_BK_TYPES = ['BK2105', 'BK2106'] as const;

// DiseaseSpecificFields.jsx의 FREQUENCY_OPTIONS — ExposureForm.jsx의 COMMON_FREQUENCY_
// OPTIONS(occasional/frequent 2단계)와는 다른 상수(none 포함 3단계)다. static_holding_level/
// direct_pressure_level 둘 다 이 도메인을 쓴다.
const FREQUENCY_WITH_NONE_VALUES = ['none', 'occasional', 'frequent'] as const;

// static_holding_level(BK2101/BK2106)·direct_pressure_level(BK2105/BK2106) 공용 —
// selectedBkType만 다르고 값 도메인·게이트 구조는 동일하다.
function extractElbowBranchFrequencyField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'static_holding_level' | 'direct_pressure_level',
  bkTypes: readonly string[],
): RepeatedObservation<string>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isBkType(entry, bkTypes)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry[field];
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (typeof raw !== 'string' || !FREQUENCY_WITH_NONE_VALUES.includes(raw as (typeof FREQUENCY_WITH_NONE_VALUES)[number])) {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    return { value: raw, missing: null, qualityFlags: flags };
  });
}

export function extractElbowJobDiagnosisStaticHoldingLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchFrequencyField(mr, 'static_holding_level', STATIC_HOLDING_BK_TYPES);
}
export function extractElbowJobDiagnosisDirectPressureLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchFrequencyField(mr, 'direct_pressure_level', ELBOW_PRESSURE_LEVEL_BK_TYPES);
}

export function extractElbowJobDiagnosisVibrationExposure(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<boolean>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isBkType(entry, BK2103_TYPES)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry.vibration_exposure;
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (raw === 'present') return { value: true, missing: null, qualityFlags: flags };
    if (raw === 'none') return { value: false, missing: null, qualityFlags: flags };
    return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
  });
}

// bk2101_cycle_seconds/bk2101_repetition_per_hour(둘 다 BK2101 전용, 비음수 숫자) —
// bk2101_repetition_per_hour는 UI가 cycle_seconds로부터 매번 재계산해 표시하는 readOnly
// 필드지만, 저장 필드 자체는 레거시 경로로 값이 남아있을 수 있는 raw 값이라 파생 계산
// 없이 그대로 노출한다(재구현 금지).
function extractElbowBk2101NumericField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'bk2101_cycle_seconds' | 'bk2101_repetition_per_hour',
): RepeatedObservation<number>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isBkType(entry, BK2101_TYPES)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry[field];
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || n < 0) {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    return { value: n, missing: null, qualityFlags: flags };
  });
}

export function extractElbowJobDiagnosisBk2101CycleSeconds(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBk2101NumericField(mr, 'bk2101_cycle_seconds');
}
export function extractElbowJobDiagnosisBk2101RepetitionPerHour(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBk2101NumericField(mr, 'bk2101_repetition_per_hour');
}

// yes/no 필드 공용 — BK2101(monotony/forced_dorsal_extension/prosupination),
// BK2105(elbow_leaning), BK2103(tool_pressing/frequent_high_force_grip) 전부 같은
// 값 도메인('yes'/'no')을 쓴다.
function extractElbowBranchYesNoField(
  mr: MigrationResult<AnalysisPatient>,
  field: string,
  bkTypes: readonly string[],
): RepeatedObservation<boolean>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isBkType(entry, bkTypes)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry[field];
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (raw === 'yes') return { value: true, missing: null, qualityFlags: flags };
    if (raw === 'no') return { value: false, missing: null, qualityFlags: flags };
    return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
  });
}

export function extractElbowJobDiagnosisBk2101Monotony(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchYesNoField(mr, 'bk2101_monotony', BK2101_TYPES);
}
export function extractElbowJobDiagnosisBk2101ForcedDorsalExtension(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchYesNoField(mr, 'bk2101_forced_dorsal_extension', BK2101_TYPES);
}
export function extractElbowJobDiagnosisBk2101Prosupination(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchYesNoField(mr, 'bk2101_prosupination', BK2101_TYPES);
}
export function extractElbowJobDiagnosisBk2105ElbowLeaning(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchYesNoField(mr, 'bk2105_elbow_leaning', BK2105_TYPES);
}
export function extractElbowJobDiagnosisBk2103ToolPressing(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchYesNoField(mr, 'bk2103_tool_pressing', BK2103_TYPES);
}
export function extractElbowJobDiagnosisBk2103FrequentHighForceGrip(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchYesNoField(mr, 'bk2103_frequent_high_force_grip', BK2103_TYPES);
}

export function extractElbowJobDiagnosisBk2103DailyVibrationHours(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<number>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isBkType(entry, BK2103_TYPES) || !isVibrationPresent(entry)) {
      return { value: null, missing: 'not_applicable' };
    }
    const flags = inferredLinkFlags(entry);
    const raw = entry.bk2103_daily_vibration_hours;
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    const n = Number(String(raw).trim());
    if (!Number.isFinite(n) || n < 0) {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    return { value: n, missing: null, qualityFlags: flags };
  });
}

// 다중선택 3종 — §다중선택 배열 계약 그대로 적용(undefined→structural_missing,
// 비배열/원소손상→invalid, 정상 배열(빈 배열 포함)→옵션별 true/false + 미지원값은
// legacy_unknown). bk2105_pressure_source/bk2106_pressure_source는 같은 옵션 값
// 집합(PRESSURE_SOURCE_OPTIONS)을 쓰지만 별도 필드·별도 namespace다.
const ELBOW_PRESSURE_SOURCE_OPTIONS = ['hard_surface', 'tool_edge', 'ground_contact', 'carrying_contact', 'other'] as const;
const ELBOW_VIBRATION_TOOL_OPTIONS = [
  'grinder', 'jackhammer', 'demolition_hammer', 'chipping_hammer', 'tamping_machine',
  'rotary_hammer', 'compactor', 'reciprocating_saw', 'rivet_hammer', 'rust_hammer',
  'powder_actuated_tool', 'forging_hammer', 'other',
] as const;

function extractElbowBranchMultiSelectOption(
  mr: MigrationResult<AnalysisPatient>,
  field: string,
  option: string,
  knownOptions: readonly string[],
  isGateOpen: (entry: JobDiagnosisCommonEntry) => boolean,
): RepeatedObservation<boolean>[] {
  return extractElbowJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isGateOpen(entry)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    // normalizeDiagnosisEntry(legacyNormalize.ts)가 이 필드들을 배열 여부만 보정해
    // undefined/비배열 손상값을 조용히 []로 바꿔버리므로, 아래 raw 검사는 이미 정상
    // 배열만 보게 된다 — 보정 직전에 남긴 _corruptedArrayFields 마커로 먼저 판정한다
    // (§다중선택 배열 계약 리뷰 지적, Slice 8c).
    if (Array.isArray(entry._corruptedArrayFields) && entry._corruptedArrayFields.includes(field)) {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    const raw = entry[field];
    if (raw === undefined) return { value: null, missing: 'structural_missing', qualityFlags: flags };
    if (!Array.isArray(raw) || !raw.every((v): v is string => typeof v === 'string')) {
      return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    }
    const legacyUnknown = raw.some((v) => !knownOptions.includes(v));
    const qualityFlags: QualityFlag[] = legacyUnknown ? [...flags, 'legacy_unknown'] : flags;
    return { value: raw.includes(option), missing: null, qualityFlags };
  });
}

function isBk2105PressureSourceGateOpen(entry: JobDiagnosisCommonEntry): boolean {
  return isBkType(entry, BK2105_TYPES) && isPressureGateOpen(entry);
}
function isBk2106PressureSourceGateOpen(entry: JobDiagnosisCommonEntry): boolean {
  return isBkType(entry, BK2106_TYPES) && isPressureGateOpen(entry);
}
function isBk2103VibrationToolGateOpen(entry: JobDiagnosisCommonEntry): boolean {
  return isBkType(entry, BK2103_TYPES) && isVibrationPresent(entry);
}

export function extractElbowJobDiagnosisBk2105PressureSourceHardSurface(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2105_pressure_source', 'hard_surface', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2105PressureSourceGateOpen);
}
export function extractElbowJobDiagnosisBk2105PressureSourceToolEdge(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2105_pressure_source', 'tool_edge', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2105PressureSourceGateOpen);
}
export function extractElbowJobDiagnosisBk2105PressureSourceGroundContact(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2105_pressure_source', 'ground_contact', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2105PressureSourceGateOpen);
}
export function extractElbowJobDiagnosisBk2105PressureSourceCarryingContact(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2105_pressure_source', 'carrying_contact', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2105PressureSourceGateOpen);
}
export function extractElbowJobDiagnosisBk2105PressureSourceOther(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2105_pressure_source', 'other', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2105PressureSourceGateOpen);
}

export function extractElbowJobDiagnosisBk2106PressureSourceHardSurface(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'hard_surface', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}
export function extractElbowJobDiagnosisBk2106PressureSourceToolEdge(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'tool_edge', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}
export function extractElbowJobDiagnosisBk2106PressureSourceGroundContact(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'ground_contact', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}
export function extractElbowJobDiagnosisBk2106PressureSourceCarryingContact(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'carrying_contact', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}
export function extractElbowJobDiagnosisBk2106PressureSourceOther(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'other', ELBOW_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}

export function extractElbowJobDiagnosisBk2103VibrationToolTypeGrinder(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'grinder', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeJackhammer(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'jackhammer', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeDemolitionHammer(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'demolition_hammer', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeChippingHammer(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'chipping_hammer', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeTampingMachine(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'tamping_machine', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeRotaryHammer(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'rotary_hammer', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeCompactor(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'compactor', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeReciprocatingSaw(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'reciprocating_saw', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeRivetHammer(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'rivet_hammer', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeRustHammer(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'rust_hammer', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypePowderActuatedTool(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'powder_actuated_tool', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeForgingHammer(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'forging_hammer', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractElbowJobDiagnosisBk2103VibrationToolTypeOther(mr: MigrationResult<AnalysisPatient>) {
  return extractElbowBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'other', ELBOW_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
