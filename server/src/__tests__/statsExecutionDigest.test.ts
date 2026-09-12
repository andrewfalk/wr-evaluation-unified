import { describe, expect, it, vi } from 'vitest';
import { computeExecutionDigest } from '../statsExecutionDigest';

const base = {
  organizationId: 'org-1',
  requestedBy: 'user-1',
  recipeDigest: 'recipe-digest-1',
  sourceDigest: 'source-digest-1',
};

describe('computeExecutionDigest', () => {
  it('is deterministic for the same input', () => {
    expect(computeExecutionDigest(base)).toBe(computeExecutionDigest({ ...base }));
  });

  it('changes when organizationId changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, organizationId: 'org-2' }));
  });

  it('changes when requestedBy changes (v1: no cross-user cache sharing)', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, requestedBy: 'user-2' }));
  });

  it('changes when recipeDigest changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, recipeDigest: 'recipe-digest-2' }));
  });

  it('changes when sourceDigest changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, sourceDigest: 'source-digest-2' }));
  });
});

// PR0-B3 Part C — 계획 "통합 카탈로그" 절 "확인 필요" 3번: 서버 전용
// SERVER_CATALOG_EXTENSION_VERSION(statsCatalogVersion.ts)만 바뀌어도(analytics-core의
// CATALOG_VERSION은 그대로여도) execution digest가 달라져야 한다 — 안 그러면 서버 전용
// SnapshotColumn 로직만 고쳤을 때 옛 캐시가 그대로 재사용된다. 모듈을 모킹해 실제로
// 값이 바뀌는지 실측한다(정적 코드 읽기가 아니라 런타임 digest 비교).
describe('computeExecutionDigest — 서버 확장 버전 단독 변경 시 캐시 무효화', () => {
  it('INTEGRATED_CATALOG_VERSION(=CATALOG_VERSION+SERVER_CATALOG_EXTENSION_VERSION)만 달라져도 digest가 달라진다', async () => {
    vi.resetModules();
    const original = await import('../statsExecutionDigest');
    const originalDigest = original.computeExecutionDigest(base);

    vi.doMock('../statsCatalogVersion', () => ({
      INTEGRATED_CATALOG_VERSION: 'v5-task-grain-diagnosis-module-group+v2-snapshot-columns-changed-for-test',
    }));
    vi.resetModules();
    const patched = await import('../statsExecutionDigest');
    const patchedDigest = patched.computeExecutionDigest(base);

    expect(patchedDigest).not.toBe(originalDigest);

    vi.doUnmock('../statsCatalogVersion');
    vi.resetModules();
  });
});
