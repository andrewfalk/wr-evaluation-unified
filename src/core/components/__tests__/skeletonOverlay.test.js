import { describe, it, expect } from 'vitest';
import { scaledKeypoints, COCO17_BONES } from '../SkeletonOverlay.jsx';

const kps = [
  [100, 200, 0.9],
  [300, 400, 0.1],
];

describe('scaledKeypoints (SkeletonOverlay geometry)', () => {
  it('pixel 좌표 → maxWidth 스케일, score 보존', () => {
    const s = scaledKeypoints(kps, { frameWidth: 640, frameHeight: 480, coordinateSpace: 'pixel' }, 320); // scale 0.5
    expect(s.scale).toBe(0.5);
    expect(s.width).toBe(320);
    expect(s.height).toBe(240);
    expect(s.points[0]).toMatchObject({ x: 50, y: 100, score: 0.9 });
    expect(s.points[1]).toMatchObject({ x: 150, y: 200, score: 0.1 });
  });

  it('normalized 좌표 → frame 크기로 환원 후 스케일', () => {
    const norm = [[0.5, 0.5, 1]];
    const s = scaledKeypoints(norm, { frameWidth: 640, frameHeight: 480, coordinateSpace: 'normalized' }, 640); // scale 1
    expect(s.points[0]).toMatchObject({ x: 320, y: 240 });
  });

  it('빈/누락 입력 → 안전한 빈 결과', () => {
    expect(scaledKeypoints(null, { frameWidth: 640 }).points).toEqual([]);
    expect(scaledKeypoints(kps, { frameWidth: 0 }).points).toEqual([]);
  });

  it('COCO17 본 페어는 17점 인덱스 범위 안', () => {
    for (const [a, b] of COCO17_BONES) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(17);
    }
  });
});
