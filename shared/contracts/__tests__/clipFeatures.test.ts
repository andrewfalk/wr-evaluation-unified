import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ClipFeatureSetSchema } from '../clipFeatures';
import { FeatureKeySchema, FeatureUnitSchema } from '../videoAnalysis';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const svc = path.resolve(__dirname, '../../../services/pose-inference');
const fixture = JSON.parse(readFileSync(path.join(svc, 'fixtures/clip_features.sample.json'), 'utf-8'));
const featureConfig = JSON.parse(readFileSync(path.join(svc, 'feature_config.json'), 'utf-8'));

describe('ClipFeatureSetSchema — drift guard', () => {
  it('validates the committed synthetic fixture (feature_calc.py 산출 형태와 동일 계약)', () => {
    const r = ClipFeatureSetSchema.parse(fixture);
    expect(r.featureConfigVersion).toBeTruthy();
    expect(Object.keys(r.features).length).toBeGreaterThan(0);
  });

  it('rejects extra fields (strict)', () => {
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, surprise: 1 })).toThrow();
    const extra = structuredClone(fixture);
    extra.features.squatDuration.surprise = 1;
    expect(() => ClipFeatureSetSchema.parse(extra)).toThrow();
  });

  it('rejects confidence outside 0..1 and unknown metric', () => {
    const badConf = structuredClone(fixture);
    badConf.features.squatDuration.confidence = 1.5;
    expect(() => ClipFeatureSetSchema.parse(badConf)).toThrow();
    const badMetric = structuredClone(fixture);
    badMetric.features.squatDuration.metric = 'made_up';
    expect(() => ClipFeatureSetSchema.parse(badMetric)).toThrow();
  });

  it('rejects a segment with endMs < startMs', () => {
    const bad = structuredClone(fixture);
    bad.features.squatDuration.segments = [{ startMs: 5000, endMs: 1000 }];
    expect(() => ClipFeatureSetSchema.parse(bad)).toThrow();
  });

  it('rejects posture_ratio outside 0..1 (superRefine)', () => {
    const tooBig = structuredClone(fixture);
    tooBig.features.squatDuration.value = 1.5;
    expect(() => ClipFeatureSetSchema.parse(tooBig)).toThrow(/0\.\.1/);
    const neg = structuredClone(fixture);
    neg.features.squatDuration.value = -0.1;
    expect(() => ClipFeatureSetSchema.parse(neg)).toThrow();
  });

  it('rejects an unknown featureKey', () => {
    const bad = structuredClone(fixture);
    bad.features.notAFeature = { kind: 'numeric', metric: 'posture_ratio', value: 0.1, unit: 'ratio', confidence: 0.5 };
    expect(() => ClipFeatureSetSchema.parse(bad)).toThrow();
  });
});

describe('ClipFeatureSetSchema — tracking block (PR D2a, §8.7)', () => {
  it('accepts a valid tracking block (targetTrackId/presenceRatio/trackCount)', () => {
    const r = ClipFeatureSetSchema.parse({ ...fixture, tracking: { targetTrackId: 't1', presenceRatio: 0.92, trackCount: 3 } });
    expect(r.tracking?.targetTrackId).toBe('t1');
    expect(r.tracking?.presenceRatio).toBeCloseTo(0.92, 5);
  });

  it('allows targetTrackId null (fallback) and omitting tracking (PR C 하위호환)', () => {
    expect(ClipFeatureSetSchema.parse({ ...fixture, tracking: { targetTrackId: null, presenceRatio: 0, trackCount: 0 } }).tracking?.targetTrackId).toBeNull();
    expect(ClipFeatureSetSchema.parse(fixture).tracking).toBeUndefined(); // tracking 없는 기존 fixture
  });

  it('rejects presenceRatio outside 0..1 and extra/missing fields (strict)', () => {
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, tracking: { targetTrackId: 't1', presenceRatio: 1.5, trackCount: 1 } })).toThrow();
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, tracking: { targetTrackId: 't1', presenceRatio: -0.1, trackCount: 1 } })).toThrow();
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, tracking: { targetTrackId: 't1', presenceRatio: 0.5, trackCount: 1, surprise: 1 } })).toThrow();
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, tracking: { targetTrackId: 't1', presenceRatio: 0.5 } })).toThrow(); // trackCount 누락
  });
});

