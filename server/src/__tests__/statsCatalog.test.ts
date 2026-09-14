import { describe, it, expect } from 'vitest';
import { getIntegratedCatalog } from '../statsCatalog';
import { ASSIGNED_DOCTOR_KEY, REGISTERED_AT_KEY } from '../statsSnapshotColumnVariables';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';

describe('getIntegratedCatalog — 통합 카탈로그(analytics-core + SNAPSHOT_COLUMN_VARIABLES)', () => {
  // PR0-B4 Slice 1 — analytics-core 카탈로그가 21→36개(spine 잔여 필드 15종)로 늘어
  // 21+2=23에서 36+2=38로 바뀐다. 매 슬라이스 갱신 부담을 줄이려면 analytics-core
  // 카탈로그 개수를 직접 import해서 대조하는 편이 낫다(analytics-core는 이미
  // coverage/pr0B4FieldMapping.ts fixture로 자체 개수를 고정하므로 여기서 또 하드코딩
  // 하지 않는다).
  it('analytics-core 카탈로그 + SNAPSHOT_COLUMN_VARIABLES 2개를 합친 개수를 반환한다', () => {
    expect(getIntegratedCatalog()).toHaveLength(getFullVariableCatalog().length + 2);
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
