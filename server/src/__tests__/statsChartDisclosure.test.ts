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

describe('resolveDisclosableHistogram — 재분할(B안 폴백)', () => {
  it('원본(8개)은 실패하지만 사다리에 자연스럽게 있는 후보(4개)에서 통과한다', () => {
    // bin0(5명)+bin1(5명)이 원본에선 각각 소수셀 — 4개로 재분할하면 두 쌍씩 묶여
    // (5+5, 10, 10, 10) 전부 10명 이상이 된다.
    const values = [
      ...Array.from({ length: 5 }, () => 5), // [0,10)
      ...Array.from({ length: 5 }, () => 15), // [10,20)
      ...Array.from({ length: 10 }, () => 25), // [20,30)
      ...Array.from({ length: 10 }, () => 35), // [30,40)
      ...Array.from({ length: 10 }, () => 45), // [40,50)
      ...Array.from({ length: 10 }, () => 55), // [50,60)
      ...Array.from({ length: 10 }, () => 65), // [60,70)
      ...Array.from({ length: 10 }, () => 75), // [70,80]
    ];
    const rows = distinctPersonRows(values);
    const bins = [
      { lower: 0, upper: 10, count: 5 }, { lower: 10, upper: 20, count: 5 },
      { lower: 20, upper: 30, count: 10 }, { lower: 30, upper: 40, count: 10 },
      { lower: 40, upper: 50, count: 10 }, { lower: 50, upper: 60, count: 10 },
      { lower: 60, upper: 70, count: 10 }, { lower: 70, upper: 80, count: 10 },
    ];
    const resolved = resolveDisclosableHistogram(rows, bins, valueOf);
    expect(resolved).toEqual({
      merged: true,
      bins: [
        { lower: 0, upper: 20, count: 10 },
        { lower: 20, upper: 40, count: 20 },
        { lower: 40, upper: 60, count: 20 },
        { lower: 60, upper: 80, count: 20 },
      ],
    });
  });

  it('사다리 하한 누락 반례 — 원본 4개(인원 [1,9,10,10])는 실패하지만 자연스러운 절반 축소(ceil(4/2)=2)로는 하한(3) 미만이라 건너뛸 뻔한 3개를 강제로 시도해 [10,10,10]으로 통과한다', () => {
    const values = [
      ...Array.from({ length: 1 }, () => 1), // [0,3)
      ...Array.from({ length: 9 }, () => 5), // [3,10)
      ...Array.from({ length: 10 }, () => 15), // [10,20)
      ...Array.from({ length: 10 }, () => 25), // [20,30)
    ];
    const rows = distinctPersonRows(values);
    const bins = [
      { lower: 0, upper: 3, count: 1 },
      { lower: 3, upper: 10, count: 9 },
      { lower: 10, upper: 20, count: 10 },
      { lower: 20, upper: 30, count: 10 },
    ];
    const resolved = resolveDisclosableHistogram(rows, bins, valueOf);
    expect(resolved).toEqual({
      merged: true,
      bins: [
        { lower: 0, upper: 10, count: 10 },
        { lower: 10, upper: 20, count: 10 },
        { lower: 20, upper: 30, count: 10 },
      ],
    });
  });

  it('경계값 정확 배정 — 재분할 경계에 정확히 걸치는 값도 부동소수점 오차 없이 올바른 bin에 들어간다(원본이 실제로 소수셀이어야 재분할 경로를 탄다)', () => {
    // 1차 리뷰 지적 — 이전 버전은 bins 배열의 count 필드만 1로 적어뒀을 뿐, 실제
    // rows는 원본 bin마다 10명씩(count 필드가 아니라 실제 재순회로 판정하므로)
    // 넣어 원본이 그대로 통과해버렸다(merged:false, 44개 그대로) — 재분할 코드
    // 자체는 한 번도 실행되지 않고도 테스트가 통과할 수 있었다. 이번엔 원본
    // bin마다 실제로 5명만(소수셀) 넣어 반드시 재분할을 타게 만든다.
    const k = 22;
    const lo = 0;
    const hi = 1;
    const edgeUnderTest = lo + (15 * (hi - lo)) / k; // 15/22 = 0.6818181818181818...(부동소수점 반복소수)
    // 원본 44개(=22*2) bin — fallbackCandidates(44)의 첫 후보가 22다. 원본 44개가
    // 전부 lo~hi를 균등분할한 것이므로, k=22의 edges는 정확히 원본 bin을 2개씩
    // 짝지은 것과 수학적으로 일치한다(15/22 === 30/44) — 그래서 재분할 후
    // 각 bin의 기본 인원이 정확히 "원본 2개bin×5명=10명"이 될 것을 예측할 수 있다.
    const originalK = 44;
    const originalEdges = Array.from({ length: originalK + 1 }, (_v, i) => lo + (i * (hi - lo)) / originalK);

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

    const rightBinIndex = resolved!.bins.findIndex((b) => Math.abs(b.lower - edgeUnderTest) < 1e-9);
    expect(rightBinIndex).toBeGreaterThan(0);
    const rightBin = resolved!.bins[rightBinIndex];
    const leftBin = resolved!.bins[rightBinIndex - 1];

    // 오른쪽 bin: 원본 2개(5+5=10명) + 경계값 자체(9명, 왼쪽 폐구간이라 여기 소속) +
    // 경계+EPS(1명) = 20명. 왼쪽 bin: 원본 2개(10명) + 경계-EPS(1명) = 11명.
    expect(rightBin.count).toBe(10 + RIGHT_EXTRA + 1);
    expect(leftBin.count).toBe(10 + 1);
    expect(resolved!.bins.reduce((s, b) => s + b.count, 0)).toBe(values.length);
  });

  it('같은 사람의 서로 다른 두 행이 원본에서는 다른 두 bin에 있었는데 재분할 후 같은 bin에 합쳐지면, 그 사람은 정확히 1명으로만 세어진다(합산 아님)', () => {
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
    // 재분할(하한 3개, edges=[0,6.667,13.333,20])에서 첫 bin은 원본 bin0 전체(9명) +
    // shared의 두 번째 행(값 6, 6.667 미만이라 첫 bin에 포함)까지 받는다 — 행
    // 수로는 10행(8명+shared 2행)이지만 실제 서로 다른 사람은 9명뿐이다. 만약
    // 구현이 (합집합이 아니라) 행 수나 원본 bin별 인원수 합산으로 잘못 판정한다면
    // 10으로 보여 통과해버릴 것이다 — 정확한 구현은 9명으로 판정해 이 후보도
    // 실패해야 한다(더 낮출 후보가 없으므로 결과는 null).
    expect(resolveDisclosableHistogram(rows, bins, valueOf)).toBeNull();
  });

  it('정해진 후보를 전부 시도해도 통과하는 게 없으면 null을 반환한다', () => {
    // 9명이 lo 지점(0)에 고립돼 있고, 나머지 91명은 반대쪽 끝(250)에 몰려 있다 —
    // 몇 개로 재분할하든(하한 3개까지) lo쪽 구간엔 그 9명만 남는다.
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
// 4개 이상으로 구성해, B안이 새로 만들어낸 "어느 해상도로 보여주는가"라는 신호가
// 인접 데이터셋(9명↔10명) 사이에서 실제로 달라지는 걸 관찰하고, 기존(all-or-
// nothing) 방식이었다면 어떻게 보였을지와 나란히 비교한다. "안전하다"를
// 증명하는 테스트가 아니라 사실을 기록해두는 관찰 테스트다.
describe('resolveDisclosableHistogram — differencing 관찰(9명↔10명 경계, 새 해상도 신호)', () => {
  it('bin0의 고유 인원이 9명→10명으로 1명만 늘어도 "몇 개 해상도로 보여줄지"가 통째로 바뀐다(4개 재분할 ↔ 원본 8개 그대로)', () => {
    // 원본 8개(폭 10, [0,80]) — bin0만 인원을 9/10으로 바꾸고 나머지(bin1~7)는
    // 전부 10명으로 고정한다.
    const buildValues = (bin0Count: number) => [
      ...Array.from({ length: bin0Count }, () => 5), // [0,10)
      ...Array.from({ length: 10 }, () => 15), // [10,20)
      ...Array.from({ length: 10 }, () => 25), // [20,30)
      ...Array.from({ length: 10 }, () => 35), // [30,40)
      ...Array.from({ length: 10 }, () => 45), // [40,50)
      ...Array.from({ length: 10 }, () => 55), // [50,60)
      ...Array.from({ length: 10 }, () => 65), // [60,70)
      ...Array.from({ length: 10 }, () => 75), // [70,80]
    ];
    const buildBins = (bin0Count: number) => [
      { lower: 0, upper: 10, count: bin0Count }, { lower: 10, upper: 20, count: 10 },
      { lower: 20, upper: 30, count: 10 }, { lower: 30, upper: 40, count: 10 },
      { lower: 40, upper: 50, count: 10 }, { lower: 50, upper: 60, count: 10 },
      { lower: 60, upper: 70, count: 10 }, { lower: 70, upper: 80, count: 10 },
    ];

    const nineBins = buildBins(9);
    const withNine = resolveDisclosableHistogram(distinctPersonRows(buildValues(9)), nineBins, valueOf);
    const tenBins = buildBins(10);
    const withTen = resolveDisclosableHistogram(distinctPersonRows(buildValues(10)), tenBins, valueOf);

    // "기존 방식"(all-or-nothing, 재분할 없음)이었다면: bin0=9일 때 원본 8개 중
    // 하나가 소수셀이라 히스토그램 전체가 null이었을 것이고, bin0=10일 때는
    // 원본 8개가 전부 통과해 그대로 노출됐을 것이다 — 즉 옛 방식도 9→10 경계에서
    // null↔노출이 갈리는 건 이미 있던 현상이다(새 문제 아님).
    //
    // "새 방식"(B안)에서는 그 경계가 완전히 다른 모습으로 나타난다 — bin0=9는
    // null이 아니라 "재분할된 4개 bin"으로 뜨고(옛 방식이면 안 보였을 히스토그램이
    // 대신 더 굵은 해상도로는 보인다), bin0=10은 원본 8개 그대로 뜬다. 즉 B안에서
    // 9명↔10명 경계가 "노출 여부"가 아니라 "몇 개 해상도로 보여주는가"(4개 대
    // 8개, count 19 대 10)라는 새로운 축으로 옮겨간다 — 이게 이번에 새로 생긴
    // 신호이고, 이 테스트가 고정해두는 관찰 사실이다.
    expect(withNine).toEqual({
      merged: true,
      bins: [
        { lower: 0, upper: 20, count: 19 },
        { lower: 20, upper: 40, count: 20 },
        { lower: 40, upper: 60, count: 20 },
        { lower: 60, upper: 80, count: 20 },
      ],
    });
    expect(withTen).toEqual({ bins: tenBins, merged: false });

    // 두 결과 사이의 명시적 대비 — bins.length·merged·bin0 카운트 셋 다 달라진다.
    expect(withNine!.bins).toHaveLength(4);
    expect(withTen!.bins).toHaveLength(8);
    expect(withNine!.merged).toBe(true);
    expect(withTen!.merged).toBe(false);
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
