// 히스토그램 가로축 경계 라벨 배치(chooseEdgeLabels) — 표시된 라벨끼리 "확정된 정렬 기준의 좌우
// 범위"가 gap 이상 떨어져 있어야 하고, 위치는 균등 간격이 아니라 실제 경계 좌표를 쓴다.
import { describe, expect, it } from 'vitest';
import { chooseEdgeLabels } from '../edgeLabels';

const INNER = 488; // 560 - 56 - 16 (Histogram.jsx의 플롯 안쪽 폭)
const MARGIN_LEFT = 56;
const MARGIN_RIGHT = 16;
const CHAR = 6.5;
const GAP = 8;

function layout(labels, positions) {
  return chooseEdgeLabels({
    positions, labels, innerWidth: INNER, marginLeft: MARGIN_LEFT, marginRight: MARGIN_RIGHT, charWidth: CHAR, gap: GAP,
  });
}

function uniformPositions(n) {
  return Array.from({ length: n }, (_v, i) => (i / (n - 1)) * INNER);
}

// 확정된 정렬 기준으로 각 라벨이 차지하는 좌우 범위.
function ranges(selected, labels, positions) {
  return selected.map(({ index, anchor }) => {
    const x = positions[index];
    const w = labels[index].length * CHAR;
    if (anchor === 'end') return [x - w, x];
    if (anchor === 'start') return [x, x + w];
    return [x - w / 2, x + w / 2];
  });
}

function expectNoOverlap(selected, labels, positions) {
  const r = ranges(selected, labels, positions);
  for (let i = 1; i < r.length; i += 1) expect(r[i][0] - r[i - 1][1]).toBeGreaterThanOrEqual(GAP - 1e-9);
}

function expectInsidePlotMargins(selected, labels, positions) {
  const r = ranges(selected, labels, positions);
  for (const [left, right] of r) {
    expect(left).toBeGreaterThanOrEqual(-MARGIN_LEFT - 1e-9);
    expect(right).toBeLessThanOrEqual(INNER + MARGIN_RIGHT + 1e-9);
  }
}

