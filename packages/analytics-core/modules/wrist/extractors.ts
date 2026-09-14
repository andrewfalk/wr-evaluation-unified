// Raw extractor — wrist.assessment.burdenGradeMax 1개(§1-1). §1-1a 공통 0단계 + wrist 전용
// 우선순위(모듈 비활성 → 진단/직력 없음 → missing 필드 존재 → 정상 계산)를 구현한다.
// elbow와 동일한 이유로 burdenGradeMax(ordinal)를 처음부터 대표 변수로 채택한다(metadata.ts
// 주석 참고) — diagnosisSummaries[].burdenGrade 중 가장 심각한 등급을 case 값으로 롤업.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag, RepeatedObservation } from '../../types';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { computeWristCalc, type WristDiagnosis, type WristDiagnosisEntry, type WristJobLike, type WristModuleShape } from './derived';
import { normalizeWristModuleData } from './legacyNormalize';
import { WRIST_BURDEN_GRADE_ORDER } from './metadata';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';
import { enumerateJobDiagnosisEntities, type JobDiagnosisCommonEntry, type JobDiagnosisSource } from '../../grainEntities';
import type { GrainEntity } from '../../types';
import { normalizeJobName } from '../job/extractors';
import { parseStrictIsoDate } from '../../dates';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// null·undefined·공백 문자열만 빈 값으로 본다(elbow와 동일 원칙 — isBlank의 String(x)
// 강제변환 우회 방지).
function isBlankScalar(x: unknown): boolean {
  return x === null || x === undefined || (typeof x === 'string' && x.trim() === '');
}

// §1-1a 공통 0단계 숫자 파싱 규칙이 적용되는 원본 필드 4종(toNumber()로 읽는 값,
// computeDiagnosisFlags/getBk2101RepetitionPerHour가 사용).
const NUMERIC_ENTRY_FIELDS: Array<keyof WristDiagnosisEntry> = [
  'daily_exposure_hours',
  'shift_share_percent',
  'bk2101_cycle_seconds',
  'bk2101_repetition_per_hour',
];

export function extractWristBurdenGradeMax(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const { payload } = migrationResult;

  // 순서 1(공통 0단계): 모듈 비활성 또는 data.modules.wrist가 plain object가 아님.
  const activeModules = payload.data.activeModules ?? [];
  const wristModule = (payload.data.modules as Record<string, unknown> | undefined)?.wrist;
  if (!activeModules.includes('wrist') || !isPlainObject(wristModule)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as WristJobLike[];
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as WristDiagnosis[];

  const synced = normalizeWristModuleData(wristModule as WristModuleShape, jobs, diagnoses, activeModules);

  // 순서 2: 손목/손가락 진단이 없거나 직력 정보 자체가 없음.
  if (synced.wristDiagnoses.length === 0 || jobs.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  const sanitizedShared = { ...shared, jobs, diagnoses };
  const result = computeWristCalc({ shared: sanitizedShared, module: synced.moduleData, activeModules });

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
    const worstIndex = WRIST_BURDEN_GRADE_ORDER.indexOf(worst as (typeof WRIST_BURDEN_GRADE_ORDER)[number]);
    const currentIndex = WRIST_BURDEN_GRADE_ORDER.indexOf(summary.burdenGrade as (typeof WRIST_BURDEN_GRADE_ORDER)[number]);
    return currentIndex > worstIndex ? summary.burdenGrade : worst;
  }, result.diagnosisSummaries[0].burdenGrade);

  return { value: worstGrade, missing: null, qualityFlags: Array.from(qualityFlagSet) };
}

// ── PR0-B4 Slice 8a — temporal 4개(case grain). elbow와 동일 원칙(정규화된 병합 결과를
// 그대로 읽는다, 재구현 금지).
function getWristTemporalSequence(migrationResult: MigrationResult<AnalysisPatient>) {
  const { payload } = migrationResult;
  const activeModules = payload.data.activeModules ?? [];
  const wristModule = (payload.data.modules as Record<string, unknown> | undefined)?.wrist;
  if (!activeModules.includes('wrist') || !isPlainObject(wristModule)) return null;

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as WristJobLike[];
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as WristDiagnosis[];

  return normalizeWristModuleData(wristModule as WristModuleShape, jobs, diagnoses, activeModules).moduleData.temporalSequence;
}

const RECENT_TASK_CHANGE_VALUES = ['none', 'increased_load', 'process_change', 'new_task'];

