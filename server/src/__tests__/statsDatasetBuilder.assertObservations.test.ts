// grain 단순화 개정(PR0-B4) — 이 파일은 원래 vibration_interval grain 전용 테스트였다.
// vibration_interval grain 자체가 소스코드까지 완전 삭제됐고, 그 grain의 §2.2(caseCount≠
// observationCount)·변수-독립성·결정성·필터 계약은 이제 job grain으로 충분히 검증된다
// (statsDatasetBuilder.job.test.ts). 여기 남기는 건 grain에 의존하지 않는 순수 단위테스트
// (assertObservationsMatchCanonicalEntities) 하나뿐이다 — extractor가 canonical entity
// 목록을 1:1 map()으로만 순회했는지 검증하는 방어 로직 자체는 어느 grain을 쓰든 동일하다.
import { describe, it, expect } from 'vitest';
import { assertObservationsMatchCanonicalEntities } from '../statsDatasetBuilder';
import type { GrainEntity, RepeatedObservation } from '@wr/analytics-core';

// PR0-B3 Part A(2차 리뷰 지적) — 길이 비교만으로는 canonical=[A,B]에 [A,A]를 반환하는
// 계약 위반(A가 덮어써지고 B가 결측인 채 남음)을 못 잡는다. 실제 extractor 없이 조작된
// 입력으로 이 함수를 직접 검증한다.
describe('assertObservationsMatchCanonicalEntities — 계약 위반 감지', () => {
  function entity(key: string): GrainEntity<unknown> {
    return { entityKey: [key], source: null, qualityFlags: [] };
  }
  function observation(key: string): RepeatedObservation<unknown> {
    return { entityKey: [key], value: 1, missing: null, qualityFlags: [] };
  }

  it('정상 — canonical과 반환이 정확히 1:1 대응하면 통과한다', () => {
    expect(() =>
      assertObservationsMatchCanonicalEntities('test.key', 'case-1', [observation('A'), observation('B')], [entity('A'), entity('B')]),
    ).not.toThrow();
  });

  it('중복 반환 — canonical=[A,B]인데 [A,A]를 반환하면 던진다(길이는 같아도 B가 누락된다)', () => {
    expect(() =>
      assertObservationsMatchCanonicalEntities('test.key', 'case-1', [observation('A'), observation('A')], [entity('A'), entity('B')]),
    ).toThrow(/중복/);
  });

  it('canonical에 없는 entityKey 반환 — 즉시 던진다', () => {
    expect(() =>
      assertObservationsMatchCanonicalEntities('test.key', 'case-1', [observation('A'), observation('C')], [entity('A'), entity('B')]),
    ).toThrow(/canonical 목록에 없는/);
  });

  it('개수 부족 — canonical 2개인데 1개만 반환하면 던진다', () => {
    expect(() =>
      assertObservationsMatchCanonicalEntities('test.key', 'case-1', [observation('A')], [entity('A'), entity('B')]),
    ).toThrow(/다르다/);
  });

  it('canonical이 빈 배열이고 반환도 빈 배열이면 통과한다(그 case는 이 grain에서 관측 0개)', () => {
    expect(() => assertObservationsMatchCanonicalEntities('test.key', 'case-1', [], [])).not.toThrow();
  });
});
