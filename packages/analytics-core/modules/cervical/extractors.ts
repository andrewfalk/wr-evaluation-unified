// Raw extractor — cervical case grain 롤업 2개(§1-1, §2.1 case-grain 롤업).
//  · cervical.case.maxJobCumulativeKgHours — BK2109 누적 총부하량의 전 직업 합계
//  · cervical.case.totalNonNeutralHoursPerDay — 비중립 정적 자세 시간(시간/일)의 전 직업·전 작업 합계
// §1-1a 공통 0단계 + cervical 전용 우선순위(모듈 비활성 → 직력 없음 → 손상값 → task 필수필드
// 미입력 → 정상 계산)를 구현한다. 작업이 0건인 job/case는 결측이 아니라 유효한 값 0으로
// 흘러간다(계획서 §1-1a cervical 행, buildJobSummary의 "작업 없음=유효 상태" 주석과 동일 원칙).
//
// 손상값 정책: 예측 코호트(statsPredictionCohort)는 missing만 보고 qualityFlags는 보지 않으므로
// 손상 입력은 value가 아니라 결측(not_entered + invalid)으로 반환한다. 손상 여부는 필수필드
// 미입력보다 먼저 판정한다 — 그렇지 않으면 name:''와 load_weight_kg:'abc'가 함께 있을 때
// invalid가 사라지고 not_entered만 남는다. 숫자 검증은 계산기의 toNumber(parseFloat)가 아니라
// numericInput.ts의 엄격 파서를 쓴다('45kg'·[45]·음수를 통과시키지 않는다).

import type { ExtractedValue, MissingReason, MigrationResult } from '../../types';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { computeCervicalCalc, type CervicalDiagnosis, type CervicalJobLike, type CervicalModuleShape } from './derived';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';
import { parseStrictNonNegative } from '../../numericInput';
import { getEvaluatedRawCervicalTasks, validateRawCervicalTaskExposure } from './rawTasks';
import { hasNoEvaluableJobs } from '../../jobScope';

const HEAVY_LOAD_TYPE = 'shoulder_heavy_load';
const AWKWARD_NECK_TYPE = 'awkward_static_neck_load';

// 누적 총부하량 계산에 쓰이는 task 수치 필드. 기존 계산기(derived.ts toNumber)는 parseFloat로 읽어
// 검증 파서(Number())와 해석이 다르다 — '0x2d'(=45)·'0x2'(=2)·'0b10'(=2)가 검증은 통과하는데
// 계산에서는 0이 되어 정상 데이터가 "정상적인 0"으로 나갔다. 검증을 통과한 수치를 숫자로 바꿔
// 계산기에 넘기면 검증과 계산이 같은 값을 쓴다(계산 로직 재구현 없이). blank·invalid는 그대로 둔다
// (blank는 필수필드/blank 검사, invalid는 손상 검사가 처리).
const STRICT_NUMERIC_TASK_FIELDS = ['load_weight_kg', 'carry_hours_per_shift'] as const;

function withStrictNumericTaskFields(cervicalModule: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(cervicalModule.tasks)) return cervicalModule;
  const tasks = cervicalModule.tasks.map((task: unknown) => {
    if (!isPlainObject(task)) return task;
    const next: Record<string, unknown> = { ...task };
    for (const field of STRICT_NUMERIC_TASK_FIELDS) {
      const parsed = parseStrictNonNegative(task[field]);
      if (parsed.kind === 'value') next[field] = parsed.value;
    }
    return next;
  });
  return { ...cervicalModule, tasks };
}

// 호출마다 새 객체를 반환한다(qualityFlags 배열을 호출자가 변경해도 공유 상수가 오염되지 않게).
function notEnteredInvalid(): ExtractedValue<number> {
  return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
}

interface CervicalCaseInputs {
  cervicalModule: Record<string, unknown>;
  activeModules: string[];
  shared: Record<string, unknown>;
  jobs: CervicalJobLike[];
  diagnoses: CervicalDiagnosis[];
}

