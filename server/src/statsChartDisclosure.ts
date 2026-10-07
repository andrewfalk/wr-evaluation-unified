// PR3-B — 차트 데이터(히스토그램·박스플롯 이상치·산점도)의 person 단위 공개통제.
// 계획서 §1/§3/§9. 이 모듈은 두 가지 독립된 축을 다룬다:
//
//   1) aggregate 게이트(compute 시점, 캐시 대상) — 히스토그램은 원본 bin을
//      buildOriginalHistogram(Node가 유일한 기준 구현)으로 만든 뒤
//      resolveDisclosableHistogram이 해상도별로 "그대로 → 끝 구간 병합" 순서로
//      시도해 공개 가능한 가장 세밀한 것을 채택한다(B안 재분할 + 끝 구간 병합).
//      박스플롯 이상치는 여전히 전용 partition 게이트(outlierCount의 존재 여부,
//      all-or-nothing) 그대로.
//   2) limited_row 응답시점 merge(§9) — 권한이 있을 때만 원본 rows에서 즉석
//      재계산한다(Python 재호출 없음, stats_runs.result에 절대 저장하지 않음).
//      outlierValues는 outlierCount가 공개 확정된 변수에만, 원본 히스토그램
//      (rawHistogram)은 변수 자체가 공개된 경우에만 붙는다.
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
  /** 끝 구간 병합으로 원래 bin 2개 이상이 합쳐진 bin이면 true(아니면 키 없음). */
  tailMerged?: boolean;
}

// services/stats-engine/histogram.py와 같은 상한·하한.
const MAX_ORIGINAL_BINS = 50;
const MIN_ORIGINAL_BINS = 1;

/**
 * 원본 bin 개수 — services/stats-engine/histogram.py `compute_histogram`과 같은
 * 공식(FD, IQR==0이거나 h가 비정상이면 Sturges, 1~50 clamp). n 자리에는 행 수가
 * 아니라 "해당 변수에 유효값을 낸 고유 인원수"를 쓴다(job/disease grain
 * 브로드캐스트로 같은 사람의 값이 여러 행에 복제돼도 bin이 잘게 쪼개지지 않게,
 * A안). 인원수가 0 이하면 행 수로 대체한다(Python과 동일).
 */
export function computeOriginalBinCount(
  lo: number,
  hi: number,
  q1: number,
  q3: number,
  personCount: number,
  rowCount: number,
): number {
  const kN = personCount > 0 ? personCount : rowCount;
  const sturges = () => Math.ceil(Math.log2(kN) + 1);
  const iqr = q3 - q1;
  let k: number;
  if (iqr === 0) {
    k = sturges();
  } else {
    const h = 2 * iqr * Math.pow(kN, -1 / 3);
    k = h > 0 && Number.isFinite(h) ? Math.ceil((hi - lo) / h) : sturges();
  }
  return Math.max(MIN_ORIGINAL_BINS, Math.min(MAX_ORIGINAL_BINS, k));
}

/** lo~hi를 k개 구간으로 균등분할한 경계(k+1개). `np.histogram(bins=k, range=(lo,hi))`
 * 내부의 `np.linspace(lo, hi, k+1)`와 **연산 순서까지** 같게 `i * step + lo`로
 * 계산하고 마지막 경계만 hi로 대입한다. `lo + (i * (hi - lo)) / k`처럼 순서를
 * 바꾸면 같은 수식이라도 결과가 1ulp씩 달라진다(실측: [0,1]·k=5에서 numpy의 세
 * 번째 경계는 0.6000000000000001인데 그 식은 0.6 — 값 0.6이 다른 bin에 배정됨). */
export function buildUniformEdges(lo: number, hi: number, k: number): number[] {
  const step = (hi - lo) / k;
  const edges = new Array<number>(k + 1);
  for (let i = 0; i < k; i += 1) edges[i] = i * step + lo;
  edges[k] = hi;
  return edges;
}

