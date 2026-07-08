import { describe, it, expect } from 'vitest';
import {
  FeatureKeySchema,
  FeatureUnitSchema,
  VideoFeatureValueSchema,
  CandidateFeatureValueSchema,
  VideoFeatureMapSchema,
  VideoJobStatusSchema,
  ConfidenceSchema,
  AppliedInputSchema,
  VideoAnalysisDataSchema,
  VideoProcessSchema,
  ProcessFeaturesSchema,
  resolveAnalysisJobIds,
  SampleDetectResultSchema,
  VIDEO_FEATURE_TARGETS,
} from '../videoAnalysis';
import { SharedDataSchema } from '../patient';

const baseNumeric = {
  kind: 'numeric' as const,
  value: 1.8,
  unit: 'hours_per_day' as const,
  confidence: 0.82,
  autoSuggestAllowed: true,
  requiresManualReview: false,
  warnings: [],
};

describe('VideoFeatureValueSchema (discriminatedUnion)', () => {
  it('parses a numeric feature', () => {
    const r = VideoFeatureValueSchema.parse(baseNumeric);
    expect(r.kind).toBe('numeric');
    if (r.kind === 'numeric') expect(r.value).toBe(1.8);
  });

  it('parses a boolean feature', () => {
    const r = VideoFeatureValueSchema.parse({
      kind: 'boolean',
      value: true,
      confidence: 0.7,
      autoSuggestAllowed: false,
      requiresManualReview: true,
      warnings: ['PARTIAL_OCCLUSION'],
    });
    expect(r.kind).toBe('boolean');
  });

  it('parses a categorical feature with allowedValues', () => {
    const r = VideoFeatureValueSchema.parse({
      kind: 'categorical',
      value: 'G3',
      allowedValues: ['G1', 'G2', 'G3'],
      confidence: 0.6,
      autoSuggestAllowed: false,
      requiresManualReview: true,
      warnings: [],
    });
    expect(r.kind).toBe('categorical');
  });

  it('rejects an unknown kind', () => {
    expect(() =>
      VideoFeatureValueSchema.parse({ ...baseNumeric, kind: 'weird' })
    ).toThrow();
  });

  it('rejects numeric value with an invalid unit', () => {
    expect(() =>
      VideoFeatureValueSchema.parse({ ...baseNumeric, unit: 'furlongs' })
    ).toThrow();
  });

  it('rejects confidence outside 0..1', () => {
    expect(() =>
      VideoFeatureValueSchema.parse({ ...baseNumeric, confidence: 1.5 })
    ).toThrow();
  });
});

describe('CandidateFeatureValueSchema invariants (§8.4)', () => {
  const candidate = {
    kind: 'candidate' as const,
    value: { tool: 'impact_wrench', minutes: 40 },
    reason: 'vibration intensity not measurable from video',
    confidence: 0.5,
    autoSuggestAllowed: false as const,
    requiresManualReview: true as const,
    warnings: [],
  };

  it('parses a valid candidate', () => {
    const r = CandidateFeatureValueSchema.parse(candidate);
    expect(r.autoSuggestAllowed).toBe(false);
    expect(r.requiresManualReview).toBe(true);
  });

  it('rejects candidate with autoSuggestAllowed:true (schema-level enforcement)', () => {
    expect(() =>
      CandidateFeatureValueSchema.parse({ ...candidate, autoSuggestAllowed: true })
    ).toThrow();
  });

  it('rejects candidate with requiresManualReview:false (schema-level enforcement)', () => {
    expect(() =>
      CandidateFeatureValueSchema.parse({ ...candidate, requiresManualReview: false })
    ).toThrow();
  });

  it('rejects candidate with a non-JSON value', () => {
    expect(() =>
      CandidateFeatureValueSchema.parse({ ...candidate, value: () => 1 })
    ).toThrow();
  });
});

describe('VideoFeatureMapSchema', () => {
  it('parses a partial map keyed by FeatureKey', () => {
    const r = VideoFeatureMapSchema.parse({
      overheadHours: baseNumeric,
      squatDuration: { ...baseNumeric, unit: 'minutes_per_day' },
    });
    expect(Object.keys(r)).toHaveLength(2);
  });

  it('rejects an unknown feature key', () => {
    expect(() => VideoFeatureMapSchema.parse({ notAFeature: baseNumeric })).toThrow();
  });
});

