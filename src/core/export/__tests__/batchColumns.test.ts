// 일괄 내보내기 열 표(P2-54b·55a·55b, Phase 2 C6) — 구간·열 수·order. 값은 G2·G4·P2-54a 골든이 지킨다.
import { describe, expect, it } from 'vitest';
import { assembleBatchColumnSections, getBatchColumnSections, getBatchHeaders, type BatchColumnSection } from '../batchColumns';

const columns = (count: number) => Array.from({ length: count }, (_, index) => ({ header: `h${index}`, cell: () => '' }));

describe('모듈 미등록', () => {
  it('core 구간(32열)만', () => {
    expect(getBatchColumnSections().map(section => [section.id, section.order, section.columns.length])).toEqual([
      ['core', 0, 32],
    ]);
  });
});

describe('6모듈 등록', () => {
  it('구간 7개(지금 열 순서), 열 124개, 머리글 고유', async () => {
    for (const id of ['knee', 'shoulder', 'elbow', 'wrist', 'spine', 'cervical']) await import(`../../../modules/${id}/index`);
    expect(getBatchColumnSections().map(section => [section.id, section.order, section.columns.length])).toEqual([
      ['core', 0, 32],
      ['knee', 10, 8],
      ['shoulder', 20, 6],
      ['cervical', 30, 9],
      ['elbow', 40, 31],
      ['wrist', 50, 31],
      ['spine', 60, 7],
    ]);
    const headers = getBatchHeaders();
    expect(headers).toHaveLength(124);
    expect(new Set(headers).size).toBe(124);
  });
});

describe('assembleBatchColumnSections', () => {
  it('order 순으로 끼워 넣는다(넘긴 순서와 무관)', () => {
    const sections: BatchColumnSection[] = [
      { id: 'late', order: 70, columns: columns(1) },
      { id: 'early', order: 5, columns: columns(1) },
    ];
    expect(assembleBatchColumnSections(sections).map(section => section.id))
      .toEqual(['core', 'early', 'late']);
  });

  it('order가 겹치면 throw', () => {
    expect(() => assembleBatchColumnSections([{ id: 'x', order: 0, columns: columns(1) }]))
      .toThrow("[batchColumns] 구간 order 0이 'core'와 'x'에 겹칩니다");
    expect(() => assembleBatchColumnSections([
      { id: 'a', order: 10, columns: columns(1) },
      { id: 'b', order: 10, columns: columns(1) },
    ])).toThrow("[batchColumns] 구간 order 10이 'a'와 'b'에 겹칩니다");
  });

  it('order가 없거나 숫자가 아니면 throw', () => {
    expect(() => assembleBatchColumnSections([{ id: 'x', order: Number.NaN, columns: columns(1) }]))
      .toThrow("[batchColumns] 구간 'x'의 order가 숫자가 아닙니다");
    expect(() => assembleBatchColumnSections([{ id: 'y', columns: columns(1) } as unknown as BatchColumnSection]))
      .toThrow("[batchColumns] 구간 'y'의 order가 숫자가 아닙니다");
  });

  it('같은 id가 둘이면 throw', () => {
    expect(() => assembleBatchColumnSections([
      { id: 'elbow', order: 40, columns: columns(1) },
      { id: 'elbow', order: 45, columns: columns(1) },
    ])).toThrow("[batchColumns] 구간 'elbow'가 두 번 있습니다");
  });
});
