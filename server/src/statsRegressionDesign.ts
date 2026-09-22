// PR4-A1 — 연관성 회귀 ④설계행렬 조립 + 추정가능성 검사. 계획서
// (pr4-a-lexical-reddy.md) §2 "④ 설계행렬 + 추정가능성" 참고.
//
// Node가 숫자 설계행렬(더미 인코딩 완료)을 만들고 Python은 순수 수치 계산만
// 한다 — patsy formula 문자열을 Python에 넘기면 더미 인코딩·기준 레벨 선택이
// Python 안으로 숨어 Node가 소수셀 판정을 못 한다. 결정성·억제·감사가 전부
// Node에 남도록 이 파일이 설계행렬(y, X, 열 이름)까지 완성한다.
//
// rank 판정은 계획서(§2 ④)대로 SVD 기반이다 — 단 외부 선형대수 라이브러리
// 없이, X(N×P)에 직접 one-sided Jacobi SVD(Hestenes)를 적용해 특이값을 구한다.
// 리뷰로 발견한 결함 — 이전 판은 rank(X)=rank(X'X)라는 수학적 항등식만 믿고
// Gram 행렬(X'X)을 명시적으로 만들어 그 고유값에 문턱을 걸었다. X'X를
// 형성하는 순간 조건수가 제곱되고(cond(X'X)=cond(X)²), 작은 특이값의 정보가
// 부동소수점 상쇄로 소실된다 — 실측 재현: 40행·독립 3열(조건수 약 1e6)에서
// numpy SVD는 rank 4(정상)인데 Gram+고유값 경로는 소실된 정밀도 때문에
// 노이즈 바닥이 1e-8~1e-9까지 올라가 RANK_DEFICIENT로 오판하거나(고유값에
// 직접 문턱 적용) 반대로 진짜 중복열을 못 잡는(고유값 sqrt 후 문턱 적용)
// 비일관성을 보였다. one-sided Jacobi SVD는 회전을 X의 열에 직접 적용해
// 반복적으로 재계산하므로(Gram 행렬을 한 번에 형성·분해하지 않음) 작은
// 특이값도 거의 기계정밀도까지 정확하다(Demmel–Veselic) — 실측 대조로
// numpy.linalg.svd와 특이값이 소수점 다섯 자리까지 일치함을 확인했다.
// N이 커도 P(≤maxParameters=20)에 대해서만 열-쌍 회전을 반복하므로 비용은
// O(sweeps·P²·N)로 무시할 만하다.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { RegressionNonEstimableReason } from '@wr/contracts';
import type { DatasetRow } from './statsDatasetBuilder';
import { getOrdinalOrder, getCategoricalOrder } from './statsOrdinalOrder';
import { sortDeterministic } from './statsBivariateRoles';
import { REGRESSION_POLICY } from './statsPolicy';
import type { RegressionEventSummary } from './statsRegressionDataset';
import { resolveSplineKnots, naturalSplineBasis, type SplineKnots } from './statsSplineBasis';

export interface RegressionDesignColumn {
  name: string;
  label: string;
  variableKey: string | null; // null은 절편
  level: string | null;
  // PR4-A2 — spline 기저 항은 forest plot에서 묶어 빼고 부분효과 곡선으로 대체
  // 표시해야 한다. interaction 항은 어느 두 predictor의 곱인지 알아야 한다.
  termType: 'main' | 'interaction' | 'spline_basis';
  interactionOf: [string, string] | null;
}

export interface RegressionDesignMatrix {
  y: number[];
  x: number[][]; // N × P(절편 포함, 항상 첫 열)
  columns: RegressionDesignColumn[];
  personClusterKeys: string[];
  // PR4-A2 — limited_row 진단(§4)의 결정적 표시 샘플링에 쓰인다(sampleScatterPoints와
  // 같은 원칙 — caseId로 먼저 정렬 후 seed 셔플). y/x/personClusterKeys와 같은 행 순서.
  caseIds: string[];
  referenceLevelsUsed: Record<string, string>;
  method: 'ols_linear' | 'binary_logistic';
  eventLevel: string | null;
  qualityFlags: string[];
  // PR4-A2 — 표준화 실제 적용 열/평균·SD(재현·해석용, outcome은 표준화하지 않음).
  standardizedPredictorKeys: string[];
  standardization: Record<string, { mean: number; sd: number }>;
  // PR4-A2 — spline predictor별 knot(경계 2 + 내부 3). 예측 그리드가 같은 knot을
  // 재사용해야 하므로(§2 "표준화·spline 기저") 여기 보존한다.
  splineKnots: Record<string, SplineKnots>;
}

