// Raw extractor — knee.relatedness.max 1개 변수(§4). 계획서 §4.2~4.3의 job 3분류와
// 결측 우선순위를 그대로 구현한다.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag, RepeatedObservation } from '../../types';
import { parseStrictIsoDate, compareDate, calculateAgeStrict } from '../../dates';
import { parseWorkPeriodOverride } from '../../workPeriod';
import { resolveKneeCalculationJobs, computeKneeCalc, type KneeCalculationJob, type KneeJobExtras } from './derived';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { enumerateDiseaseEntities, enumerateJobEntities } from '../../grainEntities';
import { filterAnalysisJobs, hasNoEvaluableJobs, isJobExcludedFromAnalysis } from '../../jobScope';
import { resolveDiagnosisModule, supportsKlGrade } from '../../diagnosisMapping';
import { KNEE_KLG_ORDER } from './metadata';
import { parseStrictNonNegative } from '../../numericInput';

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

  // 신체부담평가 미포함: 모든 직력이 제외되면 업무관련성 공식의 평가 대상이 없다. 미입력(not_entered)과
  // 구분되도록 날짜·직력 입력 검증보다 먼저 not_applicable로 돌려준다.
  if (hasNoEvaluableJobs((shared as Record<string, unknown>).jobs as unknown[] | undefined)) {
    return { value: null, missing: 'not_applicable', qualityFlags: [] };
  }

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
  // 사용자 요청(2026-09-26) — 카탈로그에는 최댓값 대신 평균값을 노출한다. relatedness.min/max는
  // "여러 관측치의 최소·최대"가 아니라, 부담수준 등급(경도/중등도하/중등도상/고도)이 점수
  // *범위*(예: 중등도상 3.0~6.0)로 정의돼 있어 나온 하나의 기여도 "최소추정치~최대추정치"
  // 구간이다(calculateWorkRelatedness). 평균은 그 구간의 중점 — evaluateCumulativeBurden이
  // 누적부담 충분성 판정에 이미 쓰는 것과 같은 산식이다. 실제 종합소견/EMR 출력은 이 값과
  // 무관하게 여전히 min~max 구간을 그대로 보여준다(computeKneeCalc/KneeResultPanel 미변경) —
  // 통계 카탈로그 표시값만 바뀐다.
  // 키·함수명은 여전히 "max"이지만 바꾸지 않았다 — 이 카탈로그 키가 스냅샷/레시피 검증/억제
  // 테스트 등 30여 개 파일에서 "유효한 continuous 무릎 변수" 픽스처로 광범위하게 재사용되고
  // 있어(값 자체를 검증하는 곳은 없음), 리네임의 변경 범위가 이 계산값 교체와 비교해 불균형하게
  // 크다고 판단했다. CATALOG_VERSION은 계산값이 바뀌므로 올린다.
  const result = computeKneeCalc({ shared: shared as any, module: kneeModule as any });
  const average = (Number(result.relatedness.min) + Number(result.relatedness.max)) / 2;
  return { value: average, missing: null, qualityFlags: [] };
}

