// PR3-B — 산점도(계획서 §2/§6.8.1/§7). 원시좌표는 이미 Node의 PairedRow로 존재하고
// 2D 그리드 집계도 사칙연산이라 전부 Node(TS)에서 처리한다 — Python을 거치지
// 않는다("산점도는 Python 미경유" 원칙). bin count는 histogram.py와 동일한
// Freedman-Diaconis 규칙을 JS로 이식한다(재호출 대신 이식).
import { isSmallCell } from './statsSmallCell';
import type { PersonKeyed } from './statsChartDisclosure';

const MAX_BINS = 50;
const MIN_BINS = 1;
export const MAX_SCATTER_POINTS = 2000;

// numpy.percentile(method="linear")과 동치 — R quantile(type=7). sortedValues는
// 오름차순 정렬된 배열이어야 한다.
function quantileLinear(sortedValues: number[], q: number): number {
  const n = sortedValues.length;
  if (n === 1) return sortedValues[0];
  const rank = q * (n - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sortedValues[lower];
  const frac = rank - lower;
  return sortedValues[lower] + frac * (sortedValues[upper] - sortedValues[lower]);
}

/** histogram.py::compute_histogram의 bin count 결정 로직(§2 분기 3/4)과 동일한
 * 규칙 — 여기서는 min===max(분기2, 상수) 판정은 호출자가 먼저 처리한다. */
function freedmanDiaconisBinCount(values: number[]): number {
  const n = values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[n - 1];
  const q1 = quantileLinear(sorted, 0.25);
  const q3 = quantileLinear(sorted, 0.75);
  const iqr = q3 - q1;
  let k: number;
  if (iqr === 0) {
    k = Math.ceil(Math.log2(n) + 1);
  } else {
    const h = 2 * iqr * Math.pow(n, -1 / 3);
    k = h > 0 && Number.isFinite(h) ? Math.ceil((max - min) / h) : Math.ceil(Math.log2(n) + 1);
  }
  return Math.max(MIN_BINS, Math.min(MAX_BINS, k));
}

// 부동소수점 나눗셈(예: min=0.05/max=0.21/k=5)에서 min+((max-min)*k)/k가 max와
// 정확히 같지 않을 수 있다(0.20999999999999996 등) — 마지막 bin이 max를 포함하지
// 못해 최댓값 관측치가 어느 bin에도 안 걸리고 조용히 누락되면(§소수셀 억제 우회)
// 그 관측치가 실제로는 소수셀이었어도 그리드가 공개될 수 있다. 양끝을 min/max로
// 강제 고정해 부동소수점 오차가 경계 판정에 영향을 주지 않게 한다.
function makeEdges(min: number, max: number, k: number): number[] {
  const edges: number[] = [];
  for (let i = 0; i <= k; i += 1) edges.push(min + ((max - min) * i) / k);
  edges[0] = min;
  edges[edges.length - 1] = max;
  return edges;
}

// 마지막 bin만 양끝 포함(numpy.histogram과 동일한 경계 규칙, §2).
function binIndex(value: number, edges: number[]): number {
  const k = edges.length - 1;
  for (let i = 0; i < k; i += 1) {
    const isLast = i === k - 1;
    const inBin = isLast ? value >= edges[i] && value <= edges[i + 1] : value >= edges[i] && value < edges[i + 1];
    if (inBin) return i;
  }
  return -1;
}

export interface ScatterGridCell {
  i: number;
  j: number;
  count: number;
}

export interface ScatterGridResult {
  xEdges: number[];
  yEdges: number[];
  cells: ScatterGridCell[];
}

/**
 * 산점도 2D 그리드 — 그리드 셀 단위 person 소수셀 전체연결억제(계획서 §3을
 * 그리드에 확장). 어느 한 셀이라도 소수셀이면 그리드 전체를 억제한다(null 반환,
 * §6.8.4 "과밀과 억제"). rows는 person 신원을 아는 쪽(PairedRow)이어야 한다.
 */
export function computeScatterGrid<T extends PersonKeyed>(
  rows: T[],
  xOf: (row: T) => number,
  yOf: (row: T) => number,
): ScatterGridResult | null {
  const n = rows.length;
  if (n === 0) return { xEdges: [], yEdges: [], cells: [] };

  const xValues = rows.map(xOf);
  const yValues = rows.map(yOf);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const yMin = Math.min(...yValues);
  const yMax = Math.max(...yValues);

  const xEdges = xMin === xMax ? [xMin, xMax] : makeEdges(xMin, xMax, freedmanDiaconisBinCount(xValues));
  const yEdges = yMin === yMax ? [yMin, yMax] : makeEdges(yMin, yMax, freedmanDiaconisBinCount(yValues));

  const cellRows = new Map<string, T[]>();
  for (const row of rows) {
    const xi = xMin === xMax ? 0 : binIndex(xOf(row), xEdges);
    const yj = yMin === yMax ? 0 : binIndex(yOf(row), yEdges);
    // 유효 관측치(xOf/yOf는 항상 유한수)가 bin 배정에 실패하는 건 makeEdges의
    // 경계 계산 버그를 뜻한다 — 조용히 continue하면 그 관측치가 소수셀 검사를
    // 거치지 않고 그리드에서 사라져 억제를 우회할 수 있다(실제로 발견된 반례:
    // 부동소수점 오차로 마지막 edge<max가 돼 max값 관측치 1명이 누락된 채
    // 나머지 10명짜리 그리드만 공개됨). 절대 일어나면 안 되는 상태이므로 무시
    // 대신 명시적으로 실패시킨다.
    if (xi < 0 || yj < 0) {
      throw new Error(`statsScatterGrid: bin 배정 실패(경계 계산 결함) — x=${xOf(row)}, y=${yOf(row)}`);
    }
    const cellKey = `${xi}:${yj}`;
    let bucket = cellRows.get(cellKey);
    if (!bucket) { bucket = []; cellRows.set(cellKey, bucket); }
    bucket.push(row);
  }

  for (const bucket of cellRows.values()) {
    const personCount = new Set(bucket.map((r) => r.personClusterKey)).size;
    if (isSmallCell(personCount)) return null;
  }

  const cells: ScatterGridCell[] = [...cellRows.entries()].map(([key, bucket]) => {
    const [i, j] = key.split(':').map(Number);
    return { i, j, count: bucket.length };
  });

  // 방어적 불변조건 — 공개되는 그리드의 count 합은 항상 입력 전체 유효 pair 수와
  // 같아야 한다(위에서 배정 실패를 이미 throw로 막았으니 이 시점엔 항상 참이어야
  // 하지만, 향후 리팩터로 그 불변조건이 깨지는 걸 회귀로 잡기 위해 명시적으로 확인).
  const totalCellCount = cells.reduce((sum, c) => sum + c.count, 0);
  if (totalCellCount !== n) {
    throw new Error(`statsScatterGrid: 그리드 count 합(${totalCellCount})이 전체 관측치 수(${n})와 불일치`);
  }

  return { xEdges, yEdges, cells };
}

// --- 결정적 시드 기반 셔플(Math.random() 금지, 계획서 §4/§7) ---
function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seedValue: number): () => number {
  let a = seedValue;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface ScatterPointsResult {
  displayedCount: number;
  totalCount: number;
  points: Array<[number, number]>;
}

/**
 * 응답시점 전용(§9) — stats.export_limited_rows 권한이 있을 때만 호출한다.
 * 표본추출 전 caseId로 먼저 정렬(입력 순서 독립성 확보, §4/§7)한 뒤, executionDigest
 * 파생 시드로 결정적 Fisher-Yates 셔플을 적용해 최대 2,000쌍을 뽑는다. 회귀선·r·
 * pValue는 이 함수와 무관하게 항상 전체 유효 pairwise-complete 집합 기준이다
 * (표시가 샘플로 축소돼도 통계량 자체는 축소되지 않음, §2).
 */
export function sampleScatterPoints<T extends { caseId: string }>(
  rows: T[],
  xOf: (row: T) => number,
  yOf: (row: T) => number,
  seed: string,
): ScatterPointsResult {
  const totalCount = rows.length;
  const sorted = [...rows].sort((a, b) => a.caseId.localeCompare(b.caseId));
  if (totalCount <= MAX_SCATTER_POINTS) {
    return { displayedCount: totalCount, totalCount, points: sorted.map((r) => [xOf(r), yOf(r)]) };
  }
  const rand = mulberry32(hashSeed(seed));
  const shuffled = [...sorted];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const sample = shuffled.slice(0, MAX_SCATTER_POINTS);
  return { displayedCount: sample.length, totalCount, points: sample.map((r) => [xOf(r), yOf(r)]) };
}
