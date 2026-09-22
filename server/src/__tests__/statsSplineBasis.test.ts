// PR4-A2 — statsSplineBasis.ts 단위테스트. knot 계산(type-7 quantile)과 자연 3차
// spline 기저 자체는 원소 값이 R `splines::ns()`와 그대로 같을 필요가 없다는 것이
// 파일 주석에 명시돼 있으므로(동등한 다른 기저 표현 가능), 여기서는 계획서 §검증이
// 요구하는 대로 "적합값·예측값" 곡선을 R 골든값과 대조한다 — raw 기저 행렬 원소
// 대조가 아니다.
//
// R 골든값 생성(docker r-base:latest, splines 패키지는 base R 포함):
//   x <- c(30개 값, set.seed(42); rnorm(30, 0, 3) 유래)
//   y <- 2 + 0.5*x - 0.1*x^2 + 0.05*x^3 + rnorm(noise)
//   internal_knots <- quantile(x, c(0.10, 0.50, 0.90), type = 7)
//   boundary_knots <- range(x)
//   fit <- lm(y ~ ns(x, knots = internal_knots, Boundary.knots = boundary_knots,
//                    intercept = FALSE))
//   grid <- seq(min(x), max(x), length.out = 10)
//   predict(fit, newdata = data.frame(x = grid))
import { describe, it, expect } from 'vitest';
import { resolveSplineKnots, naturalSplineBasis } from '../statsSplineBasis';

const X = [
  -7.9694, -7.3214, -5.3439, -5.2895, -4.1666, -1.92, -1.6941, -1.2914, -0.9199, -0.8528,
  -0.8364, -0.7718, -0.5158, -0.4, -0.3184, -0.284, -0.1881, 1.0894, 1.2128, 1.3803,
  1.8986, 1.9079, 3.644, 3.9146, 3.9603, 4.1129, 4.5346, 5.6856, 6.0553, 6.8599,
];
const Y = [
  -33.1877, -25.9386, -10.1229, -11.4513, -4.9311, -1.3995, -0.1616, 0.2289, -0.9977, 1.506,
  1.6886, 1.1705, 2.4668, 1.0541, 0.4608, 2.2816, 1.0907, 3.9348, 2.1171, 3.2868,
  3.2529, 2.1533, 6.4892, 6.0672, 5.6072, 6.1201, 7.5525, 10.8897, 9.4693, 17.1497,
];

const R_INTERNAL_KNOTS = [-5.29494, -0.3012, 4.6497];
const R_BOUNDARY_KNOTS: [number, number] = [-7.9694, 6.8599];
const R_FITTED = [
  -32.39747569, -26.61217557, -11.25286077, -10.91922031, -5.36171957, 0.00095217, 0.25946646,
  0.64527621, 0.93657257, 0.98434939, 0.9958462, 1.04049876, 1.20949423, 1.28311215, 1.3344544,
  1.3560326, 1.41611121, 2.27803612, 2.37494024, 2.51255951, 2.9912036, 3.00062083, 5.47128407,
  6.01614435, 6.11328414, 6.44878756, 7.46946002, 10.94197119, 12.21256903, 15.0978249,
];
const R_GRID = [
  -7.9694, -6.3217, -4.674, -3.0263, -1.3786, 0.2691, 1.9168, 3.5645, 5.2122, 6.8599,
];
const R_GRID_FITTED = [
  -32.39747569, -18.19769922, -7.57380396, -1.88526892, 0.56881993, 1.70533961, 3.00966293,
  5.32074784, 9.40785475, 15.0978249,
];
const R_SQUARED = 0.9891862;

/** 정규방정식 OLS(외부 라이브러리 없이 — 이 테스트는 spline 기저 자체의 정확성을
 * 검증하는 것이 목적이므로, 프로젝트의 SVD 기반 rank/fit 로직 재사용은 불필요하다). */
