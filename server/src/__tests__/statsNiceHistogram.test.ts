// 권한자 원본 히스토그램(rawHistogram)의 "보기 좋은 경계" — buildNiceHistogram.
//
// 구간 경계를 폭 1·2·5×10^e의 배수에 맞추되, 어떤 입력에서도 (a) 경계가 엄격히 증가하고
// (b) 데이터를 덮으며 (c) 모든 값이 정의대로(lower ≤ v < upper, 마지막 구간만 lastClosed일 때
// ≤ upper) 정확히 한 구간에 세어지는지 고정한다. 외부 리뷰에서 나온 반례를 그대로 넣었다:
//   - 폭 0.1, 최솟값 0.299999999999 / 최댓값 0.900000000001 → 허용오차 반올림은 경계가 0.3~0.9로
//     잘려 양 끝 값이 범위 밖인데도 끝 구간으로 클램프돼 건수 합 검사는 통과한다.
//   - 폭 1e-13 → toFixed(12) 고정 자릿수는 경계가 전부 0이 된다.
//   - 정수 1~9가 20건씩 → 마지막 구간을 닫으면 마지막 막대만 40건.
//   - 정수 1e16, 1e16+2 → 한 칸씩 올릴 수 없어 정렬이 불가능하다.
//   - 1e6 ± 2^-33 → 기존 buildOriginalHistogram(k=9)은 서로 다른 경계가 3개뿐이고 폭 0 구간이 생긴다.
// "경계가 폭의 배수"는 정렬 성공 경로(aligned === true)에만, "마지막 구간 포함 여부"는 입력이
// 정수인지가 아니라 반환된 lastClosed에 따른다.
import { describe, expect, it } from 'vitest';
import {
  buildNiceHistogram,
  buildOriginalHistogram,
  isValidEdges,
  roundToNiceWidth,
  type NiceHistogramResult,
} from '../statsChartDisclosure';

type Row = { personClusterKey: string; v: number };
const valueOf = (r: Row) => r.v;

function rowsOf(vals: number[], persons?: string[]): Row[] {
  return vals.map((v, i) => ({ personClusterKey: persons ? persons[i] : `p${i}`, v }));
}

function quantile(sorted: number[], q: number): number {
  const h = (sorted.length - 1) * q;
  const lo = Math.floor(h);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

function run(vals: number[], q1?: number, q3?: number, persons?: string[]): NiceHistogramResult {
  const sorted = [...vals].sort((a, b) => a - b);
  const result = buildNiceHistogram(rowsOf(vals, persons), valueOf, q1 ?? quantile(sorted, 0.25), q3 ?? quantile(sorted, 0.75));
  if (!result) throw new Error('unexpected null');
  return result;
}

const edgesOf = (r: NiceHistogramResult): number[] => [...r.bins.map((b) => b.lower), r.bins[r.bins.length - 1].upper];

// 부동소수점 바로 위·아래 이웃 — 고정 ±1e-9는 폭 1e-12에서 약 1,000구간을 건너뛴다.
const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer); // little-endian: [0]=low, [1]=high
function nextUpPositive(x: number): number {
  f64[0] = x;
  u32[0] += 1;
  if (u32[0] === 0) u32[1] += 1;
  return f64[0];
}
function nextDownPositive(x: number): number {
  f64[0] = x;
  if (u32[0] === 0) u32[1] -= 1;
  u32[0] -= 1;
  return f64[0];
}
function nextUp(x: number): number {
  if (x === 0) return Number.MIN_VALUE;
  return x > 0 ? nextUpPositive(x) : -nextDownPositive(-x);
}
function nextDown(x: number): number {
  return -nextUp(-x);
}

/** 정의대로(브루트포스) 각 값이 속하는 구간을 세고, 정확히 한 구간에만 속하는지 확인한다.
 * 끝 구간 클램프가 건수를 숨기면 여기서 값이 "어느 구간에도 안 속함"으로 잡힌다. */
