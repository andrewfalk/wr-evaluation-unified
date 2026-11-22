// 일괄 내보내기 열 표(P2-54b, Phase 2 C6) — 구간 7개·열 124개·order 고유. 값은 G2·G4·P2-54a 골든이 지킨다.
import { describe, expect, it } from 'vitest';
import { BATCH_COLUMN_SECTIONS, BATCH_COLUMNS } from '../batchColumns';

describe('BATCH_COLUMN_SECTIONS', () => {
  it('구간 7개, 지금 열 순서(core → knee → shoulder → cervical → elbow → wrist → spine)와 구간별 열 수', () => {
    expect(BATCH_COLUMN_SECTIONS.map(section => [section.id, section.order, section.columns.length])).toEqual([
      ['core', 0, 32],
      ['knee', 10, 8],
      ['shoulder', 20, 6],
      ['cervical', 30, 9],
      ['elbow', 40, 31],
      ['wrist', 50, 31],
      ['spine', 60, 7],
    ]);
  });

  it('열 124개, 머리글은 서로 다르다', () => {
    expect(BATCH_COLUMNS).toHaveLength(124);
    expect(new Set(BATCH_COLUMNS.map(column => column.header)).size).toBe(124);
  });

  it('order는 서로 다르다', () => {
    const orders = BATCH_COLUMN_SECTIONS.map(section => section.order);
    expect(new Set(orders).size).toBe(orders.length);
  });
});