describe('feature_config.json ↔ contract cross-check (drift guard)', () => {
  it('all configured feature keys are valid FeatureKeys with valid unit', () => {
    const keys = Object.keys(featureConfig.features);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(FeatureKeySchema.options).toContain(k);
      const f = featureConfig.features[k];
      expect(['numeric', 'boolean', 'categorical']).toContain(f.kind);
      if (f.unit) expect(() => FeatureUnitSchema.parse(f.unit)).not.toThrow();
    }
  });

  it('declares a config version (재현성)', () => {
    expect(typeof featureConfig.version).toBe('string');
    expect(featureConfig.version.length).toBeGreaterThan(0);
  });
});

describe('ClipFeatureSetSchema — confidenceBreakdown + quality (PR D3a, §8.8)', () => {
  const withBreakdown = (bd: unknown) => {
    const c = structuredClone(fixture);
    c.features.squatDuration.confidenceBreakdown = bd;
    return c;
  };
  const validQuality = { blurMetric: { mean: 120, p10: 40, median: 110 }, dropRatio: 0.02, sampledFps: 2 };

  it('accepts a valid confidenceBreakdown (keypoint/visibility + optional tracking/viewpoint/usableFrameRatio)', () => {
    const r = ClipFeatureSetSchema.parse(withBreakdown({ keypoint: 0.9, visibility: 0.8, tracking: 0.95, viewpoint: 1, usableFrameRatio: 0.83 }));
    expect(r.features.squatDuration.confidenceBreakdown?.keypoint).toBeCloseTo(0.9, 5);
  });

  it('allows omitting confidenceBreakdown and its optional components (PR C/D2 하위호환)', () => {
    expect(ClipFeatureSetSchema.parse(fixture).features.squatDuration.confidenceBreakdown).toBeUndefined();
    const r = ClipFeatureSetSchema.parse(withBreakdown({ keypoint: 0.9, visibility: 0.8 }));
    expect(r.features.squatDuration.confidenceBreakdown?.tracking).toBeUndefined();
  });

  it('rejects breakdown out of 0..1, missing required component, or extra field (strict)', () => {
    expect(() => ClipFeatureSetSchema.parse(withBreakdown({ keypoint: 1.2, visibility: 0.8 }))).toThrow();
    expect(() => ClipFeatureSetSchema.parse(withBreakdown({ keypoint: 0.9 }))).toThrow(); // visibility 누락
    expect(() => ClipFeatureSetSchema.parse(withBreakdown({ keypoint: 0.9, visibility: 0.8, surprise: 1 }))).toThrow();
  });

  it('accepts clip-global quality (blurMetric/dropRatio/sampledFps + optional threshold-derived)', () => {
    const r = ClipFeatureSetSchema.parse({ ...fixture, quality: { ...validQuality, blurThreshold: 100, blurRatio: 0.1, usableFrameRatio: 0.88 } });
    expect(r.quality?.blurMetric.median).toBe(110);
  });

  it('allows omitting quality (하위호환) and threshold-derived fields', () => {
    expect(ClipFeatureSetSchema.parse(fixture).quality).toBeUndefined();
    expect(ClipFeatureSetSchema.parse({ ...fixture, quality: validQuality }).quality?.blurRatio).toBeUndefined();
  });

  it('rejects quality ratios out of 0..1, missing blurMetric, or extra field (strict)', () => {
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, quality: { ...validQuality, dropRatio: 1.5 } })).toThrow();
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, quality: { ...validQuality, usableFrameRatio: -0.1 } })).toThrow();
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, quality: { dropRatio: 0.1, sampledFps: 2 } })).toThrow(); // blurMetric 누락
    expect(() => ClipFeatureSetSchema.parse({ ...fixture, quality: { ...validQuality, surprise: 1 } })).toThrow();
  });
});