function bruteCounts(vals: number[], r: NiceHistogramResult): number[] {
  const counts = new Array<number>(r.bins.length).fill(0);
  const last = r.bins.length - 1;
  for (const v of vals) {
    const hits: number[] = [];
    r.bins.forEach((b, i) => {
      const inside = v >= b.lower && (v < b.upper || (i === last && r.lastClosed && v === b.upper));
      if (inside) hits.push(i);
    });
    if (hits.length !== 1) throw new Error(`값 ${v}이 ${hits.length}개 구간에 속함(정확히 1개여야 함)`);
    counts[hits[0]] += 1;
  }
  return counts;
}

function expectMatchesDefinition(vals: number[], r: NiceHistogramResult): void {
  expect(r.bins.map((b) => b.count)).toEqual(bruteCounts(vals, r));
  expect(r.bins.reduce((s, b) => s + b.count, 0)).toBe(vals.length);
  for (let i = 1; i < r.bins.length; i += 1) expect(r.bins[i].lower).toBe(r.bins[i - 1].upper); // 빈틈·겹침 없음
}

function expectStrictlyIncreasing(r: NiceHistogramResult): void {
  const e = edgesOf(r);
  for (let i = 1; i < e.length; i += 1) expect(e[i]).toBeGreaterThan(e[i - 1]);
}

function expectCoversData(vals: number[], r: NiceHistogramResult): void {
  const e = edgesOf(r);
  expect(e[0]).toBeLessThanOrEqual(Math.min(...vals));
  const max = Math.max(...vals);
  if (r.lastClosed) expect(e[e.length - 1]).toBeGreaterThanOrEqual(max);
  else expect(e[e.length - 1]).toBeGreaterThan(max);
}

/** 모든 경계가 폭의 배수인지 — 정렬 성공(aligned) 경로에만 적용한다. */
function expectMultiplesOfWidth(r: NiceHistogramResult): number {
  const e = edgesOf(r);
  // 1e6 부근에서는 인접 경계의 부동소수점 차이(999999.56 − 999999.54 = 0.02000000001862645)가 폭과
  // 어긋나므로, 폭은 차이를 가장 가까운 보기 좋은 폭으로 반올림해 구한다.
  const w = roundToNiceWidth(e[1] - e[0]);
  // 정확한 불변식: 모든 경계가 `Number((k * w).toFixed(decimals))`(k는 안전한 정수)와 같다. 비율이
  // 10^10 이상이면 `edge / w`의 소수부 허용오차가 부동소수점 정밀도를 넘으므로 비율 근사 검사는 쓰지 않는다.
  const decimals = Math.max(0, -Math.floor(Math.log10(w)));
  for (const edge of e) {
    const k = Math.round(edge / w);
    expect(Number.isSafeInteger(k)).toBe(true);
    const expected = Number((k * w).toFixed(decimals));
    expect(edge).toBe(expected === 0 ? 0 : expected);
  }
  return w;
}

