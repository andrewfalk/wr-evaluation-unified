// PR3-B 계획서 §1/§3 — 히스토그램 bin 공개통제 + 이상치 전용 partition
// 게이트(히스토그램 게이트와 완전히 별개). §1의 반례를 정확히 재현해 고정한다.
// B안(A안 후속) — 히스토그램은 더 이상 "어느 한 bin이라도 소수셀이면 즉시
// 전체 억제"가 아니라, 원본이 실패하면 정해진 후보 해상도로 재분할해 공개
// 가능한 가장 세밀한 것을 채택한다(resolveDisclosableHistogram). MIN_DISCLOSABLE_
// BINS(현재 3)는 폴백 후보에만 적용되는 하한이라 아래 테스트에 그 값을 그대로
// 리터럴로 사용한다(MINIMUM_COHORT=10을 다른 테스트들이 리터럴로 쓰는 것과 동일
// 관례).
import { describe, expect, it } from 'vitest';
import type { DatasetRow } from '../statsDatasetBuilder';
import {
  buildUniformEdges,
  computeOutlierValues,
  isOutlierCountDisclosable,
  resolveDisclosableHistogram,
} from '../statsChartDisclosure';

const KEY = 'v';

function row(i: number, personKey: string, value: number): DatasetRow {
  return {
    caseId: `case-${i}`,
    personClusterKey: personKey,
    values: { [KEY]: { value, missing: null, qualityFlags: [] } },
  };
}

// 1:1 person:case로 n개의 행을 만든다(각 값이 서로 다른 사람).
function distinctPersonRows(values: number[]): DatasetRow[] {
  return values.map((v, i) => row(i, `person-${i}`, v));
}

function valueOf(r: DatasetRow): number | null {
  const extracted = r.values[KEY];
  if (!extracted || extracted.missing !== null) return null;
  return typeof extracted.value === 'number' ? extracted.value : null;
}