// PR0-B3 Part B — diagnosis_side grain. K-L Grade는 무릎 진단(M17 등)에 좌/우 각각 저장되는
// 임상 판단값이라 case가 아니라 이 grain에 속한다(knee/metadata.ts 헤더 주석 — "다중 상병
// 축약 규칙이 필요한데 그건 이 grain이 생기는 PR에서 정한다"는 예고가 이 PR). entity.source를
// 그대로 쓴다(재조회 없음, §핵심 아키텍처 — 엔터티가 원본 참조를 담는다).
export function extractKneeDiagnosisSideKlGrade(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  const activeModules = migrationResult.payload.data.activeModules ?? [];
  return enumerateDiseaseEntities(migrationResult).map((entity) => {
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
  return enumerateDiseaseEntities(migrationResult).map((entity) => {
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

// ── PR0-B4 Slice 4 — coverage 잔여 필드(매핑표 §2). jobExtras 원시값 8종을 job grain에
// 독립 노출한다. shoulder Slice 3와 동일 패턴 — enumerateJobEntities(shared.jobs[] 기준)
// 로 행 모집단을 고정하고, sharedJobId로 modules.knee.jobExtras[]를 찾아 투영한다.
// **레거시 modules.knee.jobs[] 배열은 의도적으로 안 본다**(계획 결정 — 그 배열 자체가
// 카탈로그 대상에서 제외·폐기 예정이라, resolveKneeCalculationJobs의 legacy 병합을
// 재사용하면 legacy 배열의 별도 id 체계가 shared.jobs[] 기준 entityKey와 어긋난다).
function findKneeJobExtra(
  migrationResult: MigrationResult<AnalysisPatient>,
  jobId: unknown,
): KneeJobExtras | undefined {
  const kneeModule = (migrationResult.payload.data.modules as Record<string, unknown> | undefined)?.knee;
  const rawJobExtras = Array.isArray((kneeModule as { jobExtras?: unknown })?.jobExtras)
    ? ((kneeModule as { jobExtras?: unknown[] }).jobExtras as unknown[])
    : [];
  const jobExtras = rawJobExtras.filter(isPlainObject) as unknown as KneeJobExtras[];
  return jobExtras.find((e) => e.sharedJobId === jobId);
}

function isKneeModuleActive(migrationResult: MigrationResult<AnalysisPatient>): boolean {
  const activeModules = migrationResult.payload.data.activeModules ?? [];
  const kneeModule = (migrationResult.payload.data.modules as Record<string, unknown> | undefined)?.knee;
  return activeModules.includes('knee') && isPlainObject(kneeModule);
}

// weight/squatting — parseNonNegativeNumber(이 파일 상단, 기존 knee 계산과 동일 규칙:
// Number() 강제변환 + 0 이상만 허용, UI min="0"과 일치)를 그대로 재사용한다.
function extractKneeJobNumericField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: 'weight' | 'squatting',
): RepeatedObservation<number>[] {
  const entities = enumerateJobEntities(migrationResult);
  if (entities.length === 0) return [];
  if (!isKneeModuleActive(migrationResult)) {
    return entities.map((entity) => ({ entityKey: entity.entityKey, value: null, missing: 'structural_missing', qualityFlags: entity.qualityFlags }));
  }
  return entities.map((entity) => {
    // 신체부담평가 미포함 직력: 엔터티(행 모집단)는 유지하고 값만 not_applicable로 둔다.
    if (isJobExcludedFromAnalysis(entity.source)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    const extra = findKneeJobExtra(migrationResult, entity.source.id);
    const raw = extra?.[field];
    // isBlank(전역, 이 파일 다른 곳에서도 쓰임)는 String(x)로 감싸 [] · [null]도 빈
    // 문자열로 만들어버려 typeof 검사보다 먼저 걸리면 손상 배열이 invalid 없이 조용히
    // not_entered로 빠진다(9차 검토 P2) — null·undefined·공백 문자열만 여기서 빈 값으로
    // 본다.
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    // typeof 먼저(강제변환 우회 방지) — parseNonNegativeNumber는 내부적으로 String(x)를
    // 거치므로 배열도 우연히 숫자로 통과시킨다(예: [123] → "123" → 123, 8차 검토 P2). 기존
    // classifyKneeJob(§4.2, 생산 계산 분기)은 그대로 두고 이 extractor 레벨에서만 막는다.
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: [...entity.qualityFlags, 'invalid'] };
    }
    const n = parseNonNegativeNumber(raw);
    if (n === null) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: [...entity.qualityFlags, 'invalid'] };
    }
    return { entityKey: entity.entityKey, value: n, missing: null, qualityFlags: entity.qualityFlags };
  });
}

export function extractKneeJobWeight(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeJobNumericField(mr, 'weight');
}
export function extractKneeJobSquatting(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeJobNumericField(mr, 'squatting');
}

// stairs/kneeTwist/startStop/tightSpace/kneeContact/jumpDown — 체크박스(JobTab.jsx,
// `checked={extras[key] || false}`)라 원본은 boolean 아니면 undefined뿐이다. undefined는
// not_entered, boolean이 아닌 값(손상 데이터)만 invalid로 구분한다.
function extractKneeJobBooleanField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: 'stairs' | 'kneeTwist' | 'startStop' | 'tightSpace' | 'kneeContact' | 'jumpDown',
): RepeatedObservation<boolean>[] {
  const entities = enumerateJobEntities(migrationResult);
  if (entities.length === 0) return [];
  if (!isKneeModuleActive(migrationResult)) {
    return entities.map((entity) => ({ entityKey: entity.entityKey, value: null, missing: 'structural_missing', qualityFlags: entity.qualityFlags }));
  }
  return entities.map((entity) => {
    if (isJobExcludedFromAnalysis(entity.source)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }
    const extra = findKneeJobExtra(migrationResult, entity.source.id);
    const raw = extra?.[field];
    if (raw === undefined || raw === null) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    if (typeof raw !== 'boolean') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: [...entity.qualityFlags, 'invalid'] };
    }
    return { entityKey: entity.entityKey, value: raw, missing: null, qualityFlags: entity.qualityFlags };
  });
}