/** `edges`(길이 k+1, 오름차순) 안에서 값 `v`가 속하는 bin 인덱스(0..k-1)를 이진탐색으로
 * 찾는다 — `lower <= v < upper`(왼쪽 폐구간), 마지막 bin만 양끝 포함. 산술식으로
 * 직접 인덱스를 계산하면(`floor((v-lo)/(hi-lo)*k)`) 부동소수점 오차로 경계값 자체가
 * 엉뚱한 bin에 배정될 수 있어(실측 확인) 반드시 `edges` 배열 자체를 기준으로
 * 판정한다 — "표시되는 경계"와 "그 경계로 센 인원"이 항상 같은 소스에서 나오게
 * 만드는 게 핵심이다. numpy.histogram도 최종 배정은 같은 경계 배열 기준이다. */
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

interface EdgeCounts {
  edges: number[];
  /** bin별 관측 건수(행 수 — 같은 사람의 반복 행도 각각 센다). */
  counts: number[];
  /** bin별 고유 인원 집합(공개 게이트용). */
  personSets: Array<Set<string>>;
}

function countByEdges<T extends PersonKeyed>(
  presentRows: T[],
  edges: number[],
  valueOf: (row: T) => number | null,
): EdgeCounts {
  const k = edges.length - 1;
  const counts = new Array<number>(k).fill(0);
  const personSets: Array<Set<string>> = Array.from({ length: k }, () => new Set<string>());
  for (const row of presentRows) {
    const idx = bucketIndex(edges, valueOf(row) as number);
    counts[idx] += 1;
    personSets[idx].add(row.personClusterKey);
  }
  return { edges, counts, personSets };
}

function toBins(edges: number[], counts: number[]): HistogramBinLike[] {
  return counts.map((count, i) => ({ lower: edges[i], upper: edges[i + 1], count }));
}

/**
 * 원본 히스토그램 — 공개통제 전의 균등분할 bin. 이 함수는 **공개 판정(집계) 경로의
 * 기준 구현**이다: resolveDisclosableHistogram의 입력(= 캐시되는 공개용 histogram의
 * 원본)을 만든다. numpy `histogram`과 경계·건수까지 정확히 같은 결과를 내는 것이
 * 목적이라(histogramParity 픽스처 테스트가 고정) 경계는 최솟값에서 시작하는 균등분할이다.
 * 권한자 원본(rawHistogram, limited_row)은 이 함수를 쓰지 않는다 — 보기 좋은 정수·소수
 * 경계로 정렬한 `buildNiceHistogram`을 쓰므로 같은 변수라도 공개용과 경계가 다를 수 있다.
 * Python 엔진도 여전히 `histogram`을 계산해 내보내지만 Node는 더 이상 쓰지 않는다
 * (엔진 프로토콜은 그대로 두고 제거는 후속으로 분리).
 *
 * 입력은 valueOf가 숫자를 돌려주는 행만 쓴다(Python 요청 조립과 같은 필터 —
 * statsDescriptiveSuppression.ts buildStatsEngineRequest). q1/q3는 엔진이 계산한
 * 값을 그대로 받는다(numpy 분위수 방식을 Node에서 재구현하지 않음). 유효값이
 * 없으면 null.
 */
export function buildOriginalHistogram<T extends PersonKeyed>(
  rows: T[],
  valueOf: (row: T) => number | null,
  q1: number,
  q3: number,
): HistogramBinLike[] | null {
  const presentRows = rows.filter((r) => valueOf(r) !== null);
  if (presentRows.length === 0) return null;

  let lo = Infinity;
  let hi = -Infinity;
  const persons = new Set<string>();
  for (const row of presentRows) {
    const v = valueOf(row) as number;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    persons.add(row.personClusterKey);
  }

  if (lo === hi) return [{ lower: lo, upper: hi, count: presentRows.length }];

  const k = computeOriginalBinCount(lo, hi, q1, q3, persons.size, presentRows.length);
  const { edges, counts } = countByEdges(presentRows, buildUniformEdges(lo, hi, k), valueOf);
  return toBins(edges, counts);
}