describe('VideoJobStatusSchema (§8.5 state machine)', () => {
  it('accepts the documented states', () => {
    for (const s of [
      'uploaded',
      'sample_detecting',
      'awaiting_target_selection',
      'target_selected',
      'queued',
      'processing',
      'review_pending',
      'done',
      'error',
      'expired',
      'cancelled',
    ]) {
      expect(VideoJobStatusSchema.parse(s)).toBe(s);
    }
  });

  it('rejects an undocumented state', () => {
    expect(() => VideoJobStatusSchema.parse('applied')).toThrow();
  });
});

describe('ConfidenceSchema (§8.8)', () => {
  it('requires overall, defaults warnings, allows optional components', () => {
    const r = ConfidenceSchema.parse({ overall: 0.82 });
    expect(r.overall).toBe(0.82);
    expect(r.warnings).toEqual([]);
  });

  it('rejects missing overall', () => {
    expect(() => ConfidenceSchema.parse({ keypoint: 0.8 })).toThrow();
  });
});

describe('AppliedInputSchema (§8.11 provenance)', () => {
  it('parses a full provenance record', () => {
    const r = AppliedInputSchema.parse({
      moduleId: 'shoulder',
      targetPath: 'modules.shoulder.jobExtras[sharedJobId=x].overheadHours',
      suggestedValue: 1.8,
      appliedValue: 2.0,
      previousValue: null,
      unit: 'hours_per_day',
      source: 'video',
      confidence: 0.82,
      analysisBundleVersion: 'rtmpose-2026-06-a',
      appliedAt: '2026-06-15T00:00:00.000Z',
      appliedBy: 'doctor01',
    });
    expect(r.processIds).toEqual([]);
    expect(r.source).toBe('video');
  });

  it('rejects a non-video source', () => {
    expect(() =>
      AppliedInputSchema.parse({
        moduleId: 'shoulder',
        targetPath: 'x',
        suggestedValue: 1,
        appliedValue: 1,
        previousValue: null,
        unit: null,
        source: 'manual',
        confidence: 0.5,
        analysisBundleVersion: 'v',
        appliedAt: '',
        appliedBy: '',
      })
    ).toThrow();
  });
});