export type RegressionDesignResult =
  | { ok: true; design: RegressionDesignMatrix }
  | { ok: false; reason: RegressionNonEstimableReason };

// ---------------------------------------------------------------------------
// 기준 레벨 해석 (리뷰 #12/#18)
// ---------------------------------------------------------------------------

/** 모든 후보를 "완전사례에 실제로 관측된 레벨"로 먼저 좁힌다. 선언 순서가
 * 있는 변수는 선언∩관측의 첫 값, 없는 동적 categorical은 사용자 지정값이
 * 관측돼 있으면 그대로, 아니면 관측값을 결정적 정렬한 첫 값. */
function resolveReferenceLevel(
  variableKey: string,
  observedLevels: readonly string[], // 완전사례에서 실제 관측된 고유 레벨(중복 없음)
  requestedLevel: string | undefined,
): { level: string; usedFallback: boolean } {
  const declared = getOrdinalOrder(variableKey) ?? getCategoricalOrder(variableKey);
  const observedSet = new Set(observedLevels);

  if (declared) {
    // 선언은 있으나 완전사례에 없는 레벨은 후보에서 제외 — 그 레벨을 기준으로
    // 잡으면 더미 인코딩에서 "관측된 적 없는 기준"이라는 무의미한 결과가 된다.
    const candidates = declared.filter((l) => observedSet.has(l));
    if (requestedLevel !== undefined && candidates.includes(requestedLevel)) {
      return { level: requestedLevel, usedFallback: false };
    }
    // requestedLevel이 선언엔 있지만 완전사례엔 없거나, 애초에 미지정 → 폴백.
    return { level: candidates[0], usedFallback: requestedLevel !== undefined };
  }

  // 선언 없는 동적 categorical(예: 담당의) — statsRecipeValidation.ts 1단계에서
  // 이 값의 유효성을 검증할 수 없었으므로 여기서 처음 판정한다. 관측된 값을
  // 사용자가 지정했으면 그대로 쓴다(400도, 조용한 치환도 아님 — 리뷰 #18).
  if (requestedLevel !== undefined && observedSet.has(requestedLevel)) {
    return { level: requestedLevel, usedFallback: false };
  }
  const sorted = sortDeterministic(observedLevels);
  return { level: sorted[0], usedFallback: requestedLevel !== undefined };
}

// ---------------------------------------------------------------------------
// rank 계산 — one-sided Jacobi SVD(X에 직접 적용, Gram 행렬을 형성하지 않음)
// ---------------------------------------------------------------------------

const RANK_RCOND = 1e-10;

/** one-sided Jacobi(Hestenes) SVD — X(N×P)의 두 열이 직교가 아니면 그 두 열
 * 평면에서 회전시켜 직교화하고, 전체 열 쌍이 수렴할 때까지 반복한다. 수렴 후
 * 각 열의 L2 노름이 특이값이다. Gram 행렬(X'X)을 한 번에 형성·분해하지 않고
 * 매 스윕마다 *현재* 열에서 내적(alpha·beta·gamma)을 다시 계산하므로, 이미
 * 직교화가 진행된 뒤에는 그 내적 자체가 아주 작은 값으로 정확히 계산된다 —
 * Gram 행렬을 한 번만 만들어 고유분해하는 방식은 작은 특이값의 정보가 X'X를
 * 형성하는 시점의 부동소수점 상쇄로 이미 소실돼 있어 이 정확도에 도달할 수
 * 없다(Demmel–Veselic, "Jacobi's method is more accurate than QR"). */
