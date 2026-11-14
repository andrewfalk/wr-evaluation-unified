// 구조 래칫(REFACTORING_ROADMAP Phase 2 P2-01) — Phase 2가 없애는 구조 부채 수가 늘지 않게, 줄면 기준도 내리게 한다.
// 세는 규칙은 scripts/arch-metrics.mjs 머리 주석, 기준은 scripts/arch-baseline.json.
import { describe, expect, it } from 'vitest';
import { computeMetrics, METRICS, readBaseline } from '../../scripts/arch-metrics.mjs';

const { totals, byFile } = computeMetrics();
const baseline = readBaseline().metrics;

describe('architecture ratchet (P2-01)', () => {
  it('baseline covers exactly the measured metrics', () => {
    expect(Object.keys(baseline).sort()).toEqual([...METRICS].sort());
  });

  it.each(METRICS)('%s does not exceed the baseline', (key) => {
    const files = Object.entries(byFile[key]).map(([file, n]) => `${file}: ${n}`).join('\n');
    expect(totals[key], `${key} rose above scripts/arch-baseline.json — remove the new occurrence.\n${files}`)
      .toBeLessThanOrEqual(baseline[key]);
  });

  it.each(METRICS)('%s baseline is lowered when the count goes down', (key) => {
    expect(totals[key], `${key} went down — run \`node scripts/arch-metrics.mjs --lower\` and commit the baseline.`)
      .toBeGreaterThanOrEqual(baseline[key]);
  });
});