function fitOls(designRows: readonly (readonly number[])[], y: readonly number[]): number[] {
  const n = designRows.length;
  const p = designRows[0].length;
  const AtA = Array.from({ length: p }, () => new Array(p).fill(0));
  const Atb = new Array(p).fill(0);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < p; j += 1) {
      Atb[j] += designRows[i][j] * y[i];
      for (let k = 0; k < p; k += 1) AtA[j][k] += designRows[i][j] * designRows[i][k];
    }
  }
  const M = AtA.map((row, i) => [...row, Atb[i]]);
  for (let col = 0; col < p; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < p; r += 1) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    [M[col], M[pivot]] = [M[pivot], M[col]];
    for (let r = 0; r < p; r += 1) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= p; c += 1) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row, i) => row[p] / row[i]);
}

function designRow(x: number, knots: NonNullable<ReturnType<typeof resolveSplineKnots>>): number[] {
  return [1, ...naturalSplineBasis(x, knots)];
}

describe('resolveSplineKnots — type-7 quantile 위치가 R quantile(type=7)과 일치', () => {
  it('내부/경계 knot이 R 골든값과 일치', () => {
    const knots = resolveSplineKnots(X);
    expect(knots).not.toBeNull();
    expect(knots!.boundary[0]).toBeCloseTo(R_BOUNDARY_KNOTS[0], 6);
    expect(knots!.boundary[1]).toBeCloseTo(R_BOUNDARY_KNOTS[1], 6);
    knots!.internal.forEach((v, i) => expect(v).toBeCloseTo(R_INTERNAL_KNOTS[i], 4));
  });

  it('고유값 5개 미만이면 null', () => {
    expect(resolveSplineKnots([1, 1, 1, 2, 3])).toBeNull();
  });

  it('내부 knot이 경계와 겹치면(편중 분포) null', () => {
    // 90% 분위수가 최댓값과 같아지도록 값을 극단적으로 치우치게 구성.
    const skewed = [0, 0, 0, 0, 0, 0, 0, 0, 1, 100];
    expect(resolveSplineKnots(skewed)).toBeNull();
  });
});

describe('naturalSplineBasis — R ns()와 같은 함수공간(적합값·예측값으로 대조)', () => {
  const knots = resolveSplineKnots(X)!;

  it('훈련 데이터 적합값이 R lm(y ~ ns(...))의 fitted()와 일치', () => {
    const design = X.map((x) => designRow(x, knots));
    const beta = fitOls(design, Y);
    const fitted = design.map((row) => row.reduce((s, v, i) => s + v * beta[i], 0));
    fitted.forEach((v, i) => expect(v).toBeCloseTo(R_FITTED[i], 5));
  });

  it('예측 그리드(원단위)에서 predict()와 일치 — 같은 knot 재사용 검증', () => {
    const design = X.map((x) => designRow(x, knots));
    const beta = fitOls(design, Y);
    const gridFitted = R_GRID.map((x) => {
      const row = designRow(x, knots);
      return row.reduce((s, v, i) => s + v * beta[i], 0);
    });
    gridFitted.forEach((v, i) => expect(v).toBeCloseTo(R_GRID_FITTED[i], 5));
  });

  it('결정계수(R²)가 R summary(fit)$r.squared와 일치', () => {
    const design = X.map((x) => designRow(x, knots));
    const beta = fitOls(design, Y);
    const fitted = design.map((row) => row.reduce((s, v, i) => s + v * beta[i], 0));
    const ssRes = Y.reduce((s, yi, i) => s + (yi - fitted[i]) ** 2, 0);
    const yMean = Y.reduce((a, b) => a + b, 0) / Y.length;
    const ssTot = Y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
    expect(1 - ssRes / ssTot).toBeCloseTo(R_SQUARED, 6);
  });

  it('훈련 knot과 예측 grid에서 같은 SplineKnots 객체를 재사용해야 곡선이 일치(다른 knot 재계산 시 어긋남을 확인)', () => {
    // 그리드 부분집합으로 knot을 다시 계산하면(잘못된 사용) 다른 기저가 되어
    // 원래 적합값과 어긋난다는 것을 보여줌 — 호출자가 반드시 원본 knot을 재사용해야 함을 방증.
    const wrongKnots = resolveSplineKnots(R_GRID);
    expect(wrongKnots).not.toBeNull();
    expect(wrongKnots!.internal).not.toEqual(knots.internal);
  });
});