// 결정적 의사난수(재현 가능한 성질 기반 테스트용).
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe('roundToNiceWidth — 클라이언트 scales.js niceNumber(round=true)와 같은 임계값', () => {
  // 임계값(1.5·3·7)에서 떨어진 표본으로 고정한다(경계값 자체는 부동소수점 오차로 흔들린다).
  // 같은 표 값을 클라이언트 테스트(scales.test.js)도 niceNumber로 검증해 두 구현이 어긋나지 않게 한다.
  const table: Array<[number, number]> = [
    [0.012, 0.01], [0.026, 0.02], [0.04, 0.05], [0.14, 0.1], [0.26, 0.2], [0.55, 0.5], [0.9, 1],
    [1.2, 1], [1.4, 1], [2.9, 2], [3.5, 5], [6.9, 5], [7.5, 10], [14, 10], [26, 20], [55, 50], [95, 100],
  ];
  it.each(table)('%d → %d', (x, expected) => {
    expect(roundToNiceWidth(x)).toBe(expected);
  });

  it('양의 유한수가 아니면 1', () => {
    expect(roundToNiceWidth(0)).toBe(1);
    expect(roundToNiceWidth(-3)).toBe(1);
    expect(roundToNiceWidth(Number.NaN)).toBe(1);
    expect(roundToNiceWidth(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('isValidEdges', () => {
  it('엄격 증가·덮음·구간 수·유한수를 검증한다', () => {
    expect(isValidEdges([0, 5, 10], 1, 9, true)).toBe(true);
    expect(isValidEdges([0, 5, 5, 10], 1, 9, true)).toBe(false); // 폭 0 구간
    expect(isValidEdges([0, 5, 4], 1, 3, true)).toBe(false); // 감소
    expect(isValidEdges([2, 5, 10], 1, 9, true)).toBe(false); // 첫 경계 > lo
    expect(isValidEdges([0, 5, 8], 1, 9, true)).toBe(false); // 마지막 경계 < hi
    expect(isValidEdges([0, Number.POSITIVE_INFINITY], 1, 9, true)).toBe(false);
    expect(isValidEdges([0], 0, 0, true)).toBe(false); // 구간 0개
    expect(isValidEdges(Array.from({ length: 52 }, (_v, i) => i), 0, 50, true)).toBe(false); // 51구간
    expect(isValidEdges(Array.from({ length: 51 }, (_v, i) => i), 0, 49, true)).toBe(true); // 50구간
  });

  it('마지막 경계 조건은 lastClosed에 따른다(닫힘 ≥ hi, 반개구간 > hi)', () => {
    expect(isValidEdges([0, 5, 10], 1, 10, true)).toBe(true);
    expect(isValidEdges([0, 5, 10], 1, 10, false)).toBe(false);
    expect(isValidEdges([0, 5, 15], 1, 10, false)).toBe(true);
  });
});

describe('buildNiceHistogram — 정렬 경로(aligned)', () => {
  it('근속 0.3~35.2년 200명 → 정수 폭, 모든 경계가 폭의 배수, 데이터를 덮고 정의대로 센다', () => {
    const rnd = lcg(1);
    const vals = [0.3, 35.2, ...Array.from({ length: 198 }, () => 0.3 + rnd() * 34.9)];
    const r = run(vals);
    expect(r.aligned).toBe(true);
    expect(r.lastClosed).toBe(true); // 비정수
    const w = expectMultiplesOfWidth(r);
    expect(w).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(w)).toBe(true);
    expectCoversData(vals, r);
    expectStrictlyIncreasing(r);
    expectMatchesDefinition(vals, r);
    expect(r.bins.length).toBeLessThanOrEqual(50);
  });

  it('범위가 10 미만인 비정수 데이터(0.2~3.1)는 소수 폭을 쓴다(정수로 강제하지 않음)', () => {
    const rnd = lcg(2);
    const vals = [0.2, 3.1, ...Array.from({ length: 98 }, () => 0.2 + rnd() * 2.9)];
    const r = run(vals);
    expect(r.aligned).toBe(true);
    const w = expectMultiplesOfWidth(r);
    expect(w).toBeLessThan(1);
    expect(r.bins.length).toBeGreaterThanOrEqual(2);
    expectMatchesDefinition(vals, r);
  });

  it('정수 데이터 0~8은 범위가 10 미만이어도 폭 ≥ 1이다(정수 데이터에 0.5 폭을 쓰면 빈 막대가 생긴다)', () => {
    const vals = Array.from({ length: 90 }, (_v, i) => i % 9);
    const r = run(vals);
    expect(r.aligned).toBe(true);
    expect(expectMultiplesOfWidth(r)).toBeGreaterThanOrEqual(1);
    expectMatchesDefinition(vals, r);
  });

  it('정수 1~9가 20건씩이면 아홉 구간이 모두 20건이다(마지막 막대가 40건이 아님, 반개구간)', () => {
    const vals = Array.from({ length: 180 }, (_v, i) => 1 + (i % 9));
    const r = run(vals);
    expect(r.aligned).toBe(true);
    expect(r.lastClosed).toBe(false);
    expect(edgesOf(r)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(r.bins.map((b) => b.count)).toEqual(new Array(9).fill(20));
    expectMatchesDefinition(vals, r);
  });

  it('정수 0~20에 폭 5이면 최댓값 20이 [20, 25) 구간에 자기 자리를 갖는다', () => {
    const vals = Array.from({ length: 21 }, (_v, i) => i);
    const r = run(vals, 5, 15);
    expect(r.aligned).toBe(true);
    expect(r.lastClosed).toBe(false);
    expect(edgesOf(r)).toEqual([0, 5, 10, 15, 20, 25]);
    expect(r.bins.map((b) => b.count)).toEqual([5, 5, 5, 5, 1]);
    expectMatchesDefinition(vals, r);
  });

  it('비정수 데이터는 최댓값이 정확히 경계일 때 마지막 구간에 포함된다(닫힘)', () => {
    const vals = [0.5, 3, 7.5, 12.25, 20];
    const r = run(vals, 3, 12.25);
    expect(r.aligned).toBe(true);
    expect(r.lastClosed).toBe(true);
    expect(edgesOf(r)[edgesOf(r).length - 1]).toBe(20);
    expect(r.bins[r.bins.length - 1].count).toBeGreaterThanOrEqual(1);
    expectMatchesDefinition(vals, r);
  });

  it('음수를 포함한 범위(−12.5~7.3)', () => {
    const rnd = lcg(3);
    const vals = [-12.5, 7.3, ...Array.from({ length: 98 }, () => -12.5 + rnd() * 19.8)];
    const r = run(vals);
    expect(r.aligned).toBe(true);
    expectMultiplesOfWidth(r);
    expectCoversData(vals, r);
    expectMatchesDefinition(vals, r);
  });

  it('큰 범위(0~10,000, 5,000명)에서도 구간은 50개 이하다', () => {
    const rnd = lcg(4);
    const vals = [0, 10000, ...Array.from({ length: 4998 }, () => rnd() * 10000)];
    const r = run(vals);
    expect(r.bins.length).toBeLessThanOrEqual(50);
    expect(r.bins.length).toBeGreaterThanOrEqual(2);
    expectMatchesDefinition(vals, r);
  });

  it('목표 폭을 반올림하면 구간이 50개를 넘는 입력은 폭을 한 단계 올려 정렬을 유지한다(폴백으로 넘어가지 않음)', () => {
    // 5,000명이 [0, 24]에 몰려 있고(IQR ≈ 12) 극단값 70이 하나 있다 → 목표 구간 수 50, 목표 폭 1.4 → 가장 가까운
    // 폭은 1이지만 70구간이 되므로 폭 2(35~36구간)로 올려야 한다.
    const rnd = lcg(11);
    const vals = [0.01, 70.3, ...Array.from({ length: 4998 }, () => rnd() * 24)];
    const r = run(vals);
    expect(r.aligned).toBe(true);
    expect(r.bins.length).toBeLessThanOrEqual(50);
    expect(expectMultiplesOfWidth(r)).toBe(2);
    expectMatchesDefinition(vals, r);
  });

  it('인원수 기준으로 구간 수를 정한다 — 같은 값을 4명이 반복 기록한 40행은 40명보다 구간이 적거나 같고, 건수는 행 수다', () => {
    const rnd = lcg(5);
    const base = Array.from({ length: 10 }, () => rnd() * 100);
    const vals = base.flatMap((v) => [v, v, v, v]);
    const repeated = run(vals, undefined, undefined, vals.map((_v, i) => `p${Math.floor(i / 10)}`)); // 4명
    const distinct = run(vals);
    expect(repeated.bins.length).toBeLessThanOrEqual(distinct.bins.length);
    expect(repeated.bins.reduce((s, b) => s + b.count, 0)).toBe(40);
    expectMatchesDefinition(vals, repeated);
  });

  it('유효값이 없으면 null', () => {
    expect(buildNiceHistogram([] as Row[], valueOf, 0, 0)).toBeNull();
  });
});

describe('buildNiceHistogram — 경계 정확성(리뷰 반례)', () => {
  it('폭 0.1, 최솟값 0.299999999999 / 최댓값 0.900000000001 → 경계가 범위를 덮고 어떤 값도 클램프되지 않는다', () => {
    const vals = [0.299999999999, 0.900000000001, 0.35, 0.5, 0.6, 0.72, 0.81];
    const r = run(vals, 0.45, 0.75);
    expect(r.aligned).toBe(true);
    expectCoversData(vals, r);
    expect(edgesOf(r)[0]).toBeLessThanOrEqual(0.299999999999);
    expect(edgesOf(r)[edgesOf(r).length - 1]).toBeGreaterThanOrEqual(0.900000000001);
    expectMatchesDefinition(vals, r); // 클램프가 있으면 여기서 "속하는 구간 0개"로 실패한다
  });

  it.each([
    ['폭 1(정수 경계, 비정수 데이터)', () => { const rnd = lcg(6); return [0.5, 20.5, ...Array.from({ length: 198 }, () => 0.5 + rnd() * 20)]; }],
    ['폭 0.001', () => { const rnd = lcg(7); return [0.2005, 0.2205, ...Array.from({ length: 198 }, () => 0.2005 + rnd() * 0.02)]; }],
    ['폭 1e-9', () => { const rnd = lcg(8); return [2.0e-8, 4.0e-8, ...Array.from({ length: 198 }, () => 2.0e-8 + rnd() * 2.0e-8)]; }],
  ])('내부 경계 바로 위·아래 값(부동소수점 이웃)이 정의대로 배정된다 — %s', (_name, make) => {
    const base = make();
    const first = run(base);
    expect(first.aligned).toBe(true);
    const probes: number[] = [];
    for (const e of edgesOf(first).slice(1, -1)) probes.push(nextDown(e), e, nextUp(e));
    // 같은 사람의 추가 행으로 넣어 인원수(=구간 수 공식)와 q1/q3를 그대로 둔다.
    const vals = [...base, ...probes];
    const persons = [...base.map((_v, i) => `p${i}`), ...probes.map(() => 'p0')];
    const sorted = [...base].sort((a, b) => a - b);
    const r = run(vals, quantile(sorted, 0.25), quantile(sorted, 0.75), persons);
    expect(r.aligned).toBe(true);
    expect(edgesOf(r)).toEqual(edgesOf(first)); // 프로브가 경계를 바꾸지 않았다
    expectMatchesDefinition(vals, r);
    // 경계 값 자체는 오른쪽 구간, 바로 아래 이웃은 왼쪽 구간에 있다(브루트포스가 이미 보장하지만 명시).
    const e = edgesOf(r);
    const idx = Math.floor(e.length / 2);
    const bi = (v: number) => r.bins.findIndex((b, i) => v >= b.lower && (v < b.upper || (i === r.bins.length - 1 && r.lastClosed && v === b.upper)));
    expect(bi(e[idx])).toBe(idx);
    expect(bi(nextDown(e[idx]))).toBe(idx - 1);
    expect(bi(nextUp(e[idx]))).toBe(idx);
  });

  it('lastClosed에 따라 마지막 경계 값의 소속이 달라진다 — 닫힘이면 마지막 구간에 포함, 반개구간이면 마지막 경계는 최댓값보다 크다', () => {
    const nonInt = run([0.5, 3, 7.5, 12.25, 20], 3, 12.25);
    expect(nonInt.lastClosed).toBe(true);
    expect(bruteCounts([20], nonInt).reduce((s, c, i) => s + (i === nonInt.bins.length - 1 ? c : 0), 0)).toBe(1);
    const ints = run(Array.from({ length: 21 }, (_v, i) => i), 5, 15);
    expect(ints.lastClosed).toBe(false);
    expect(edgesOf(ints)[edgesOf(ints).length - 1]).toBeGreaterThan(20);
  });
});

describe('buildNiceHistogram — 폴백 사슬', () => {
  it('값이 0 ~ 5e-13이면 폭 자릿수(>12) 때문에 정렬을 포기하고(aligned=false) 경계가 0으로 뭉개지지 않는다', () => {
    const vals = [0, 1e-13, 2e-13, 3e-13, 4e-13, 5e-13, 2.5e-13, 1.2e-13];
    const r = run(vals, 1e-13, 4e-13);
    expect(r.aligned).toBe(false);
    expect(r.lastClosed).toBe(true);
    expectStrictlyIncreasing(r);
    expect(new Set(edgesOf(r)).size).toBe(edgesOf(r).length);
    expectCoversData(vals, r);
    expectMatchesDefinition(vals, r);
    // 단일 구간으로 퇴화하지 않고 모양을 유지한다(이 입력의 목표 구간 수 k0는 2 — 균등분할이 유효하면 그대로 채택).
    expect(r.bins.map((b) => b.count)).toEqual([4, 4]);
  });

  it('1e6 ± 2^-33(서로 인접한 double 3개): 기존 buildOriginalHistogram은 폭 0 구간을 만들고, buildNiceHistogram은 구간 수를 줄여 유효한 결과를 낸다', () => {
    const ulp = Math.pow(2, -33);
    const vals = [
      ...Array.from({ length: 100 }, () => 1e6 - ulp),
      ...Array.from({ length: 50 }, () => 1e6),
      ...Array.from({ length: 50 }, () => 1e6 + ulp),
    ];
    // 기존 공개용 함수의 알려진 결함을 기록한다(numpy 대조가 목적이라 이번에 고치지 않음 — 후속).
    const legacy = buildOriginalHistogram(rowsOf(vals), valueOf, 1e6, 1e6)!;
    expect(legacy.length).toBe(9);
    const legacyEdges = [...legacy.map((b) => b.lower), legacy[legacy.length - 1].upper];
    expect(new Set(legacyEdges).size).toBe(3);
    expect(legacy.some((b) => b.lower === b.upper)).toBe(true);

    const r = run(vals, 1e6, 1e6);
    expect(r.aligned).toBe(false);
    expectStrictlyIncreasing(r);
    r.bins.forEach((b) => expect(b.upper).toBeGreaterThan(b.lower));
    expectCoversData(vals, r);
    expectMatchesDefinition(vals, r);
    // 폴백이 최후의 단일 구간으로 퇴화하지 않고, 유효한 가장 세밀한 해상도(k=9 → 5 → 3 → 2)를 찾는다:
    // 값이 서로 인접한 double 3개(100 / 100 / 100건 중 가운데는 마지막 구간의 시작)라 2구간이 최대다.
    expect(r.bins.map((b) => b.count)).toEqual([100, 100]);
  });

  it('1e6 ~ 1e6+1e-9는 경계 10개가 모두 달라 원래 반례가 아니다(정상 입력 회귀)', () => {
    const rnd = lcg(9);
    const vals = [1e6, 1e6 + 1e-9, ...Array.from({ length: 198 }, () => 1e6 + rnd() * 1e-9)];
    const r = run(vals);
    expectStrictlyIncreasing(r);
    expectCoversData(vals, r);
    expectMatchesDefinition(vals, r);
  });

  it('값이 인접한 double 두 개뿐이면 구간 수가 1까지 내려가도 유효하다', () => {
    const lo = 1e6;
    const hi = nextUp(lo);
    const vals = [lo, lo, hi, lo, hi];
    const r = run(vals, lo, lo);
    expectStrictlyIncreasing(r);
    r.bins.forEach((b) => expect(b.upper).toBeGreaterThan(b.lower));
    expectCoversData(vals, r);
    expectMatchesDefinition(vals, r);
  });

  it('정수 1e16, 1e16+2(간격 2) → 폭 1로는 한 칸씩 올릴 수 없어 정렬을 포기하고 마지막 구간을 닫아 폴백한다', () => {
    const vals = [1e16, 1e16 + 2, 1e16 + 2, 1e16];
    const r = run(vals, 1e16, 1e16); // IQR 0 → Sturges로 목표 폭이 1 미만 → 정수 폭 1
    expect(r.aligned).toBe(false);
    expect(r.lastClosed).toBe(true); // 폴백은 항상 닫힘(균등분할의 마지막 경계는 hi)
    expectStrictlyIncreasing(r);
    expectCoversData(vals, r);
    expectMatchesDefinition(vals, r);
    expect(r.bins.length).toBeGreaterThanOrEqual(1);
  });

  it('상수 데이터는 엄격 증가의 예외 — 구간 1개, 경계 lo === hi, 건수 = n, aligned=false', () => {
    const r = run([7, 7, 7], 7, 7);
    expect(r.bins).toEqual([{ lower: 7, upper: 7, count: 3 }]);
    expect(r.aligned).toBe(false);
  });
});

describe('buildNiceHistogram — 성질 기반 검증(무작위 데이터셋)', () => {
  it('정수·소수·음수·작은/큰 범위·반복값·좁은 범위 600개에서 모든 불변식이 성립한다', () => {
    const rnd = lcg(20261007);
    let alignedCount = 0;
    let fallbackCount = 0;
    for (let t = 0; t < 600; t += 1) {
      const kind = t % 6;
      const n = 2 + Math.floor(rnd() * 300);
      let vals: number[];
      if (kind === 0) vals = Array.from({ length: n }, () => Math.floor(rnd() * 60)); // 정수
      else if (kind === 1) vals = Array.from({ length: n }, () => rnd() * 40); // 소수
      else if (kind === 2) vals = Array.from({ length: n }, () => -50 + rnd() * 80); // 음수 포함
      else if (kind === 3) {
        const scale = Math.pow(10, -Math.floor(rnd() * 15)); // 데이터셋마다 한 번만 — 값마다 뽑으면 범위가 항상 큰 값에 지배된다
        vals = Array.from({ length: n }, () => rnd() * scale); // 매우 작은 폭(폭 자릿수 > 12이면 폴백)
      } else if (kind === 4) {
        const scale = Math.pow(10, -Math.floor(rnd() * 12));
        vals = Array.from({ length: n }, () => 1e6 + (rnd() - 0.5) * scale); // 큰 값 + 좁은 범위(인덱스가 2^53을 넘으면 폴백)
      }
      else vals = Array.from({ length: n }, () => [1, 2, 2, 3, 3, 3, 10][Math.floor(rnd() * 7)]); // 반복값
      if (Math.min(...vals) === Math.max(...vals)) continue; // 상수는 별도 테스트
      const r = run(vals);
      expect(r.bins.length).toBeGreaterThanOrEqual(1);
      expect(r.bins.length).toBeLessThanOrEqual(50);
      expectStrictlyIncreasing(r);
      expectCoversData(vals, r);
      expectMatchesDefinition(vals, r);
      if (r.aligned) { alignedCount += 1; expectMultiplesOfWidth(r); } else { fallbackCount += 1; expect(r.lastClosed).toBe(true); }
    }
    // 두 경로가 모두 실제로 실행됐는지(자가검증).
    expect(alignedCount).toBeGreaterThan(300);
    expect(fallbackCount).toBeGreaterThan(0);
  });
});
