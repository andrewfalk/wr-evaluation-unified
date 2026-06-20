import { describe, it, expect } from 'vitest';
import { fuseClipFeatureSets, fuseClipFeatureSetsWithEvidence, NON_PREFERRED_WARNING, CONFLICT_WARNING } from '../videoViewpointFusion.js';
import { ClipFeatureSetSchema } from '@contracts/index';

const numFeat = (value, confidence, breakdown, warnings = []) => ({
  kind: 'numeric', metric: 'posture_ratio', value, unit: 'ratio', confidence,
  ...(breakdown ? { confidenceBreakdown: breakdown } : {}), segments: [], warnings,
});
const angle = (value, confidence = 0.8) => ({
  kind: 'numeric', metric: 'peak_angle', value, unit: 'degrees', confidence, segments: [], warnings: [],
});
const clipSet = (clipRef, features) => ({
  schemaVersion: 1, featureConfigVersion: 'fc-test', clipRef, clipDurationMs: 10000, analyzedFrames: 50, features,
});
const entry = (viewpoint, features, clipRef = viewpoint) => ({ viewpoint, clipFeatureSet: clipSet(clipRef, features) });

describe('fuseClipFeatureSets (시점 융합 §8.6.1, PR D3b)', () => {
  it('빈 entries → null', () => {
    expect(fuseClipFeatureSets([])).toBeNull();
    expect(fuseClipFeatureSets(null)).toBeNull();
  });

  it('단일 시점: 메타 보존 + viewpoint 성분 breakdown + non-preferred 경고(squatDuration preferred=sagittal)', () => {
    const fused = fuseClipFeatureSets([entry('frontal', { squatDuration: numFeat(0.5, 0.9, { keypoint: 0.9, visibility: 0.9 }) })]);
    expect(() => ClipFeatureSetSchema.parse(fused)).not.toThrow();
    const f = fused.features.squatDuration;
    expect(f.confidenceBreakdown.viewpoint).toBe(0.5);      // frontal = non-preferred
    expect(f.confidence).toBe(0.5);                          // min(0.9, 0.5)
    expect(f.warnings).toContain(NON_PREFERRED_WARNING);
  });

  it('preferred가 non-preferred를 tier로 이김(keypoint 더 높아도)', () => {
    const fused = fuseClipFeatureSets([
      entry('frontal', { squatDuration: numFeat(0.7, 0.95, { keypoint: 0.95, visibility: 0.95 }) }),  // non-preferred, high
      entry('sagittal', { squatDuration: numFeat(0.5, 0.6, { keypoint: 0.6, visibility: 0.6 }) }),     // preferred, lower
    ]);
    const f = fused.features.squatDuration;
    expect(f.value).toBe(0.5);                               // sagittal(preferred) 채택
    expect(f.confidenceBreakdown.viewpoint).toBe(1.0);
    expect(f.confidence).toBe(0.6);                          // min(0.6, 1.0)
    expect(f.warnings).not.toContain(NON_PREFERRED_WARNING);
  });

  it('other/unknown 시점은 known preferred를 못 이김(tier tie-breaker)', () => {
    const fused = fuseClipFeatureSets([
      entry('other', { squatDuration: numFeat(0.7, 0.99, { keypoint: 0.99, visibility: 0.99 }) }),  // other, 매우 높음
      entry('sagittal', { squatDuration: numFeat(0.5, 0.5, { keypoint: 0.5, visibility: 0.5 }) }),   // preferred, 낮음
    ]);
    expect(fused.features.squatDuration.value).toBe(0.5);    // sagittal 채택
  });

  it('trunkFlexionOver45Duration: 측면(sagittal) preferred가 정면을 이김(체간 전굴)', () => {
    const fused = fuseClipFeatureSets([
      entry('frontal', { trunkFlexionOver45Duration: numFeat(0.7, 0.95, { keypoint: 0.95, visibility: 0.95 }) }),
      entry('sagittal', { trunkFlexionOver45Duration: numFeat(0.4, 0.6, { keypoint: 0.6, visibility: 0.6 }) }),
    ]);
    const f = fused.features.trunkFlexionOver45Duration;
    expect(f.value).toBe(0.4);                              // sagittal(preferred) 채택
    expect(f.confidenceBreakdown.viewpoint).toBe(1.0);
    expect(f.warnings).not.toContain(NON_PREFERRED_WARNING);
  });

  it('INTER_VIEW_CONFLICT 기본 비활성(임계값 없음) → 경고 없음', () => {
    const fused = fuseClipFeatureSets([
      entry('sagittal', { trunkPostureG: angle(20) }),
      entry('frontal', { trunkPostureG: angle(60) }),
    ]);
    expect(fused.features.trunkPostureG.warnings).not.toContain(CONFLICT_WARNING);
  });

  it('INTER_VIEW_CONFLICT: 주입 임계값 미만 차이=무경고, 이상=경고', () => {
    const mk = () => ([
      entry('sagittal', { trunkPostureG: angle(20) }),
      entry('frontal', { trunkPostureG: angle(60) }),  // diff 40
    ]);
    const below = fuseClipFeatureSets(mk(), { conflictThresholds: { trunkPostureG: 50 } });
    expect(below.features.trunkPostureG.warnings).not.toContain(CONFLICT_WARNING);
    const above = fuseClipFeatureSets(mk(), { conflictThresholds: { trunkPostureG: 30 } });
    expect(above.features.trunkPostureG.warnings).toContain(CONFLICT_WARNING);
  });

  it('다중 시점 융합 결과는 ClipFeatureSetSchema 통과 + 메타 합성(clipRef join·frames sum)', () => {
    const fused = fuseClipFeatureSets([
      entry('sagittal', { squatDuration: numFeat(0.5, 0.8, { keypoint: 0.8, visibility: 0.8 }) }, 'a'),
      entry('frontal', { overheadHours: numFeat(0.3, 0.7, { keypoint: 0.7, visibility: 0.7 }) }, 'b'),
    ]);
    expect(() => ClipFeatureSetSchema.parse(fused)).not.toThrow();
    expect(fused.clipRef).toBe('a+b');
    expect(fused.analyzedFrames).toBe(100);
    // overheadHours preferred=frontal → frontal에서 vp=1.0
    expect(fused.features.overheadHours.confidenceBreakdown.viewpoint).toBe(1.0);
  });
});

