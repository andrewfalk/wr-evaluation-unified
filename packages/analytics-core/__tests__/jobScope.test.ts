import { describe, it, expect } from 'vitest';
import {
  isJobExcludedFromAnalysis,
  filterAnalysisJobs,
  hasNoEvaluableJobs,
  hasExcludedJobs,
  orderJobsForHistory,
  hasUnmigratedLegacyJobData,
  neutralizeExclusionForLegacy,
  resolveItemJobKey,
  scopeItemsToIncludedJobs,
} from '../jobScope';

const job = (id: string, excludeFromAnalysis?: unknown) => ({ id, jobName: id, excludeFromAnalysis }) as any;

describe('isJobExcludedFromAnalysis — 엄격한 === true', () => {
  it('true만 미포함이다', () => {
    expect(isJobExcludedFromAnalysis({ excludeFromAnalysis: true })).toBe(true);
  });
  it('undefined·false·비불리언·null·비객체는 모두 포함', () => {
    expect(isJobExcludedFromAnalysis({})).toBe(false);
    expect(isJobExcludedFromAnalysis({ excludeFromAnalysis: false })).toBe(false);
    expect(isJobExcludedFromAnalysis({ excludeFromAnalysis: 'true' })).toBe(false);
    expect(isJobExcludedFromAnalysis({ excludeFromAnalysis: 1 })).toBe(false);
    expect(isJobExcludedFromAnalysis(null)).toBe(false);
    expect(isJobExcludedFromAnalysis(undefined)).toBe(false);
    expect(isJobExcludedFromAnalysis('x')).toBe(false);
  });
});

describe('filterAnalysisJobs / hasNoEvaluableJobs / hasExcludedJobs', () => {
  it('미포함만 제거하고 순서를 유지한다', () => {
    const jobs = [job('a'), job('b', true), job('c', false), job('d')];
    expect(filterAnalysisJobs(jobs).map((j) => j.id)).toEqual(['a', 'c', 'd']);
  });
  it('배열이 아니면 빈 배열', () => {
    expect(filterAnalysisJobs(undefined)).toEqual([]);
    expect(filterAnalysisJobs(null)).toEqual([]);
  });
  it('직력이 1개 이상이고 전부 미포함일 때만 hasNoEvaluableJobs', () => {
    expect(hasNoEvaluableJobs([job('a', true), job('b', true)])).toBe(true);
    expect(hasNoEvaluableJobs([job('a', true), job('b')])).toBe(false);
    expect(hasNoEvaluableJobs([])).toBe(false); // 직력 0개는 별개 상태
    expect(hasNoEvaluableJobs(undefined)).toBe(false);
  });
  it('hasExcludedJobs', () => {
    expect(hasExcludedJobs([job('a'), job('b', true)])).toBe(true);
    expect(hasExcludedJobs([job('a')])).toBe(false);
    expect(hasExcludedJobs(undefined)).toBe(false);
  });
});