// ---------------------------------------------------------------------------
// 권한자 원본 히스토그램 — 보기 좋은 경계(buildNiceHistogram)
// ---------------------------------------------------------------------------

/** 값의 범위가 이 이상이면 구간 폭은 최소 1(정수)이다. 그보다 작은 범위의 비정수 데이터는
 * 소수 폭(0.1·0.2·0.5…)을 허용한다(0~3년처럼 정수로만 끊으면 구간이 2~3개뿐이라). */
const INTEGER_WIDTH_MIN_RANGE = 10;
/** 폭의 자릿수(decimals) 상한 — 이보다 작은 폭은 정렬을 포기하고 폴백한다. */
const MAX_WIDTH_DECIMALS = 12;
/** 경계 인덱스 보정 루프의 최대 횟수. 넘으면 정렬 실패로 보고 폴백한다. */
const MAX_EDGE_CORRECTIONS = 4;

interface NiceWidth {
  /** 1, 2, 5 중 하나. */
  mantissa: 1 | 2 | 5;
  exponent: number;
}

/** `m × 10^e`를 정확한 십진 리터럴에 가장 가까운 double로 만든다. 음수 지수는 곱셈이 아니라
 * 나눗셈으로 계산한다(10^k, k ≤ 22는 double로 정확하고 나눗셈은 정확히 반올림되므로
 * 0.1·0.5·1e-13 같은 값이 리터럴과 같다). */
function niceWidthValue({ mantissa, exponent }: NiceWidth): number {
  return exponent >= 0 ? mantissa * Math.pow(10, exponent) : mantissa / Math.pow(10, -exponent);
}

function nextNiceWidth({ mantissa, exponent }: NiceWidth): NiceWidth {
  if (mantissa === 1) return { mantissa: 2, exponent };
  if (mantissa === 2) return { mantissa: 5, exponent };
  return { mantissa: 1, exponent: exponent + 1 };
}

function prevNiceWidth({ mantissa, exponent }: NiceWidth): NiceWidth {
  if (mantissa === 5) return { mantissa: 2, exponent };
  if (mantissa === 2) return { mantissa: 1, exponent };
  return { mantissa: 5, exponent: exponent - 1 };
}

function niceWidthFor(x: number): NiceWidth {
  const exponent = Math.floor(Math.log10(x));
  const fraction = x / Math.pow(10, exponent);
  // 클라이언트 src/core/components/charts/scales.js niceNumber(value, round=true)와 같은 임계값.
  if (fraction < 1.5) return { mantissa: 1, exponent };
  if (fraction < 3) return { mantissa: 2, exponent };
  if (fraction < 7) return { mantissa: 5, exponent };
  return { mantissa: 1, exponent: exponent + 1 };
}

/** `x`에 가장 가까운 보기 좋은 폭(1·2·5 × 10^e) — 임계값은 클라이언트 `niceNumber(round)`와 같다
 * (가수 < 1.5 → 1, < 3 → 2, < 7 → 5, 그 외 다음 자릿수의 1). 테스트가 클라이언트와 같은 값을
 * 내는지 표본으로 고정한다. x가 양의 유한수가 아니면 1. */
export function roundToNiceWidth(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 1;
  return niceWidthValue(niceWidthFor(x));
}

/** 경계 배열이 히스토그램으로 유효한지 — 유한수, **엄격 증가**(폭 0 구간 없음), 첫 경계 ≤ lo,
 * 마지막 경계가 `lastClosed`이면 ≥ hi(마지막 구간 닫힘), 아니면 > hi(정수 정렬의 반개구간),
 * 구간 수 1~50. 이 검증을 통과한 경계라면 `bucketIndex`의 끝 구간 강제 배정(클램프)이
 * 건수를 숨겨 구간 정의를 위반하는 일이 없다. */
