import { describe, it, expect } from 'vitest';
import { getIntegratedCatalog } from '../statsCatalog';
import { ASSIGNED_DOCTOR_KEY, REGISTERED_AT_KEY } from '../statsSnapshotColumnVariables';

describe('getIntegratedCatalog — 통합 카탈로그(analytics-core + SNAPSHOT_COLUMN_VARIABLES)', () => {
  it('analytics-core 카탈로그 21개 + SNAPSHOT_COLUMN_VARIABLES 2개 = 23개를 반환한다', () => {
    expect(getIntegratedCatalog()).toHaveLength(23);
  });

  it('담당의·등록일이 analytics-core 카탈로그와 함께 조회된다', () => {
    const keys = getIntegratedCatalog().map((v) => v.key);
    expect(keys).toContain(ASSIGNED_DOCTOR_KEY);
    expect(keys).toContain(REGISTERED_AT_KEY);
    expect(keys).toContain('knee.relatedness.max');
    expect(keys).toContain('job.identity.jobNameNormalized');
  });

  it('키가 전부 유일하다(중복 없음)', () => {
    const keys = getIntegratedCatalog().map((v) => v.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