export function extractWristTemporalRecentTaskChange(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const temporal = getWristTemporalSequence(migrationResult);
  if (!temporal) return { value: null, missing: 'structural_missing', qualityFlags: [] };
  const raw = temporal.recent_task_change;
  if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string' || !RECENT_TASK_CHANGE_VALUES.includes(raw)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractWristTemporalTaskChangeDate(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const temporal = getWristTemporalSequence(migrationResult);
  if (!temporal) return { value: null, missing: 'structural_missing', qualityFlags: [] };
  const raw = temporal.task_change_date;
  if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string' || !parseStrictIsoDate(raw)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractWristTemporalSymptomOnsetInterval(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const temporal = getWristTemporalSequence(migrationResult);
  if (!temporal) return { value: null, missing: 'structural_missing', qualityFlags: [] };
  const raw = temporal.symptom_onset_interval;
  if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string') return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractWristTemporalImprovesWithRest(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<boolean> {
  const temporal = getWristTemporalSequence(migrationResult);
  if (!temporal) return { value: null, missing: 'structural_missing', qualityFlags: [] };
  const raw = temporal.improves_with_rest;
  if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (raw === 'yes') return { value: true, missing: null, qualityFlags: [] };
  if (raw === 'no') return { value: false, missing: null, qualityFlags: [] };
  return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
}

// ── PR0-B4 Slice 8b — job_diagnosis grain 공통 필드 14개. elbow origin entity를 받으면
// 무조건 not_applicable(§job_diagnosis 계약 — elbow 쪽도 동일하게 wrist origin에
// not_applicable을 반환).
function extractWristJobDiagnosisField<T>(
  migrationResult: MigrationResult<AnalysisPatient>,
  compute: (entry: JobDiagnosisCommonEntry) => { value: T | null; missing: MissingReason | null; qualityFlags?: QualityFlag[] },
): RepeatedObservation<T>[] {
  return enumerateJobDiagnosisEntities(migrationResult).map((entity: GrainEntity<JobDiagnosisSource>) => {
    if (entity.source.moduleId !== 'wrist') {
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

function isExposureTypeSelected(entry: JobDiagnosisCommonEntry, option: string): boolean {
  return Array.isArray(entry.exposure_types) && entry.exposure_types.includes(option);
}

function inferredLinkFlags(entry: JobDiagnosisCommonEntry): QualityFlag[] {
  return entry.bkAutoSyncedFrom ? ['inferred_link'] : [];
}

const WRIST_BK_TYPE_VALUES = ['BK2113', 'BK2101', 'BK2103', 'BK2106'];

export function extractWristJobDiagnosisSelectedBkType(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
    const raw = entry.selectedBkType;
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered' };
    if (typeof raw !== 'string' || !WRIST_BK_TYPE_VALUES.includes(raw)) {
      return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
    }
    return { value: raw, missing: null };
  });
}

export function extractWristJobDiagnosisMainTaskName(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry.main_task_name;
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (typeof raw !== 'string') return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
    return { value: normalizeJobName(raw), missing: null, qualityFlags: flags };
  });
}

export function extractWristJobDiagnosisDirectAnatomicLink(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<boolean>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
    const raw = entry.direct_anatomic_link;
    const flags = inferredLinkFlags(entry);
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (raw === 'yes') return { value: true, missing: null, qualityFlags: flags };
    if (raw === 'no') return { value: false, missing: null, qualityFlags: flags };
    return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
  });
}

function extractWristExposureTypeOption(
  mr: MigrationResult<AnalysisPatient>,
  option: string,
): RepeatedObservation<boolean>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry)) return { value: null, missing: 'not_applicable' };
    return { value: isExposureTypeSelected(entry, option), missing: null, qualityFlags: inferredLinkFlags(entry) };
  });
}

export function extractWristJobDiagnosisExposureTypeRepetition(mr: MigrationResult<AnalysisPatient>) {
  return extractWristExposureTypeOption(mr, 'repetition');
}
export function extractWristJobDiagnosisExposureTypeForce(mr: MigrationResult<AnalysisPatient>) {
  return extractWristExposureTypeOption(mr, 'force');
}
export function extractWristJobDiagnosisExposureTypeAwkwardPosture(mr: MigrationResult<AnalysisPatient>) {
  return extractWristExposureTypeOption(mr, 'awkward_posture');
}

function extractWristLevelField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'repetition_level' | 'force_level' | 'awkward_posture_level',
  gateOption: string,
  domain: readonly string[],
): RepeatedObservation<string>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
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

export function extractWristJobDiagnosisRepetitionLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractWristLevelField(mr, 'repetition_level', 'repetition', FREQUENCY_LEVEL_VALUES);
}
export function extractWristJobDiagnosisForceLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractWristLevelField(mr, 'force_level', 'force', FORCE_LEVEL_VALUES);
}
export function extractWristJobDiagnosisAwkwardPostureLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractWristLevelField(mr, 'awkward_posture_level', 'awkward_posture', FREQUENCY_LEVEL_VALUES);
}

function extractWristAnatomicGatedStringField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'work_pattern' | 'rest_distribution',
  domain: readonly string[],
): RepeatedObservation<string>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
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