describe('PR D1 fields — activeMinutesPerDay / analysisJobIds / ProcessFeatures.jobId', () => {
  it('VideoProcessSchema: activeMinutesPerDay nullable·optional·범위', () => {
    expect(VideoProcessSchema.parse({ id: 'p', sharedJobId: 'j', name: 'n', activeMinutesPerDay: 200 }).activeMinutesPerDay).toBe(200);
    expect(VideoProcessSchema.parse({ id: 'p', sharedJobId: 'j', name: 'n', activeMinutesPerDay: null }).activeMinutesPerDay).toBeNull();
    // 미입력(하위호환): 필드 없이도 통과
    expect(VideoProcessSchema.parse({ id: 'p', sharedJobId: 'j', name: 'n' }).shiftSharePercent).toBe(0);
    expect(() => VideoProcessSchema.parse({ id: 'p', sharedJobId: 'j', name: 'n', activeMinutesPerDay: 1441 })).toThrow();
    expect(() => VideoProcessSchema.parse({ id: 'p', sharedJobId: 'j', name: 'n', activeMinutesPerDay: -1 })).toThrow();
  });

  it('AppliedInputSchema: analysisJobIds 기본 []', () => {
    const r = AppliedInputSchema.parse({
      moduleId: 'shoulder', targetPath: 'x', suggestedValue: 1, appliedValue: 1, previousValue: null,
      unit: null, source: 'video', confidence: 0.5, analysisBundleVersion: 'v', appliedAt: '', appliedBy: '',
    });
    expect(r.analysisJobIds).toEqual([]);
    const r2 = AppliedInputSchema.parse({
      moduleId: 'shoulder', targetPath: 'x', suggestedValue: 1, appliedValue: 1, previousValue: null,
      unit: null, source: 'video', confidence: 0.5, analysisBundleVersion: 'v', appliedAt: '', appliedBy: '',
      analysisJobIds: ['job-a', 'job-b'],
    });
    expect(r2.analysisJobIds).toEqual(['job-a', 'job-b']);
  });

  it('ProcessFeaturesSchema: jobId optional', () => {
    expect(ProcessFeaturesSchema.parse({ processId: 'p', features: {} }).jobId).toBeUndefined();
    expect(ProcessFeaturesSchema.parse({ processId: 'p', jobId: 'job-1', features: {} }).jobId).toBe('job-1');
  });

  it('ProcessFeaturesSchema: analysisJobIds[] optional (D3b 다중 시점 융합)', () => {
    expect(ProcessFeaturesSchema.parse({ processId: 'p', analysisJobIds: ['a', 'b'], features: {} }).analysisJobIds).toEqual(['a', 'b']);
    expect(ProcessFeaturesSchema.parse({ processId: 'p', features: {} }).analysisJobIds).toBeUndefined();
  });

  it('resolveAnalysisJobIds: 정규화 — analysisJobIds 우선, 빈배열/undefined jobId에 [undefined] 방지 (D3b)', () => {
    expect(resolveAnalysisJobIds({ analysisJobIds: ['a', 'b'], jobId: 'x' })).toEqual(['a', 'b']); // 배열 우선
    expect(resolveAnalysisJobIds({ analysisJobIds: [], jobId: 'x' })).toEqual(['x']);              // 빈배열 → jobId 폴백
    expect(resolveAnalysisJobIds({ jobId: 'x' })).toEqual(['x']);                                  // 폴백
    expect(resolveAnalysisJobIds({})).toEqual([]);                                                 // 둘 다 없음 → [] ([undefined] 아님)
    expect(resolveAnalysisJobIds(null)).toEqual([]);
  });
});

describe('SampleDetectResultSchema (§8.7, PR D2b)', () => {
  const valid = {
    schemaVersion: 1, frameIndex: 100, timestampMs: 8000, frameWidth: 640, frameHeight: 480,
    persons: [{ id: 'p1', bbox: [10, 20, 100, 200], score: 0.9 }],
  };
  it('parses a valid sample-detect result', () => {
    expect(SampleDetectResultSchema.parse(valid).persons[0].id).toBe('p1');
  });
  it('rejects bbox length ≠ 4, score>1, missing fields, extra fields', () => {
    expect(() => SampleDetectResultSchema.parse({ ...valid, persons: [{ id: 'p1', bbox: [1, 2, 3], score: 0.5 }] })).toThrow();
    expect(() => SampleDetectResultSchema.parse({ ...valid, persons: [{ id: 'p1', bbox: [1, 2, 3, 4], score: 1.5 }] })).toThrow();
    expect(() => SampleDetectResultSchema.parse({ ...valid, frameWidth: 0 })).toThrow();
    expect(() => SampleDetectResultSchema.parse({ ...valid, surprise: 1 })).toThrow();
  });
  it('rejects negative bbox values (Python clamps to nonnegative)', () => {
    expect(() => SampleDetectResultSchema.parse({ ...valid, persons: [{ id: 'p1', bbox: [-1, 20, 100, 200], score: 0.9 }] })).toThrow();
    expect(() => SampleDetectResultSchema.parse({ ...valid, persons: [{ id: 'p1', bbox: [10, 20, -5, 200], score: 0.9 }] })).toThrow();
  });
});

