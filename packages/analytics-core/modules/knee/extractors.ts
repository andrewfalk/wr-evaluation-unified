// Raw extractor — knee.relatedness.max 1개 변수(§4). 계획서 §4.2~4.3의 job 3분류와
// 결측 우선순위를 그대로 구현한다.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag, RepeatedObservation } from '../../types';
import { parseStrictIsoDate, compareDate, calculateAgeStrict } from '../../dates';
import { parseWorkPeriodOverride } from '../../workPeriod';
import { resolveKneeCalculationJobs, computeKneeCalc, type KneeCalculationJob } from './derived';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';
import { enumerateDiagnosisSideEntities } from '../../grainEntities';
import { resolveDiagnosisModule, supportsKlGrade } from '../../diagnosisMapping';
import { KNEE_KLG_ORDER } from './metadata';

export function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

/** parseFloat가 아니라 Number — "12kg"·"30minutes"처럼 숫자 접두부만 있는 문자열을 유효로 오인하지 않는다.
 * UI input이 min="0"(JobTab.jsx)이라 음수도 거부해 UI와 일치시킨다. */
export function parseNonNegativeNumber(x: unknown): number | null {
  if (isBlank(x)) return null;
  const parsed = Number(String(x).trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isValidPositivePeriod(job: KneeCalculationJob): boolean {
  const override = job.workPeriodOverride;
  if (!isBlank(override)) {
    return parseWorkPeriodOverride(String(override)) > 0;
  }
  const { startDate, endDate } = job;
  if (isBlank(startDate) || isBlank(endDate)) return false;
  const s = parseStrictIsoDate(String(startDate));
  const e = parseStrictIsoDate(String(endDate));
  if (!s || !e) return false;
  return compareDate(e, s) > 0;
}

export type JobClassification = 'empty' | 'complete' | 'partial';

/** §4.2 — 원본 필드 입력 여부로 판정한다(계산된 기간이 아니라). */
export function classifyKneeJob(job: KneeCalculationJob): JobClassification {
  const noPeriodInput = isBlank(job.workPeriodOverride) && isBlank(job.startDate) && isBlank(job.endDate);
  const noExposureInput = isBlank(job.weight) && isBlank(job.squatting);
  if (noPeriodInput && noExposureInput) return 'empty';

  const complete =
    isValidPositivePeriod(job) &&
    parseNonNegativeNumber(job.weight) !== null &&
    parseNonNegativeNumber(job.squatting) !== null;
  return complete ? 'complete' : 'partial';
}

/** §4.3 결측 우선순위를 그대로 구현한다. */
export function extractKneeRelatednessMax(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<number> {
  const { payload, issues } = migrationResult;

  // 순서 1: unsupported_legacy_spine_jobs — payload는 이 시점 이후 참조하지 않는다.
  if (issues.some((issue) => issue.code === 'unsupported_legacy_spine_jobs')) {
    const qualityFlags: QualityFlag[] = ['legacy_unknown'];
    return { value: null, missing: 'not_assessed', qualityFlags };
  }

  // 순서 2: 무릎 모듈 비활성
  const activeModules = payload.data.activeModules ?? [];
  const kneeModule = payload.data.modules?.knee;
  if (!activeModules.includes('knee') || !kneeModule) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = payload.data.shared ?? {};
  const birthDate = (shared as Record<string, unknown>).birthDate;
  const injuryDate = (shared as Record<string, unknown>).injuryDate;
  const hadBirthDate = !isBlank(birthDate);
  const hadInjuryDate = !isBlank(injuryDate);

  // 순서 3: strict 날짜 검증(형식 실패·없음·음수 나이 전부 포함)
  const age =
    hadBirthDate && hadInjuryDate ? calculateAgeStrict(String(birthDate), String(injuryDate)) : null;
  if (age === null) {
    const qualityFlags: QualityFlag[] = hadBirthDate && hadInjuryDate ? ['invalid'] : [];
    return { value: null, missing: 'not_entered', qualityFlags };
  }

  // 순서 4: 30세 이하는 업무관련성 공식이 정의되지 않는 사업 규칙(조기 반환)
  if (age <= 30) {
    return { value: null, missing: 'not_applicable', qualityFlags: [] };
  }

  // resolveKneeCalculationJobs로 computeKneeCalc와 정확히 같은 배열을 검사한다(§3.1).
  const jobs = resolveKneeCalculationJobs(shared as any, kneeModule as any);
  const classifications = jobs.map(classifyKneeJob);

  // 순서 5: partial job이 하나라도 있으면 전체 not_entered
  if (classifications.includes('partial')) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 6: complete job이 0개(전부 empty)
  if (!classifications.includes('complete')) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 7: 정상 계산 — 필터링 없이 원본 배열 그대로 computeKneeCalc에 넘긴다(UI와 동일 값).
  const result = computeKneeCalc({ shared: shared as any, module: kneeModule as any });
  return { value: Number(result.relatedness.max), missing: null, qualityFlags: [] };
}

// PR0-B3 Part B — diagnosis_side grain. K-L Grade는 무릎 진단(M17 등)에 좌/우 각각 저장되는
// 임상 판단값이라 case가 아니라 이 grain에 속한다(knee/metadata.ts 헤더 주석 — "다중 상병
// 축약 규칙이 필요한데 그건 이 grain이 생기는 PR에서 정한다"는 예고가 이 PR). entity.source를
// 그대로 쓴다(재조회 없음, §핵심 아키텍처 — 엔터티가 원본 참조를 담는다).
export function extractKneeDiagnosisSideKlGrade(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  const activeModules = migrationResult.payload.data.activeModules ?? [];
  return enumerateDiagnosisSideEntities(migrationResult).map((entity) => {
    const { diagnosis, side } = entity.source;
    const moduleId = resolveDiagnosisModule(diagnosis, activeModules)?.moduleId;
    if (moduleId !== 'knee' || !supportsKlGrade(diagnosis)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    // side가 없으면(원본 diag.side 공백) klgRight/klgLeft 중 무엇을 읽을지 알 수 없다.
    if (side === 'unspecified') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    const raw = side === 'right' ? diagnosis.klgRight : diagnosis.klgLeft;
    if (isBlank(raw)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    // AssessmentIndividualFields.jsx의 "N/A"(해당없음) 선택은 등급값이 아니라 "이 side에는
    // K-L Grade가 적용되지 않는다"는 임상 판단이다 — 판정 자체가 없는 경우(moduleId!==knee 등)와
    // 같은 missing 의미로 취급한다(등급 1~4만 순서형 값으로 남기고, "N/A"를 순서에 끼워넣지 않는다).
    if (raw === 'N/A') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    // 3차 리뷰 P1 — KLG_OPTIONS(knee/utils/data.js)가 실제로 제공하는 값은 ''·'N/A'·
    // KNEE_KLG_ORDER(1~4)뿐이다. 그 외(boolean·object·대소문자 오타·트레일링 공백 등)는
    // "값이 있는데 유효한 등급이 아님"이므로 String()으로 그냥 통과시키면 안 된다 —
    // groupPairsByLevel()이 선언된 순서 밖 값을 조용히 버려 이변량과 기술통계의 유효
    // 관측 수가 달라진다. 타입까지 string으로 좁혀야 KNEE_KLG_ORDER.includes가 정확하다
    // (Number 등 다른 원시값이 우연히 같은 문자로 강제변환되는 경우를 배제).
    if (typeof raw === 'string' && (KNEE_KLG_ORDER as readonly string[]).includes(raw)) {
      return { entityKey: entity.entityKey, value: raw, missing: null, qualityFlags: entity.qualityFlags };
    }
    return {
      entityKey: entity.entityKey,
      value: null,
      missing: 'not_entered',
      qualityFlags: [...entity.qualityFlags, 'invalid'],
    };
  });
}

// "상병 상태"(확인/미확인) — AssessmentTab.jsx SideAssessment의 confirmedRight/confirmedLeft.
// 값이 2상태뿐이라 boolean으로 모델링한다 — categorical 타입을 새로 쓰면
// statsBivariateRoles.ts의 resolveLevelOrder가 categorical 순서를 아직 못 주는 문제를
// 그대로 만나므로, 이 변수에서는 그 문제 자체를 피해간다(Part B 착수 시 결정).
export function extractKneeDiagnosisSideConfirmedStatus(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<boolean>[] {
  const activeModules = migrationResult.payload.data.activeModules ?? [];
  return enumerateDiagnosisSideEntities(migrationResult).map((entity) => {
    const { diagnosis, side } = entity.source;
    const moduleId = resolveDiagnosisModule(diagnosis, activeModules)?.moduleId;
    if (moduleId !== 'knee') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    if (side === 'unspecified') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    const raw = side === 'right' ? diagnosis.confirmedRight : diagnosis.confirmedLeft;
    if (isBlank(raw)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    if (raw === 'confirmed') {
      return { entityKey: entity.entityKey, value: true, missing: null, qualityFlags: entity.qualityFlags };
    }
    if (raw === 'unconfirmed') {
      return { entityKey: entity.entityKey, value: false, missing: null, qualityFlags: entity.qualityFlags };
    }
    return {
      entityKey: entity.entityKey,
      value: null,
      missing: 'not_entered',
      qualityFlags: [...entity.qualityFlags, 'invalid'],
    };
  });
}

// "신청≠확정 여부" — 신청상병(code/name)과 확정상병(confirmedCode/confirmedName)이 다른가.
// side와 무관하게 진단 하나에 대해 정해지는 값이므로, side==='both'로 엔터티가 2개(우/좌)
// 생겨도 같은 진단이면 두 행에 동일한 값이 반복된다(진단 레벨 사실을 diagnosis_side grain에
// 투영 — job 레벨 값을 job_diagnosis grain에 투영하는 것과 같은 패턴).
export function extractKneeDiagnosisSideAppliedConfirmedMismatch(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<boolean>[] {
  const activeModules = migrationResult.payload.data.activeModules ?? [];
  return enumerateDiagnosisSideEntities(migrationResult).map((entity) => {
    const { diagnosis } = entity.source;
    const moduleId = resolveDiagnosisModule(diagnosis, activeModules)?.moduleId;
    if (moduleId !== 'knee') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    const confirmedCode = String(diagnosis.confirmedCode ?? '').trim();
    const confirmedName = String(diagnosis.confirmedName ?? '').trim();
    if (confirmedCode === '' && confirmedName === '') {
      // 아직 확정상병 자체가 입력되지 않았다 — 비교할 대상이 없다.
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    const requestedCode = String(diagnosis.code ?? '').trim();
    const requestedName = String(diagnosis.name ?? '').trim();
    const mismatch = confirmedCode !== requestedCode || confirmedName !== requestedName;
    return { entityKey: entity.entityKey, value: mismatch, missing: null, qualityFlags: entity.qualityFlags };
  });
}