export function extractWristJobDiagnosisWorkPattern(mr: MigrationResult<AnalysisPatient>) {
  return extractWristAnatomicGatedStringField(mr, 'work_pattern', WORK_PATTERN_VALUES);
}
export function extractWristJobDiagnosisRestDistribution(mr: MigrationResult<AnalysisPatient>) {
  return extractWristAnatomicGatedStringField(mr, 'rest_distribution', REST_DISTRIBUTION_VALUES);
}

function extractWristAnatomicGatedNumericField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'daily_exposure_hours' | 'shift_share_percent' | 'days_per_week',
  max?: number,
): RepeatedObservation<number>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
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

export function extractWristJobDiagnosisDailyExposureHours(mr: MigrationResult<AnalysisPatient>) {
  return extractWristAnatomicGatedNumericField(mr, 'daily_exposure_hours');
}
export function extractWristJobDiagnosisShiftSharePercent(mr: MigrationResult<AnalysisPatient>) {
  return extractWristAnatomicGatedNumericField(mr, 'shift_share_percent', 100);
}
export function extractWristJobDiagnosisDaysPerWeek(mr: MigrationResult<AnalysisPatient>) {
  return extractWristAnatomicGatedNumericField(mr, 'days_per_week', 7);
}

// ── PR0-B4 Slice 8c — BK유형별 세부 분기 필드. elbow와 동일 설계(direct_anatomic_link
// 외곽 게이트 + selectedBkType 내곽 게이트, 일부는 direct_pressure_level/vibration_exposure
// 로 한 단계 더 게이트). wrist는 BK2105가 없고(direct_pressure_level 게이트가 BK2106만)
// BK2113(수근관증후군, bk2113_repetitive_wrist_motion)이 있다.
function isBkType(entry: JobDiagnosisCommonEntry, types: readonly string[]): boolean {
  return typeof entry.selectedBkType === 'string' && types.includes(entry.selectedBkType);
}

function isPressureGateOpen(entry: JobDiagnosisCommonEntry): boolean {
  const raw = entry.direct_pressure_level;
  return typeof raw === 'string' && raw !== '' && raw !== 'none';
}

function isVibrationPresent(entry: JobDiagnosisCommonEntry): boolean {
  return entry.vibration_exposure === 'present';
}

const BK2101_TYPES = ['BK2101'] as const;
const BK2103_TYPES = ['BK2103'] as const;
const BK2106_TYPES = ['BK2106'] as const;
const BK2113_TYPES = ['BK2113'] as const;
const STATIC_HOLDING_BK_TYPES = ['BK2101', 'BK2106'] as const;
// wrist는 direct_pressure_level 게이트가 BK2106 하나뿐이다(elbow는 BK2105도 포함) —
// DiseaseSpecificFields.jsx 확인 완료.
const WRIST_PRESSURE_LEVEL_BK_TYPES = ['BK2106'] as const;

const FREQUENCY_WITH_NONE_VALUES = ['none', 'occasional', 'frequent'] as const;

function extractWristBranchFrequencyField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'static_holding_level' | 'direct_pressure_level',
  bkTypes: readonly string[],
): RepeatedObservation<string>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
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

export function extractWristJobDiagnosisStaticHoldingLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchFrequencyField(mr, 'static_holding_level', STATIC_HOLDING_BK_TYPES);
}
export function extractWristJobDiagnosisDirectPressureLevel(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchFrequencyField(mr, 'direct_pressure_level', WRIST_PRESSURE_LEVEL_BK_TYPES);
}

export function extractWristJobDiagnosisVibrationExposure(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<boolean>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isBkType(entry, BK2103_TYPES)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry.vibration_exposure;
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (raw === 'present') return { value: true, missing: null, qualityFlags: flags };
    if (raw === 'none') return { value: false, missing: null, qualityFlags: flags };
    return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
  });
}

function extractWristBk2101NumericField(
  mr: MigrationResult<AnalysisPatient>,
  field: 'bk2101_cycle_seconds' | 'bk2101_repetition_per_hour',
): RepeatedObservation<number>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
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

export function extractWristJobDiagnosisBk2101CycleSeconds(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBk2101NumericField(mr, 'bk2101_cycle_seconds');
}
export function extractWristJobDiagnosisBk2101RepetitionPerHour(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBk2101NumericField(mr, 'bk2101_repetition_per_hour');
}

function extractWristBranchYesNoField(
  mr: MigrationResult<AnalysisPatient>,
  field: string,
  bkTypes: readonly string[],
): RepeatedObservation<boolean>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isBkType(entry, bkTypes)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    const raw = entry[field];
    if (isBlankScalar(raw)) return { value: null, missing: 'not_entered', qualityFlags: flags };
    if (raw === 'yes') return { value: true, missing: null, qualityFlags: flags };
    if (raw === 'no') return { value: false, missing: null, qualityFlags: flags };
    return { value: null, missing: 'not_entered', qualityFlags: [...flags, 'invalid'] };
  });
}