// ── case grain 합계 2종 — 직업력 단순합(직업별 일일 입력값의 합계, 근속·근무일수 가중 없음).
// job grain 원본(weight/squatting) 2종을 직업 간에 합산한다. shoulder.case.sum*
// (extractShoulderCaseSum)과 같은 정책이다.
//
// 합산 대상은 shared.jobs의 모든 plain object다 — enumerateJobEntities와 달리 기본(placeholder)
// 행(직종·시작일·종료일·기간 override 전부 빈칸)도 jobExtras에 연결된 노출값이 있으면 포함한다.
// 따라서 "case 합계 = job grain 값의 합"이 항상 성립하지는 않는다(어깨 선례 유지).
// 직업↔extras 연결은 sharedJobId === job.id(ID 기반이라 extras 배열 순서와 무관)이고,
// shared.jobs에 없는 orphan extras는 합산되지 않는다. 레거시 modules.knee.jobs[]는 이 함수가
// 직접 읽지 않는다 — 원본에 shared.jobs가 없을 때 deterministicMigrate가 변환한 결과만 반영된다
// (그 변환은 `weight || ''`라 레거시 숫자 weight 0은 blank로 바뀐다 — 이번 범위에서 수정하지 않음).
//
// 결측 정책(예측 코호트가 missing만 보고 qualityFlags는 안 보므로 손상값은 value가 아니라
// 결측으로 표현한다):
//  · 모듈 비활성/비객체 → structural_missing, shared.jobs 없음 → not_entered
//  · 개별 입력: null·undefined·공백 문자열만 blank, 그 외 비-number/string·비유한·음수는 invalid
//  · 전 직업 blank → not_entered (0이 아님). 입력한 0/'0'은 blank가 아닌 정상 0
//  · 일부 직업만 blank → 그 직업은 "입력 없음"으로 보고 건너뛴 나머지의 합
//  · invalid가 하나라도 있으면(정상 직업이 섞여 있어도) not_entered + invalid — 부분합 비반환.
//    합산 결과 판정에서는 invalid 확인이 "전 직업 blank" 판정보다 먼저다
//  · 최종 합이 유한값이 아니면(합산 overflow) not_entered + invalid
function extractKneeCaseSum(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: 'weight' | 'squatting',
): ExtractedValue<number> {
  const { payload } = migrationResult;

  if (!isKneeModuleActive(migrationResult)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject);
  // 신체부담평가 미포함: 전부 제외면 합산 대상이 없다(미입력과 구분), 일부 제외면 포함 직력만 합산한다.
  if (hasNoEvaluableJobs(jobs)) {
    return { value: null, missing: 'not_applicable', qualityFlags: [] };
  }
  if (jobs.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  let sum = 0;
  let enteredJobCount = 0;
  let hasInvalid = false;
  for (const job of filterAnalysisJobs(jobs)) {
    const parsed = parseStrictNonNegative(findKneeJobExtra(migrationResult, job.id)?.[field]);
    if (parsed.kind === 'blank') continue;
    if (parsed.kind === 'invalid') {
      hasInvalid = true;
      continue;
    }
    enteredJobCount += 1;
    sum += parsed.value;
  }

  if (hasInvalid) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  if (enteredJobCount === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }
  if (!Number.isFinite(sum)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }
  return { value: sum, missing: null, qualityFlags: [] };
}

export function extractKneeCaseSumSquattingMinutesPerDay(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeCaseSum(mr, 'squatting');
}
export function extractKneeCaseSumDailyLoadKg(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeCaseSum(mr, 'weight');
}

export function extractKneeJobStairs(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeJobBooleanField(mr, 'stairs');
}
export function extractKneeJobKneeTwist(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeJobBooleanField(mr, 'kneeTwist');
}
export function extractKneeJobStartStop(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeJobBooleanField(mr, 'startStop');
}
export function extractKneeJobTightSpace(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeJobBooleanField(mr, 'tightSpace');
}
export function extractKneeJobKneeContact(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeJobBooleanField(mr, 'kneeContact');
}
export function extractKneeJobJumpDown(mr: MigrationResult<AnalysisPatient>) {
  return extractKneeJobBooleanField(mr, 'jumpDown');
}
