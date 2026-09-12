// PR3-B 계획서 §2/§3/§4/§7 — 산점도 그리드(person 단위 전체연결억제)와 결정적
// 샘플링(caseId 정렬 후 시드 기반 셔플, Math.random() 미사용).
import { describe, expect, it } from 'vitest';
import { computeScatterGrid, MAX_SCATTER_POINTS, sampleScatterPoints } from '../statsScatterGrid';

interface Row {
  caseId: string;
  personClusterKey: string;
  x: number;
  y: number;
}

function rows(n: number, mapper: (i: number) => { x: number; y: number }): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    caseId: `case-${i}`,
    personClusterKey: `person-${i}`,
    ...mapper(i),
  }));
}

describe('computeScatterGrid', () => {
  it('모든 셀이 person 소수셀 없이 깨끗하면 그리드를 반환한다', () => {
    const data = rows(200, (i) => ({ x: i, y: i * 2 }));
    const grid = computeScatterGrid(data, (r) => r.x, (r) => r.y);
    expect(grid).not.toBeNull();
    expect(grid!.cells.reduce((s, c) => s + c.count, 0)).toBe(200);
  });

  it('어느 한 셀이라도 소수셀이면 그리드 전체가 억제된다(null)', () => {
    // 대부분 (0,0) 근방에 몰아넣고, 3개만 멀리 떨어뜨려 소수셀 만든다.
    const data: Row[] = [
      ...rows(50, () => ({ x: 0, y: 0 })),
      ...rows(3, () => ({ x: 1000, y: 1000 })).map((r, i) => ({ ...r, caseId: `far-${i}`, personClusterKey: `far-person-${i}` })),
    ];
    const grid = computeScatterGrid(data, (r) => r.x, (r) => r.y);
    expect(grid).toBeNull();
  });

  it('x 또는 y가 상수(min===max)여도 크래시 없이 단일 grid line을 만든다', () => {
    // y도 두 값(각 10명)만 써서 그리드 셀마다 인원이 충분하게 만든다 —
    // "상수 x 처리"만 검증하려는 것이지 억제 여부를 검증하려는 게 아니다.
    const data = rows(20, (i) => ({ x: 5, y: i < 10 ? 0 : 100 }));
    const grid = computeScatterGrid(data, (r) => r.x, (r) => r.y);
    expect(grid).not.toBeNull();
    expect(grid!.xEdges).toEqual([5, 5]);
  });

  it('n=0이면 빈 그리드(에러 없음)', () => {
    const grid = computeScatterGrid([] as Row[], (r) => r.x, (r) => r.y);
    expect(grid).toEqual({ xEdges: [], yEdges: [], cells: [] });
  });

  it('코드리뷰 반례 — 마지막 bin 경계의 부동소수점 오차로 최댓값 관측치가 조용히 누락돼 소수셀 억제를 우회하면 안 된다', () => {
    // x=0.05인 10명 + x=0.21인 1명. makeEdges(0.05, 0.21, 5)의 마지막 경계는
    // min+((max-min)*5)/5 계산 시 부동소수점 오차로 0.20999999999999996(<0.21)이
    // 나온다 — 고치기 전에는 x=0.21인 마지막 1명이 어느 bin에도 안 걸려 조용히
    // continue되고, 나머지 10명짜리 셀만 "소수셀 없음"으로 판정돼 그리드가
    // 그대로 공개됐다(실제로는 1명짜리 셀이 존재하므로 전체 억제돼야 함).
    const data: Row[] = [
      ...rows(10, () => ({ x: 0.05, y: 1 })),
      { caseId: 'outlier', personClusterKey: 'outlier-person', x: 0.21, y: 2 },
    ];
    const grid = computeScatterGrid(data, (r) => r.x, (r) => r.y);
    expect(grid).toBeNull();
  });

  it('그리드가 공개되면 셀 count 합은 항상 입력 전체 유효 관측치 수와 같다', () => {
    const data = rows(37, (i) => ({ x: i * 0.013, y: i * 0.019 }));
    const grid = computeScatterGrid(data, (r) => r.x, (r) => r.y);
    // 37명 전부 서로 다른 person이면 대부분의 셀이 소수셀이라 억제될 수 있으므로,
    // 억제되지 않았을 때만(=grid가 나왔을 때만) 불변조건을 확인한다.
    if (grid) {
      expect(grid.cells.reduce((s, c) => s + c.count, 0)).toBe(37);
    }
  });
});

describe('sampleScatterPoints', () => {
  it(`전체 쌍이 ${MAX_SCATTER_POINTS} 이하면 전부 표시(표시 n === 전체 n)`, () => {
    const data = rows(500, (i) => ({ x: i, y: i }));
    const result = sampleScatterPoints(data, (r) => r.x, (r) => r.y, 'seed-1');
    expect(result.displayedCount).toBe(500);
    expect(result.totalCount).toBe(500);
    expect(result.points).toHaveLength(500);
  });

  it(`전체 쌍이 ${MAX_SCATTER_POINTS} 초과면 정확히 상한만큼만 표시된다`, () => {
    const data = rows(5000, (i) => ({ x: i, y: i }));
    const result = sampleScatterPoints(data, (r) => r.x, (r) => r.y, 'seed-1');
    expect(result.displayedCount).toBe(MAX_SCATTER_POINTS);
    expect(result.totalCount).toBe(5000);
    expect(result.points).toHaveLength(MAX_SCATTER_POINTS);
  });

  it('같은 seed + 같은 입력이면 항상 같은 샘플이 나온다(결정성)', () => {
    const data = rows(5000, (i) => ({ x: i, y: i * 2 }));
    const r1 = sampleScatterPoints(data, (r) => r.x, (r) => r.y, 'digest-abc');
    const r2 = sampleScatterPoints(data, (r) => r.x, (r) => r.y, 'digest-abc');
    expect(r1.points).toEqual(r2.points);
  });

  it('입력 순서가 달라도(같은 집합) 같은 결과가 나온다(입력 순서 독립성 — caseId 정렬 선행)', () => {
    const data = rows(5000, (i) => ({ x: i, y: i * 2 }));
    const shuffledInput = [...data].reverse();
    const r1 = sampleScatterPoints(data, (r) => r.x, (r) => r.y, 'digest-xyz');
    const r2 = sampleScatterPoints(shuffledInput, (r) => r.x, (r) => r.y, 'digest-xyz');
    expect(r1.points).toEqual(r2.points);
  });

  it('다른 seed는 다른 샘플을 만든다(표본추출 자체가 seed에 의존)', () => {
    const data = rows(5000, (i) => ({ x: i, y: i * 2 }));
    const r1 = sampleScatterPoints(data, (r) => r.x, (r) => r.y, 'seed-A');
    const r2 = sampleScatterPoints(data, (r) => r.x, (r) => r.y, 'seed-B');
    expect(r1.points).not.toEqual(r2.points);
  });
});
