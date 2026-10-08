// 직력별 "신체부담평가 미포함"(shared.jobs[].excludeFromAnalysis) 판정·필터 공통 헬퍼.
//
// 규칙
//  · 판정은 항상 `job.excludeFromAnalysis === true`다. undefined(구데이터·서버 payload·시드)는 "포함".
//  · 소비처(계산기·완료 판정·화면·직업력 출력·통계)는 이 파일의 헬퍼만 쓰고 필드를 직접 읽지 않는다.
//  · 필터는 "계산 결과를 만드는 단계"에서만 한다. UI의 sync 함수(jobEvaluations/task 정리)에는
//    필터 전 전체 jobs를 넘겨야 미포함 직력의 입력값이 삭제되지 않는다.
//  · 브라우저(Win7 Chrome 80)에서도 돌므로 Object.hasOwn/replaceAll/at/structuredClone/??= 금지.

export interface ExcludableJob {
  id?: string;
  excludeFromAnalysis?: boolean;
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** 미포함 직력인가. 판정은 엄격하게 `=== true`. */
export function isJobExcludedFromAnalysis(job: unknown): boolean {
  return isPlainObject(job) && job.excludeFromAnalysis === true;
}

/** 미포함 직력을 뺀 배열(순서 유지). 입력이 배열이 아니면 빈 배열. */
export function filterAnalysisJobs<T>(jobs: readonly T[] | undefined | null): T[] {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter((job) => !isJobExcludedFromAnalysis(job));
}

/** 직력 목록에서 id로 찾은 직력이 미포함인가(없는 id는 false). */
export function isJobIdExcluded(jobs: readonly ExcludableJob[] | undefined | null, jobId: unknown): boolean {
  if (!Array.isArray(jobs)) return false;
  for (let i = 0; i < jobs.length; i += 1) {
    if (jobs[i] && jobs[i].id === jobId) return isJobExcludedFromAnalysis(jobs[i]);
  }
  return false;
}

/** 직력이 1개 이상이고 전부 미포함. 직력이 0개인 경우는 false(기존대로 "직업력 입력 필요"). */
export function hasNoEvaluableJobs(jobs: readonly unknown[] | undefined | null): boolean {
  if (!Array.isArray(jobs) || jobs.length === 0) return false;
  return jobs.every((job) => isJobExcludedFromAnalysis(job));
}

/** 미포함 직력이 하나라도 있는가. */
export function hasExcludedJobs(jobs: readonly unknown[] | undefined | null): boolean {
  return Array.isArray(jobs) && jobs.some((job) => isJobExcludedFromAnalysis(job));
}

/** 직업력 출력 순서: 포함 직력(원래 순서) → 미포함 직력(원래 순서). 안정 정렬, 원본 비변경. */
export function orderJobsForHistory<T>(jobs: readonly T[] | undefined | null): T[] {
  if (!Array.isArray(jobs)) return [];
  const included: T[] = [];
  const excluded: T[] = [];
  jobs.forEach((job) => {
    (isJobExcludedFromAnalysis(job) ? excluded : included).push(job);
  });
  return included.concat(excluded);
}

// ── 레거시/혼재 데이터 ────────────────────────────────────────────────────────
// shared.jobs가 있는데 직력과 연결되지 않는 구형 직업 필드가 남아 있는 환자는 직력↔레거시 항목
// 연결을 확정할 수 없다(레거시 id가 shared id로 복사됐다는 보장 없음). 이런 환자는 미포함 설정을
// 무력화한다. 감지 조건은 실제 계산 분기·통계 issue 조건과 맞춘다:
//  · knee: `knee/derived.ts resolveKneeCalculationJobs`가 `moduleData.jobs ? … : …`로 빈 배열도 우선 선택
//  · spine: `deterministicMigrate`가 unsupported_legacy_spine_jobs issue를 만드는 조건과 동일한 합집합
//    (mddm.ts hasLegacyFields = careerYears/workDaysPerYear 는 이 합집합의 부분집합)
const LEGACY_SPINE_JOB_FIELDS = ['jobName', 'careerYears', 'careerMonths', 'workDaysPerYear'];

export function hasUnmigratedLegacyJobData(modules: unknown): boolean {
  if (!isPlainObject(modules)) return false;
  const knee = modules.knee;
  if (isPlainObject(knee) && Array.isArray(knee.jobs)) return true;
  const spine = modules.spine;
  if (isPlainObject(spine)) {
    for (let i = 0; i < LEGACY_SPINE_JOB_FIELDS.length; i += 1) {
      if (spine[LEGACY_SPINE_JOB_FIELDS[i]] !== undefined) return true;
    }
  }
  return false;
}

/**
 * 레거시 혼재 환자의 미포함 플래그를 전부 `false`로 무력화한 새 객체를 돌려준다(입력 비변경, 멱등).
 * 바꿀 것이 없으면 입력 객체를 그대로 돌려준다. 환자 데이터가 계산·검증으로 들어가는 모든
 * 입력 경계(클라이언트 migratePatient·완료 판정, deterministicMigrate, verifyAllModulesComplete)에서
 * 호출해, 계산·완료·화면·직업력 출력·통계가 모두 같은 플래그 값을 읽게 한다.
 */
export function neutralizeExclusionForLegacy<T extends { shared?: unknown; modules?: unknown }>(data: T): T {
  if (!isPlainObject(data)) return data;
  const shared = data.shared;
  if (!isPlainObject(shared) || !Array.isArray(shared.jobs)) return data;
  if (!shared.jobs.some((job) => isJobExcludedFromAnalysis(job))) return data;
  if (!hasUnmigratedLegacyJobData(data.modules)) return data;
  const jobs = shared.jobs.map((job) => (isJobExcludedFromAnalysis(job) ? { ...(job as Record<string, unknown>), excludeFromAnalysis: false } : job));
  return { ...data, shared: { ...shared, jobs } };
}

// ── task·interval 등 sharedJobId로 직력에 붙는 항목의 귀속 ─────────────────────────
// 귀속은 항상 "필터 전 전체 jobs" 기준으로 정한 뒤, 귀속 직력이 미포함인 항목만 제거한다.
// 필터된 jobs를 귀속 함수에 넘기면 첫 직력이 미포함일 때 항목이 다음 직력으로 재귀속되어 값이
// 달라진다. 귀속 규칙은 모듈별 기존 동작을 보존한다(orphan 옵션):
//  · 'firstJob'(MDDM groupTasksByJob / 진동 groupIntervalsByJob): sharedJobId가 없거나 jobs에 없는(고아)
//    항목은 전체 jobs[0]에 귀속
//  · 'drop'(경추 getLinkedRawCervicalTasks / 화면 sync): sharedJobId가 비어 있는 항목만 jobs[0]에
//    귀속하고, id가 있으나 jobs에 없는 고아는 귀속되지 않은 채 그대로 둔다(기존 로직이 제외한다)
// 어느 직력에도 귀속되지 않은 항목은 이 함수가 건드리지 않는다(기존 동작 유지).
export type OrphanPolicy = 'firstJob' | 'drop';

export function resolveItemJobKey(
  item: { sharedJobId?: unknown },
  allJobs: readonly ExcludableJob[],
  orphan: OrphanPolicy,
): string | null {
  if (!Array.isArray(allJobs) || allJobs.length === 0) return null;
  const keys: Record<string, true> = {};
  allJobs.forEach((job) => {
    keys[(job && job.id) || ''] = true;
  });
  const firstKey = (allJobs[0] && allJobs[0].id) || '';
  const own = typeof item.sharedJobId === 'string' ? item.sharedJobId : '';
  const wanted = own || firstKey;
  if (keys[wanted] === true) return wanted;
  if (orphan === 'firstJob' && firstKey && keys[firstKey] === true) return firstKey;
  return null;
}

export function scopeItemsToIncludedJobs<T extends { sharedJobId?: unknown }>(
  items: readonly T[] | undefined | null,
  allJobs: readonly ExcludableJob[] | undefined | null,
  options: { orphan: OrphanPolicy },
): T[] {
  const list = Array.isArray(items) ? items : [];
  const jobs = Array.isArray(allJobs) ? allJobs : [];
  if (!hasExcludedJobs(jobs)) return list.slice();
  const excludedKeys: Record<string, true> = {};
  jobs.forEach((job) => {
    if (isJobExcludedFromAnalysis(job)) excludedKeys[(job && job.id) || ''] = true;
  });
  return list.filter((item) => {
    const key = resolveItemJobKey(item, jobs, options.orphan);
    return !(key !== null && excludedKeys[key] === true);
  });
}
