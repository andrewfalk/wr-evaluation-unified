// BK2117 해석 판정(P2-61a) — 소견서·EMR·AI 입력이 같이 쓰는 규칙.
import { describe, expect, it } from 'vitest';
import { classifyBk2117Interpretation } from '../../../modules/shoulder/interpretation';

const t = (ratio: number, exceeded = false, label = `항목${ratio}`) => ({ label, ratio, exceeded });

describe('classifyBk2117Interpretation', () => {
  it('기준을 넘은 항목이 있으면 exceeded — 넘은 항목의 라벨을 totals 순서로', () => {
    expect(classifyBk2117Interpretation([t(0.2, false, 'A'), t(1.2, true, '오버헤드'), t(0.9, false, 'B'), t(1, true, '진동')]))
      .toEqual({ kind: 'exceeded', exceededLabels: ['오버헤드', '진동'] });
  });

  it('초과가 없으면 50% 이상 3개 또는 75% 이상 2개가 combinedSufficient', () => {
    expect(classifyBk2117Interpretation([t(0.5), t(0.5), t(0.5), t(0)]).kind).toBe('combinedSufficient');
    expect(classifyBk2117Interpretation([t(0.75), t(0.75), t(0)]).kind).toBe('combinedSufficient');
    expect(classifyBk2117Interpretation([t(0.75), t(0.5), t(0.49)])).toEqual({ kind: 'insufficient', exceededLabels: [] });
    expect(classifyBk2117Interpretation([t(0.74), t(0.74), t(0.49)]).kind).toBe('insufficient');
  });

  it('초과가 복합 노출보다 먼저다', () => {
    expect(classifyBk2117Interpretation([t(0.8), t(0.8), t(0.8), t(1, true, 'X')]).kind).toBe('exceeded');
  });

  it('totals가 없거나 비면 insufficient', () => {
    expect(classifyBk2117Interpretation(undefined)).toEqual({ kind: 'insufficient', exceededLabels: [] });
    expect(classifyBk2117Interpretation(null)).toEqual({ kind: 'insufficient', exceededLabels: [] });
    expect(classifyBk2117Interpretation([])).toEqual({ kind: 'insufficient', exceededLabels: [] });
  });
});
