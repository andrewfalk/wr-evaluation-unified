import { describe, it, expect } from 'vitest';
import { scaledKeypoints, COCO17_BONES, frameActive, activeFrameIndices } from '../SkeletonOverlay.jsx';

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

describe('frameActive / activeFrameIndices (자세 활성 프레임 하이라이트)', () => {
  const durSeg = [{ startMs: 2000, endMs: 6000 }];
  const peakSeg = [{ startMs: 3000, endMs: 3000 }]; // peak 변수 점-세그먼트

  it('지속 구간: 구간 안 프레임만 active', () => {
    expect(frameActive(1999, durSeg)).toBe(false);
    expect(frameActive(2000, durSeg)).toBe(true);  // 경계 포함
    expect(frameActive(6000, durSeg)).toBe(true);
    expect(frameActive(6001, durSeg)).toBe(false);
  });

  it('peak 점-세그먼트: 정확히 그 프레임만 active', () => {
    expect(frameActive(3000, peakSeg)).toBe(true);
    expect(frameActive(2999, peakSeg)).toBe(false);
    expect(frameActive(3001, peakSeg)).toBe(false);
  });

  it('segments 없음/널 → 항상 false', () => {
    expect(frameActive(3000, [])).toBe(false);
    expect(frameActive(3000, undefined)).toBe(false);
    expect(frameActive(null, durSeg)).toBe(false);
  });

  it('activeFrameIndices: 활성 프레임 인덱스 목록', () => {
    const frames = [{ timestampMs: 1000 }, { timestampMs: 3000 }, { timestampMs: 5000 }, { timestampMs: 7000 }];
    expect(activeFrameIndices(frames, durSeg)).toEqual([1, 2]); // 3000·5000 ∈ [2000,6000]
    expect(activeFrameIndices(frames, peakSeg)).toEqual([1]);   // 3000만
    expect(activeFrameIndices(frames, [])).toEqual([]);
  });
});
