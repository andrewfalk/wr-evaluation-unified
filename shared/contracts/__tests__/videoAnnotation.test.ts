import { describe, it, expect } from 'vitest';
import {
  AnnotationValueSchema,
  GoldStandardAnnotationSchema,
  AnnotationSetSchema,
} from '../videoAnnotation';

describe('AnnotationValueSchema', () => {
  it('parses numeric/boolean/categorical', () => {
    expect(AnnotationValueSchema.parse({ kind: 'numeric', value: 2, unit: 'hours_per_day' }).kind).toBe('numeric');
    expect(AnnotationValueSchema.parse({ kind: 'boolean', value: true }).kind).toBe('boolean');
    expect(AnnotationValueSchema.parse({ kind: 'categorical', value: 'G3' }).kind).toBe('categorical');
  });

  it('rejects numeric without unit / unknown kind', () => {
    expect(() => AnnotationValueSchema.parse({ kind: 'numeric', value: 2 })).toThrow();
    expect(() => AnnotationValueSchema.parse({ kind: 'weird', value: 1 })).toThrow();
  });

  it('rejects an unknown unit', () => {
    expect(() => AnnotationValueSchema.parse({ kind: 'numeric', value: 2, unit: 'furlongs' })).toThrow();
  });
});

describe('GoldStandardAnnotationSchema', () => {
  const base = {
    id: 'a1', videoRef: 'clip-001', annotator: 'doctor01', annotatedAt: '2026-06-16T00:00:00.000Z',
    features: { overheadHours: { kind: 'numeric', value: 2.0, unit: 'hours_per_day' } },
  };

  it('parses with defaults for stratification/segments', () => {
    const r = GoldStandardAnnotationSchema.parse(base);
    expect(r.stratification).toEqual({});
    expect(r.segments).toEqual([]);
  });

  it('accepts stratification + segments/events', () => {
    const r = GoldStandardAnnotationSchema.parse({
      ...base,
      stratification: { viewpoint: 'sagittal', occlusionLevel: 'partial', multiplePeople: true },
      segments: [{ featureKey: 'overheadHours', kind: 'posture', startMs: 1000, endMs: 5000 }],
    });
    expect(r.stratification.viewpoint).toBe('sagittal');
    expect(r.segments[0].featureKey).toBe('overheadHours');
  });

  it('rejects an unknown feature key in features map', () => {
    expect(() => GoldStandardAnnotationSchema.parse({ ...base, features: { notAFeature: { kind: 'boolean', value: true } } })).toThrow();
  });

  it('rejects an invalid stratification enum', () => {
    expect(() => GoldStandardAnnotationSchema.parse({ ...base, stratification: { viewpoint: 'diagonal' } })).toThrow();
  });

  it('rejects a segment with endMs < startMs (negative-length)', () => {
    expect(() => GoldStandardAnnotationSchema.parse({
      ...base, segments: [{ featureKey: 'overheadHours', startMs: 5000, endMs: 1000 }],
    })).toThrow();
  });

  it('rejects empty/non-datetime annotatedAt (traceability)', () => {
    expect(() => GoldStandardAnnotationSchema.parse({ ...base, annotatedAt: '' })).toThrow();
    expect(() => GoldStandardAnnotationSchema.parse({ ...base, annotatedAt: 'yesterday' })).toThrow();
  });

  it('rejects empty id/videoRef/annotator', () => {
    expect(() => GoldStandardAnnotationSchema.parse({ ...base, id: '' })).toThrow();
    expect(() => GoldStandardAnnotationSchema.parse({ ...base, videoRef: '' })).toThrow();
  });
});

describe('AnnotationSetSchema', () => {
  it('parses a versioned set', () => {
    const r = AnnotationSetSchema.parse({
      version: 1,
      annotations: [{
        id: 'a1', videoRef: 'c1', annotator: 'd', annotatedAt: '2026-06-16T00:00:00.000Z',
        features: { squatDuration: { kind: 'numeric', value: 200, unit: 'minutes_per_day' } },
      }],
    });
    expect(r.annotations).toHaveLength(1);
  });

  it('rejects version other than 1', () => {
    expect(() => AnnotationSetSchema.parse({ version: 2, annotations: [] })).toThrow();
  });
});
