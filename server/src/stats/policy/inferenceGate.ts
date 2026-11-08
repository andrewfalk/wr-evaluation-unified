// PR3-A — §6.1 반복측정 게이트. 마스터 계획서 §6.1: "personCount == rowCount면
// 일반 검정 허용, personCount < rowCount면 추론 차단"(층화 기술통계 예외는 PR3-A
// 범위 밖이라 여기선 고려하지 않는다 — PR3-A의 8개 방법은 전부 추론 검정이다).
//
// 입력은 buildPairedDataset()의 "그 쌍만의" includedPersonCount/includedCaseCount다
// — recipe 전체의 personCount/caseCount가 아니다(쌍마다 결측 패턴이 달라 게이트
// 판정도 쌍마다 달라야 정확함). grain은 현재 'case'뿐이라 rowCount===caseCount로
// 단순화한다.
export interface InferenceGateResult {
  allowed: boolean;
  reasonCode: 'REPEATED_MEASURES_NOT_ALIGNED' | null;
}

export function evaluateInferenceGate(personCount: number, rowCount: number): InferenceGateResult {
  const allowed = personCount === rowCount;
  return { allowed, reasonCode: allowed ? null : 'REPEATED_MEASURES_NOT_ALIGNED' };
}