export function isValidEdges(edges: number[], lo: number, hi: number, lastClosed: boolean): boolean {
  const k = edges.length - 1;
  if (k < MIN_ORIGINAL_BINS || k > MAX_ORIGINAL_BINS) return false;
  for (let i = 0; i <= k; i += 1) {
    if (!Number.isFinite(edges[i])) return false;
    if (i > 0 && !(edges[i] > edges[i - 1])) return false;
  }
  if (edges[0] > lo) return false;
  return lastClosed ? edges[k] >= hi : edges[k] > hi;
}

interface AlignedEdges {
  edges: number[];
  lastClosed: boolean;
}

/** 폭 `width`로 [lo, hi]를 덮는 정렬 경계를 만든다. 실패(null)하면 호출부가 폴백한다.
 * 경계는 `Number((i * w).toFixed(decimals))` — 고정 12자리가 아니라 **폭의 자릿수**로 반올림해
 * 폭이 작아도 0으로 뭉개지지 않고, 폭의 정확한 배수가 된다. 허용오차 반올림 대신 **실제
 * 경계 값으로** 시작·끝 인덱스를 보정해 `lo`/`hi`가 항상 범위 안에 들어오게 한다. */
function buildAlignedEdges(lo: number, hi: number, width: NiceWidth, integerData: boolean): AlignedEdges | null {
  const w = niceWidthValue(width);
  const decimals = Math.max(0, -width.exponent);
  if (decimals > MAX_WIDTH_DECIMALS || !Number.isFinite(w) || !(w > 0)) return null;

  const edge = (i: number): number => {
    const v = Number((i * w).toFixed(decimals));
    return v === 0 ? 0 : v; // -0 정규화
  };
  // 정수 데이터의 정렬 성공 경로만 마지막 구간을 닫지 않는다([k, k+1) — 최댓값도 자기 막대를 가짐).
  const lastClosed = !integerData;
  const coversHi = (i: number): boolean => (lastClosed ? edge(i) >= hi : edge(i) > hi);

  // 경계 인덱스(a, b)가 안전한 정수(≤ 2^53)가 아니면 `i * w`가 정확한 배수가 아니다(예: 1e6 근처에
  // 폭 1e-10 → 인덱스 1e16). 그때는 "폭의 배수"라는 정렬의 전제가 성립하지 않으므로 폴백한다.
  let a = Math.floor(lo / w);
  if (!Number.isSafeInteger(a)) return null;
  let guard = 0;
  while (edge(a) > lo) { a -= 1; guard += 1; if (guard > MAX_EDGE_CORRECTIONS) return null; }
  guard = 0;
  while (edge(a + 1) <= lo) { a += 1; guard += 1; if (guard > MAX_EDGE_CORRECTIONS) return null; }

  let b = Math.ceil(hi / w);
  guard = 0;
  while (!coversHi(b)) { b += 1; guard += 1; if (guard > MAX_EDGE_CORRECTIONS) return null; }
  guard = 0;
  while (b - 1 > a && coversHi(b - 1)) { b -= 1; guard += 1; if (guard > MAX_EDGE_CORRECTIONS) return null; }
  if (!(b > a) || !Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;

  const edges: number[] = [];
  for (let i = a; i <= b; i += 1) edges.push(edge(i));
  return { edges, lastClosed };
}

export interface NiceHistogramResult {
  bins: HistogramBinLike[];
  /** 정렬 경계(폭의 배수)를 만들었으면 true. 상수 데이터·폴백은 false. */
  aligned: boolean;
  /** 실제로 적용된 마지막 구간 규칙 — true면 마지막 구간이 양끝 포함, false면 반개구간(정수 정렬). */
  lastClosed: boolean;
}

/**
 * 권한자 원본 히스토그램(rawHistogram, limited_row) — 구간 경계를 **보기 좋은 값**(폭 1·2·5×10^e의
 * 배수)에 맞춘다. 게이트를 거치지 않는 원본이라 경계를 자유롭게 정할 수 있고, 경계가 [최솟값,
 * 최댓값] 밖으로 조금 나가도 새로 드러나는 정보가 없다(최솟값·최댓값은 이미 공개). 공개용 히스토그램
 * (buildOriginalHistogram + resolveDisclosableHistogram)은 소수 인원 판정과 numpy 대조가 경계에
 * 걸려 있어 이 함수를 쓰지 않는다 — 같은 변수라도 두 경계는 다를 수 있다.
 *
 * - 폭: rawWidth = (hi − lo) / k0(공개용과 같은 목표 구간 수)를 가장 가까운 보기 좋은 폭으로
 *   반올림. 값이 전부 정수이거나 범위가 10 이상이면 폭 ≥ 1, 그보다 작은 비정수 범위는 소수 폭.
 *   구간 수가 50을 넘으면 폭을 올리고 2 미만이면 내린다.
 * - 정수 데이터는 반개구간 [k, k+1)로 최댓값도 자기 구간을 갖는다(정수 1~9가 20건씩이면 모든
 *   막대가 20). 그 밖에는 기존 규칙(마지막 구간만 양끝 포함).
 * - **폴백 사슬:** 정렬이 불가능하거나 검증(isValidEdges)에 실패하면 균등분할 경계로 대체하고
 *   (마지막 구간 닫힘), 그것도 유효하지 않으면(예: 1e6 ± 2^-33처럼 부동소수점 간격에 가까운
 *   범위에서 서로 다른 경계가 부족) 구간 수를 절반씩 줄여 다시 만들어 센다. k=1이면 [lo, hi]라
 *   항상 유효하므로 어떤 입력에서도 폭 0 구간 없이 건수 합이 정의대로 맞는 결과를 낸다.
 * - 모든 값이 같으면 [lo, hi] 한 구간(엄격 증가 검증의 유일한 예외).
 *
 * q1/q3는 엔진이 계산한 값을 그대로 받는다. 유효값이 없으면 null.
 */
export function buildNiceHistogram<T extends PersonKeyed>(
  rows: T[],
  valueOf: (row: T) => number | null,
  q1: number,
  q3: number,
): NiceHistogramResult | null {
  const presentRows = rows.filter((r) => valueOf(r) !== null);
  if (presentRows.length === 0) return null;

  let lo = Infinity;
  let hi = -Infinity;
  let allIntegers = true;
  const persons = new Set<string>();
  for (const row of presentRows) {
    const v = valueOf(row) as number;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    if (allIntegers && !Number.isInteger(v)) allIntegers = false;
    persons.add(row.personClusterKey);
  }

  if (lo === hi) {
    return { bins: [{ lower: lo, upper: hi, count: presentRows.length }], aligned: false, lastClosed: true };
  }

  const k0 = computeOriginalBinCount(lo, hi, q1, q3, persons.size, presentRows.length);
  const range = hi - lo;
  const integerWidthOnly = allIntegers || range >= INTEGER_WIDTH_MIN_RANGE;

  // 1) 정렬 경계 — 폭을 구간 수 1(또는 2)~50 안으로 맞추며 시도한다.
  let width = niceWidthFor(range / k0);
  if (integerWidthOnly && niceWidthValue(width) < 1) width = { mantissa: 1, exponent: 0 };
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const aligned = buildAlignedEdges(lo, hi, width, allIntegers);
    if (!aligned) break;
    const k = aligned.edges.length - 1;
    if (k > MAX_ORIGINAL_BINS) { width = nextNiceWidth(width); continue; }
    const lowered = prevNiceWidth(width);
    if (k < 2 && (!integerWidthOnly || niceWidthValue(lowered) >= 1)) { width = lowered; continue; }
    if (isValidEdges(aligned.edges, lo, hi, aligned.lastClosed)) {
      const { edges, counts } = countByEdges(presentRows, aligned.edges, valueOf);
      return { bins: toBins(edges, counts), aligned: true, lastClosed: aligned.lastClosed };
    }
    break;
  }

  // 2) 폴백 — 균등분할(마지막 구간 닫힘)을 검증하고, 유효하지 않으면 구간 수를 절반씩 줄인다.
  let k = k0;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const edges = k <= 1 ? [lo, hi] : buildUniformEdges(lo, hi, k);
    if (isValidEdges(edges, lo, hi, true)) {
      const counted = countByEdges(presentRows, edges, valueOf);
      return { bins: toBins(counted.edges, counted.counts), aligned: false, lastClosed: true };
    }
    k = Math.ceil(k / 2);
  }
  // 도달 불가(k=1이면 [lo, hi]가 항상 유효) — 방어적으로 단일 구간.
  return { bins: [{ lower: lo, upper: hi, count: presentRows.length }], aligned: false, lastClosed: true };
}