describe('chooseEdgeLabels', () => {
  it('라벨이 짧으면 모든 경계를 표시한다(구간 6개 → 경계 7개)', () => {
    const labels = ['0', '5', '10', '15', '20', '25', '30'];
    const positions = uniformPositions(7);
    const sel = layout(labels, positions);
    expect(sel.map((s) => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expectNoOverlap(sel, labels, positions);
  });

  it.each([12, 30, 50])('긴 라벨(1,000.5 형식)에서도 구간 %d개일 때 표시된 라벨끼리 겹치지 않고 첫·마지막 경계를 포함한다', (bins) => {
    const labels = Array.from({ length: bins + 1 }, (_v, i) => `${(1000 + i * 0.5).toLocaleString('en-US', { minimumFractionDigits: 1 })}`);
    const positions = uniformPositions(bins + 1);
    const sel = layout(labels, positions);
    expect(sel[0].index).toBe(0);
    expect(sel[sel.length - 1].index).toBe(bins);
    expectNoOverlap(sel, labels, positions);
    expectInsidePlotMargins(sel, labels, positions);
  });

  it('리뷰 반례 고정: 30구간·가로폭 488px·라벨 폭 58.5px — 마지막 라벨이 end로 바뀐 뒤에도 겹치지 않는다', () => {
    // 9자 라벨 × 6.5px = 58.5px. 정렬을 확정하기 전에 간격만 계산하면 마지막 라벨이 end가 되면서
    // 앞 라벨과 약 6.4px 겹친다.
    const labels = Array.from({ length: 31 }, (_v, i) => `1,234.${String(i % 10)}00`);
    expect(labels[0].length * CHAR).toBeCloseTo(58.5, 5);
    const positions = uniformPositions(31);
    const sel = layout(labels, positions);
    expect(sel[sel.length - 1].anchor).toBe('end'); // 오른쪽 여백(16px)보다 반폭(29px)이 커서 end
    expectNoOverlap(sel, labels, positions);
    expectInsidePlotMargins(sel, labels, positions);
  });

  it('마지막 라벨이 오른쪽 여백을 넘으면 end, 짧아서 안 넘으면 middle이다', () => {
    const long = ['0', '10,000.5'];
    const posLong = uniformPositions(2);
    expect(layout(long, posLong).find((s) => s.index === 1).anchor).toBe('end');
    const short = ['0', '10'];
    expect(layout(short, uniformPositions(2)).find((s) => s.index === 1).anchor).toBe('middle');
  });

  it('첫 라벨의 반폭이 왼쪽 여백(56px)을 넘을 만큼 길면 start', () => {
    const labels = ['x'.repeat(20), 'x'.repeat(20)]; // 130px → 반폭 65px > 56px
    const sel = layout(labels, uniformPositions(2));
    expect(sel[0].anchor).toBe('start');
    expectInsidePlotMargins(sel, labels, uniformPositions(2));
  });

  it('리뷰 반례 고정: 간격이 균등하지 않은 경계(1000 ~ 1000+6×2^-43, k=9)에서도 실제 좌표 기준으로 겹침이 없다', () => {
    const lo = 1000;
    const hi = 1000 + 6 * Math.pow(2, -43);
    const k = 9;
    const step = (hi - lo) / k;
    const edges = Array.from({ length: k + 1 }, (_v, i) => (i === k ? hi : i * step + lo));
    const positions = edges.map((e) => ((e - lo) / (hi - lo)) * INNER);
    // 균등 가정(i × binPx)과 실제 위치가 다르다 — i=2에서 108.4px vs 81.3px.
    expect(positions[2]).toBeLessThan((2 / k) * INNER - 20);
    const labels = edges.map((e) => String(e));
    const sel = layout(labels, positions);
    expectNoOverlap(sel, labels, positions);
    expectInsidePlotMargins(sel, labels, positions);
    // 라벨 위치는 렌더링에 쓰는 실제 경계 좌표 그대로다(호출부가 positions[index]를 쓴다).
    for (const { index } of sel) expect(positions[index]).toBe(((edges[index] - lo) / (hi - lo)) * INNER);
  });

  it('경계 좌표가 한쪽에 몰린 입력에서는 균등 간격 가정이면 겹친다 — 실제 좌표 기준으로 솎아야 한다', () => {
    // 경계 6개 중 앞 5개가 0~32px에 몰려 있다. 인덱스 기준 균등 간격(98px)으로 보면 모든 라벨이 떨어져
    // 보이지만 실제 좌표로는 서로 겹친다.
    const labels = ['1000', '1001', '1002', '1003', '1004', '1005'];
    const positions = [0, 8, 16, 24, 32, 488];
    const sel = layout(labels, positions);
    expect(sel.length).toBeLessThan(6);
    expect(sel[0].index).toBe(0);
    expect(sel[sel.length - 1].index).toBe(5);
    expectNoOverlap(sel, labels, positions);
  });

  it('마지막 라벨과 겹치는 앞 정규 라벨만 빼고 나머지는 촘촘하게 유지한다(0, 2, 4, 7 — stride를 늘리지 않음)', () => {
    // 경계 8개(0~7), 라벨 10자(65px), 간격 69.7px: 인접 라벨은 겹치고(4.7px < 8) 2칸 간격은 괜찮다.
    // stride 2는 인덱스 0,2,4,6에 마지막 7을 더하는데 6과 7이 겹친다 → 6만 빼면 [0,2,4,7]이 된다.
    // 앞 라벨을 빼지 않으면 stride를 3, 4로 늘려야 해서 [0,4,7]처럼 라벨이 더 성겨진다.
    const labels = Array.from({ length: 8 }, (_v, i) => `10${i}.00000.0`.slice(0, 10));
    expect(labels[0].length).toBe(10);
    const positions = uniformPositions(8);
    const sel = layout(labels, positions);
    expect(sel.map((s) => s.index)).toEqual([0, 2, 4, 7]);
    expectNoOverlap(sel, labels, positions);
  });

  it('겹침 금지는 예외가 없다 — 라벨 하나가 가로폭의 절반을 넘는 극단에서는 첫 라벨 하나만 반환한다', () => {
    const labels = ['y'.repeat(80), 'y'.repeat(80), 'y'.repeat(80)]; // 520px 라벨
    const positions = uniformPositions(3);
    const sel = layout(labels, positions);
    expect(sel).toEqual([{ index: 0, anchor: 'start' }]);
  });

  it('경계가 하나뿐이면 그 라벨을 반환하고, 없으면 빈 배열이다', () => {
    expect(layout(['5'], [0])).toEqual([{ index: 0, anchor: 'middle' }]);
    expect(layout([], [])).toEqual([]);
  });

  it('균등 간격에서는 stride가 규칙적이다(0, s, 2s … 그리고 마지막)', () => {
    const labels = Array.from({ length: 41 }, (_v, i) => String(i * 10));
    const positions = uniformPositions(41);
    const sel = layout(labels, positions);
    const idx = sel.map((s) => s.index);
    const stride = idx[1] - idx[0];
    expect(stride).toBeGreaterThan(1);
    for (let i = 1; i < idx.length - 1; i += 1) expect(idx[i] - idx[i - 1]).toBe(stride);
    expect(idx[idx.length - 1]).toBe(40);
    expectNoOverlap(sel, labels, positions);
  });

  it('성질 기반: 무작위 라벨 길이·구간 수·불균등 위치에서 표시된 라벨끼리 항상 겹치지 않는다', () => {
    let s = 20261007;
    const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
    for (let t = 0; t < 300; t += 1) {
      const n = 2 + Math.floor(rnd() * 50);
      const len = 1 + Math.floor(rnd() * 14);
      const labels = Array.from({ length: n }, () => 'd'.repeat(len));
      const raw = Array.from({ length: n }, () => rnd());
      raw.sort((a, b) => a - b);
      const positions = raw.map((v) => ((v - raw[0]) / (raw[n - 1] - raw[0] || 1)) * INNER);
      const sel = layout(labels, positions);
      expect(sel.length).toBeGreaterThanOrEqual(1);
      expect(sel[0].index).toBe(0);
      expectNoOverlap(sel, labels, positions);
    }
  });
});
