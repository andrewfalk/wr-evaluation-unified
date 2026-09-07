import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  checkAndRecordDifferencing,
  computeQueryFamilyDigest,
  __resetDifferencingGuardForTests,
} from '../statsDifferencingGuard';
import type { StatsAnalysisRecipe } from '@wr/contracts';

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'case',
    variableKeys: ['knee.relatedness.max'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    ...overrides,
  };
}

beforeEach(() => {
  __resetDifferencingGuardForTests();
});

describe('computeQueryFamilyDigest', () => {
  it('필터 값이 달라도 키/연산자가 같으면 동일 family(값은 절대 포함하지 않음)', () => {
    const a = computeQueryFamilyDigest(recipe({ filters: [{ key: 'knee.relatedness.max', operator: 'gt', value: 1 }] }));
    const b = computeQueryFamilyDigest(recipe({ filters: [{ key: 'knee.relatedness.max', operator: 'gt', value: 999 }] }));
    expect(a).toBe(b);
  });

  it('variableKeys가 다르면 다른 family다', () => {
    const a = computeQueryFamilyDigest(recipe({ variableKeys: ['knee.relatedness.max'] }));
    const b = computeQueryFamilyDigest(recipe({ variableKeys: ['spine.vibration.dvMax'] }));
    expect(a).not.toBe(b);
  });
});

describe('checkAndRecordDifferencing — is_missing 필터(value=undefined) 정상 처리', () => {
  // §2라운드 회귀 — canonicalSerialize는 undefined를 throw하도록 설계돼 있는데, is_missing/
  // not_missing 필터의 value는 항상 undefined다. guard가 이를 별도 sentinel로 취급하지
  // 않으면 정상 요청에서 예외가 난다.
  it('is_missing 필터가 포함된 정상 요청이 예외 없이 처리된다', () => {
    const r = recipe({ filters: [{ key: 'knee.relatedness.max', operator: 'is_missing' }] });
    const family = computeQueryFamilyDigest(r);
    expect(() => checkAndRecordDifferencing('org-1', 'user-1', r, family)).not.toThrow();
  });
});

describe('checkAndRecordDifferencing — family 내 값 다양성 초과', () => {
  it('같은 family에서 서로 다른 필터 값이 임계값(10)을 넘으면 억제된다', () => {
    const family = computeQueryFamilyDigest(recipe({ filters: [{ key: 'knee.relatedness.max', operator: 'gt', value: 0 }] }));
    let lastResult;
    for (let i = 0; i < 15; i++) {
      const r = recipe({ filters: [{ key: 'knee.relatedness.max', operator: 'gt', value: i }] });
      lastResult = checkAndRecordDifferencing('org-1', 'user-1', r, family);
    }
    expect(lastResult!.forceSuppress).toBe(true);
  });

  it('같은 값을 반복 조회하면(값 다양성 없음) family 요청 수 한도(30) 전까지는 억제되지 않는다', () => {
    const r = recipe({ filters: [{ key: 'knee.relatedness.max', operator: 'gt', value: 0 }] });
    const family = computeQueryFamilyDigest(r);
    let lastResult;
    for (let i = 0; i < 20; i++) {
      lastResult = checkAndRecordDifferencing('org-1', 'user-1', r, family);
    }
    expect(lastResult!.forceSuppress).toBe(false);
  });
});

describe('checkAndRecordDifferencing — 값 다양성 기록의 시간 만료 (회귀)', () => {
  // 리뷰에서 실제로 재현된 버그: family 자체는 접근할 때마다 lastAccess가 now로 갱신되므로
  // 계속 조회하면 family가 영원히 만료되지 않고, distinctFilterValueDigestsByKey가 Set이라
  // 값별 관측 시각을 모르니 15분 전에 본 값도 계속 카운트에 남는다 — "최근 15분의 고유값만
  // 집계"가 아니라 "이 family가 살아있는 동안 본 모든 값"이 돼버린다.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('서로 다른 값 11개로 억제된 뒤, 15분이 지나 같은 값만 반복 조회하면 억제가 풀린다', () => {
    vi.useFakeTimers();
    const base = new Date('2026-01-01T00:00:00Z').getTime();
    vi.setSystemTime(base);

    const key = 'knee.relatedness.max';
    const family = computeQueryFamilyDigest(recipe({ filters: [{ key, operator: 'gt', value: 0 }] }));

    let lastResult;
    for (let i = 0; i < 11; i++) {
      const r = recipe({ filters: [{ key, operator: 'gt', value: i }] });
      lastResult = checkAndRecordDifferencing('org-1', 'user-1', r, family);
    }
    expect(lastResult!.forceSuppress).toBe(true);

    // 14분 후 — 처음 11개 값이 아직 15분 창 안이라 계속 억제돼야 정상.
    vi.setSystemTime(base + 14 * 60_000);
    const r14 = recipe({ filters: [{ key, operator: 'gt', value: 0 }] });
    expect(checkAndRecordDifferencing('org-1', 'user-1', r14, family).forceSuppress).toBe(true);

    // 16분 후 — 최근 15분 안에 실제로 관측된 값은 0 하나뿐이어야 하므로 억제가 풀려야 한다.
    // (수정 전에는 family.lastAccess가 매 접근마다 갱신돼 11개 값이 계속 살아남아 여기서도
    // forceSuppress=true·remaining이 회복되지 않는 버그가 있었다.)
    vi.setSystemTime(base + 16 * 60_000);
    const r16 = recipe({ filters: [{ key, operator: 'gt', value: 0 }] });
    const result16 = checkAndRecordDifferencing('org-1', 'user-1', r16, family);
    expect(result16.forceSuppress).toBe(false);
  });
});

describe('checkAndRecordDifferencing — 전역 예산(family 우회 방어)', () => {
  it('variableKeys를 바꿔가며 매번 새 family를 만들어도 전역 예산(100)에는 걸린다', () => {
    let lastResult;
    for (let i = 0; i < 120; i++) {
      const r = recipe({ variableKeys: [`fake.var.${i}`] });
      const family = computeQueryFamilyDigest(r);
      lastResult = checkAndRecordDifferencing('org-1', 'user-1', r, family);
    }
    expect(lastResult!.forceSuppress).toBe(true);
  });

  it('다른 사용자의 요청은 서로의 전역 예산에 영향을 주지 않는다', () => {
    const r = recipe();
    const family = computeQueryFamilyDigest(r);
    for (let i = 0; i < 50; i++) checkAndRecordDifferencing('org-1', 'user-1', r, family);
    const other = checkAndRecordDifferencing('org-1', 'user-2', r, family);
    expect(other.forceSuppress).toBe(false);
  });
});
