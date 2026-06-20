// videoValidateReport.mjs 하네스의 *로직* 검증 — 하네스는 이 모듈들을 Vite SSR로 로드해 wiring만 한다.
// vitest는 @contracts를 소스로 alias하므로 동일 모듈을 직접 import해 fuse→convert→normalize→compare를
// 재현하고, 앱(videoAnalysisRun)과 같은 순서로 같은 값이 나오는지 + 검증 normalization을 단언한다.
import { describe, it, expect } from 'vitest';
import { fuseClipFeatureSetsWithEvidence } from '../videoViewpointFusion.js';
import { convertClipFeaturesToPerDay } from '../videoPerDayConversion.js';
import { compareFeatureMap, summarizeErrors, withinTolerance } from '../videoValidation.js';
import { normalizeForComparison } from '../videoValidationThresholds.js';
import { VIDEO_FEATURE_TARGETS } from '@contracts/index';

function clipSet(features, clipRef = 'clip.mp4') {
  return { schemaVersion: 1, featureConfigVersion: 'fc-test-1', clipRef, clipDurationMs: 60000, analyzedFrames: 300, features };
}
function clipFeature(metric, value, unit, extra = {}) {
  return { kind: 'numeric', metric, value, unit, confidence: 0.8, segments: [], warnings: [], ...extra };
}

// 하네스와 동일한 파이프라인(단일 case): fuse → convert → normalize → compare.
function runCase({ clips, activeMinutesPerDay, activeModules, gold }) {
  const entries = clips.map((c) => ({ viewpoint: c.viewpoint, clipFeatureSet: c.clipFeatureSet }));
  const { fused } = fuseClipFeatureSetsWithEvidence(entries);
  const allowed = activeModules
    ? Object.keys(VIDEO_FEATURE_TARGETS).filter((k) => activeModules.includes(VIDEO_FEATURE_TARGETS[k].moduleId))
    : undefined;
  const conv = convertClipFeaturesToPerDay(fused, activeMinutesPerDay, { allowedFeatureKeys: allowed });
  const normalizedMap = {};
  const skips = [];
  for (const [key, fv] of Object.entries(conv.features)) {
    const norm = normalizeForComparison(key, fv, conv.evidenceByFeatureKey[key] || {});
    if (norm && norm.status) { skips.push({ key, reason: norm.status }); continue; }
    normalizedMap[key] = norm;
  }
  return { normalizedMap, comparisons: compareFeatureMap(normalizedMap, gold), skips, conv };
}

describe('B2 검증 파이프라인 (fuse→convert→normalize→compare)', () => {
  const clips = [{
    viewpoint: 'sagittal',
    clipFeatureSet: clipSet({
      trunkPostureG: clipFeature('peak_angle', 50, 'degrees', { warnings: ['POSTURE_G_MANUAL'] }),
      trunkFlexionOver45Duration: clipFeature('posture_ratio', 0.25, 'ratio'),
    }),
  }];
  const gold = {
    trunkPostureG: { kind: 'numeric', value: 52, unit: 'degrees' },
    trunkFlexionOver45Duration: { kind: 'numeric', value: 95, unit: 'minutes_per_day' },
  };

  it('candidate를 비교가능 numeric으로 정규화(각도 raw, 시간 비율×활동분)', () => {
    const { normalizedMap } = runCase({ clips, activeMinutesPerDay: 360, activeModules: ['spine'], gold });
    expect(normalizedMap.trunkPostureG).toEqual({ kind: 'numeric', value: 50, unit: 'degrees' });
    // 0.25 × 360분 = 90분/일.
    expect(normalizedMap.trunkFlexionOver45Duration).toEqual({ kind: 'numeric', value: 90, unit: 'minutes_per_day' });
  });

  it('gold 대비 MAE/오차율 + §8.9 허용오차 판정', () => {
    const { comparisons } = runCase({ clips, activeMinutesPerDay: 360, activeModules: ['spine'], gold });
    const summaries = summarizeErrors(comparisons);
    const angle = summaries.find((s) => s.featureKey === 'trunkPostureG');
    const time = summaries.find((s) => s.featureKey === 'trunkFlexionOver45Duration');
    expect(angle).toMatchObject({ kind: 'numeric', metric: 'angle', n: 1, mae: 2 });
    expect(time.metric).toBe('time');
    expect(time.meanErrorRate).toBeCloseTo(5 / 95, 6);
    expect(withinTolerance(angle)).toBe(true); // 2° <= 12.5°
    expect(withinTolerance(time)).toBe(true);  // 5.3% <= 20%
  });

  it('활동분 없으면 시간형 candidate는 비교에서 빠짐(no_active_time)', () => {
    const { normalizedMap, skips } = runCase({ clips, activeMinutesPerDay: null, activeModules: ['spine'], gold });
    expect(normalizedMap.trunkFlexionOver45Duration).toBeUndefined();
    expect(skips.find((s) => s.key === 'trunkFlexionOver45Duration').reason).toBe('no_active_time');
    // 각도형은 활동분과 무관하게 비교 가능.
    expect(normalizedMap.trunkPostureG).toEqual({ kind: 'numeric', value: 50, unit: 'degrees' });
  });

  it('다중 시점 융합 후 환산도 동일 파이프라인으로 동작(순서: fuse 먼저)', () => {
    const twoView = [
      clips[0],
      { viewpoint: 'frontal', clipFeatureSet: clipSet({ trunkPostureG: clipFeature('peak_angle', 40, 'degrees') }, 'c2.mp4') },
    ];
    const { normalizedMap } = runCase({ clips: twoView, activeMinutesPerDay: 360, activeModules: ['spine'], gold });
    // 융합이 단일 trunkPostureG로 합쳐져 numeric 정규화까지 도달(에러 없이).
    expect(normalizedMap.trunkPostureG.kind).toBe('numeric');
    expect(normalizedMap.trunkPostureG.unit).toBe('degrees');
  });
});
