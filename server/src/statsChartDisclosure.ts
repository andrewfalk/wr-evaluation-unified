// PR3-B — 차트 데이터(히스토그램·박스플롯 이상치·산점도)의 person 단위 공개통제.
// 계획서 §1/§3/§9. 이 모듈은 두 가지 독립된 축을 다룬다:
//
//   1) aggregate 게이트(compute 시점, 캐시 대상) — 히스토그램은 B안(적응형 해상도
//      축소, resolveDisclosableHistogram): 원본 bin이 실패하면 정해진 후보
//      해상도로 lo~hi를 다시 균등분할해 공개 가능한 가장 세밀한 것을 채택한다(A안
//      후속). 박스플롯 이상치는 여전히 전용 partition 게이트(outlierCount의 존재
//      여부, all-or-nothing) 그대로.
//   2) limited_row 응답시점 merge(§9) — outlierCount가 이미 공개 확정된 변수에
//      한해, 권한이 있을 때만 정확한 원시값을 원본 rows에서 즉석 재계산한다
//      (Python 재호출 없음, stats_runs.result에 절대 저장하지 않음).
//
// Python은 person을 모른다(프로젝트 전역 원칙) — 이 두 게이트 모두 Node가
// person 신원을 아는 원본 행(DatasetRow 또는 PairedRow, 둘 다 personClusterKey를
// 가짐)을 직접 재순회해 판정한다. 제네릭으로 두 타입 모두를 받아 그룹별 박스플롯
// (계획서 §5, PairedRow 기반)과 단변량 히스토그램/박스플롯(DatasetRow 기반)이
// 같은 게이트 로직을 공유하게 한다(중복 구현 금지).
import { isSmallCell } from './statsSmallCell';
import { MIN_DISCLOSABLE_BINS } from './statsPolicy';

export interface PersonKeyed {
  personClusterKey: string;
}

function distinctPersons<T extends PersonKeyed>(rows: T[]): number {
  return new Set(rows.map((r) => r.personClusterKey)).size;
}

export interface HistogramBinLike {
  lower: number;
  upper: number;
  count: number;
}

/** 0단계(원본) 검사 — 옛 `isHistogramDisclosable`과 동일한 규칙을 그대로 재사용한다.
 * 마지막 bin만 양끝 포함(numpy.histogram과 동일한 경계 포함 규칙). count===0인 bin은
 * 검사할 person 집합이 없으므로 건너뛴다. */
function passesOriginal<T extends PersonKeyed>(
  presentRows: T[],
  bins: HistogramBinLike[],
  valueOf: (row: T) => number | null,
): boolean {
  for (let i = 0; i < bins.length; i += 1) {
    const bin = bins[i];
    if (bin.count === 0) continue;
    const isLast = i === bins.length - 1;
    const inBin = presentRows.filter((row) => {
      const v = valueOf(row) as number;
      return isLast ? v >= bin.lower && v <= bin.upper : v >= bin.lower && v < bin.upper;
    });
    if (isSmallCell(distinctPersons(inBin))) return false;
  }
  return true;
}

/** B안 폴백 후보 bin 개수 목록 — 원본 개수를 절반씩(`ceil(k/2)`) 줄여가며
 * `MIN_DISCLOSABLE_BINS`보다 큰 동안 추가하고, 마지막에 `MIN_DISCLOSABLE_BINS` 자체를
 * 반드시 한 번 추가한다(원본이 그보다 작거나 같으면 추가하지 않음). 단순히 반씩
 * 줄이기만 하면 하한값 자체는 사다리에서 건너뛸 수 있다 — 예: 원본 4개는
 * ceil(4/2)=2로 하한(3) 미만이라 반복이 바로 멈춰버려 3을 한 번도 시도 안 하게
 * 되는데, 정작 3개로는 통과할 수 있는 데이터일 수 있다(실측 확인: 4개일 때 인원
 * [1,9,10,10]으로 실패해도 3개로 재분할하면 [10,10,10]으로 통과). */