describe('VideoAnalysisDataSchema (§8.11)', () => {
  it('fills defaults for an empty object', () => {
    const r = VideoAnalysisDataSchema.parse({});
    expect(r.processes).toEqual([]);
    expect(r.appliedInputs).toEqual([]);
    expect(r.settings.retentionMode).toBe('privacy_first');
  });

  it('6.0-17: processFeatureAggregationMode는 optional — 구 데이터(필드 부재)도 통과(undefined)', () => {
    const r = VideoAnalysisDataSchema.parse({});
    expect(r.processFeatureAggregationMode).toBeUndefined();
  });

  it('6.0-17: processFeatureAggregationMode는 shareWeighted|absolutePerDay만 허용', () => {
    expect(VideoAnalysisDataSchema.parse({ processFeatureAggregationMode: 'shareWeighted' }).processFeatureAggregationMode).toBe('shareWeighted');
    expect(VideoAnalysisDataSchema.parse({ processFeatureAggregationMode: 'absolutePerDay' }).processFeatureAggregationMode).toBe('absolutePerDay');
    expect(() => VideoAnalysisDataSchema.parse({ processFeatureAggregationMode: 'other' })).toThrow();
  });

  it('6.0-17: JSON 직렬화 왕복(저장→리로드 재현) 후에도 processFeatureAggregationMode·processFeatures가 그대로 보존된다', () => {
    // 실제 저장 경로(로컬스토리지/서버 JSONB)는 JSON.stringify → 나중에 JSON.parse → 스키마 재검증이라,
    // 이 왕복이 6.0-17 신규 필드에 값 유실을 일으키지 않는지가 "리로드 후 영속" 요구의 핵심 리스크다.
    const original = VideoAnalysisDataSchema.parse({
      processes: [{ id: 'p1', sharedJobId: 'j1', name: '공정1', shiftSharePercent: 60 }],
      processFeatures: [{ processId: 'p1', features: { overheadHours: {
        kind: 'numeric', value: 1.8, unit: 'hours_per_day', confidence: 0.82,
        autoSuggestAllowed: true, requiresManualReview: false, warnings: [],
      } } }],
      processFeatureAggregationMode: 'shareWeighted',
    });
    const roundTripped = VideoAnalysisDataSchema.parse(JSON.parse(JSON.stringify(original)));
    expect(roundTripped.processFeatureAggregationMode).toBe('shareWeighted');
    expect(roundTripped.processFeatures[0].features.overheadHours.value).toBe(1.8);
  });
});

describe('VIDEO_FEATURE_TARGETS ↔ FeatureKey consistency (§8.10.2-1)', () => {
  it('covers exactly the FeatureKey enum, no more no less', () => {
    const keys = Object.keys(VIDEO_FEATURE_TARGETS).sort();
    const enumKeys = [...FeatureKeySchema.options].sort();
    expect(keys).toEqual(enumKeys);
  });

  it('uses valid units (or null) and consistent candidate mode', () => {
    for (const [key, t] of Object.entries(VIDEO_FEATURE_TARGETS)) {
      if (t.unit !== null) expect(() => FeatureUnitSchema.parse(t.unit)).not.toThrow();
      // candidate mode → 모듈 필드 미기입(targetField null)
      if (t.mode === 'candidate') expect(t.targetField).toBeNull();
      // 비-candidate → 실제 필드 지정
      if (t.mode !== 'candidate') expect(typeof t.targetField).toBe('string');
      expect(['knee', 'shoulder', 'spine', 'cervical', 'elbow', 'wrist']).toContain(t.moduleId);
      expect(key.length).toBeGreaterThan(0);
    }
  });
});

describe('SharedDataSchema videoAnalysis extension', () => {
  const base = {
    patientNo: '', name: '', gender: '', height: '', weight: '',
    birthDate: '', injuryDate: '', hospitalName: '', department: '',
    doctorName: '', evaluationDate: '', medicalRecord: '',
    highBloodPressure: '', diabetes: '', visitHistory: '',
    consultReplyOrtho: '', consultReplyNeuro: '', consultReplyRehab: '',
    consultReplyOther: '', specialNotes: '', diagnoses: [], jobs: [],
  };

  it('parses shared data WITHOUT videoAnalysis (legacy file compat)', () => {
    const r = SharedDataSchema.parse(base);
    expect(r.videoAnalysis).toBeUndefined();
  });

  it('parses shared data WITH videoAnalysis', () => {
    const r = SharedDataSchema.parse({ ...base, videoAnalysis: {} });
    expect(r.videoAnalysis?.settings.retentionMode).toBe('privacy_first');
  });
});
