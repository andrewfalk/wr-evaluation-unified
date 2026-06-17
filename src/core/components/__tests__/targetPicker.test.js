import { describe, it, expect } from 'vitest';
import { scaledCandidates } from '../TargetPicker.jsx';

const result = {
  frameWidth: 640, frameHeight: 480,
  persons: [
    { id: 'p1', bbox: [10, 20, 100, 200], score: 1 },
    { id: 'p2', bbox: [320, 240, 64, 96], score: 1 },
  ],
};

describe('scaledCandidates (TargetPicker geometry)', () => {
  it('frameWidth → maxWidth로 스케일, 박스 좌표·크기 비례', () => {
    const s = scaledCandidates(result, 320); // scale 0.5
    expect(s.scale).toBe(0.5);
    expect(s.width).toBe(320);
    expect(s.height).toBe(240);
    expect(s.boxes[0]).toMatchObject({ id: 'p1', x: 5, y: 10, w: 50, h: 100 });
    expect(s.boxes[1]).toMatchObject({ id: 'p2', x: 160, y: 120, w: 32, h: 48 });
  });

  it('빈/누락 result → 안전한 빈 결과', () => {
    expect(scaledCandidates(null).boxes).toEqual([]);
    expect(scaledCandidates({ frameWidth: 0, persons: [] }).boxes).toEqual([]);
  });

  it('박스 순서·id 보존(클릭 시 onSelect에 해당 id 전달용)', () => {
    expect(scaledCandidates(result).boxes.map((b) => b.id)).toEqual(['p1', 'p2']);
  });
});
