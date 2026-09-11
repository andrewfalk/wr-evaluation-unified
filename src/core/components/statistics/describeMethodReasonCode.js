// PR3-A — availableMethods[].reasonCode → 한국어 문구. describeStatsError.js와
// 분리한 이유(계획서 §"에러 코드"): 이건 HTTP 에러가 아니라 200 응답 안의 방법별
// 상태 사유라 다른 UI(인라인 카드 뱃지)에 쓰인다 — 같은 문자열이 두 다른 문맥에서
// 다른 안내로 쓰이는 걸 막기 위해 파일을 나눴다.
//
// B-사유(그룹/셀 소수셀·값상수·제외사유 소수셀)는 여기 없다 — 절대 별도 reasonCode를
// 만들지 않는다는 게 설계 원칙이라, 서버가 그 사유를 아예 안 보낸다(계획서 §"방법
// 가용성 판정").
const REASON_LABELS = {
  METHOD_TYPE_MISMATCH: '선택한 두 변수의 타입 조합에 쓸 수 없는 방법입니다.',
  PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING: '현재 카탈로그에는 좌우 대응(짝) 변수가 없어 지원하지 않습니다.',
  REPEATED_MEASURES_NOT_ALIGNED: '한 사람이 여러 사례에 걸쳐 있어(반복측정) 일반 검정을 실행할 수 없습니다.',
  INSUFFICIENT_DATA: '완전사례가 없어 실행할 수 없습니다.',
  REQUIRES_EXACTLY_TWO_GROUPS: '관측된 그룹이 정확히 2개여야 합니다.',
  REQUIRES_AT_LEAST_TWO_GROUPS: '관측된 그룹이 2개 이상이어야 합니다.',
  REQUIRES_AT_LEAST_TWO_LEVELS: '각 축에 관측된 수준이 2개 이상이어야 합니다.',
  TABLE_NOT_2X2: '2×2 표에만 쓸 수 있습니다.',
  LOW_EXPECTED_COUNT: '일부 칸의 기대도수가 작아 근사의 타당성이 낮습니다.',
};

export function describeMethodReasonCode(reasonCode) {
  if (!reasonCode) return null;
  return REASON_LABELS[reasonCode] || reasonCode;
}