describe('fuseClipFeatureSetsWithEvidence (B2 선행 — 채택 클립/시점 provenance)', () => {
  // evidence용 entry: clipMetaId/serverClipId/jobId 포함.
  const evEntry = (viewpoint, features, meta = {}) => ({
    viewpoint, clipFeatureSet: clipSet(meta.clipMetaId || viewpoint, features), ...meta,
  });

  it('빈 entries → { fused: null, evidenceByFeatureKey: {} }', () => {
    expect(fuseClipFeatureSetsWithEvidence([])).toEqual({ fused: null, evidenceByFeatureKey: {} });
  });

  it('fused 출력은 fuseClipFeatureSets와 동일(winner 계산 공유 — drift 없음)', () => {
    const entries = [
      evEntry('frontal', { squatDuration: numFeat(0.7, 0.95, { keypoint: 0.95, visibility: 0.95 }) }, { clipMetaId: 'c1', jobId: 'j1' }),
      evEntry('sagittal', { squatDuration: numFeat(0.5, 0.6, { keypoint: 0.6, visibility: 0.6 }) }, { clipMetaId: 'c2', jobId: 'j2' }),
    ];
    const plain = fuseClipFeatureSets(entries);
    const withEv = fuseClipFeatureSetsWithEvidence(entries);
    expect(withEv.fused).toEqual(plain);
  });

  it('단일 시점: evidence adopted=그 클립, candidates 1개', () => {
    const r = fuseClipFeatureSetsWithEvidence([
      evEntry('sagittal', { squatDuration: numFeat(0.5, 0.8, { keypoint: 0.8, visibility: 0.8 }) }, { clipMetaId: 'c1', serverClipId: 's1', jobId: 'j1' }),
    ]);
    const ev = r.evidenceByFeatureKey.squatDuration;
    expect(ev.candidates).toHaveLength(1);
    expect(ev.adopted).toMatchObject({ viewpoint: 'sagittal', clipMetaId: 'c1', serverClipId: 's1', jobId: 'j1', adopted: true });
  });

  it('경쟁: adopted=preferred(sagittal) 클립, candidates 2개·tier 반영', () => {
    const r = fuseClipFeatureSetsWithEvidence([
      evEntry('frontal', { squatDuration: numFeat(0.7, 0.95, { keypoint: 0.95, visibility: 0.95 }) }, { clipMetaId: 'cF', jobId: 'jF' }),
      evEntry('sagittal', { squatDuration: numFeat(0.5, 0.6, { keypoint: 0.6, visibility: 0.6 }) }, { clipMetaId: 'cS', jobId: 'jS' }),
    ]);
    const ev = r.evidenceByFeatureKey.squatDuration;
    expect(ev.candidates).toHaveLength(2);
    expect(ev.adopted.clipMetaId).toBe('cS'); // sagittal(preferred) 채택
    const adoptedCand = ev.candidates.find((c) => c.adopted);
    expect(adoptedCand.clipMetaId).toBe('cS');
    expect(ev.candidates.filter((c) => c.adopted)).toHaveLength(1); // 정확히 하나만 채택
  });
});
