// niceNumber(value, round=true) — 서버 권한자 원본 히스토그램의 폭 선택(server/src/statsChartDisclosure.ts
// roundToNiceWidth)이 같은 임계값(가수 < 1.5 → 1, < 3 → 2, < 7 → 5, 그 외 10)을 쓰는지 고정한다.
// server/src/__tests__/statsNiceHistogram.test.ts의 "roundToNiceWidth" 표와 같은 값이다 — 한쪽만 바꾸면
// 여기서 또는 서버 테스트에서 실패한다. 임계값(1.5·3·7) 자체는 부동소수점 오차로 흔들려 표본에서 제외했다.
import { describe, expect, it } from 'vitest';
import { niceNumber } from '../scales';

describe('niceNumber(round=true) — 서버 roundToNiceWidth와 같은 표', () => {
  const table = [
    [0.012, 0.01], [0.026, 0.02], [0.04, 0.05], [0.14, 0.1], [0.26, 0.2], [0.55, 0.5], [0.9, 1],
    [1.2, 1], [1.4, 1], [2.9, 2], [3.5, 5], [6.9, 5], [7.5, 10], [14, 10], [26, 20], [55, 50], [95, 100],
  ];
  it.each(table)('%d → %d', (x, expected) => {
    expect(niceNumber(x, true)).toBeCloseTo(expected, 12);
  });

  it('0이면 0(기존 동작 유지)', () => {
    expect(niceNumber(0, true)).toBe(0);
  });
});
