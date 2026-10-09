// 클라이언트의 예측 필요 인원 사본(src/core/components/statistics/predictionRequirements.js)이 서버 정책과 같은지 고정한다.
// 결과 카드가 "현재 인원 / 필요 기준"을 나란히 보여 줄 때 쓰는 값이라, 서버 정책만 바뀌고 사본이 남으면 사용자가 잘못된 기준을
// 보게 된다 — 서버 정책을 바꾸면 이 테스트가 실패해 사본 갱신을 강제한다. (판정은 항상 서버가 한다.)
import { describe, expect, it } from 'vitest';
import { PREDICTION_POLICY } from '../statsPolicy';
// @ts-expect-error — 클라이언트 JS 모듈(타입 선언 없음)을 값만 읽어 비교한다.
import { PREDICTION_REQUIREMENTS } from '../../../src/core/components/statistics/predictionRequirements.js';

describe('예측 필요 인원 — 클라이언트 사본과 서버 정책 일치', () => {
  it('minPersons / minEventPersons / minNonEventPersons가 서버 PREDICTION_POLICY와 같다', () => {
    expect(PREDICTION_REQUIREMENTS).toEqual({
      minPersons: PREDICTION_POLICY.minPersons,
      minEventPersons: PREDICTION_POLICY.minEventPersons,
      minNonEventPersons: PREDICTION_POLICY.minNonEventPersons,
    });
  });
});