function singularValuesOneSidedJacobi(x: number[][]): number[] {
  const n = x.length;
  const p = n > 0 ? x[0].length : 0;
  if (p === 0) return [];
  const cols: Float64Array[] = Array.from({ length: p }, (_, j) => Float64Array.from(x.map((row) => row[j])));
  const maxSweeps = 60;
  const convTol = 1e-15;
  for (let sweep = 0; sweep < maxSweeps; sweep += 1) {
    let maxOffRatio = 0;
    for (let pp = 0; pp < p - 1; pp += 1) {
      for (let qq = pp + 1; qq < p; qq += 1) {
        const cp = cols[pp];
        const cq = cols[qq];
        let alpha = 0;
        let beta = 0;
        let gamma = 0;
        for (let i = 0; i < n; i += 1) {
          alpha += cp[i] * cp[i];
          beta += cq[i] * cq[i];
          gamma += cp[i] * cq[i];
        }
        const denom = Math.sqrt(alpha * beta);
        if (denom === 0) continue; // 완전 0벡터 열은 ④ 앞단(ZERO_VARIANCE_PREDICTOR)에서 이미 걸러짐
        const ratio = Math.abs(gamma) / denom;
        if (ratio > maxOffRatio) maxOffRatio = ratio;
        if (ratio < convTol) continue;
        const zeta = (beta - alpha) / (2 * gamma);
        const t = zeta === 0 ? 1 : Math.sign(zeta) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
        const c = 1 / Math.sqrt(1 + t * t);
        const s = c * t;
        for (let i = 0; i < n; i += 1) {
          const vp = cp[i];
          const vq = cq[i];
          cp[i] = c * vp - s * vq;
          cq[i] = s * vp + c * vq;
        }
      }
    }
    if (maxOffRatio < convTol) break;
  }
  return cols.map((c) => {
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) sumSq += c[i] * c[i];
    return Math.sqrt(sumSq);
  });
}

/** 특이값 중 최댓값의 RANK_RCOND배보다 큰 것만 rank에 센다 — numpy
 * `linalg.matrix_rank(X, tol=rcond*s.max())`와 동일한 판정 기준. */
export function matrixRank(x: number[][]): number {
  const singularValues = singularValuesOneSidedJacobi(x);
  if (singularValues.length === 0) return 0;
  const maxSingular = Math.max(...singularValues, 0);
  const threshold = RANK_RCOND * (maxSingular || 1);
  return singularValues.filter((s) => s > threshold).length;
}

// ---------------------------------------------------------------------------
// 설계행렬 조립
// ---------------------------------------------------------------------------

