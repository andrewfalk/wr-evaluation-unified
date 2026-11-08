// Stats engine protocol: version constant and the request shapes sent to the Python engine.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.

// PR4-B2 — services/stats-engine 프로토콜 버전 단일 상수(계획서 §5단계). z.literal·
// stdin envelope·byte 사전검사 envelope 15곳(5+5+5) 전부 이 상수를 참조한다 —
// 리터럴 숫자를 흩어두면 다음 프로토콜 변경 때 한 곳을 빠뜨리기 쉽다(1차 리뷰 #3).
export const ENGINE_PROTOCOL_VERSION = 6;

export type StatsEngineVariableKind = 'continuous' | 'discrete';

export interface StatsEngineVariable {
  key: string;
  kind: StatsEngineVariableKind;
  values: Array<number | string | boolean>;
  // PR3-B 후속 — histogram bin 개수(Freedman-Diaconis/Sturges) 계산 기준을 행 수(values.length,
  // job/disease grain 브로드캐스트면 같은 case가 여러 행으로 중복된다)가 아니라 실제 서로 다른
  // 인원 수로 맞추기 위한 힌트. continuous에서만 채운다 — Python은 person 신원을 몰라도(전역
  // 원칙 유지) 이 스칼라 하나는 받아 bin 해상도 계산에만 쓴다(histogram.py 참고).
  personCount?: number;
}

export interface StatsEngineRequest {
  variables: StatsEngineVariable[];
}

// PR3-A — 이변량 3-shape 요청(계획서 §"Node→Python 3-shape"). Node가 그룹핑/
// 교차집계까지 전부 끝낸 뒤 보낸다 — Python은 카탈로그를 모른다는 기존 원칙 확장.
export type BivariateMethodId =
  | 'welch_t' | 'mann_whitney' | 'anova' | 'kruskal_wallis'
  | 'chi_square' | 'fisher_exact'
  | 'pearson_correlation' | 'spearman_correlation';
  // paired_t/wilcoxon_signed_rank는 이 엔진에 절대 보내지 않는다 — Node의
  // statsMethodCatalog A-사유(PAIRED_TEST_REQUIRES_EXPLICIT_PAIRING)가 항상
  // 사전에 막는다(현재 카탈로그에 대응 메타데이터가 없음).

export interface BivariateGroupsRequest {
  method: 'welch_t' | 'mann_whitney' | 'anova' | 'kruskal_wallis';
  groups: Array<{ label: string | boolean; values: number[] }>;
}
export interface BivariateTableRequest {
  method: 'chi_square' | 'fisher_exact';
  table: number[][];
  rowLabels: Array<string | boolean>;
  colLabels: Array<string | boolean>;
}
export interface BivariateCorrelationRequest {
  method: 'pearson_correlation' | 'spearman_correlation';
  x: number[];
  y: number[];
}
export type BivariateEngineRequest = BivariateGroupsRequest | BivariateTableRequest | BivariateCorrelationRequest;

// PR3-B — 상관행렬 3-shape 추가(계획서 §4). row-aligned 배열을 변수당 1개씩만
// 보낸다 — pair마다 복제 전송하지 않는다(payload O(k·n), 복제 시 O(k²·n)이 되는
// 것을 피함). Python이 pair마다 pairwise-complete 필터링을 수행한다.
export interface CorrelationMatrixEngineVariable {
  key: string;
  values: Array<number | null>;
}
export interface CorrelationMatrixEngineRequest {
  method: 'pearson_correlation' | 'spearman_correlation';
  variables: CorrelationMatrixEngineVariable[];
}

// PR4-A1 — 회귀 요청(계획서 §3 "요청/응답"). y/x는 Node가 완전사례로 걸러 더미
// 인코딩까지 끝낸 숫자 배열 — Python은 person 신원을 모른다는 원칙 그대로.
// covariance.groups는 personClusterKey를 그대로 보낸다(person 신원 자체는
// Python이 몰라도 "이 행들이 같은 클러스터"라는 등가류 라벨은 필요).
export type RegressionCovarianceSpec =
  | { type: 'hc3' }
  | { type: 'cluster'; groups: string[] };

// PR4-A1 리뷰 — X는 대문자여야 한다. protocol.py의 jsonschema가 "X"(대문자)를
// required로 요구하고 analyze.py도 request["regression"]["X"]로 읽는다(계획서
// §3 "요청/응답"). 소문자 x로 보내면 Python이 구조검증 단계에서 즉시
// INVALID_INPUT으로 거부해 회귀 분석 자체가 항상 실패한다 — 필드명은 반드시
// Python 계약과 대소문자까지 일치해야 한다.
export interface RegressionEngineRequest {
  family: 'gaussian' | 'binomial';
  y: number[];
  X: number[][];
  columnNames: string[];
  covariance: RegressionCovarianceSpec;
  // PR4-A2 — spline predictor별 대비행렬(§3 "spline 부분효과"). Python은
  // spline을 모르고 대비 벡터만 평가한다.
  splineContrasts: { variableKey: string; contrastMatrix: number[][] }[];
}

// PR4-A2 — limited_row 진단(§4 "limited_row 진단값"). 재적합 없이 이미 주어진
// β로 h/잔차/Cook's D만 계산하는 경량 요청 — 캐시 hit/miss와 완전히 독립적인
// (X,y,β)만의 순수 함수라 covariance 정보가 필요 없다.
export interface RegressionDiagnosticsEngineRequest {
  family: 'gaussian' | 'binomial';
  y: number[];
  X: number[][];
  columnNames: string[];
  beta: number[];
  sampledRowIndices: number[];
}

// PR4-B2 — 예측 요청(계획서 §4단계 "요청"). y/X는 S2(완전사례) full one-hot
// 설계행렬(절편 미포함) — stats/dataset/predictionDesign.ts가 만든다. groups는
// cohortPersonKey를 그대로 보낸다(personClusterKey가 아니다 — §3-1단계).
// outerFolds는 Node가 확정한 R×N 배정을 그대로 보낸다(Python은 fold를
// 스스로 정하지 않는다 — 재현성·감사가 전부 Node에 남도록).
export interface PredictionEngineRequest {
  y: number[];
  X: number[][];
  columnNames: string[];
  groups: string[];
  outerFoldCount: number;
  outerFolds: number[][];
  config: {
    innerFolds: number;
    lambdaGrid: number[];
    bootstrapReplicates: number;
    bootstrapMinValidRate: number;
    cvMinValidRepeats: number;
    aucCiReplicates: number;
    samplerSeed: string;
    representativeRepeat: number;
  };
}
