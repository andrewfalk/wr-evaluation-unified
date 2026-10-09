// 예측이 추정 가능하려면 완전사례(예측변수 값이 모두 있는 사람)가 최소 몇 명이어야 하는지.
// 서버 정책(server/src/statsPolicy.ts PREDICTION_POLICY.minPersons/minEventPersons/minNonEventPersons)의 클라이언트 사본이다 —
// 결과 카드가 "현재 인원 / 필요 기준"을 나란히 보여 주기 위해서만 쓴다(판정은 항상 서버가 한다).
// 두 값이 어긋나면 사용자가 잘못된 기준을 보게 되므로 server/src/__tests__/statsPredictionRequirementsParity.test.ts가
// 서버 정책과 같은지 검증한다 — 서버 정책을 바꾸면 여기와 그 테스트가 함께 실패한다.
export const PREDICTION_REQUIREMENTS = Object.freeze({
  minPersons: 50,
  minEventPersons: 25,
  minNonEventPersons: 25,
});