// §1-1a 공통 0단계 + 순서 2 — 두 변수가 공유하는 부분(모듈 활성 여부 → 직업 존재 여부)만 여기에 둔다.
// task 필수필드 검사 등 이후 단계는 변수별로 다르다(비중립 시간은 하중·정밀작업 필드와 무관).
function readCervicalCaseInputs(
  migrationResult: MigrationResult<AnalysisPatient>,
): { early: ExtractedValue<number> } | { inputs: CervicalCaseInputs } {
  const { payload } = migrationResult;

  // 순서 1(공통 0단계): 모듈 비활성 또는 data.modules.cervical이 plain object가 아님.
  const activeModules = payload.data.activeModules ?? [];
  const cervicalModule = (payload.data.modules as Record<string, unknown> | undefined)?.cervical;
  if (!activeModules.includes('cervical') || !isPlainObject(cervicalModule)) {
    const missing: MissingReason = 'structural_missing';
    return { early: { value: null, missing, qualityFlags: [] } };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as CervicalJobLike[];
  // shared.diagnoses는 이 변수의 값에 영향을 주지 않지만(metadata.ts 근거 참고),
  // isCervicalDiagnosis가 null 원소에서 예외를 던지므로(diagnosisMapping.ts의
  // getDiagnosisModuleHint가 optional chaining 없이 diag.code를 읽음) 방어적으로 걸러낸다.
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as CervicalDiagnosis[];

  // 신체부담평가 미포함: 모든 직력이 제외되면 평가 대상이 없다 — 직업 정보 없음(not_entered)과 구분해 not_applicable.
  if (hasNoEvaluableJobs(jobs)) {
    return { early: { value: null, missing: 'not_applicable', qualityFlags: [] } };
  }

  // 순서 2: shared.jobs 비어있음 → 직업 정보 자체가 없음.
  if (jobs.length === 0) {
    return { early: { value: null, missing: 'not_entered', qualityFlags: [] } };
  }

  return { inputs: { cervicalModule, activeModules, shared, jobs, diagnoses } };
}

// 키 이름은 "max"로 남아 있지만 값은 전 직업의 합계다(사용자 요청 — UI의 "BK2109 누적 총부하량
// 합계"(overallCumulativeKgHours)와 일치). 키·함수명을 바꾸지 않은 이유는 knee.relatedness.max
// (최댓값→평균 변경, knee/extractors.ts 주석)와 같다 — 이 키가 서버·클라이언트 테스트 픽스처로
// 광범위하게 쓰여 리네임의 변경 범위가 계산값 교체에 비해 불균형하게 크다.
// 주의: 레시피에는 카탈로그 버전 필드가 없어 같은 레시피가 새 의미(합계)로 재실행된다 —
// 특히 최댓값 기준으로 저장된 필터 임계값은 선택 대상이 달라질 수 있다(CATALOG_VERSION은
// 실행 캐시만 분리한다).
export function extractCervicalCaseMaxJobCumulativeKgHours(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<number> {
  const read = readCervicalCaseInputs(migrationResult);
  if ('early' in read) return read.early;
  const { cervicalModule, activeModules, shared, jobs, diagnoses } = read.inputs;

  // 순서 3a: 정규화 전 원본 exposure_types 검증 — 정규화가 손상값을 []로 바꿔 BK2109 대상 작업이
  // 조용히 사라지는(= 누적 0) 경로를 막는다. 직업 연결은 정규화와 같은 규칙(rawTasks.ts).
  if (!validateRawCervicalTaskExposure(getEvaluatedRawCervicalTasks(cervicalModule, jobs))) {
    return notEnteredInvalid();
  }

  const sanitizedShared = { ...shared, jobs, diagnoses };
  const result = computeCervicalCalc({
    shared: sanitizedShared,
    module: withStrictNumericTaskFields(cervicalModule) as CervicalModuleShape,
    activeModules,
  });

  // 순서 3b: 이 변수의 계산에 쓰이는 원본 입력의 손상 검사(필수필드 미입력보다 먼저).
  // jobSummaries[].taskSummaries는 현재 직업에 연결된 정규화 task라 고아 작업은 이미 제외돼 있다.
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  let hasInvalid = false;
  // 필수 수치(하중·운반시간)가 공백 문자열/탭이면 엄격 파서는 blank로 보지만 기존 필수필드 검사
  // (derived.ts hasValue)는 ''·null·undefined·[]만 빈값이라 공백을 "입력됨"으로 본다 — 그대로 두면
  // 공백 하중이 계산기에서 0이 되어 value 0(결측 아님)으로 나간다. blank를 별도로 기록해 아래에서
  // not_entered로 반환한다(invalid가 있으면 invalid 우선).
  let hasBlankRequiredNumeric = false;
  for (const jobSummary of result.jobSummaries) {
    for (const taskSummary of jobSummary.taskSummaries) {
      // 하중·운반시간은 shoulder_heavy_load가 선택된 작업만 검증 — 비중립 전용 작업에 남은
      // 숨은 stale 값(load_weight_kg:'abc' 등)이 정상 누적부하량 전체를 죽이지 않게 한다.
      // blank는 invalid가 아니라 필수 수치 미입력(hasBlankRequiredNumeric)으로 처리된다.
      if (!(taskSummary.exposure_types ?? []).includes(HEAVY_LOAD_TYPE)) continue;
      for (const field of STRICT_NUMERIC_TASK_FIELDS) {
        const parsed = parseStrictNonNegative(taskSummary[field]);
        if (parsed.kind === 'invalid') hasInvalid = true;
        else if (parsed.kind === 'blank') hasBlankRequiredNumeric = true;
      }
    }
    // BK2109 핵심 task가 있는 job만 근속기간(yearsExposed)·연간근무일수(workDaysPerYear)를
    // 실제로 소비한다(computeTaskSignals의 `bk2109CoreTask ? getTaskCumulativeKgHours(...)
    // : 0` 게이트). getEffectiveWorkPeriod는 날짜 문자열이 파싱 불가능하면 NaN을 반환하는데
    // NaN과의 모든 비교는 항상 false라서 `<=0` 검사로는 못 잡는다 — `!(yearsExposed > 0)`로
    // 부정 비교해 NaN도 함께 걸러낸다. workDaysPerYear는 계산기가 `Number(x) || 0`로 읽어
    // blank·비숫자·'250days'를 조용히 0으로 흡수하므로 원본을 엄격 파서로 직접 본다(blank도 invalid).
    if (jobSummary.hasBk2109CoreTask) {
      if (!(jobSummary.yearsExposed > 0)) hasInvalid = true;
      if (parseStrictNonNegative(jobById.get(jobSummary.sharedJobId)?.workDaysPerYear).kind !== 'value') {
        hasInvalid = true;
      }
    }
  }
  if (hasInvalid) return notEnteredInvalid();

  // 순서 4: task가 있는 job에서 어느 task든 필수 필드 미입력 → not_entered. task가 0건인
  // job/case는 "경추 부담 작업 없음"이라는 유효한 상태이므로 여기 걸리지 않는다(원본
  // buildJobSummary 주석과 동일 원칙 —계획서 §1-1a cervical 행 ③).
  const hasMissingTaskFields = result.jobSummaries.some(
    (jobSummary) => jobSummary.totalTaskCount > 0 && jobSummary.missingFields.length > 0,
  );
  if (hasMissingTaskFields || hasBlankRequiredNumeric) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 5: 정상 계산 — case 내 모든 job의 누적 총부하량 합계(작업 0건인 job은 0으로 기여하므로
  // 모든 job이 작업 없음이면 자연히 0). computeCervicalCalc().overallCumulativeKgHours는
  // `(js.cumulativeKgHours || 0)`로 NaN을 0으로 삼키므로 쓰지 않고 직접 합산한다.
  const totalCumulativeKgHours = result.jobSummaries.reduce((sum, js) => sum + js.cumulativeKgHours, 0);

  // 최종 안전장치 — 합산 overflow(Infinity)나 NaN 오염은 값 그대로 내보내지 않고 결측으로
  // 전환한다(계획서 §1-1a 7라운드의 최종 NaN/Infinity 가드 패턴과 동일).
  if (!Number.isFinite(totalCumulativeKgHours)) {
    return notEnteredInvalid();
  }

  return { value: totalCumulativeKgHours, missing: null, qualityFlags: [] };
}

// 비중립 정적 자세 시간(시간/일)의 전 직업·전 작업 단순합 — 근무일수·근속연수 가중 없음.
// 기존 필수필드 검사(getTaskRequiredFields)는 하중·운반시간·자세·정밀작업까지 요구해, 비중립
// 시간이 입력돼 있어도 다른 작업 필드 하나로 not_entered가 되므로 공유하지 않는다. 대상 작업은
// "현재 직업에 연결되고(정규화와 같은 연결 규칙, 고아 작업 제외) awkward_static_neck_load가
// 선택된 작업"이며, 노출유형 미선택 작업의 숨은 stale 값은 합산하지 않는다.
export function extractCervicalCaseTotalNonNeutralHoursPerDay(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<number> {
  const read = readCervicalCaseInputs(migrationResult);
  if ('early' in read) return read.early;
  const { cervicalModule, jobs } = read.inputs;

  const linkedTasks = getEvaluatedRawCervicalTasks(cervicalModule, jobs);
  if (!validateRawCervicalTaskExposure(linkedTasks)) {
    return notEnteredInvalid();
  }

  const targetTasks = linkedTasks.filter(({ task }) =>
    Array.isArray(task.exposure_types) && task.exposure_types.includes(AWKWARD_NECK_TYPE),
  );
  // 대상 작업이 0건이면 "비중립 작업 없음"이라는 유효한 상태 — 결측이 아니라 0.
  if (targetTasks.length === 0) {
    return { value: 0, missing: null, qualityFlags: [] };
  }

  let sum = 0;
  let hasBlank = false;
  let hasInvalid = false;
  for (const { task } of targetTasks) {
    const parsed = parseStrictNonNegative(task.neck_nonneutral_hours_per_day);
    if (parsed.kind === 'blank') hasBlank = true;
    else if (parsed.kind === 'invalid') hasInvalid = true;
    else sum += parsed.value;
  }

  // 손상이 우선 — blank와 섞여 있어도 invalid 플래그를 잃지 않는다.
  if (hasInvalid) return notEnteredInvalid();
  // 노출유형을 선택한 작업에서는 이 시간이 필수 입력이라 blank는 "없음"이 아니라 "입력 누락"이다
  // (어깨 jobExtras의 선택 입력과 다르다) → 부분합 없이 전체 결측.
  if (hasBlank) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (!Number.isFinite(sum)) return notEnteredInvalid();

  return { value: sum, missing: null, qualityFlags: [] };
}