function fallbackCandidates(originalK: number): number[] {
  const candidates: number[] = [];
  let k = originalK;
  for (;;) {
    k = Math.ceil(k / 2);
    if (k <= MIN_DISCLOSABLE_BINS) break;
    candidates.push(k);
  }
  if (MIN_DISCLOSABLE_BINS < originalK) {
    if (candidates.length === 0 || candidates[candidates.length - 1] !== MIN_DISCLOSABLE_BINS) {
      candidates.push(MIN_DISCLOSABLE_BINS);
    }
  }
  return candidates;
}

/** lo~hi를 k개 구간으로 균등분할한 경계(k+1개)를 직접 산술로 만든다 — 양끝은 계산이
 * 아니라 대입으로 고정해 부동소수점 드리프트를 막는다(`np.histogram(bins=k,
 * range=(lo,hi))`와 동일한 경계). */
function buildUniformEdges(lo: number, hi: number, k: number): number[] {
  const edges = new Array<number>(k + 1);
  edges[0] = lo;
  edges[k] = hi;
  for (let i = 1; i < k; i += 1) edges[i] = lo + (i * (hi - lo)) / k;
  return edges;
}

/** `edges`(길이 k+1, 오름차순) 안에서 값 `v`가 속하는 bin 인덱스(0..k-1)를 이진탐색으로
 * 찾는다 — `lower <= v < upper`(왼쪽 폐구간), 마지막 bin만 양끝 포함. 산술식으로
 * 직접 인덱스를 계산하면(`floor((v-lo)/(hi-lo)*k)`) 부동소수점 오차로 경계값 자체가
 * 엉뚱한 bin에 배정될 수 있어(실측 확인) 반드시 `edges` 배열 자체를 기준으로
 * 판정한다 — "표시되는 경계"와 "그 경계로 센 인원"이 항상 같은 소스에서 나오게
 * 만드는 게 핵심이다. */
function bucketIndex(edges: number[], v: number): number {
  const k = edges.length - 1;
  if (v <= edges[0]) return 0;
  if (v >= edges[k]) return k - 1;
  let lo = 0;
  let hi = k;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid] <= v) lo = mid; else hi = mid - 1;
  }
  return Math.min(lo, k - 1);
}

function passesGate(counts: number[], personSets: Array<Set<string>>): boolean {
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] === 0) continue;
    if (isSmallCell(personSets[i].size)) return false;
  }
  return true;
}

export interface ResolvedHistogram {
  bins: HistogramBinLike[];
  /** 원본보다 구간 수를 줄여 재분할했으면 true(내부적으로는 재분할이지 인접 bin을
   * 그대로 합치는 게 아니다 — API 필드명은 짧게 유지). */
  merged: boolean;
}

/**
 * 히스토그램 person 단위 공개통제(B안 — 적응형 해상도 축소, A안 후속). 원본(Python이
 * 만든) bin이 그대로 공개 가능하면 그걸 쓰고, 아니면 `fallbackCandidates`가 정한
 * 후보 해상도들을 세밀한 순서부터 시도해 **처음 통과하는 것**을 반환한다("정해진
 * 후보 해상도 중 공개 가능한 가장 세밀한 것" — 가능한 모든 bin 개수를 다 시도한다는
 * 뜻은 아니다). 각 후보는 lo~hi를 그 개수만큼 다시 균등분할한 것이지, 원본 bin을
 * 인접한 것끼리 그대로 합치는 게 아니다(원본 bin 경계 내부를 새 경계가 가로지를 수
 * 있음). 후보를 전부 시도해도 통과하는 게 없으면 `null`(호출부가 별도
 * reasonCode로 "해상도 부족"임을 명시한다). 같은 사람의 서로 다른 두 행이 서로
 * 다른 bin에 있다가 재분할로 같은 bin에 들어가도 `Set` 합집합이라 정확히 1명으로만
 * 세어진다(합산 아님).
 */