describe('resolveDisclosableHistogram — 0단계(원본) 그대로 공개', () => {
  it('모든 bin이 person 소수셀 없이 깨끗하면 원본 그대로 공개(merged:false)', () => {
    const values = [
      ...Array.from({ length: 50 }, () => 0),
      ...Array.from({ length: 50 }, () => 10),
    ];
    const rows = distinctPersonRows(values);
    const bins = [
      { lower: 0, upper: 5, count: 50 },
      { lower: 5, upper: 10, count: 0 },
      { lower: 10, upper: 15, count: 50 },
    ];
    expect(resolveDisclosableHistogram(rows, bins, valueOf)).toEqual({ bins, merged: false });
  });

  it('마지막 bin은 양끝 포함(numpy.histogram과 동일한 경계 규칙)', () => {
    const values = Array.from({ length: 20 }, () => 10); // 정확히 상단 경계값
    const rows = distinctPersonRows(values);
    const bins = [
      { lower: 0, upper: 5, count: 0 },
      { lower: 5, upper: 10, count: 20 }, // 마지막 bin이라 10 포함
    ];
    expect(resolveDisclosableHistogram(rows, bins, valueOf)).toEqual({ bins, merged: false });
  });

  it('count===0인 bin은 사람이 없으므로 검사를 건너뛴다(에러 없이 통과)', () => {
    const rows = distinctPersonRows([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const bins = [{ lower: 0, upper: 100, count: 10 }, { lower: 100, upper: 200, count: 0 }];
    expect(resolveDisclosableHistogram(rows, bins, valueOf)).toEqual({ bins, merged: false });
  });

  it('원본 bin이 이미 1개(상수값)면서 통과하면 재분할 시도 없이 그대로 공개한다', () => {
    const rows = distinctPersonRows(Array.from({ length: 20 }, () => 5));
    const bins = [{ lower: 5, upper: 5, count: 20 }];
    expect(resolveDisclosableHistogram(rows, bins, valueOf)).toEqual({ bins, merged: false });
  });

  it('bins가 빈 배열이면 방어적으로 null을 반환한다(호출부의 truthy 검사만으로는 안 걸러짐)', () => {
    const rows = distinctPersonRows([1, 2, 3]);
    expect(resolveDisclosableHistogram(rows, [], valueOf)).toBeNull();
  });
});

// 해상도 r의 bin 경계 — 원본 bin·재분할 후보 모두 buildUniformEdges(numpy linspace와
// 같은 연산 순서)로 만든다. 기대값도 같은 함수로 만들어 부동소수점 표기 차이를 없앤다.
function binsFrom(lo: number, hi: number, counts: number[]) {
  const edges = buildUniformEdges(lo, hi, counts.length);
  return counts.map((count, i) => ({ lower: edges[i], upper: edges[i + 1], count }));
}

// 원본 bin i의 중앙값에 personsPerBin[i]명(각자 서로 다른 사람)을 넣는다.
function valuesAtCenters(lo: number, hi: number, personsPerBin: number[]): number[] {
  const edges = buildUniformEdges(lo, hi, personsPerBin.length);
  return personsPerBin.flatMap((n, i) => Array.from({ length: n }, () => (edges[i] + edges[i + 1]) / 2));
}

describe('resolveDisclosableHistogram — 끝 구간 병합', () => {
  it('오른쪽 끝 소수셀 bin들(4·0·2·1명)을 안쪽 이웃까지 흡수해 17명 bin 하나로 합친다(시안 예시 1)', () => {
    const persons = [13, 18, 12, 10, 4, 0, 2, 1];
    const rows = distinctPersonRows(valuesAtCenters(10, 410, persons));
    const resolved = resolveDisclosableHistogram(rows, binsFrom(10, 410, persons), valueOf);
    const edges = buildUniformEdges(10, 410, 8);
    expect(resolved).toEqual({
      merged: false,
      bins: [
        { lower: edges[0], upper: edges[1], count: 13 },
        { lower: edges[1], upper: edges[2], count: 18 },
        { lower: edges[2], upper: edges[3], count: 12 },
        { lower: edges[3], upper: edges[8], count: 17, tailMerged: true },
      ],
    });
  });

  it('양 끝을 동시에 병합한다 — 왼쪽은 한 번(2+9), 오른쪽은 두 번(1+5+11)(시안 예시 2)', () => {
    const persons = [2, 9, 15, 22, 17, 11, 5, 1];
    const rows = distinctPersonRows(valuesAtCenters(16, 40, persons));
    const resolved = resolveDisclosableHistogram(rows, binsFrom(16, 40, persons), valueOf);
    const edges = buildUniformEdges(16, 40, 8);
    expect(resolved).toEqual({
      merged: false,
      bins: [
        { lower: edges[0], upper: edges[2], count: 11, tailMerged: true },
        { lower: edges[2], upper: edges[3], count: 15 },
        { lower: edges[3], upper: edges[4], count: 22 },
        { lower: edges[4], upper: edges[5], count: 17 },
        { lower: edges[5], upper: edges[8], count: 17, tailMerged: true },
      ],
    });
  });

  it('병합 인원은 bin별 인원수의 합이 아니라 person 합집합이다 — 같은 5명이 두 bin에 걸치면 9명이라 한 bin 더 흡수한다', () => {
    // bin0: p0~p4(5명) / bin1: p0~p4의 두 번째 행 + q0~q3(합집합 9명, 합산이면 14명) /
    // bin2~5: 각 10명. 합산으로 잘못 세면 bin0+bin1에서 멈추고, 합집합이면 bin2까지 흡수한다.
    const edges = buildUniformEdges(0, 60, 6);
    const center = (i: number) => (edges[i] + edges[i + 1]) / 2;
    const rows: DatasetRow[] = [
      ...Array.from({ length: 5 }, (_v, i) => row(i, `p${i}`, center(0))),
      ...Array.from({ length: 5 }, (_v, i) => row(10 + i, `p${i}`, center(1))),
      ...Array.from({ length: 4 }, (_v, i) => row(20 + i, `q${i}`, center(1))),
      ...[2, 3, 4, 5].flatMap((b) => Array.from({ length: 10 }, (_v, i) => row(100 * b + i, `b${b}-${i}`, center(b)))),
    ];
    const resolved = resolveDisclosableHistogram(rows, binsFrom(0, 60, [5, 9, 10, 10, 10, 10]), valueOf);
    expect(resolved).toEqual({
      merged: false,
      bins: [
        { lower: edges[0], upper: edges[3], count: 5 + 9 + 10, tailMerged: true },
        { lower: edges[3], upper: edges[4], count: 10 },
        { lower: edges[4], upper: edges[5], count: 10 },
        { lower: edges[5], upper: edges[6], count: 10 },
      ],
    });
  });

  it('같은 해상도에서는 끝 구간 병합이 더 거친 재분할보다 우선한다(원본 8개 → 병합 후 7개, 4개 재분할 아님)', () => {
    // 4개로 재분할해도 [10,20,20,20]으로 통과하지만, 원본 해상도의 끝 병합이 먼저 통과한다.
    const persons = [5, 5, 10, 10, 10, 10, 10, 10];
    const rows = distinctPersonRows(valuesAtCenters(0, 80, persons));
    const resolved = resolveDisclosableHistogram(rows, binsFrom(0, 80, persons), valueOf);
    const edges = buildUniformEdges(0, 80, 8);
    expect(resolved).toEqual({
      merged: false,
      bins: [
        { lower: edges[0], upper: edges[2], count: 10, tailMerged: true },
        ...[2, 3, 4, 5, 6, 7].map((i) => ({ lower: edges[i], upper: edges[i + 1], count: 10 })),
      ],
    });
  });

  it('가운데에 소수셀이 남으면 그 해상도의 끝 병합은 실패하고 재분할 후보로 넘어간다(가운데는 병합하지 않음)', () => {
    // 원본 8개 [10,5,5,10,...] — 양 끝은 정상이라 끝 병합으로 고칠 게 없고 가운데 5명 bin
    // 둘이 남는다 → 4개 재분할(15/15/20/20)에서 통과.
    const persons = [10, 5, 5, 10, 10, 10, 10, 10];
    const rows = distinctPersonRows(valuesAtCenters(0, 80, persons));
    const resolved = resolveDisclosableHistogram(rows, binsFrom(0, 80, persons), valueOf);
    expect(resolved).toEqual({ merged: true, bins: binsFrom(0, 80, [15, 15, 20, 20]) });
  });

  it('재분할 해상도에서도 끝 구간 병합을 시도한다 — 4개 재분할 그대로는 실패해도 그 해상도의 끝 병합으로 통과한다', () => {
    // 원본 8개 [3,0,10,5,5,10,10,10]: 원본 끝 병합은 가운데 5명 bin 때문에 실패.
    // 4개 재분할 [3,15,15,20]: 그대로는 왼쪽 3명 때문에 실패 → 끝 병합 [18,15,20] 통과.
    const persons = [3, 0, 10, 5, 5, 10, 10, 10];
    const rows = distinctPersonRows(valuesAtCenters(0, 80, persons));
    const resolved = resolveDisclosableHistogram(rows, binsFrom(0, 80, persons), valueOf);
    const edges = buildUniformEdges(0, 80, 4);
    expect(resolved).toEqual({
      merged: true,
      bins: [
        { lower: edges[0], upper: edges[2], count: 18, tailMerged: true },
        { lower: edges[2], upper: edges[3], count: 15 },
        { lower: edges[3], upper: edges[4], count: 20 },
      ],
    });
  });

  it('양쪽 병합이 만나면(가운데가 남지 않으면) 그 해상도는 실패한다 — 모든 후보가 그러면 null', () => {
    const persons = [5, 5, 0, 0, 0, 0, 0, 9];
    const rows = distinctPersonRows(valuesAtCenters(0, 80, persons));
    expect(resolveDisclosableHistogram(rows, binsFrom(0, 80, persons), valueOf)).toBeNull();
  });

  it('병합 후 bin이 MIN_DISCLOSABLE_BINS(3) 미만이면 거부한다(원본 3개 [9,10,10] → 병합하면 2개)', () => {
    const persons = [9, 10, 10];
    const rows = distinctPersonRows(valuesAtCenters(0, 30, persons));
    expect(resolveDisclosableHistogram(rows, binsFrom(0, 30, persons), valueOf)).toBeNull();
  });

  it('병합된 오른쪽 끝 bin은 최댓값(마지막 경계)을 포함한다', () => {
    // 오른쪽 끝 값 2개가 정확히 hi(=100)에 있다 — 마지막 bin만 양끝 포함이라 병합 bin에 들어가야 한다.
    const values = [...valuesAtCenters(0, 100, [10, 10, 10, 8, 0]), 100, 100];
    const rows = distinctPersonRows(values);
    const resolved = resolveDisclosableHistogram(rows, binsFrom(0, 100, [10, 10, 10, 8, 2]), valueOf);
    const edges = buildUniformEdges(0, 100, 5);
    expect(resolved!.bins[resolved!.bins.length - 1]).toEqual({ lower: edges[3], upper: edges[5], count: 10, tailMerged: true });
    expect(resolved!.bins.reduce((s, b) => s + b.count, 0)).toBe(values.length);
  });
});

describe('resolveDisclosableHistogram — 재분할(B안 폴백)', () => {
  it('사다리 하한 누락 반례 — 원본 4개(인원 [10,1,9,10])는 그대로·끝 병합 모두 실패하고, 자연스러운 절반 축소(ceil(4/2)=2)로는 하한(3) 미만이라 건너뛸 뻔한 3개를 강제로 시도해 [10,10,10]으로 통과한다', () => {
    // 가운데(1명·9명)가 소수셀이라 끝 병합으로는 못 고친다.
    const values = [
      ...Array.from({ length: 10 }, () => 5), // [0,10)
      ...Array.from({ length: 1 }, () => 15), // [10,20)
      ...Array.from({ length: 9 }, () => 25), // [20,30)
      ...Array.from({ length: 10 }, () => 35), // [30,40]
    ];
    const rows = distinctPersonRows(values);
    const resolved = resolveDisclosableHistogram(rows, binsFrom(0, 40, [10, 1, 9, 10]), valueOf);
    expect(resolved).toEqual({ merged: true, bins: binsFrom(0, 40, [10, 10, 10]) });
  });

  it('경계값 정확 배정 — 재분할 경계에 정확히 걸치는 값도 부동소수점 오차 없이 올바른 bin에 들어간다(원본이 실제로 소수셀이어야 재분할 경로를 탄다)', () => {
    // 1차 리뷰 지적 — 이전 버전은 bins 배열의 count 필드만 1로 적어뒀을 뿐, 실제
    // rows는 원본 bin마다 10명씩(count 필드가 아니라 실제 재순회로 판정하므로)
    // 넣어 원본이 그대로 통과해버렸다(merged:false, 44개 그대로) — 재분할 코드
    // 자체는 한 번도 실행되지 않고도 테스트가 통과할 수 있었다. 이번엔 원본
    // bin마다 실제로 5명만(소수셀) 넣어 반드시 재분할을 타게 만든다(끝 병합도
    // 가운데 5명 bin들 때문에 실패한다).
    const k = 22;
    const lo = 0;
    const hi = 1;
    // 경계는 실제 구현(buildUniformEdges, numpy linspace와 같은 i*step+lo)이 만드는 값
    // 그대로 — 15/22는 부동소수점 반복소수라 연산 순서에 따라 1ulp 달라질 수 있다.
    const edgeUnderTest = buildUniformEdges(lo, hi, k)[15];
    // 원본 44개(=22*2) bin — fallbackCandidates(44)의 첫 후보가 22다. 원본 44개가
    // 전부 lo~hi를 균등분할한 것이므로, k=22의 edges는 원본 bin을 2개씩 짝지은 것과
    // 일치한다(step이 정확히 2배라 i*(2s) === (2i)*s) — 그래서 재분할 후 각 bin의
    // 기본 인원이 정확히 "원본 2개bin×5명=10명"이 될 것을 예측할 수 있다.
    const originalK = 44;
    const originalEdges = buildUniformEdges(lo, hi, originalK);

    const values: number[] = [];
    for (let i = 0; i < originalK; i += 1) {
      const center = (originalEdges[i] + originalEdges[i + 1]) / 2;
      for (let j = 0; j < 5; j += 1) values.push(center); // 원본은 5명뿐 — 반드시 소수셀
    }
    const EPS = 1e-9;
    const RIGHT_EXTRA = 9;
    for (let i = 0; i < RIGHT_EXTRA; i += 1) values.push(edgeUnderTest); // 경계값 자체 — 왼쪽 폐구간이라 "오른쪽" bin 소속
    values.push(edgeUnderTest - EPS); // 경계 바로 왼쪽 — "왼쪽" bin 소속
    values.push(edgeUnderTest + EPS); // 경계 바로 오른쪽 — 당연히 "오른쪽" bin 소속

    const originalBins = Array.from({ length: originalK }, (_v, i) => {
      const isLast = i === originalK - 1;
      const lower = originalEdges[i];
      const upper = originalEdges[i + 1];
      const count = values.filter((v) => (isLast ? v >= lower && v <= upper : v >= lower && v < upper)).length;
      return { lower, upper, count };
    });

    const rows = distinctPersonRows(values);
    const resolved = resolveDisclosableHistogram(rows, originalBins, valueOf);

    expect(resolved).not.toBeNull();
    expect(resolved!.merged).toBe(true);
    expect(resolved!.bins).toHaveLength(k);

    const rightBinIndex = resolved!.bins.findIndex((b) => b.lower === edgeUnderTest);
    expect(rightBinIndex).toBeGreaterThan(0);
    const rightBin = resolved!.bins[rightBinIndex];
    const leftBin = resolved!.bins[rightBinIndex - 1];

    // 오른쪽 bin: 원본 2개(5+5=10명) + 경계값 자체(9명, 왼쪽 폐구간이라 여기 소속) +
    // 경계+EPS(1명) = 20명. 왼쪽 bin: 원본 2개(10명) + 경계-EPS(1명) = 11명.
    expect(rightBin.count).toBe(10 + RIGHT_EXTRA + 1);
    expect(leftBin.count).toBe(10 + 1);
    expect(resolved!.bins.reduce((s, b) => s + b.count, 0)).toBe(values.length);
  });

  it('같은 사람의 서로 다른 두 행이 원본에서는 다른 두 bin에 있었는데 재분할·병합 후 같은 bin에 합쳐지면, 그 사람은 정확히 1명으로만 세어진다(합산 아님)', () => {
    const sharedPerson = 'shared-person';
    const others = Array.from({ length: 8 }, (_v, i) => row(i, `other-${i}`, 3)); // 원본 bin0
    const sharedRow1 = row(100, sharedPerson, 1); // 원본 bin0
    const sharedRow2 = row(101, sharedPerson, 6); // 원본 bin1
    const bin2Rows = Array.from({ length: 10 }, (_v, i) => row(200 + i, `p2-${i}`, 12)); // 원본 bin2
    const bin3Rows = Array.from({ length: 10 }, (_v, i) => row(300 + i, `p3-${i}`, 18)); // 원본 bin3
    const rows = [...others, sharedRow1, sharedRow2, ...bin2Rows, ...bin3Rows];
    const bins = [
      { lower: 0, upper: 5, count: 9 }, // 8명 + shared 1행 — 9명(소수셀)
      { lower: 5, upper: 10, count: 1 }, // shared 1행만 — 1명(소수셀)
      { lower: 10, upper: 15, count: 10 },
      { lower: 15, upper: 20, count: 10 },
    ];
    // 원본 끝 병합: bin0(9명)에 bin1을 합쳐도 shared가 이미 있어 합집합은 9명 그대로라
    // bin2까지 흡수해야 하고, 그러면 남는 bin이 2개(<3)라 실패한다. 재분할(하한 3개,
    // edges=[0,6.667,13.333,20])에서도 첫 bin은 원본 bin0 전체(9명) + shared의 두 번째
    // 행(값 6)까지 받는다 — 행 수로는 10행이지만 서로 다른 사람은 9명뿐이다. 만약
    // 구현이 (합집합이 아니라) 행 수나 원본 bin별 인원수 합산으로 잘못 판정한다면
    // 10으로 보여 통과해버릴 것이다 — 정확한 구현은 9명으로 판정해 그대로·끝 병합
    // 모두 실패해야 한다(더 낮출 후보가 없으므로 결과는 null).
    expect(resolveDisclosableHistogram(rows, bins, valueOf)).toBeNull();
  });

  it('정해진 후보를 전부 시도해도 통과하는 게 없으면 null을 반환한다', () => {
    // 9명이 lo 지점(0)에 고립돼 있고, 나머지 91명은 반대쪽 끝(250)에 몰려 있다 —
    // 몇 개로 재분할하든(하한 3개까지) lo쪽 구간엔 그 9명만 남고, 끝 병합하면
    // 반대쪽 끝까지 다 삼켜 가운데가 남지 않는다.
    const values = [
      ...Array.from({ length: 9 }, () => 0),
      ...Array.from({ length: 91 }, () => 250),
    ];
    const rows = distinctPersonRows(values);
    const bins = [
      { lower: 0, upper: 75, count: 9 },
      { lower: 75, upper: 150, count: 0 },
      { lower: 150, upper: 225, count: 0 },
      { lower: 225, upper: 300, count: 91 },
    ];
    expect(resolveDisclosableHistogram(rows, bins, valueOf)).toBeNull();
  });
});

// 2차 리뷰 지적 — 원본이 3개뿐이면 fallbackCandidates(3)이 애초에 비어있어(하한
// 3 이상 후보가 안 나옴) "재분할"이라는 새 신호 자체를 관찰할 수 없다(null↔원본
// 그대로 노출이라는 옛날부터 있던 all-or-nothing 현상만 재확인하게 됨). 원본을
// 4개 이상으로 구성해, 새로 만들어낸 "어떤 모양으로 보여주는가"라는 신호가
// 인접 데이터셋(9명↔10명) 사이에서 실제로 달라지는 걸 관찰하고, 기존(all-or-
// nothing) 방식이었다면 어떻게 보였을지와 나란히 비교한다. "안전하다"를
// 증명하는 테스트가 아니라 사실을 기록해두는 관찰 테스트다.
describe('resolveDisclosableHistogram — differencing 관찰(9명↔10명 경계, 새 모양 신호)', () => {
  it('bin0의 고유 인원이 9명→10명으로 1명만 늘어도 보여주는 모양이 바뀐다(왼쪽 끝 병합 7개 ↔ 원본 8개 그대로)', () => {
    // 원본 8개(폭 10, [0,80]) — bin0만 인원을 9/10으로 바꾸고 나머지(bin1~7)는
    // 전부 10명으로 고정한다.
    const buildValues = (bin0Count: number) => valuesAtCenters(0, 80, [bin0Count, 10, 10, 10, 10, 10, 10, 10]);
    const buildBins = (bin0Count: number) => binsFrom(0, 80, [bin0Count, 10, 10, 10, 10, 10, 10, 10]);

    const withNine = resolveDisclosableHistogram(distinctPersonRows(buildValues(9)), buildBins(9), valueOf);
    const tenBins = buildBins(10);
    const withTen = resolveDisclosableHistogram(distinctPersonRows(buildValues(10)), tenBins, valueOf);

    // "기존 방식"(all-or-nothing)이었다면 bin0=9일 때 히스토그램 전체가 null, bin0=10일
    // 때 원본 8개 그대로 노출 — 9→10 경계에서 null↔노출이 갈리는 건 이미 있던 현상이다.
    // B안(재분할)에서는 그 경계가 "4개 재분할 ↔ 원본 8개"로, 끝 구간 병합 이후에는
    // "왼쪽 끝 2개가 합쳐진 7개 ↔ 원본 8개"로 옮겨간다. 병합 bin의 count(19)는 bin0의
    // 정확한 인원을 따로 드러내지 않지만, "병합이 일어났다"는 사실 자체는 bin0가
    // 1~9명이었다는 것을 알려준다 — 소수셀 억제가 원래부터 드러내던 수준의 신호다.
    const edges = buildUniformEdges(0, 80, 8);
    expect(withNine).toEqual({
      merged: false,
      bins: [
        { lower: edges[0], upper: edges[2], count: 19, tailMerged: true },
        ...[2, 3, 4, 5, 6, 7].map((i) => ({ lower: edges[i], upper: edges[i + 1], count: 10 })),
      ],
    });
    expect(withTen).toEqual({ bins: tenBins, merged: false });
    expect(withNine!.bins).toHaveLength(7);
    expect(withTen!.bins).toHaveLength(8);
  });
});

describe('isOutlierCountDisclosable — 계획서 §1의 반례', () => {
  it('히스토그램 게이트를 전부 통과해도 이상치가 소수집단이면 억제된다(원 반례)', () => {
    // 0×50 / 1×26 / 2.49×23 / 2.51×1, n=100 — Q1=0, Q3=1(직접 계산 확인).
    const values = [
      ...Array.from({ length: 50 }, () => 0),
      ...Array.from({ length: 26 }, () => 1),
      ...Array.from({ length: 23 }, () => 2.49),
      2.51,
    ];
    const rows = distinctPersonRows(values);
    // fence = Q1-1.5·IQR=-1.5, Q3+1.5·IQR=2.5 — 2.51만 이상치(1명).
    expect(isOutlierCountDisclosable(rows, { q1: 0, q3: 1 }, valueOf)).toBe(false);
    expect(computeOutlierValues(rows, { q1: 0, q3: 1 }, valueOf)).toEqual([2.51]);
  });

  it('반대 방향 반례 — 이상치가 다수, 비이상치가 소수(반복기록으로 가능)', () => {
    // 비이상치 구간[0,1] 안의 값이 1명뿐이고, 이상치 구간 밖 값이 10명 — 비이상치
    // partition이 소수셀이면 (이상치 partition이 크더라도) 전체가 억제돼야 한다.
    const values = [
      0.5, // 비이상치 1명뿐
      ...Array.from({ length: 10 }, () => 100), // 이상치 10명
    ];
    const rows = distinctPersonRows(values);
    // q1=q3=0.5로 두면 iqr=0, fence=[0.5,0.5] — 0.5만 비이상치, 100은 전부 이상치.
    expect(isOutlierCountDisclosable(rows, { q1: 0.5, q3: 0.5 }, valueOf)).toBe(false);
  });

  it('양쪽 partition 모두 충분하면 공개 가능', () => {
    const values = [
      ...Array.from({ length: 20 }, () => 5), // 비이상치 20명
      ...Array.from({ length: 15 }, () => 100), // 이상치 15명
    ];
    const rows = distinctPersonRows(values);
    expect(isOutlierCountDisclosable(rows, { q1: 5, q3: 5 }, valueOf)).toBe(true);
  });

  it('이상치가 0명이면(전부 비이상치) 공개 가능 — isSmallCell(0)은 false', () => {
    const values = Array.from({ length: 20 }, () => 5);
    const rows = distinctPersonRows(values);
    expect(isOutlierCountDisclosable(rows, { q1: 0, q3: 10 }, valueOf)).toBe(true);
  });
});