export function extractWristJobDiagnosisBk2101Monotony(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchYesNoField(mr, 'bk2101_monotony', BK2101_TYPES);
}
export function extractWristJobDiagnosisBk2101ForcedDorsalExtension(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchYesNoField(mr, 'bk2101_forced_dorsal_extension', BK2101_TYPES);
}
export function extractWristJobDiagnosisBk2101Prosupination(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchYesNoField(mr, 'bk2101_prosupination', BK2101_TYPES);
}
export function extractWristJobDiagnosisBk2103ToolPressing(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchYesNoField(mr, 'bk2103_tool_pressing', BK2103_TYPES);
}
export function extractWristJobDiagnosisBk2103FrequentHighForceGrip(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchYesNoField(mr, 'bk2103_frequent_high_force_grip', BK2103_TYPES);
}
export function extractWristJobDiagnosisBk2113RepetitiveWristMotion(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchYesNoField(mr, 'bk2113_repetitive_wrist_motion', BK2113_TYPES);
}

export function extractWristJobDiagnosisBk2103DailyVibrationHours(
  mr: MigrationResult<AnalysisPatient>,
): RepeatedObservation<number>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
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

const WRIST_PRESSURE_SOURCE_OPTIONS = ['hard_surface', 'tool_edge', 'palm_contact', 'carrying_contact', 'other'] as const;
const WRIST_VIBRATION_TOOL_OPTIONS = [
  'grinder', 'impact_wrench', 'hammer_drill', 'jackhammer', 'polisher', 'sander', 'other',
] as const;

function extractWristBranchMultiSelectOption(
  mr: MigrationResult<AnalysisPatient>,
  field: string,
  option: string,
  knownOptions: readonly string[],
  isGateOpen: (entry: JobDiagnosisCommonEntry) => boolean,
): RepeatedObservation<boolean>[] {
  return extractWristJobDiagnosisField(mr, (entry) => {
    if (!isDirectAnatomicLinkYes(entry) || !isGateOpen(entry)) return { value: null, missing: 'not_applicable' };
    const flags = inferredLinkFlags(entry);
    // normalizeDiagnosisEntry(legacyNormalize.ts)가 이 필드들을 배열 여부만 보정해
    // undefined/비배열 손상값을 조용히 []로 바꿔버리므로, 아래 raw 검사는 이미 정상
    // 배열만 보게 된다 — 보정 직전에 남긴 _corruptedArrayFields 마커로 먼저 판정한다
    // (elbow와 동일, §다중선택 배열 계약 리뷰 지적, Slice 8c).
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

function isBk2106PressureSourceGateOpen(entry: JobDiagnosisCommonEntry): boolean {
  return isBkType(entry, BK2106_TYPES) && isPressureGateOpen(entry);
}
function isBk2103VibrationToolGateOpen(entry: JobDiagnosisCommonEntry): boolean {
  return isBkType(entry, BK2103_TYPES) && isVibrationPresent(entry);
}

export function extractWristJobDiagnosisBk2106PressureSourceHardSurface(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'hard_surface', WRIST_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}
export function extractWristJobDiagnosisBk2106PressureSourceToolEdge(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'tool_edge', WRIST_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}
export function extractWristJobDiagnosisBk2106PressureSourcePalmContact(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'palm_contact', WRIST_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}
export function extractWristJobDiagnosisBk2106PressureSourceCarryingContact(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'carrying_contact', WRIST_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}
export function extractWristJobDiagnosisBk2106PressureSourceOther(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2106_pressure_source', 'other', WRIST_PRESSURE_SOURCE_OPTIONS, isBk2106PressureSourceGateOpen);
}

export function extractWristJobDiagnosisBk2103VibrationToolTypeGrinder(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'grinder', WRIST_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractWristJobDiagnosisBk2103VibrationToolTypeImpactWrench(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'impact_wrench', WRIST_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractWristJobDiagnosisBk2103VibrationToolTypeHammerDrill(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'hammer_drill', WRIST_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractWristJobDiagnosisBk2103VibrationToolTypeJackhammer(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'jackhammer', WRIST_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractWristJobDiagnosisBk2103VibrationToolTypePolisher(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'polisher', WRIST_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractWristJobDiagnosisBk2103VibrationToolTypeSander(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'sander', WRIST_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
export function extractWristJobDiagnosisBk2103VibrationToolTypeOther(mr: MigrationResult<AnalysisPatient>) {
  return extractWristBranchMultiSelectOption(mr, 'bk2103_vibration_tool_type', 'other', WRIST_VIBRATION_TOOL_OPTIONS, isBk2103VibrationToolGateOpen);
}
