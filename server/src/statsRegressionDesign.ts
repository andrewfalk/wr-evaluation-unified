// PR4-A1 — 연관성 회귀 ④설계행렬 조립 + 추정가능성 검사. 계획서
// (pr4-a-lexical-reddy.md) §2 "④ 설계행렬 + 추정가능성" 참고.
//
// Node가 숫자 설계행렬(더미 인코딩 완료)을 만들고 Python은 순수 수치 계산만
// 한다 — patsy formula 문자열을 Python에 넘기면 더미 인코딩·기준 레벨 선택이
// Python 안으로 숨어 Node가 소수셀 판정을 못 한다. 결정성·억제·감사가 전부
// Node에 남도록 이 파일이 설계행렬(y, X, 열 이름)까지 완성한다.
//
// rank 판정은 SVD가 아니라 Gram 행렬(X'X, P×P — P는 항상 maxParameters=20
// 이하로 작다)에 부분피벗 가우스 소거를 적용한다. rank(X) = rank(X'X)(실수
// 행렬의 표준 성질)이므로 수학적으로 동일하고, Node에 선형대수 라이브러리
// 의존성을 추가하지 않고 P×P(≤20×20) 크기만 다루므로 계산 비용도 무시할 만하다.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { RegressionNonEstimableReason } from '@wr/contracts';
import type { DatasetRow } from './statsDatasetBuilder';
import { getOrdinalOrder, getCategoricalOrder } from './statsOrdinalOrder';
import { sortDeterministic } from './statsBivariateRoles';
import { REGRESSION_POLICY } from './statsPolicy';
import type { RegressionEventSummary } from './statsRegressionDataset';

export interface RegressionDesignColumn {
  name: string;
  label: string;
  variableKey: string | null; // null은 절편
  level: string | null;
}

export interface RegressionDesignMatrix {
  y: number[];
  x: number[][]; // N × P(절편 포함, 항상 첫 열)
  columns: RegressionDesignColumn[];
  personClusterKeys: string[];
  referenceLevelsUsed: Record<string, string>;
  method: 'ols_linear' | 'binary_logistic';
  eventLevel: string | null;
  qualityFlags: string[];
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
// rank 계산 — Gram 행렬 + 부분피벗 가우스 소거
// ---------------------------------------------------------------------------

const RANK_RCOND = 1e-10;

/** 열별로 자기 L2 노름으로 정규화한다 — 정규화 없이 원본 스케일로 Gram 행렬을
 * 만들면 rank 판정이 predictor의 물리적 단위에 의존하게 된다(리뷰로 재현:
 * 독립인 두 열(±1)은 rank 2로 정상 판정되지만, 한 열만 ×100000으로 재스케일
 * 하면 threshold(=RANK_RCOND×maxDiag)가 큰 열의 분산에 끌려가 작은 열의 정상
 * 피벗까지 문턱 아래로 묻혀 RANK_DEFICIENT로 오판했다). 정규화 후 대각선은
 * 전부 1이 되고 비대각선은 코사인 유사도([-1,1])라 — 이는 상관행렬의 rank를
 * 보는 것과 동치이며, 열의 단위와 무관하게 고정 threshold 하나로 판정할 수
 * 있다. 완전 0벡터 열은 이미 ④ 앞단(ZERO_VARIANCE_PREDICTOR)에서 걸러지므로
 * norm===0 방어는 재현 불가능한 경로에 대한 안전망일 뿐이다. */
function normalizeColumns(x: number[][]): number[][] {
  const n = x.length;
  const p = n > 0 ? x[0].length : 0;
  const norms = new Array(p).fill(0);
  for (let j = 0; j < p; j += 1) {
    let sumSq = 0;
    for (let i = 0; i < n; i += 1) sumSq += x[i][j] * x[i][j];
    norms[j] = Math.sqrt(sumSq) || 1;
  }
  return x.map((row) => row.map((v, j) => v / norms[j]));
}

function computeGramMatrix(x: number[][]): number[][] {
  const n = x.length;
  const p = n > 0 ? x[0].length : 0;
  const gram: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i += 1) {
    for (let j = i; j < p; j += 1) {
      let sum = 0;
      for (let k = 0; k < n; k += 1) sum += x[k][i] * x[k][j];
      gram[i][j] = sum;
      gram[j][i] = sum;
    }
  }
  return gram;
}

/** rank(X) = rank(X'X). Gram 행렬에 부분피벗 가우스 소거를 적용해 rank를 센다
 * — 대각합의 최댓값에 RANK_RCOND를 곱한 값보다 작은 피벗은 0(의존 열)으로
 * 취급한다. */