/** B안 폴백 후보 bin 개수 목록 — 원본 개수를 절반씩(`ceil(k/2)`) 줄여가며
 * `MIN_DISCLOSABLE_BINS`보다 큰 동안 추가하고, 마지막에 `MIN_DISCLOSABLE_BINS` 자체를
 * 반드시 한 번 추가한다(원본이 그보다 작거나 같으면 추가하지 않음). 단순히 반씩
 * 줄이기만 하면 하한값 자체는 사다리에서 건너뛸 수 있다 — 예: 원본 4개는
 * ceil(4/2)=2로 하한(3) 미만이라 반복이 바로 멈춰버려 3을 한 번도 시도 안 하게
 * 되는데, 정작 3개로는 통과할 수 있는 데이터일 수 있다(실측 확인: 4개일 때 인원
 * [10,1,9,10]으로 실패해도 3개로 재분할하면 [10,10,10]으로 통과). */
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

/** 모든 bin이 0명이거나 ≥MINIMUM_COHORT명이면 통과(count===0인 bin은 검사할 사람이 없음). */
function passesGate(counts: number[], personSets: Array<Set<string>>, from = 0, to = counts.length): boolean {
  for (let i = from; i < to; i += 1) {
    if (counts[i] === 0) continue;
    if (isSmallCell(personSets[i].size)) return false;
  }
  return true;
}

