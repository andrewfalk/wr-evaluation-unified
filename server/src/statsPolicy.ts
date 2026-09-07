// PR0-C — 통계 워크벤치 preview 파이프라인의 정책 상수. 계획서
// pr0-c-snapshot-dataset-builder-sharded-rivest.md §C/§D/§F 참고.

// §C — 전체 게이트(personCount 기준) + 신호별 소수 셀 억제(person 단위) 공용 임계값.
// 이 값 미만(0 < n < MINIMUM_COHORT)이면 그 신호를 억제한다.
export const MINIMUM_COHORT = 10;

// §F — 이번 PR의 estimability는 §9.2가 요구하는 최소 카운트 집합뿐이다(전체 estimability
// gate, 즉 maxParameters/residual df/design matrix rank 등은 회귀 스펙이 없는 이 PR에는
// 대상이 없다). 정책이 바뀌면(계산 규칙 변경) 이 값을 올린다.
export const ESTIMABILITY_POLICY_VERSION = 'v0-preview-counts';

// §D-1 — family 내부 값-다양성 제한. 이 창(windowMinutes) 안에서 같은 queryFamilyDigest의
// 요청 수가 maxQueriesPerFamily를 넘거나, 어느 필터 키든 서로 다른 값의 수가
// maxDistinctFilterValuesPerKey를 넘으면 forceSuppress.
export const DIFFERENCING_POLICY = {
  version: 'v1',
  windowMinutes: 15,
  maxQueriesPerFamily: 30,
  maxDistinctFilterValuesPerKey: 10,
} as const;

// §D-2 — family를 살짝 바꿔(variableKeys 추가/제거 등) 우회하는 시도를 막는 전역 예산.
// family 예산과 독립적으로 적용된다 — 둘 중 하나라도 초과하면 억제.
export const GLOBAL_QUERY_BUDGET = {
  windowMinutes: 15,
  maxQueriesPerUser: 100,
} as const;
