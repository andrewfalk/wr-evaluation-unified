// PR0-C — 통계 워크벤치 preview 파이프라인의 정책 상수. 계획서
// pr0-c-snapshot-dataset-builder-sharded-rivest.md §C/§D/§F 참고.

// §C — 전체 게이트(personCount 기준) + 신호별 소수 셀 억제(person 단위) 공용 임계값.
// 이 값 미만(0 < n < MINIMUM_COHORT)이면 그 신호를 억제한다.
export const MINIMUM_COHORT = 10;

// §F — 이번 PR의 estimability는 §9.2가 요구하는 최소 카운트 집합뿐이다(전체 estimability
// gate, 즉 maxParameters/residual df/design matrix rank 등은 회귀 스펙이 없는 이 PR에는
// 대상이 없다). 정책이 바뀌면(계산 규칙 변경) 이 값을 올린다.
export const ESTIMABILITY_POLICY_VERSION = 'v0-preview-counts';

// PR3-A — §6.1 반복측정 게이트(personCount<rowCount면 추론 차단) 정책 버전. §6.1
// 게이트 규칙이 바뀌면(예: 다른 grain 지원 추가) 이 값을 올린다 — estimability와는
// 독립된 정책 축이라 별도 버전으로 캐시 무효화를 관리한다(계획서 §버전 상수).
export const INFERENCE_GATE_POLICY_VERSION = 'v1-repeated-measures-gate';

// PR3-B — 상관행렬 다중검정 보정 방법(계획서 §4). 토글 없이 BH-FDR 고정.
export const CORRELATION_MATRIX_MULTIPLE_TESTING_METHOD = 'bh_fdr' as const;
export const CORRELATION_MATRIX_POLICY_VERSION = 'v1-pairwise-gates-bh-fdr';

// PR3-B — 차트 데이터(히스토그램 bin·박스플롯 이상치·산점도 그리드) 억제 정책
// 버전(계획서 §1/§3). 히스토그램/그리드는 person 단위 전체연결억제, 박스플롯
// 이상치는 이상치·비이상치 양쪽 partition의 person 고유 인원 게이트가 독립
// 적용된다 — 이 판정 로직이 바뀌면 이 값을 올린다.
export const CHART_DISCLOSURE_POLICY_VERSION = 'v1-outlier-partition-gate';

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
