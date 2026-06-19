import { describe, it, expect } from 'vitest';
import {
  convertClipFeaturesToPerDay,
  buildRecipeVersion,
  VIDEO_MAPPING_CONFIG_VERSION,
} from '../videoPerDayConversion.js';

// 최소 유효 ClipFeatureSet 생성 헬퍼(ClipFeatureSetSchema 통과용).
function clipSet(features) {
  return {
    schemaVersion: 1,
    featureConfigVersion: 'fc-test-1',
    clipRef: 'clip.mp4',
    clipDurationMs: 60000,
    analyzedFrames: 300,
    features,
  };
}
const ratio = (value, conf = 0.8) => ({
  kind: 'numeric', metric: 'posture_ratio', value, unit: 'ratio', confidence: conf, segments: [], warnings: [],
});

describe('convertClipFeaturesToPerDay', () => {
  it('posture_ratio → minutes_per_day (squatDuration)', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: ratio(0.5) }), 200);
    expect(r.features.squatDuration).toMatchObject({
      kind: 'numeric', unit: 'minutes_per_day', value: 100, autoSuggestAllowed: true, requiresManualReview: false,
    });
    expect(r.features.squatDuration.confidence).toBe(0.8);
    expect(r.missingActiveTime).toEqual([]);
  });

  it('posture_ratio → hours_per_day (overheadHours)', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ overheadHours: ratio(0.25) }), 240);
    expect(r.features.overheadHours).toMatchObject({ kind: 'numeric', unit: 'hours_per_day', value: 1 });
  });

  it('activeMinutesPerDay == null → per-day feature 누락 + missingActiveTime (0 오적용 방지)', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: ratio(0.5), overheadHours: ratio(0.3) }), null);
    expect(r.features.squatDuration).toBeUndefined();
    expect(r.features.overheadHours).toBeUndefined();
    expect(r.missingActiveTime.sort()).toEqual(['overheadHours', 'squatDuration']);
  });

  it('undefined도 null과 동일하게 누락 처리', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: ratio(0.5) }), undefined);
    expect(r.missingActiveTime).toEqual(['squatDuration']);
  });

  it('activeMinutesPerDay === 0 → value 0, 적용 가능(모름과 구분)', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: ratio(0.5) }), 0);
    expect(r.features.squatDuration).toMatchObject({ kind: 'numeric', value: 0, unit: 'minutes_per_day' });
    expect(r.missingActiveTime).toEqual([]);
  });

  it('candidate(trunkPostureG, peak_angle) → 활동시간 없이 통과, autoSuggest 금지', () => {
    const cf = clipSet({
      trunkPostureG: { kind: 'numeric', metric: 'peak_angle', value: 47.2, unit: 'degrees', confidence: 0.6, segments: [], warnings: ['POSTURE_G_MANUAL'] },
    });
    const r = convertClipFeaturesToPerDay(cf, null);
    expect(r.features.trunkPostureG).toMatchObject({
      kind: 'candidate', value: 47.2, autoSuggestAllowed: false, requiresManualReview: true,
    });
    expect(r.features.trunkPostureG.reason).toBeTruthy();
    expect(r.missingActiveTime).toEqual([]); // candidate는 활동시간 무관
  });

  it('categorical clip feature(neckForcedFlexion, auto-review) → categorical 통과 + 수기확인', () => {
    const cf = clipSet({ neckForcedFlexion: { kind: 'categorical', value: 'forward_flexion', confidence: 0.7, warnings: [] } });
    const r = convertClipFeaturesToPerDay(cf, 200);
    expect(r.features.neckForcedFlexion).toMatchObject({
      kind: 'categorical', value: 'forward_flexion', autoSuggestAllowed: true, requiresManualReview: true,
    });
  });

  it('config 버전·featureConfigVersion 노출 + recipe 결합', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: ratio(0.4) }), 100);
    expect(r.mappingConfigVersion).toBe(VIDEO_MAPPING_CONFIG_VERSION);
    expect(r.featureConfigVersion).toBe('fc-test-1');
    expect(buildRecipeVersion('fc-test-1')).toContain(VIDEO_MAPPING_CONFIG_VERSION);
  });

  it('invalid ClipFeatureSet → throw(신뢰 경계 재검증)', () => {
    expect(() => convertClipFeaturesToPerDay({ schemaVersion: 1, features: {} }, 100)).toThrow();
  });

  it('allowedFeatureKeys 지정 시 무관 키 제외(활성 모듈 필터 — 고정 feature set 정리)', () => {
    const cf = clipSet({
      squatDuration: ratio(0.5),
      trunkPostureG: { kind: 'numeric', metric: 'peak_angle', value: 40, unit: 'degrees', confidence: 0.6, segments: [], warnings: [] },
    });
    // 무릎만 활성 → squatDuration만, spine candidate(trunkPostureG)는 제외
    const r = convertClipFeaturesToPerDay(cf, 200, { allowedFeatureKeys: ['squatDuration', 'suspectedKneeTwist'] });
    expect(r.features.squatDuration).toBeDefined();
    expect(r.features.trunkPostureG).toBeUndefined();
  });
});

