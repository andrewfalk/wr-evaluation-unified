// PR4-A2 — 자연 3차 spline 기저(계획서 §2 "표준화·spline 기저"). Hastie & Tibshirani,
// "The Elements of Statistical Learning" §5.4.1의 N1..NK 구성을 따른다. R
// `splines::ns(x, knots=internal, Boundary.knots=boundary, intercept=FALSE)`와 같은
// 함수 공간을 만들지만 — 동등한 다른 기저 표현일 수 있어 원소 값이 R과 그대로
// 같지는 않다(적합값·예측값·CI로 대조, 계획서 §검증) — 외부 선형대수 라이브러리
// 없이 순수 함수로 구현한다.
//
// v1은 df=4로 고정한다: 경계 knot 2개(완전사례 min/max) + 내부 knot 3개(quantile
// {0.10, 0.5, 0.90} — Hmisc 3-knot 관례에서 quantile *위치*만 차용했을 뿐, R
// ns()의 별도 경계/내부 knot 구조를 그대로 쓰는 "프로젝트 자체 정의"다). 상수항
// (N1)은 설계행렬이 이미 별도 절편 열로 갖고 있으므로 여기선 뺀다 — N2..N5의
// 4열만 반환한다.

export interface SplineKnots {
  boundary: readonly [number, number];
  internal: readonly [number, number, number];
}

const MIN_UNIQUE_VALUES = 5; // df(4) + 1

/** R 기본 `quantile()`(type 7) — h=(n-1)p를 0-index 위치로 보고 선형보간한다.
 * 정렬된 전체 표본(중복 포함) 기준 — 훈련 값과 knot 계산이 R 골든값과 일치하려면
 * 고유값이 아니라 원 표본으로 계산해야 한다. */
function quantileType7(sortedValues: readonly number[], p: number): number {
  const n = sortedValues.length;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sortedValues[lo];
  return sortedValues[lo] + (h - lo) * (sortedValues[hi] - sortedValues[lo]);
}

/** 완전사례 표본에서 spline knot을 계산한다. 고유값이 부족하거나(< 5) 내부 knot이
 * 서로 또는 경계 knot과 겹치면(편중 분포) null — 적응형 축소 없이 호출자가
 * SPLINE_INSUFFICIENT_UNIQUE_VALUES로 거부한다(계획서 §2, 리뷰로 확정된 원칙 —
 * "조용한 동작 변경보다 명확한 거부"). */
export function resolveSplineKnots(values: readonly number[]): SplineKnots | null {
  const uniqueCount = new Set(values).size;
  if (uniqueCount < MIN_UNIQUE_VALUES) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const boundaryMin = sorted[0];
  const boundaryMax = sorted[sorted.length - 1];
  const internal: [number, number, number] = [
    quantileType7(sorted, 0.10),
    quantileType7(sorted, 0.50),
    quantileType7(sorted, 0.90),
  ];

  const ordered = [boundaryMin, ...internal, boundaryMax];
  for (let i = 1; i < ordered.length; i += 1) {
    if (!(ordered[i] > ordered[i - 1])) return null; // 중복/역전 — 경계와 겹침도 여기서 잡힌다
  }

  return { boundary: [boundaryMin, boundaryMax], internal };
}

function truncatedCube(x: number, knot: number): number {
  const d = x - knot;
  return d > 0 ? d * d * d : 0;
}

/** d_k(x) = [(x-ξ_k)_+^3 - (x-ξ_K)_+^3] / (ξ_K - ξ_k) — ESL (5.5). */
function dFunction(x: number, knotK: number, knotLast: number): number {
  return (truncatedCube(x, knotK) - truncatedCube(x, knotLast)) / (knotLast - knotK);
}

/** 자연 3차 spline 기저 4열(N2..N5, 상수 N1 제외) — 훈련 열 조립과 예측 그리드
 * 양쪽 모두 이 함수 하나를 쓴다(같은 knot을 반드시 재사용 — 그리드에서 분위수를
 * 다시 계산하면 다른 기저가 된다). */
export function naturalSplineBasis(x: number, knots: SplineKnots): [number, number, number, number] {
  const ordered = [knots.boundary[0], ...knots.internal, knots.boundary[1]];
  const K = ordered.length; // 5
  const lastKnot = ordered[K - 1];
  const dLast = dFunction(x, ordered[K - 2], lastKnot); // d_{K-1}
  const n2 = x;
  const [n3, n4, n5] = [0, 1, 2].map((k) => dFunction(x, ordered[k], lastKnot) - dLast);
  return [n2, n3, n4, n5];
}
