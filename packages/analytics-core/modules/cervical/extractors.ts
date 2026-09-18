// Raw extractor — cervical.case.maxJobCumulativeKgHours 1개(§1-1, §2.1 case-grain 롤업).
// §1-1a 공통 0단계 + cervical 전용 우선순위(모듈 비활성 → 직력 없음 → task 필수필드 미입력
// → 정상 계산)를 구현한다. 작업이 0건인 job/case는 결측이 아니라 유효한 값 0으로 흘러간다
// (계획서 §1-1a cervical 행, buildJobSummary의 "작업 없음=유효 상태" 주석과 동일 원칙).

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag } from '../../types';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { computeCervicalCalc, type CervicalDiagnosis, type CervicalJobLike, type CervicalModuleShape } from './derived';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// §1-1a 공통 0단계 숫자 파싱 규칙이 적용되는 task 원본 필드 3종(toNumber()로 읽는 값).
const NUMERIC_TASK_FIELDS = ['load_weight_kg', 'carry_hours_per_shift', 'neck_nonneutral_hours_per_day'] as const;

export function extractCervicalCaseMaxJobCumulativeKgHours(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<number> {
  const { payload } = migrationResult;

  // 순서 1(공통 0단계): 모듈 비활성 또는 data.modules.cervical이 plain object가 아님.
  const activeModules = payload.data.activeModules ?? [];
  const cervicalModule = (payload.data.modules as Record<string, unknown> | undefined)?.cervical;
  if (!activeModules.includes('cervical') || !isPlainObject(cervicalModule)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as CervicalJobLike[];
  // shared.diagnoses는 이 변수의 값에 영향을 주지 않지만(metadata.ts 근거 참고),
  // isCervicalDiagnosis가 null 원소에서 예외를 던지므로(diagnosisMapping.ts의
  // getDiagnosisModuleHint가 optional chaining 없이 diag.code를 읽음) 방어적으로 걸러낸다.
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as CervicalDiagnosis[];

  // 순서 2: shared.jobs 비어있음 → 직업 정보 자체가 없음.
  if (jobs.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  const sanitizedShared = { ...shared, jobs, diagnoses };
  const result = computeCervicalCalc({ shared: sanitizedShared, module: cervicalModule as CervicalModuleShape, activeModules });

  // 순서 3: task가 있는 job에서 어느 task든 필수 필드 미입력 → not_entered. task가 0건인
  // job/case는 "경추 부담 작업 없음"이라는 유효한 상태이므로 여기 걸리지 않는다(원본
  // buildJobSummary 주석과 동일 원칙 —계획서 §1-1a cervical 행 ③).
  const hasMissingTaskFields = result.jobSummaries.some(
    (jobSummary) => jobSummary.totalTaskCount > 0 && jobSummary.missingFields.length > 0,
  );
  if (hasMissingTaskFields) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 3b(공통 0단계 숫자 파싱, 정상 계산 경로에서만 부가): coercion 이전 원본 문자열을
  // 먼저 본다 — 비어있지 않은데 parseFloat가 NaN이면 invalid qualityFlag. 값 자체는 기존
  // 계산기(toNumber, ||0)와 동일하게 그대로 0으로 계산되도록 둔다(계산 로직 재구현 금지).
  // job.workDaysPerYear는 getTaskCumulativeKgHours(derived.ts)가 `Number(job.workDaysPerYear)
  // || 0`으로 읽는다 — blank든 파싱 불가든 조용히 0으로 흡수되어 "노출은 입력됐는데 분모가
  // 없어서 0"과 "정말로 노출이 낮아서 0"이 구분 안 된다(§리뷰 지적). raw 값을 직접 봐야
  // 하므로 sharedJobId로 원본 job을 조회한다.
  const jobById = new Map(jobs.map((job) => [job.id, job]));

  const qualityFlagSet = new Set<QualityFlag>();
  for (const jobSummary of result.jobSummaries) {
    for (const taskSummary of jobSummary.taskSummaries) {
      for (const field of NUMERIC_TASK_FIELDS) {
        const raw = taskSummary[field];
        if (isBlank(raw)) continue;
        if (!Number.isFinite(parseFloat(String(raw)))) {
          qualityFlagSet.add('invalid');
        }
      }
    }
    // BK2109 핵심 task가 있는 job만 근속기간(yearsExposed)·연간근무일수(workDaysPerYear)를
    // 실제로 소비한다(computeTaskSignals의 `bk2109CoreTask ? getTaskCumulativeKgHours(...)
    // : 0` 게이트). getEffectiveWorkPeriod(shoulder에서 이미 확인된 함정과 동일 함수)는
    // 날짜 문자열이 파싱 불가능하면 NaN을 반환하는데 NaN과의 모든 비교는 항상 false라서
    // `<=0` 검사로는 못 잡는다 — `!(yearsExposed > 0)`로 부정 비교해 NaN도 함께 걸러낸다.
    // 근속기간이 전혀 없거나(0) 파싱 불가(NaN)면 노출은 입력됐는데 측정이 안 되는
    // 상태라 invalid로 표시한다(shoulder 리뷰에서 확립된 것과 동일한 원칙).
    if (jobSummary.hasBk2109CoreTask) {
      if (!(jobSummary.yearsExposed > 0)) {
        qualityFlagSet.add('invalid');
      }
      const rawWorkDaysPerYear = jobById.get(jobSummary.sharedJobId)?.workDaysPerYear;
      if (isBlank(rawWorkDaysPerYear) || !Number.isFinite(Number(rawWorkDaysPerYear))) {
        qualityFlagSet.add('invalid');
      }
    }
  }

  // 순서 4: 정상 계산 — case 내 job들의 누적 총부하량 중 최댓값(작업 0건인 job은 0으로
  // 기여하므로 모든 job이 작업 없음이면 자연히 0이 나온다 — 별도 분기 불필요).
  const maxCumulativeKgHours = Math.max(...result.jobSummaries.map((js) => js.cumulativeKgHours), 0);

  // 최종 안전장치 — job의 근속기간이 NaN이면(위 개별 job 스캔에서 이미 invalid가 붙지만)
  // Math.max 자체가 NaN 오염으로 전체 결과를 NaN으로 만들 수 있다. 이 경우 값을 그대로
  // 내보내지 않고 not_entered로 전환한다(계획서 §1-1a 7라운드의 최종 NaN/Infinity 가드
  // 패턴과 동일 — "어서션"은 예외가 아니라 반환 분기).
  if (!Number.isFinite(maxCumulativeKgHours)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }

  return { value: maxCumulativeKgHours, missing: null, qualityFlags: Array.from(qualityFlagSet) };
}