describe('convertClipFeaturesToPerDay — confidence 게이팅 (PR D3a, §8.8)', () => {
  const withBreakdown = (value, confidence, breakdown, warnings = []) => ({
    kind: 'numeric', metric: 'posture_ratio', value, unit: 'ratio', confidence,
    confidenceBreakdown: breakdown, segments: [], warnings,
  });

  it('기본(threshold 없음) → 게이팅 없음: autoSuggestAllowed 유지·LOW_CONFIDENCE 없음(하위호환)', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: withBreakdown(0.5, 0.4, { keypoint: 0.4, visibility: 0.5 }) }), 200);
    expect(r.features.squatDuration.autoSuggestAllowed).toBe(true);
    expect(r.features.squatDuration.warnings).toEqual([]);
  });

  it('주입 threshold(overall) 미만 → autoSuggestAllowed=false + LOW_CONFIDENCE_OVERALL', () => {
    const r = convertClipFeaturesToPerDay(
      clipSet({ squatDuration: withBreakdown(0.5, 0.6, { keypoint: 0.6, visibility: 0.9 }) }),
      200, { confidenceThresholds: { squatDuration: { overall: 0.7 } } },
    );
    expect(r.features.squatDuration.autoSuggestAllowed).toBe(false);
    expect(r.features.squatDuration.warnings).toContain('LOW_CONFIDENCE_OVERALL');
  });

  it('성분 threshold(visibility) 미만 → 차단(breakdown 기준)', () => {
    const r = convertClipFeaturesToPerDay(
      clipSet({ squatDuration: withBreakdown(0.5, 0.9, { keypoint: 0.9, visibility: 0.5 }) }),
      200, { confidenceThresholds: { squatDuration: { visibility: 0.65 } } },
    );
    expect(r.features.squatDuration.autoSuggestAllowed).toBe(false);
    expect(r.features.squatDuration.warnings).toContain('LOW_CONFIDENCE_VISIBILITY');
  });

  it('threshold 있어도 모든 성분 충족 → 차단 안 함', () => {
    const r = convertClipFeaturesToPerDay(
      clipSet({ squatDuration: withBreakdown(0.5, 0.9, { keypoint: 0.9, visibility: 0.9 }) }),
      200, { confidenceThresholds: { squatDuration: { overall: 0.7, visibility: 0.65 } } },
    );
    expect(r.features.squatDuration.autoSuggestAllowed).toBe(true);
    expect(r.features.squatDuration.warnings).toEqual([]);
  });

  it('게이팅 사유는 기존 warnings에 합쳐짐(union)', () => {
    const r = convertClipFeaturesToPerDay(
      clipSet({ squatDuration: withBreakdown(0.5, 0.6, { keypoint: 0.6, visibility: 0.9 }, ['TARGET_TRACK_LOST']) }),
      200, { confidenceThresholds: { squatDuration: { overall: 0.7 } } },
    );
    expect(r.features.squatDuration.warnings).toEqual(['TARGET_TRACK_LOST', 'LOW_CONFIDENCE_OVERALL']);
  });
});

describe('convertClipFeaturesToPerDay — evidence sidecar (B2 선행 근거 패널)', () => {
  const withBreakdown = (value, confidence, breakdown, warnings = []) => ({
    kind: 'numeric', metric: 'posture_ratio', value, unit: 'ratio', confidence,
    confidenceBreakdown: breakdown, segments: [], warnings,
  });

  it('numeric ratio → evidence에 intrinsicValue·intrinsicMetric·activeMinutesPerDay 운반(환산식 근거)', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: ratio(0.35) }), 360);
    expect(r.evidenceByFeatureKey.squatDuration).toMatchObject({
      intrinsicValue: 0.35, intrinsicMetric: 'posture_ratio', activeMinutesPerDay: 360,
    });
  });

  it('feature 객체에는 evidence 키가 절대 누출되지 않음(영속화 회귀 — shared 저장 안전)', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: withBreakdown(0.5, 0.8, { keypoint: 0.8, visibility: 0.9 }) }), 200);
    const f = r.features.squatDuration;
    for (const leaked of ['intrinsicValue', 'intrinsicMetric', 'activeMinutesPerDay', 'confidenceBreakdown', 'segments', 'evidence', 'trace']) {
      expect(f).not.toHaveProperty(leaked);
    }
    // evidence map에는 breakdown이 보존됨
    expect(r.evidenceByFeatureKey.squatDuration.confidenceBreakdown).toEqual({ keypoint: 0.8, visibility: 0.9 });
  });

  it('breakdown/segments 없는 출력 → evidence는 graceful degrade(해당 키 생략)', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: ratio(0.5) }), 200);
    const ev = r.evidenceByFeatureKey.squatDuration;
    expect(ev).not.toHaveProperty('confidenceBreakdown');
    expect(ev.intrinsicValue).toBe(0.5);
  });

  it('candidate도 evidence 운반(intrinsicValue=각도)', () => {
    const cf = clipSet({ trunkPostureG: { kind: 'numeric', metric: 'peak_angle', value: 47.2, unit: 'degrees', confidence: 0.6, segments: [], warnings: [] } });
    const r = convertClipFeaturesToPerDay(cf, null);
    expect(r.evidenceByFeatureKey.trunkPostureG).toMatchObject({ intrinsicValue: 47.2, intrinsicMetric: 'peak_angle' });
  });

  it('활동시간 누락(missingActiveTime)인 numeric은 feature·evidence 둘 다 미생성', () => {
    const r = convertClipFeaturesToPerDay(clipSet({ squatDuration: ratio(0.5) }), null);
    expect(r.features.squatDuration).toBeUndefined();
    expect(r.evidenceByFeatureKey.squatDuration).toBeUndefined();
  });
});