export function resolveDisclosableHistogram<T extends PersonKeyed>(
  rows: T[],
  bins: HistogramBinLike[],
  valueOf: (row: T) => number | null,
): ResolvedHistogram | null {
  if (bins.length === 0) return null;
  const presentRows = rows.filter((r) => valueOf(r) !== null);

  if (passesOriginal(presentRows, bins, valueOf)) {
    return { bins, merged: false };
  }

  const lo = bins[0].lower;
  const hi = bins[bins.length - 1].upper;
  for (const k of fallbackCandidates(bins.length)) {
    const edges = buildUniformEdges(lo, hi, k);
    const counts = new Array(k).fill(0);
    const personSets: Array<Set<string>> = Array.from({ length: k }, () => new Set<string>());
    for (const row of presentRows) {
      const v = valueOf(row) as number;
      const idx = bucketIndex(edges, v);
      counts[idx] += 1;
      personSets[idx].add(row.personClusterKey);
    }
    if (passesGate(counts, personSets)) {
      const resolvedBins: HistogramBinLike[] = counts.map((count, i) => ({
        lower: edges[i],
        upper: edges[i + 1],
        count,
      }));
      return { bins: resolvedBins, merged: true };
    }
  }
  return null;
}

export interface BoxplotFenceInput {
  q1: number;
  q3: number;
}

function computeFence({ q1, q3 }: BoxplotFenceInput): { lowerFence: number; upperFence: number } {
  const iqr = q3 - q1;
  return { lowerFence: q1 - 1.5 * iqr, upperFence: q3 + 1.5 * iqr };
}

function partitionByFence<T extends PersonKeyed>(
  rows: T[],
  lowerFence: number,
  upperFence: number,
  valueOf: (row: T) => number | null,
): { outlier: T[]; nonOutlier: T[] } {
  const outlier: T[] = [];
  const nonOutlier: T[] = [];
  for (const row of rows) {
    const v = valueOf(row);
    if (v === null) continue;
    if (v < lowerFence || v > upperFence) outlier.push(row);
    else nonOutlier.push(row);
  }
  return { outlier, nonOutlier };
}

/**
 * 이상치 전용 게이트(계획서 §1) — 히스토그램의 bin 게이트와 **완전히 별개**다.
 * 반례(직접 계산으로 확인): bin 빈도가 [50,0,26,0,0,24]로 히스토그램 게이트를
 * 전부 통과해도, 이상치가 정확히 1명이면 outlierCount가 그 소수집단을 노출한다.
 * 이상치·비이상치 **양쪽** partition의 person 고유 인원이 전부 0이거나
 * ≥MINIMUM_COHORT여야 한다 — 한쪽만 검사하면 "이상치 10명·비이상치 1명"(반복
 * 기록으로 가능) 같은 반대 방향 반례를 놓친다. 그룹별 박스플롯(§5)에도 그룹마다
 * 독립 적용한다 — 그룹 단위 게이트(전체 인원수)는 그룹 내부의 소수 이상치
 * 집단까지 막지 못하기 때문.
 */
export function isOutlierCountDisclosable<T extends PersonKeyed>(
  rows: T[],
  fence: BoxplotFenceInput,
  valueOf: (row: T) => number | null,
): boolean {
  const { lowerFence, upperFence } = computeFence(fence);
  const { outlier, nonOutlier } = partitionByFence(rows, lowerFence, upperFence, valueOf);
  return !isSmallCell(distinctPersons(outlier)) && !isSmallCell(distinctPersons(nonOutlier));
}

/**
 * 응답시점 전용(§9) — outlierCount가 이미 공개 확정된 변수에 한해, 호출자가
 * stats.export_limited_rows 권한을 확인한 뒤에만 호출해야 한다. 원본 rows에서
 * 즉석 재계산하므로 Python 재호출도, 캐시 저장도 없다.
 */
export function computeOutlierValues<T extends PersonKeyed>(
  rows: T[],
  fence: BoxplotFenceInput,
  valueOf: (row: T) => number | null,
): number[] {
  const { lowerFence, upperFence } = computeFence(fence);
  const { outlier } = partitionByFence(rows, lowerFence, upperFence, valueOf);
  const values: number[] = [];
  for (const row of outlier) {
    const v = valueOf(row);
    if (v !== null) values.push(v);
  }
  return values;
}