export function matrixRank(x: number[][]): number {
  const gram = computeGramMatrix(normalizeColumns(x));
  const p = gram.length;
  if (p === 0) return 0;
  const m = gram.map((row) => [...row]);
  const maxDiag = Math.max(...gram.map((row, i) => Math.abs(row[i])), 0);
  const threshold = RANK_RCOND * (maxDiag || 1);

  let rank = 0;
  for (let col = 0; col < p; col += 1) {
    let pivotRow = rank;
    let pivotVal = rank < p ? Math.abs(m[rank][col]) : 0;
    for (let r = rank + 1; r < p; r += 1) {
      const v = Math.abs(m[r][col]);
      if (v > pivotVal) {
        pivotVal = v;
        pivotRow = r;
      }
    }
    if (pivotVal <= threshold) continue; // 이 열은 이전 열들의 선형결합(의존 열)
    if (pivotRow !== rank) {
      const tmp = m[rank];
      m[rank] = m[pivotRow];
      m[pivotRow] = tmp;
    }
    for (let r = rank + 1; r < p; r += 1) {
      const factor = m[r][col] / m[rank][col];
      for (let c = col; c < p; c += 1) m[r][c] -= factor * m[rank][c];
    }
    rank += 1;
    if (rank === p) break;
  }
  return rank;
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
  // §2 ④ EPV — ②에서 이미 계산해둔 값을 재사용(같은 complete-case 기준으로
  // 두 번 계산하지 않는다).
  eventSummary: RegressionEventSummary | null;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function buildRegressionDesignMatrix(input: BuildRegressionDesignInput): RegressionDesignResult {
  const { completeRows, outcomeKey, predictorKeys, catalogByKey, method, referenceLevels, eventSummary } = input;
  const qualityFlags: string[] = [];

  // 리뷰로 발견한 결함 — REGRESSION_POLICY.minCompleteRows(30)가 정책 상수로는
  // 선언돼 있었지만 실행 경로 어디에서도 비교되지 않았다. 아래 parameterCount/
  // residualDf 검사만으로는 걸러지지 않는다(예: 절편+predictor 1개, n=12면
  // residualDf=10으로 minResidualDf 문턱을 통과) — 별도로 명시 검사해야 한다.
  if (completeRows.length < REGRESSION_POLICY.minCompleteRows) {
    return { ok: false, reason: 'INSUFFICIENT_COMPLETE_ROWS' };
  }

  // --- outcome 벡터 ---
  const y: number[] = [];
  for (const row of completeRows) {
    const raw = row.values[outcomeKey]?.value;
    if (method === 'ols_linear') {
      if (!isFiniteNumber(raw)) return { ok: false, reason: 'CONSTANT_OUTCOME' };
      y.push(raw);
    } else {
      y.push(raw === true ? 1 : 0);
    }
  }
  if (new Set(y).size < 2) {
    return { ok: false, reason: 'CONSTANT_OUTCOME' };
  }

  // --- predictor 열 조립(리뷰 #20 — 더미 생성 전에 원 predictor 단위로 단일
  // 레벨을 먼저 검사한다) ---
  const columns: RegressionDesignColumn[] = [
    { name: 'intercept', label: '절편', variableKey: null, level: null },
  ];
  const predictorColumns: number[][] = []; // 열 단위(전치) — 나중에 행 단위로 합친다
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
      predictorColumns.push(values);
      columns.push({ name: key, label: variable.label, variableKey: key, level: null });
      continue;
    }

    if (variable.type === 'boolean') {
      const values = completeRows.map((r) => (r.values[key]?.value === true ? 1 : 0));
      if (new Set(values).size < 2) return { ok: false, reason: 'ZERO_VARIANCE_PREDICTOR' };
      predictorColumns.push(values);
      columns.push({ name: key, label: variable.label, variableKey: key, level: null });
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

    for (const level of dummyLevelOrder) {
      const values = stringValues.map((v) => (v === level ? 1 : 0));
      predictorColumns.push(values);
      columns.push({ name: `${key}=${level}`, label: `${variable.label}: ${level}`, variableKey: key, level });
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
    if (!eventSummary || parameterCountNoIntercept === 0) {
      return { ok: false, reason: 'INSUFFICIENT_EVENTS_PER_PARAMETER' };
    }
    // 분자 = 사건을 가진 고유 person 수와 non-event person 수 중 작은 쪽(행
    // 수가 아니다 — 반복행을 독립 사건처럼 세면 게이트가 무의미해진다).
    // 분모 = 절편을 제외한 파라미터 수.
    const epv = Math.min(eventSummary.eventPersonCount, eventSummary.nonEventPersonCount) / parameterCountNoIntercept;
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
      referenceLevelsUsed,
      method,
      eventLevel: method === 'binary_logistic' ? 'true' : null,
      qualityFlags,
    },
  };
}