describe('orderJobsForHistory — 포함 먼저, 미포함은 끝 (안정 정렬·비변경)', () => {
  it('포함 직력 상대 순서와 미포함 직력 상대 순서를 각각 보존한다', () => {
    const jobs = [job('a', true), job('b'), job('c', true), job('d')];
    const before = jobs.slice();
    expect(orderJobsForHistory(jobs).map((j) => j.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(jobs).toEqual(before);
  });
  it('미포함이 없으면 원래 순서와 같다', () => {
    const jobs = [job('a'), job('b'), job('c')];
    expect(orderJobsForHistory(jobs).map((j) => j.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('hasUnmigratedLegacyJobData — 계산 분기·통계 issue 조건과 일치', () => {
  it('knee.jobs는 빈 배열이어도 감지한다 (resolveKneeCalculationJobs가 빈 배열도 우선 선택)', () => {
    expect(hasUnmigratedLegacyJobData({ knee: { jobs: [] } })).toBe(true);
    expect(hasUnmigratedLegacyJobData({ knee: { jobs: [{ id: 'x' }] } })).toBe(true);
    expect(hasUnmigratedLegacyJobData({ knee: { jobExtras: [] } })).toBe(false);
  });
  it('spine은 jobName/careerYears/careerMonths/workDaysPerYear 중 하나라도 정의되면 감지한다', () => {
    ['jobName', 'careerYears', 'careerMonths', 'workDaysPerYear'].forEach((key) => {
      expect(hasUnmigratedLegacyJobData({ spine: { [key]: '' } })).toBe(true);
    });
    expect(hasUnmigratedLegacyJobData({ spine: { tasks: [] } })).toBe(false);
    expect(hasUnmigratedLegacyJobData({ spine: { careerYears: undefined } })).toBe(false);
  });
  it('모듈 맵이 없거나 비객체면 false', () => {
    expect(hasUnmigratedLegacyJobData(undefined)).toBe(false);
    expect(hasUnmigratedLegacyJobData(null)).toBe(false);
    expect(hasUnmigratedLegacyJobData([])).toBe(false);
  });
});

describe('neutralizeExclusionForLegacy', () => {
  const mixed = () => ({
    shared: { jobs: [job('a', true), job('b'), job('c', true)] },
    modules: { spine: { jobName: '구형' } },
    activeModules: ['spine'],
  });

  it('레거시 혼재 환자의 모든 미포함 플래그를 false로 만든 새 객체를 돌려준다', () => {
    const out = neutralizeExclusionForLegacy(mixed());
    expect(out.shared.jobs.map((j: any) => j.excludeFromAnalysis)).toEqual([false, undefined, false]);
  });

  it('입력 객체를 변경하지 않는다 (참조·값 불변)', () => {
    const input = mixed();
    const jobsRef = input.shared.jobs;
    const firstRef = input.shared.jobs[0];
    const out = neutralizeExclusionForLegacy(input);
    expect(out).not.toBe(input);
    expect(input.shared.jobs).toBe(jobsRef);
    expect(input.shared.jobs[0]).toBe(firstRef);
    expect(input.shared.jobs[0].excludeFromAnalysis).toBe(true);
    expect(input.shared.jobs[2].excludeFromAnalysis).toBe(true);
  });

  it('멱등: 두 번 적용한 결과 = 한 번 적용한 결과 (두 번째는 같은 객체)', () => {
    const once = neutralizeExclusionForLegacy(mixed());
    const twice = neutralizeExclusionForLegacy(once);
    expect(twice).toBe(once);
    expect(twice).toEqual(once);
  });

  it('레거시가 없으면 입력과 동일한 객체를 그대로 돌려준다', () => {
    const clean = { shared: { jobs: [job('a', true)] }, modules: { spine: { tasks: [] } }, activeModules: [] };
    expect(neutralizeExclusionForLegacy(clean)).toBe(clean);
  });

  it('미포함 플래그가 하나도 없으면 레거시가 있어도 입력 그대로', () => {
    const noFlags = { shared: { jobs: [job('a'), job('b', false)] }, modules: { knee: { jobs: [] } }, activeModules: [] };
    expect(neutralizeExclusionForLegacy(noFlags)).toBe(noFlags);
  });

  it('shared.jobs가 배열이 아니거나 비객체 입력이어도 예외 없이 그대로 돌려준다', () => {
    expect(neutralizeExclusionForLegacy({ shared: {}, modules: { knee: { jobs: [] } } })).toEqual({ shared: {}, modules: { knee: { jobs: [] } } });
    expect(neutralizeExclusionForLegacy(undefined as any)).toBeUndefined();
  });
});

describe('scopeItemsToIncludedJobs — 귀속은 전체 jobs 기준, 그 뒤 미포함 귀속 항목 제거', () => {
  const jobs = [job('j1', true), job('j2'), job('j3', true)];
  const t = (name: string, sharedJobId?: string) => ({ name, sharedJobId }) as any;

  it("orphan:'firstJob' — sharedJobId 없음/고아는 전체 jobs[0]에 귀속 (첫 직력이 미포함이면 제거)", () => {
    const items = [t('own-j2', 'j2'), t('none'), t('orphan', 'gone'), t('own-j1', 'j1'), t('own-j3', 'j3')];
    expect(scopeItemsToIncludedJobs(items, jobs, { orphan: 'firstJob' }).map((i) => i.name)).toEqual(['own-j2']);
  });

  it("첫 직력이 미포함이어도 sharedJobId 없는 항목이 다음 직력으로 재귀속되지 않는다 (필터된 jobs를 넘겼을 때와의 차이)", () => {
    const items = [t('none')];
    // 필터된 jobs(j2부터)를 귀속에 쓰면 j2로 가서 살아남지만, 전체 jobs 기준이면 j1(미포함)에 귀속되어 제거된다.
    expect(scopeItemsToIncludedJobs(items, jobs, { orphan: 'firstJob' })).toEqual([]);
    expect(scopeItemsToIncludedJobs(items, filterAnalysisJobs(jobs), { orphan: 'firstJob' }).length).toBe(1);
  });

  it("orphan:'drop' — sharedJobId 비어 있는 항목만 jobs[0]에 귀속, id가 있는 고아는 건드리지 않는다", () => {
    const items = [t('none'), t('orphan', 'gone'), t('own-j2', 'j2'), t('own-j3', 'j3')];
    const out = scopeItemsToIncludedJobs(items, jobs, { orphan: 'drop' }).map((i) => i.name);
    expect(out).toEqual(['orphan', 'own-j2']); // none→j1(제거), orphan 유지(기존 로직이 제외), j3 제거
  });

  it('미포함 직력이 없으면 항목을 그대로(복사본) 돌려준다', () => {
    const items = [t('a', 'j2'), t('b')];
    const all = [job('j1'), job('j2')];
    const out = scopeItemsToIncludedJobs(items, all, { orphan: 'firstJob' });
    expect(out).toEqual(items);
    expect(out).not.toBe(items);
  });

  it('jobs가 비어 있으면 어느 항목도 제거하지 않는다 (직력 0개 fallback 경로 보존)', () => {
    const items = [t('a'), t('b', 'x')];
    expect(scopeItemsToIncludedJobs(items, [], { orphan: 'firstJob' })).toEqual(items);
  });

  it('id가 없는 직력은 빈 문자열 키로 취급한다 (기존 groupTasksByJob과 동일)', () => {
    const idless = [{ jobName: 'x', excludeFromAnalysis: true }, job('j2')] as any[];
    expect(resolveItemJobKey({ sharedJobId: '' }, idless, 'firstJob')).toBe('');
    expect(scopeItemsToIncludedJobs([t('none')], idless, { orphan: 'firstJob' })).toEqual([]);
  });
});