/**
 * 끝 구간 병합 — 양 끝 bin이 소수셀(1~9명)이면 안쪽 이웃 bin을 하나씩 계속
 * 흡수해 ≥MINIMUM_COHORT명이 될 때까지 넓힌다. 인원은 bin별 인원수의 합이 아니라
 * **person 집합의 합집합**으로 다시 센다(같은 사람의 두 행이 서로 다른 bin에
 * 있었어도 1명). 다음 중 하나면 이 해상도에서는 실패(null):
 *   - 양쪽 병합이 서로 만나거나 겹침(가운데가 남지 않음)
 *   - 가운데에 남은 bin 중 소수셀이 있음(가운데 병합은 하지 않는다 — 폭이
 *     들쭉날쭉해져 분포 모양이 왜곡되므로 범위 밖)
 *   - 병합 후 bin 수가 MIN_DISCLOSABLE_BINS 미만
 *   - 양쪽 다 병합할 게 없었음(그대로 실패한 해상도라 병합으로 달라질 게 없다)
 * 병합된 bin의 바깥 경계는 lo/hi(이미 공개되는 min/max) 그대로라 경계값이 새로
 * 드러내는 정보는 없다.
 */
function tryTailMerge({ edges, counts, personSets }: EdgeCounts): HistogramBinLike[] | null {
  const k = counts.length;

  let leftEnd = 0;
  const leftSet = new Set(personSets[0]);
  while (isSmallCell(leftSet.size)) {
    leftEnd += 1;
    if (leftEnd >= k) return null;
    for (const p of personSets[leftEnd]) leftSet.add(p);
  }

  let rightStart = k - 1;
  const rightSet = new Set(personSets[k - 1]);
  while (isSmallCell(rightSet.size)) {
    rightStart -= 1;
    if (rightStart < 0) return null;
    for (const p of personSets[rightStart]) rightSet.add(p);
  }

  if (leftEnd === 0 && rightStart === k - 1) return null;
  if (leftEnd >= rightStart) return null;
  if (!passesGate(counts, personSets, leftEnd + 1, rightStart)) return null;

  const resultLength = 1 + (rightStart - leftEnd - 1) + 1;
  if (resultLength < MIN_DISCLOSABLE_BINS) return null;

  const sum = (from: number, to: number) => counts.slice(from, to + 1).reduce((s, c) => s + c, 0);
  const bins: HistogramBinLike[] = [];
  bins.push(leftEnd > 0
    ? { lower: edges[0], upper: edges[leftEnd + 1], count: sum(0, leftEnd), tailMerged: true }
    : { lower: edges[0], upper: edges[1], count: counts[0] });
  for (let i = leftEnd + 1; i < rightStart; i += 1) {
    bins.push({ lower: edges[i], upper: edges[i + 1], count: counts[i] });
  }
  bins.push(rightStart < k - 1
    ? { lower: edges[rightStart], upper: edges[k], count: sum(rightStart, k - 1), tailMerged: true }
    : { lower: edges[k - 1], upper: edges[k], count: counts[k - 1] });
  return bins;
}