export interface BuildRegressionDesignInput {
  completeRows: DatasetRow[];
  outcomeKey: string;
  predictorKeys: readonly string[]; // variableKeys 원래 순서(outcome 제외) — forest plot 행 순서
  catalogByKey: Map<string, AnalyticsVariableMetadata>;
  method: 'ols_linear' | 'binary_logistic';
  referenceLevels: Readonly<Record<string, string>>;
  // §2 ④ EPV — boolean outcome 전용. categorical outcome은 eventLevel 확정 후
  // 이 함수가 로컬로 직접 집계한다(계획서 §2 "categorical 2레벨 outcome").
  eventSummary: RegressionEventSummary | null;
  eventLevel: string | undefined;                             // PR4-A2 — categorical, recipe 지정값
  standardizePredictors: boolean;                              // PR4-A2
  interactionTerms: readonly (readonly [string, string])[];    // PR4-A2
  splineKeys: readonly string[];                                // PR4-A2
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

interface ColumnGroupEntry {
  name: string;
  label: string;
  level: string | null;
  termType: 'main' | 'spline_basis';
  values: number[];
}

export function buildRegressionDesignMatrix(input: BuildRegressionDesignInput): RegressionDesignResult {
  const {
    completeRows, outcomeKey, predictorKeys, catalogByKey, method, referenceLevels, eventSummary,
    eventLevel: requestedEventLevel, standardizePredictors, interactionTerms, splineKeys,
  } = input;
  const qualityFlags: string[] = [];

  // 리뷰로 발견한 결함 — REGRESSION_POLICY.minCompleteRows(30)가 정책 상수로는
  // 선언돼 있었지만 실행 경로 어디에서도 비교되지 않았다. 아래 parameterCount/
  // residualDf 검사만으로는 걸러지지 않는다(예: 절편+predictor 1개, n=12면
  // residualDf=10으로 minResidualDf 문턱을 통과) — 별도로 명시 검사해야 한다.
  if (completeRows.length < REGRESSION_POLICY.minCompleteRows) {
    return { ok: false, reason: 'INSUFFICIENT_COMPLETE_ROWS' };
  }

  const outcomeVar = catalogByKey.get(outcomeKey);

  // --- outcome 벡터 ---
  const y: number[] = [];
  let resolvedEventLevel: string | null = null;
  let localEventSummary: RegressionEventSummary | null = null;

  if (method === 'ols_linear') {
    for (const row of completeRows) {
      const raw = row.values[outcomeKey]?.value;
      if (!isFiniteNumber(raw)) return { ok: false, reason: 'CONSTANT_OUTCOME' };
      y.push(raw);
    }
  } else if (outcomeVar?.type === 'categorical') {
    // PR4-A2 §2 "categorical 2레벨 outcome" — ③ 공개통제(모든 관측 레벨 ≥10명)를
    // 이미 통과했으므로 여기서 "정확히 2개"를 판정해도 개별 레벨 인원수는 안 샌다.
    const stringValues = completeRows.map((r) => String(r.values[outcomeKey]?.value));
    const observedLevels = Array.from(new Set(stringValues));
    if (observedLevels.length !== 2) {
      return { ok: false, reason: 'CATEGORICAL_OUTCOME_NOT_BINARY' };
    }
    const { level, usedFallback } = resolveReferenceLevel(outcomeKey, observedLevels, requestedEventLevel);
    if (usedFallback) qualityFlags.push('event_level_fallback');
    resolvedEventLevel = level;
    const eventPersons = new Set<string>();
    const nonEventPersons = new Set<string>();
    completeRows.forEach((row, i) => {
      const isEvent = stringValues[i] === resolvedEventLevel;
      y.push(isEvent ? 1 : 0);
      (isEvent ? eventPersons : nonEventPersons).add(row.personClusterKey);
    });
    localEventSummary = { eventPersonCount: eventPersons.size, nonEventPersonCount: nonEventPersons.size };
  } else {
    // boolean outcome(기존 경로)
    resolvedEventLevel = 'true';
    for (const row of completeRows) {
      y.push(row.values[outcomeKey]?.value === true ? 1 : 0);
    }
  }
  if (new Set(y).size < 2) {
    return { ok: false, reason: 'CONSTANT_OUTCOME' };
  }

  // --- predictor 열 조립(리뷰 #20 — 더미 생성 전에 원 predictor 단위로 단일
  // 레벨을 먼저 검사한다). key -> 그 predictor가 만든 열들("그룹")로 관리해야
  // 표준화·spline 치환·interaction 외적이 predictor 단위로 자연스럽게 맞물린다. ---
  const predictorGroups = new Map<string, ColumnGroupEntry[]>();
  const rawContinuousValues = new Map<string, number[]>(); // spline knot은 항상 원단위 값으로 계산
  const referenceLevelsUsed: Record<string, string> = {};

  for (const key of predictorKeys) {
    const variable = catalogByKey.get(key);
    if (!variable) continue; // UNKNOWN_VARIABLE로 이미 statsRecipeValidation.ts가 거부

    if (variable.type === 'continuous') {
      const values = completeRows.map((r) => {
        const raw = r.values[key]?.value;
        return isFiniteNumber(raw) ? raw : NaN;
      });
      if (values.some((v) => Number.isNaN(v))) return { ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' };
      if (new Set(values).size < 2) return { ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' };
      rawContinuousValues.set(key, values);
      predictorGroups.set(key, [{ name: key, label: variable.label, level: null, termType: 'main', values: [...values] }]);
      continue;
    }

    if (variable.type === 'boolean') {
      const values = completeRows.map((r) => (r.values[key]?.value === true ? 1 : 0));
      if (new Set(values).size < 2) return { ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' };
      predictorGroups.set(key, [{ name: key, label: variable.label, level: null, termType: 'main', values }]);
      continue;
    }

    // categorical | ordinal
    const stringValues = completeRows.map((r) => String(r.values[key]?.value));
    const observedLevels = Array.from(new Set(stringValues));

    // 리뷰 #20 — 더미(k-1열)를 만들기 전에 원 predictor 단위로 레벨 수를 검사한다.
    // 레벨이 하나뿐이면 더미 열이 0개라 아래 열 분산·rank 검사에 걸릴 대상 자체가
    // 없어, 사용자가 고른 변수가 조용히 모형에서 사라진다.
    if (observedLevels.length < 2) return { ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' };
    if (observedLevels.length > REGRESSION_POLICY.maxLevels) return { ok: false, reason: 'TOO_MANY_LEVELS' };

    const { level: referenceLevel, usedFallback } = resolveReferenceLevel(key, observedLevels, referenceLevels[key]);
    if (usedFallback) qualityFlags.push('reference_level_fallback');
    referenceLevelsUsed[key] = referenceLevel;

    const declared = getOrdinalOrder(key) ?? getCategoricalOrder(key);
    const dummyLevelOrder = declared
      ? declared.filter((l) => observedLevels.includes(l) && l !== referenceLevel)
      : sortDeterministic(observedLevels).filter((l) => l !== referenceLevel);

    predictorGroups.set(key, dummyLevelOrder.map((level) => ({
      name: `${key}=${level}`,
      label: `${variable.label}: ${level}`,
      level,
      termType: 'main',
      values: stringValues.map((v) => (v === level ? 1 : 0)),
    })));
  }

  // --- 표준화(PR4-A2) — continuous 유래 열에 z-score. spline 대상은 제외한다
  // (spline은 항상 원단위 knot 기준으로 계산 — 표준화 후 splining하면 knot을
  // un-standardize해서 원단위로 보고해야 하는 불필요한 왕복이 생긴다. 표준화된
  // 값의 spline 기저는 단일 계수 해석이 없어 "표준화 계수"라는 개념 자체가
  // 적용되지 않는다). outcome은 표준화하지 않는다. ---
  const standardizedPredictorKeys: string[] = [];
  const standardization: Record<string, { mean: number; sd: number }> = {};
  if (standardizePredictors) {
    for (const key of predictorKeys) {
      const variable = catalogByKey.get(key);
      if (!variable || variable.type !== 'continuous' || splineKeys.includes(key)) continue;
      const group = predictorGroups.get(key);
      if (!group) continue;
      const values = group[0].values;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
      group[0].values = values.map((v) => (v - mean) / sd);
      standardizedPredictorKeys.push(key);
      standardization[key] = { mean, sd };
    }
  }

  // --- spline 기저 치환(PR4-A2) — §2 "표준화·spline 기저" 5-knot 정책(경계 2 +
  // 내부 3, df=4). 고유값 부족·knot 중복은 resolveSplineKnots가 null로 알린다. ---
  const splineKnots: Record<string, SplineKnots> = {};
  for (const key of splineKeys) {
    const rawValues = rawContinuousValues.get(key);
    if (!rawValues) continue; // 구조/의미검증이 이미 continuous만 허용 — 방어적 분기
    const knots = resolveSplineKnots(rawValues);
    if (!knots) return { ok: false, reason: 'SPLINE_INSUFFICIENT_UNIQUE_VALUES' };
    splineKnots[key] = knots;
    const variable = catalogByKey.get(key)!;
    const basisSuffixes = ['ns1', 'ns2', 'ns3', 'ns4'] as const;
    predictorGroups.set(key, basisSuffixes.map((suffix, basisIndex) => ({
      name: `${key}#${suffix}`,
      label: `${variable.label}(spline ${suffix})`,
      level: null,
      termType: 'spline_basis',
      values: rawValues.map((v) => naturalSplineBasis(v, knots)[basisIndex]),
    })));
  }

  // --- 절편 + predictor 열(원래 순서, forest plot 행 순서)을 조립 ---
  const columns: RegressionDesignColumn[] = [
    { name: 'intercept', label: '절편', variableKey: null, level: null, termType: 'main', interactionOf: null },
  ];
  const predictorColumns: number[][] = []; // 열 단위(전치) — 나중에 행 단위로 합친다

  for (const key of predictorKeys) {
    const group = predictorGroups.get(key);
    if (!group) continue;
    for (const entry of group) {
      predictorColumns.push(entry.values);
      columns.push({
        name: entry.name, label: entry.label, variableKey: key, level: entry.level,
        termType: entry.termType, interactionOf: null,
      });
    }
  }

  // --- interaction 열(PR4-A2) — splineKeys와 배타적(계약 단계에서 이미 거부됨)
  // 이므로 continuous/boolean/categorical(k-1열) 열 그룹의 외적만 고려한다.
  // 표준화 이후 실행되므로 표준화된 값으로 곱해진다. ---
  for (const [keyA, keyB] of interactionTerms) {
    const groupA = predictorGroups.get(keyA);
    const groupB = predictorGroups.get(keyB);
    if (!groupA || !groupB) continue; // 방어적 — 구조검사가 이미 predictor 소속을 확인
    const varA = catalogByKey.get(keyA)!;
    const varB = catalogByKey.get(keyB)!;
    for (const entryA of groupA) {
      for (const entryB of groupB) {
        const labelA = entryA.level ? `${varA.label}:${entryA.level}` : varA.label;
        const labelB = entryB.level ? `${varB.label}:${entryB.level}` : varB.label;
        predictorColumns.push(entryA.values.map((v, i) => v * entryB.values[i]));
        columns.push({
          name: `${entryA.name}×${entryB.name}`,
          label: `${labelA} × ${labelB}`,
          variableKey: null, // 두 predictor에 걸침 — interactionOf 참고
          level: null,
          termType: 'interaction',
          interactionOf: [keyA, keyB],
        });
      }
    }
  }

  // --- 절편 + predictor 열을 행 단위 행렬로 합친다 ---
  const n = completeRows.length;
  const x: number[][] = Array.from({ length: n }, () => new Array(1 + predictorColumns.length).fill(1));
  for (let col = 0; col < predictorColumns.length; col += 1) {
    for (let row = 0; row < n; row += 1) {
      x[row][1 + col] = predictorColumns[col][row];
    }
  }

  const parameterCount = columns.length; // 절편 포함
  const parameterCountNoIntercept = parameterCount - 1;
  const residualDf = n - parameterCount;

  if (parameterCount > REGRESSION_POLICY.maxParameters || residualDf < REGRESSION_POLICY.minResidualDf) {
    return { ok: false, reason: 'TOO_MANY_PARAMETERS' };
  }

  if (method === 'binary_logistic') {
    // PR4-A2 — categorical outcome은 eventLevel 확정 후 로컬로 집계한 값을 쓴다
    // (boolean은 기존 ②단계 eventSummary를 그대로 재사용 — 두 번 계산하지 않는다).
    const effectiveEventSummary = outcomeVar?.type === 'categorical' ? localEventSummary : eventSummary;
    if (!effectiveEventSummary || parameterCountNoIntercept === 0) {
      return { ok: false, reason: 'INSUFFICIENT_EVENTS_PER_PARAMETER' };
    }
    // 분자 = 사건을 가진 고유 person 수와 non-event person 수 중 작은 쪽(행
    // 수가 아니다 — 반복행을 독립 사건처럼 세면 게이트가 무의미해진다).
    // 분모 = 절편을 제외한 파라미터 수.
    const epv = Math.min(effectiveEventSummary.eventPersonCount, effectiveEventSummary.nonEventPersonCount) / parameterCountNoIntercept;
    if (epv < REGRESSION_POLICY.minEventsPerParameter) {
      return { ok: false, reason: 'INSUFFICIENT_EVENTS_PER_PARAMETER' };
    }
  }

  const rank = matrixRank(x);
  if (rank < parameterCount) {
    return { ok: false, reason: 'RANK_DEFICIENT' };
  }

  return {
    ok: true,
    design: {
      y,
      x,
      columns,
      personClusterKeys: completeRows.map((r) => r.personClusterKey),
      caseIds: completeRows.map((r) => r.caseId),
      referenceLevelsUsed,
      method,
      eventLevel: resolvedEventLevel,
      qualityFlags,
      standardizedPredictorKeys,
      standardization,
      splineKnots,
    },
  };
}
