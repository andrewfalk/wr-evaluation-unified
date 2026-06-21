import { describe, it, expect } from 'vitest';
import { validateAppliedRecipes, canonicalJson } from '../recipeValidation';
import {
  VIDEO_MAPPING_CONFIG_VERSION,
  VIDEO_VIEWPOINT_CONFIG_VERSION,
  type AnalysisRecipe,
} from '@wr/contracts';

// 서버 상수와 일치하는 verified recipe(field 대조 통과 기준).
const recipe = (over: Partial<AnalysisRecipe> = {}): AnalysisRecipe => ({
  status: 'verified',
  modelVersion: 'rtmlib-0.0.15',
  detectorSha256: 'a'.repeat(64),
  poseSha256: 'b'.repeat(64),
  preprocessConfigHash: 'pch',
  featureConfigVersion: 'fc-1',
  mappingConfigVersion: VIDEO_MAPPING_CONFIG_VERSION,
  viewpointConfigVersion: VIDEO_VIEWPOINT_CONFIG_VERSION,
  codeCommit: 'abc1234',
  ...over,
});

const entry = (over: Record<string, unknown> = {}) => ({
  moduleId: 'shoulder',
  targetPath: 'modules.shoulder.jobExtras[sharedJobId=j1].overheadHours',
  analysisJobIds: [] as string[],
  analysisBundleVersion: 'b',
  ...over,
});

const base = {
  oldAppliedInputs: [] as unknown[],
  appliedInputsCount: undefined as number | undefined,
  sourceAnalysisJobIds: [] as string[],
  sourceRecipes: new Map<string, AnalysisRecipe | null>(),
  allowUnverified: false,
};

describe('validateAppliedRecipes — suffix diff / count / prefix', () => {
  it('provenance 없는 신규 entry(jobIds 빈) → PROVENANCE_REQUIRED (운영 우회 차단)', () => {
    const r = validateAppliedRecipes({ ...base, newAppliedInputs: [entry()], appliedInputsCount: 1 });
    expect(r?.code).toBe('PROVENANCE_REQUIRED');
  });

  it('provenance 없는 신규 entry도 allowUnverified=true(dev/mock)면 통과', () => {
    expect(validateAppliedRecipes({ ...base, newAppliedInputs: [entry()], appliedInputsCount: 1, allowUnverified: true })).toBeNull();
  });

  it('count 불일치 → APPLIED_INPUTS_COUNT_MISMATCH', () => {
    const r = validateAppliedRecipes({ ...base, newAppliedInputs: [entry()], appliedInputsCount: 2 });
    expect(r?.code).toBe('APPLIED_INPUTS_COUNT_MISMATCH');
  });

  it('count 미제공이면 count 검사 skip(통과)', () => {
    expect(validateAppliedRecipes({ ...base, newAppliedInputs: [entry()], allowUnverified: true })).toBeNull();
  });

  it('이력 축소(append-only 위반) → APPLIED_INPUTS_HISTORY_SHRUNK', () => {
    const r = validateAppliedRecipes({ ...base, oldAppliedInputs: [entry(), entry()], newAppliedInputs: [entry()] });
    expect(r?.code).toBe('APPLIED_INPUTS_HISTORY_SHRUNK');
  });

  it('prefix 단일 값 변조 → APPLIED_INPUTS_PREFIX_MODIFIED', () => {
    const e0 = entry({ appliedValue: 1 });
    const r = validateAppliedRecipes({
      ...base,
      oldAppliedInputs: [e0],
      newAppliedInputs: [entry({ appliedValue: 999 }), entry()],
      appliedInputsCount: 1,
    });
    expect(r?.code).toBe('APPLIED_INPUTS_PREFIX_MODIFIED');
  });

  it('prefix 키 순서만 다르고 값 동일 → 통과(canonical 비교)', () => {
    const stored = { b: 2, a: 1, analysisJobIds: [] };
    const resent = { a: 1, b: 2, analysisJobIds: [] };
    expect(canonicalJson(stored)).toBe(canonicalJson(resent));
    const r = validateAppliedRecipes({
      ...base, oldAppliedInputs: [stored], newAppliedInputs: [resent, entry()], appliedInputsCount: 1, allowUnverified: true,
    });
    expect(r).toBeNull();
  });
});

