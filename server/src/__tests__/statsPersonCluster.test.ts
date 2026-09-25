import { describe, it, expect } from 'vitest';
import { derivePredictionCohortPersonKey } from '../statsPersonCluster';

// PR4-B2 — cohortDigest 기반 person 키(계획서 §3-1단계). personClusterKey(recipeDigest
// 기반)와 달리 predictor 선택이 바뀌어도(=cohortDigest 불변) 같은 값이 나와야 한다는
// 것이 이 함수 존재 이유다 — 그 성질은 statsPredictionCohort.test.ts(fold 고정 테스트,
// 3차 리뷰 #3-1)가 검증하고, 여기서는 함수 자체의 결정성·민감성만 고정한다.
describe('derivePredictionCohortPersonKey', () => {
  it('같은 (cohortDigest, patientPersonId)는 항상 같은 키를 낸다', () => {
    const a = derivePredictionCohortPersonKey('digest-1', 'person-1');
    const b = derivePredictionCohortPersonKey('digest-1', 'person-1');
    expect(a).toBe(b);
  });

  it('cohortDigest가 다르면 다른 키를 낸다', () => {
    const a = derivePredictionCohortPersonKey('digest-1', 'person-1');
    const b = derivePredictionCohortPersonKey('digest-2', 'person-1');
    expect(a).not.toBe(b);
  });

  it('patientPersonId가 다르면 다른 키를 낸다', () => {
    const a = derivePredictionCohortPersonKey('digest-1', 'person-1');
    const b = derivePredictionCohortPersonKey('digest-1', 'person-2');
    expect(a).not.toBe(b);
  });

  it('22자 hex 문자열이다(personClusterKey와 동일 길이 규칙)', () => {
    const key = derivePredictionCohortPersonKey('digest-1', 'person-1');
    expect(key).toMatch(/^[0-9a-f]{22}$/);
  });
});