export interface ResolvedHistogram {
  bins: HistogramBinLike[];
  /** 원본보다 구간 수를 줄여 재분할했으면 true(내부적으로는 재분할이지 인접 bin을
   * 그대로 합치는 게 아니다 — API 필드명은 짧게 유지). 끝 구간 병합 여부는 bin별
   * tailMerged로 따로 표시한다. */
  merged: boolean;
}

/**
 * 히스토그램 person 단위 공개통제(B안 재분할 + 끝 구간 병합). 해상도를 원본 →
 * `fallbackCandidates`가 정한 후보 순서(세밀한 것부터)로 내려가며, 각 해상도에서
 * "그대로" → "끝 구간 병합(tryTailMerge)" 순으로 시도해 **처음 통과하는 것**을
 * 반환한다 — 즉 원본 해상도의 끝 구간 병합이 더 거친 재분할보다 우선한다. 각
 * 후보 해상도는 lo~hi를 그 개수만큼 다시 균등분할한 것이지, 원본 bin을 인접한
 * 것끼리 그대로 합치는 게 아니다(원본 bin 경계 내부를 새 경계가 가로지를 수 있음).
 * 전부 실패하면 `null`(호출부가 별도 reasonCode로 "해상도 부족"임을 명시한다).
 * 같은 사람의 서로 다른 두 행이 서로 다른 bin에 있다가 재분할·병합으로 같은 bin에
 * 들어가도 `Set` 합집합이라 정확히 1명으로만 세어진다(합산 아님).
 *
 * `bins`는 원본 bin(보통 buildOriginalHistogram의 결과)이다. 판정은 bins의 count
 * 필드가 아니라 그 경계로 rows를 직접 재순회한 person 집합으로 한다.
 */
export function resolveDisclosableHistogram<T extends PersonKeyed>(
  rows: T[],
  bins: HistogramBinLike[],
  valueOf: (row: T) => number | null,
): ResolvedHistogram | null {
  if (bins.length === 0) return null;
  const presentRows = rows.filter((r) => valueOf(r) !== null);

  const originalEdges = [bins[0].lower, ...bins.map((b) => b.upper)];
  const original = countByEdges(presentRows, originalEdges, valueOf);
  if (passesGate(original.counts, original.personSets)) {
    return { bins, merged: false };
  }
  const originalTail = tryTailMerge(original);
  if (originalTail) return { bins: originalTail, merged: false };

  const lo = bins[0].lower;
  const hi = bins[bins.length - 1].upper;
  for (const k of fallbackCandidates(bins.length)) {
    const candidate = countByEdges(presentRows, buildUniformEdges(lo, hi, k), valueOf);
    if (passesGate(candidate.counts, candidate.personSets)) {
      return { bins: toBins(candidate.edges, candidate.counts), merged: true };
    }
    const tail = tryTailMerge(candidate);
    if (tail) return { bins: tail, merged: true };
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