describe('validateAppliedRecipes — exact-set / recipe 대조', () => {
  it('exact-set 불일치(entry가 source에 없는 job 참조) → SOURCE_JOBS_MISMATCH', () => {
    const r = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['jX'] })],
      appliedInputsCount: 1,
      sourceAnalysisJobIds: [],
    });
    expect(r?.code).toBe('SOURCE_JOBS_MISMATCH');
  });

  it('source recipe 누락 + allowUnverified=false → RECIPE_MISSING', () => {
    const r = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['j1'] })],
      appliedInputsCount: 1,
      sourceAnalysisJobIds: ['j1'],
      sourceRecipes: new Map([['j1', null]]),
    });
    expect(r?.code).toBe('RECIPE_MISSING');
  });

  it('source recipe 누락이라도 allowUnverified=true면 통과', () => {
    const r = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['j1'] })],
      appliedInputsCount: 1,
      sourceAnalysisJobIds: ['j1'],
      sourceRecipes: new Map([['j1', null]]),
      allowUnverified: true,
    });
    expect(r).toBeNull();
  });

  it('unverified recipe + allowUnverified=false → RECIPE_UNVERIFIED', () => {
    const r = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['j1'], recipe: recipe({ status: 'unverified', detectorSha256: null, poseSha256: null }) })],
      appliedInputsCount: 1,
      sourceAnalysisJobIds: ['j1'],
      sourceRecipes: new Map([['j1', recipe({ status: 'unverified', detectorSha256: null, poseSha256: null })]]),
    });
    expect(r?.code).toBe('RECIPE_UNVERIFIED');
  });

  it('verified recipe field 일치 → 통과', () => {
    const r = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['j1'], recipe: recipe() })],
      appliedInputsCount: 1,
      sourceAnalysisJobIds: ['j1'],
      sourceRecipes: new Map([['j1', recipe()]]),
    });
    expect(r).toBeNull();
  });

  it('서버-기원 field 불일치(modelVersion 위조) → RECIPE_FIELD_MISMATCH', () => {
    const r = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['j1'], recipe: recipe({ modelVersion: 'forged' }) })],
      appliedInputsCount: 1,
      sourceAnalysisJobIds: ['j1'],
      sourceRecipes: new Map([['j1', recipe()]]),
    });
    expect(r?.code).toBe('RECIPE_FIELD_MISMATCH');
  });

  it('클라-기원 map/vp 버전 불일치(stale client) → RECIPE_CONFIG_VERSION_MISMATCH', () => {
    const r = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['j1'], recipe: recipe({ mappingConfigVersion: 'pday-OLD' }) })],
      appliedInputsCount: 1,
      sourceAnalysisJobIds: ['j1'],
      sourceRecipes: new Map([['j1', recipe()]]),
    });
    expect(r?.code).toBe('RECIPE_CONFIG_VERSION_MISMATCH');
  });

  it('entry.recipe 누락 + allowUnverified=false → RECIPE_INVALID', () => {
    const r = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['j1'] })], // recipe 없음
      appliedInputsCount: 1,
      sourceAnalysisJobIds: ['j1'],
      sourceRecipes: new Map([['j1', recipe()]]),
    });
    expect(r?.code).toBe('RECIPE_INVALID');
  });

  it('다중 source recipe 상이 → aggregate bundle 문자열로 대조', () => {
    const r1 = recipe();
    const r2 = recipe({ modelVersion: 'rtmlib-0.0.16' });
    // aggregate 문자열은 buildAnalysisBundleVersion(서버 stored, 즉 r1/r2 그대로)의 정렬 결합.
    // 클라가 동일 입력으로 만든 bundle을 entry.analysisBundleVersion에 실어야 통과.
    const fail = validateAppliedRecipes({
      ...base,
      newAppliedInputs: [entry({ analysisJobIds: ['j1', 'j2'], analysisBundleVersion: 'wrong' })],
      appliedInputsCount: 1,
      sourceAnalysisJobIds: ['j1', 'j2'],
      sourceRecipes: new Map([['j1', r1], ['j2', r2]]),
    });
    expect(fail?.code).toBe('RECIPE_AGGREGATE_MISMATCH');
  });
});
