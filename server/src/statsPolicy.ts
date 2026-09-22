// PR0-C — 통계 워크벤치 preview 파이프라인의 정책 상수. 계획서
// pr0-c-snapshot-dataset-builder-sharded-rivest.md §C/§D/§F 참고.

// §C — 전체 게이트(personCount 기준) + 신호별 소수 셀 억제(person 단위) 공용 임계값.
// 이 값 미만(0 < n < MINIMUM_COHORT)이면 그 신호를 억제한다.
export const MINIMUM_COHORT = 10;

// B안(히스토그램 적응형 해상도 축소) — 재분할 폴백 후보의 최소 bin 개수. 이 개수
// 미만이면 "히스토그램"이라 부르기엔 정보가 너무 없다고 보고 안내 메시지로 대체한다.
// 원본(재분할 전) bin이 애초에 이보다 적어도(1~2개, 상수값 등) 그건 재분할 대상이
// 아니라 원본 그대로 공개한다 — 이 하한은 "폴백 후보"에만 적용되는 하한이다.
export const MIN_DISCLOSABLE_BINS = 3;

// §F — PR0-C의 estimability는 §9.2가 요구하는 최소 카운트 집합뿐이었다(maxParameters/
// residual df/design matrix rank 등은 회귀 스펙이 없어 대상 밖이었다). PR4-A1이 회귀
// 설계행렬 게이트(REGRESSION_POLICY)를 추가하며 candidateParameterCount가 실제 값을
// 갖게 됐으므로 정책 버전을 올린다.
export const ESTIMABILITY_POLICY_VERSION = 'v1-regression-design';

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
// B안 — 히스토그램이 all-or-nothing 억제 대신 적응형 해상도 축소(재분할)를 거치도록
// 판정 로직 자체가 바뀌어 범프한다(server/src/statsChartDisclosure.ts 참고).
export const CHART_DISCLOSURE_POLICY_VERSION = 'v2-histogram-adaptive-resolution';

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

// PR4-A1 — 연관성 회귀(OLS·이분 로지스틱) 설계행렬 게이트 정책(계획서
// pr4-a-lexical-reddy.md §2 "④ 설계행렬 + 추정가능성"). 실행 전 non_estimable 판정과
// 클러스터 추론 보류 판정 둘 다 이 값을 쓴다. minEventsPerParameter는 제품 정책값이지
// 정확도를 보장하는 통계 법칙이 아니다(리뷰 #7). maxClusterShare는 클러스터 수만으로
// 못 잡는 쏠림(한 사람이 행의 대부분을 차지하는 상황)을 함께 검사한다(확정 결정 5).
// 리뷰로 발견한 결함 — rank 판정 로직(statsRegressionDesign.ts matrixRank)을
// Gram 행렬 기반에서 one-sided Jacobi SVD로 교체했을 때, 이 정책 객체의
// 필드 값 자체는 하나도 바뀌지 않았다. 하지만 statsExecutionDigest.ts가
// version 문자열을 execution_digest 해시 입력에 직접 넣으므로, 코드 로직만
// 바뀌고 이 문자열을 올리지 않으면 수정 전에 RANK_DEFICIENT로 캐시된 결과가
// 같은 입력에 계속 재사용된다(statsAnalyzeHandler.ts의 캐시 조회가 적중 시
// 재계산을 하지 않는다) — 코드가 바뀔 때마다 이 버전도 함께 올릴 것.
//
// PR4-A2 — 진단(VIF·condition number·leverage 계열)·spline·interaction·표준화·
// categorical outcome을 추가하며 설계행렬 조립 로직 자체가 바뀌었으므로 버전을
// 올린다(캐시 무효화 — 위 문단과 같은 이유).
export const REGRESSION_POLICY = {
  version: 'v2-diagnostics-spline',
  minCompleteRows: 30,
  minClusters: 30,
  maxClusterShare: 0.20,
  minEventsPerParameter: 10,
  maxParameters: 20,
  maxLevels: 10,
  minResidualDf: 10,
} as const;
export const REGRESSION_POLICY_VERSION = REGRESSION_POLICY.version;
