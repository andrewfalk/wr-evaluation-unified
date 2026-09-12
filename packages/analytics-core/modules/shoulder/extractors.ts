// Raw extractor — shoulder.exposure.anyExceeded 1개 변수(§1-1). §1-1a 공통 0단계 +
// shoulder 전용 우선순위(모듈 비활성 → shared.jobs 비어있음 → 정상 계산)를 구현한다.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag, RepeatedObservation } from '../../types';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { computeShoulderCalc, type ShoulderJobExtras } from './derived';
import { getEffectiveWorkPeriod } from '../../workPeriod';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';
import { enumerateDiagnosisSideEntities } from '../../grainEntities';
import { resolveDiagnosisModule, supportsEllmanClass } from '../../diagnosisMapping';
import { SHOULDER_ELLMAN_ORDER } from './metadata';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// §1-1a 공통 0단계 숫자 파싱 규칙이 적용되는 원본 필드 6종(computeJobExposures가 읽는 값).
const NUMERIC_EXTRA_FIELDS: Array<keyof ShoulderJobExtras> = [
  'overheadHours',
  'repetitiveMediumHours',
  'repetitiveFastHours',
  'heavyLoadCount',
  'heavyLoadSeconds',
  'vibrationHours',
];

export function extractShoulderExposureAnyExceeded(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<boolean> {
  const { payload } = migrationResult;

  // 순서 1(공통 0단계): 모듈 비활성 또는 data.modules.shoulder가 plain object가 아님.
  const activeModules = payload.data.activeModules ?? [];
  const shoulderModule = (payload.data.modules as Record<string, unknown> | undefined)?.shoulder;
  if (!activeModules.includes('shoulder') || !isPlainObject(shoulderModule)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  // 순서 2: shared.jobs 비어있음 → 직업 정보 자체가 없음. 배열 원소가 plain object가 아니면
  // (레거시/외부 입력의 null 등) job.id 접근 시 예외가 나므로 제거하고 계산에도 넘기지 않는다.
  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject);
  if (jobs.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 3(공통 0단계 숫자 파싱): coercion 이전 원본 문자열을 먼저 본다 — 비어있지 않은데
  // parseFloat가 NaN이면 invalid qualityFlag. 값 자체는 기존 계산기(parseFloat(x)||0)와
  // 동일하게 그대로 0으로 계산되도록 둔다(계산 로직 재구현 금지).
  const rawJobExtras = Array.isArray((shoulderModule as { jobExtras?: unknown }).jobExtras)
    ? ((shoulderModule as { jobExtras?: unknown[] }).jobExtras as unknown[])
    : [];
  const jobExtras = rawJobExtras.filter(isPlainObject) as unknown as ShoulderJobExtras[];
  const qualityFlagSet = new Set<QualityFlag>();
  let hasAnyExposureEntered = false;
  for (const job of jobs) {
    const extra = jobExtras.find((e) => e.sharedJobId === job.id) ?? {};
    let jobHasExposureEntered = false;
    for (const field of NUMERIC_EXTRA_FIELDS) {
      const raw = extra[field];
      if (isBlank(raw)) continue;
      hasAnyExposureEntered = true;
      jobHasExposureEntered = true;
      if (!Number.isFinite(parseFloat(String(raw)))) {
        qualityFlagSet.add('invalid');
      }
    }
    // 노출값은 입력됐는데 근무기간·연간 근무일수가 없거나 파싱 불가면 계산기가 이 직력의
    // 기여도를 조용히 0으로 취급한다(periodYears=0 또는 NaN, 또는 workDaysPerYear가 비숫자
    // 문자열이면 산술에서 NaN→누적 reduce의 ||0으로 흡수) — "노출 기준 미초과"와 구분되게
    // invalid로 표시한다.
    if (jobHasExposureEntered) {
      const periodYears = getEffectiveWorkPeriod(job);
      // periodYears <= 0으로만 검사하면 NaN(예: startDate: 'abc' → new Date(NaN))을 놓친다
      // — NaN과의 모든 비교는 항상 false라서 <= 0에도 안 걸린다(리뷰 지적). 양수인지를
      // 직접 확인해 NaN을 자동으로 걸러낸다.
      if (!(periodYears > 0)) {
        qualityFlagSet.add('invalid');
      }
      const rawWorkDaysPerYear = job.workDaysPerYear;
      // 실제 계산(computeJobExposures)은 workDaysPerYear를 parseFloat가 아니라
      // `j.workDaysPerYear || 250`로 그대로 산술에 넣는다 — 곱셈 시 JS의 ToNumber
      // 강제변환(Number(), 부분 숫자열 허용 안 함)을 거친다. parseFloat('250days')는
      // 250으로 성공해 버려 실제 산술에서 NaN이 되는 걸 놓치므로(리뷰 지적), 여기서도
      // parseFloat이 아니라 Number()로 같은 변환을 재현해야 한다.
      if (!isBlank(rawWorkDaysPerYear) && !Number.isFinite(Number(String(rawWorkDaysPerYear)))) {
        qualityFlagSet.add('invalid');
      }
    }
  }

  // 순서 3.5: 매칭된 직력 전부에서 노출값 6종이 전혀 입력되지 않았으면 "미평가"다 —
  // 계산기가 0으로 채워 false를 반환해도 그것을 "노출 기준 미초과"로 집계하면 안 된다.
  if (!hasAnyExposureEntered) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 4: 정상 계산 — 필터링(원소 검증)된 배열을 그대로 computeShoulderCalc에 넘긴다(UI와 동일 값).
  const sanitizedShared = { ...shared, jobs };
  const sanitizedModule = { ...(shoulderModule as Record<string, unknown>), jobExtras };
  const result = computeShoulderCalc({ shared: sanitizedShared, module: sanitizedModule });
  return { value: result.anyExceeded, missing: null, qualityFlags: Array.from(qualityFlagSet) };
}

// PR0-B3 Part B — diagnosis_side grain. Ellman Class는 회전근개 진단(M751 등)에 좌/우 각각
// 저장되는 임상 판단값이다 — knee의 K-L Grade와 완전히 같은 패턴(entity.source 재사용,
// side==='unspecified'는 not_entered, "N/A"는 not_applicable로 흡수).
export function extractShoulderDiagnosisSideEllmanClass(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  const activeModules = migrationResult.payload.data.activeModules ?? [];
  return enumerateDiagnosisSideEntities(migrationResult).map((entity) => {
    const { diagnosis, side } = entity.source;
    const moduleId = resolveDiagnosisModule(diagnosis, activeModules)?.moduleId;
    if (moduleId !== 'shoulder' || !supportsEllmanClass(diagnosis)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    if (side === 'unspecified') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    const raw = side === 'right' ? diagnosis.ellmanRight : diagnosis.ellmanLeft;
    if (isBlank(raw)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    // ELLMAN_OPTIONS의 "N/A"(해당없음)도 K-L Grade와 동일하게 등급이 아니라 "이 side에는
    // 적용되지 않는다"는 임상 판단이다 — 순서(Grade 1<2<3<Full)에 끼워넣지 않는다.
    if (raw === 'N/A') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    // 3차 리뷰 P1 — knee.diagnosisSideKlGrade와 동일한 결함(공백·N/A 외 값을 검증 없이
    // String()으로 통과)이 재현됐다. ELLMAN_OPTIONS가 실제로 제공하는 값은 ''·'N/A'·
    // SHOULDER_ELLMAN_ORDER뿐이다 — 그 외는 groupPairsByLevel()이 조용히 버리므로
    // 결측으로 명시해야 한다.
    if (typeof raw === 'string' && (SHOULDER_ELLMAN_ORDER as readonly string[]).includes(raw)) {
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
