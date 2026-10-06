// 히스토그램 끝 구간 병합 — 원본 bin의 기준 구현(buildOriginalHistogram)이
// services/stats-engine/histogram.py(numpy)와 bin 개수·경계·bin별 건수까지
// 정확히(toEqual, 근사 비교 아님) 같은지 고정한다. 외부 리뷰에서 경계 연산 순서
// 차이(lo + i*(hi-lo)/k vs numpy linspace의 i*step+lo)로 [0,1]·k=5의 0.6이 다른
// bin에 배정되는 결함이 실측돼(합성 데이터 19건 불일치) 추가했다.
//
// 픽스처는 fixtures/gen_histogram_parity.py가 실제 numpy로 생성한다(재생성 방법은
// 그 파일 docstring). Python 없이도 항상 실행되도록 결과를 JSON으로 커밋해 둔다.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { buildOriginalHistogram, buildUniformEdges } from '../statsChartDisclosure';

interface ParityCase {
  name: string;
  values: number[];
  persons: number[];
  q1: number;
  q3: number;
  bins: Array<{ lower: number; upper: number; count: number }>;
}

const fixture = JSON.parse(
  readFileSync(path.resolve(__dirname, 'fixtures/histogramParity.json'), 'utf8'),
) as { numpy: string; cases: ParityCase[] };

type Row = { personClusterKey: string; value: number | null };
const valueOf = (r: Row) => r.value;

function rowsOf(c: ParityCase): Row[] {
  return c.values.map((value, i) => ({ personClusterKey: `p-${c.persons[i]}`, value }));
}

describe(`buildOriginalHistogram ↔ numpy ${fixture.numpy} 픽스처 대조`, () => {
  it('픽스처가 판별력 있는 케이스를 실제로 담고 있다(자가검증)', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(50);
    const names = fixture.cases.map((c) => c.name);
    expect(names).toContain('tenth-grid-on-edges');
    expect(names).toContain('broadcast-200-persons-x3');
    // 50개 상한·Sturges(IQR==0)·상수 분기가 각각 실제로 나왔는지.
    const byName = new Map(fixture.cases.map((c) => [c.name, c] as const));
    expect(byName.get('cap-50-far-outlier')!.bins).toHaveLength(50);
    expect(byName.get('sturges-power-of-two-64')!.bins).toHaveLength(7);
    expect(byName.get('constant-20')!.bins).toEqual([{ lower: 5, upper: 5, count: 20 }]);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s — 경계·건수까지 numpy와 정확히 같다', (_name, c) => {
    expect(buildOriginalHistogram(rowsOf(c), valueOf, c.q1, c.q3)).toEqual(c.bins);
  });

  it('결측(null) 행이 섞여도 결과가 같다 — 결측은 Python 요청에서도 빠진다', () => {
    const c = fixture.cases.find((x) => x.name === 'normal-200')!;
    const rows: Row[] = [
      ...rowsOf(c),
      ...Array.from({ length: 30 }, (_v, i) => ({ personClusterKey: `missing-${i}`, value: null })),
    ];
    expect(buildOriginalHistogram(rows, valueOf, c.q1, c.q3)).toEqual(c.bins);
  });

  it('반복 행은 건수에서 제거하지 않는다(건수=관측 건수, bin 개수 공식만 인원수 기준)', () => {
    const c = fixture.cases.find((x) => x.name === 'broadcast-200-persons-x3')!;
    const bins = buildOriginalHistogram(rowsOf(c), valueOf, c.q1, c.q3)!;
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(600);
  });

  it('유효값이 하나도 없으면 null', () => {
    const rows: Row[] = Array.from({ length: 5 }, (_v, i) => ({ personClusterKey: `p-${i}`, value: null }));
    expect(buildOriginalHistogram(rows, valueOf, 0, 0)).toBeNull();
  });
});

describe('buildUniformEdges — numpy linspace와 같은 연산 순서', () => {
  it('[0,1]·k=5의 세 번째 내부 경계는 numpy와 같은 0.6000000000000001이다(리뷰 실측 반례)', () => {
    const edges = buildUniformEdges(0, 1, 5);
    expect(edges[3]).toBe(0.6000000000000001);
    expect(edges[0]).toBe(0);
    expect(edges[5]).toBe(1);
  });
});
