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

// PR4-B2 — 예측(prediction) 분석 정책(계획서 §3-5단계). 결과에 영향을 주는 상수를
// 전부 여기 모은다 — statsExecutionDigest.ts가 이 객체 전체를 digest 입력에 넣는다
// (부분만 넣으면 코드/정책이 바뀌어도 캐시가 무효화되지 않는 함정, REGRESSION_POLICY와
// 동일한 교훈).
//
// 0단계 실측(2026-09-24, 운영 핀 버전 Docker: node:20-bookworm-slim + numpy==1.26.4,
// BLAS 스레드=1 — statsEngine.ts의 실제 스폰 환경과 동일) — n=700/P=20: 54.4초,
// n=5000/P=20: 308.1초(둘 다 fit_procedure 226회·λ별 적합 29,606회, 계획서 예고치와
// 정확히 일치). engineTimeoutMs는 이 두 지점에 안전마진 2배를 적용한 선형모델
// (computePredictionEngineTimeoutMs)로 요청마다 추정한다 — 비동기 job(PR4-B1)이라
// "30초"는 동기 응답 제약이 아니라 애초에 참고용 UX 목표였을 뿐이었다(사용자 확인).
// maxWorkUnits는 별도 추상 수치를 만들지 않고 행 수(maxRows) 자체를 예산으로
// 재사용한다 — P를 바꿔가며 실측하지 않아 파라미터 수까지 반영하는 2차원 비용모델을
// 지어낼 근거가 없다.
export const PREDICTION_POLICY = {
  version: 'v1-l2-grouped-cv-bootstrap',
  maxRows: 5000,
  maxColumns: 30,
  maxParameters: 20,
  maxLevels: 10,
  minPersons: 50,
  minEventPersons: 25,
  minNonEventPersons: 25,
  minEventsPerParameter: 10,
  outerFolds: 5,
  repeats: 5,
  innerFolds: 5,
  representativeRepeat: 1,
  lambdaGridMin: 1e-4,
  lambdaGridMax: 10,
  lambdaGridSize: 26,
  bootstrapReplicates: 200,
  bootstrapMinValidRate: 0.9,
  cvMinValidRepeats: 3,
  aucCiReplicates: 1000,
  samplerSeed: 'pr4-b2-v1',
  samplerVersion: 'sha256-rr-v1',
  disclosure: {
    minimumCohort: MINIMUM_COHORT,
    minDisclosableBins: MIN_DISCLOSABLE_BINS,
    curveCandidateBins: 20,
  },
  // maxWorkUnits는 maxRows와 같은 값이다(위 설명) — 이름을 분리해 admission
  // 코드가 "행 수 상한"이 아니라 "작업량 예산"이라는 의도를 드러내게 한다.
  maxWorkUnits: 5000,
} as const;
export const PREDICTION_POLICY_VERSION = PREDICTION_POLICY.version;

// 0단계 실측 2개 지점(n=700→54.4초, n=5000→308.1초)에 안전마진 2배를 적용한 선형
// 모델 — timeoutSec ≈ 2×(13.1 + 0.059×n) = 26.2 + 0.118×n. n=700→약 109초,
// n=5000→약 616초(사용자 확인 예시치 "~90초/~600초"와 정합). 안전마진은 Docker/WSL2
// 가상화 오버헤드·동시 부하 변동을 흡수하기 위함이다 — 실측치를 그대로 쓰면 컨테이너
// 부하가 조금만 늘어도 정상 실행이 timeout으로 오분류된다.
export function computePredictionEngineTimeoutMs(rowCount: number): number {
  const timeoutSec = 26.2 + 0.118 * rowCount;
  return Math.ceil(timeoutSec) * 1000;
}

// logspace(gridMin, gridMax, gridSize) — numpy.logspace와 동일 공식(10^linspace).
// PREDICTION_POLICY.lambdaGridMin/Max/Size에서 파생하는 순수 함수라 여기 둔다
// (Python 엔진은 이 배열을 그대로 config.lambdaGrid로 받는다 — §4단계 "Python은
// 정책을 모르는 순수 함수다").
export function computePredictionLambdaGrid(): number[] {
  const lambdaGridMin: number = PREDICTION_POLICY.lambdaGridMin;
  const lambdaGridMax: number = PREDICTION_POLICY.lambdaGridMax;
  const lambdaGridSize: number = PREDICTION_POLICY.lambdaGridSize;
  const logMin = Math.log10(lambdaGridMin);
  const logMax = Math.log10(lambdaGridMax);
  if (lambdaGridSize === 1) return [10 ** logMin];
  const step = (logMax - logMin) / (lambdaGridSize - 1);
  return Array.from({ length: lambdaGridSize }, (_, i) => 10 ** (logMin + step * i));
}
