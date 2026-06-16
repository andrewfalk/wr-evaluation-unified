import { describe, it, expect } from 'vitest';
import {
  metricKind,
  numericError,
  compareFeature,
  compareFeatureMap,
  summarizeErrors,
  binaryMetrics,
  withinTolerance,
  EXAMPLE_TOLERANCES,
} from '../videoValidation.js';
import { generateMockFeatures } from '../videoMock.js';

describe('metricKind', () => {
  it('maps units to error-metric kinds', () => {
    expect(metricKind('degrees')).toBe('angle');
    expect(metricKind('hours_per_day')).toBe('time');
    expect(metricKind('minutes_per_day')).toBe('time');
    expect(metricKind('seconds_per_cycle')).toBe('time');
    expect(metricKind('cycles_per_day')).toBe('count');
    expect(metricKind('ratio')).toBe('ratio');
  });
});

describe('numericError', () => {
  it('computes absolute error and rate', () => {
    expect(numericError(1.8, 2.0)).toEqual({ absError: expect.closeTo(0.2, 5), errorRate: expect.closeTo(0.1, 5) });
  });
  it('handles gold=0 (rate 0 when exact, Infinity otherwise)', () => {
    expect(numericError(0, 0).errorRate).toBe(0);
    expect(numericError(1, 0).errorRate).toBe(Infinity);
  });
});

describe('compareFeature', () => {
  it('numeric → absError/errorRate/metric', () => {
    const c = compareFeature('overheadHours',
      { kind: 'numeric', value: 1.8, unit: 'hours_per_day' },
      { kind: 'numeric', value: 2.0, unit: 'hours_per_day' });
    expect(c.metric).toBe('time');
    expect(c.absError).toBeCloseTo(0.2, 5);
    expect(c.errorRate).toBeCloseTo(0.1, 5);
  });

  it('boolean/categorical → agreement', () => {
    expect(compareFeature('suspectedKneeTwist', { kind: 'boolean', value: true }, { kind: 'boolean', value: true }).agree).toBe(true);
    expect(compareFeature('trunkPostureG', { kind: 'categorical', value: 'G3' }, { kind: 'categorical', value: 'G4' }).agree).toBe(false);
  });

  it('flags missing/type-mismatch via status', () => {
    expect(compareFeature('x', null, { kind: 'numeric', value: 1, unit: 'ratio' }).status).toBe('missing_extracted');
    expect(compareFeature('x', { kind: 'numeric', value: 1, unit: 'ratio' }, null).status).toBe('no_gold');
    expect(compareFeature('x', { kind: 'candidate', value: 1 }, { kind: 'numeric', value: 1, unit: 'ratio' }).status).toBe('type_mismatch');
  });

  it('rejects candidate value leaking into a boolean gold (strict kind)', () => {
    const c = compareFeature('suspectedKneeTwist', { kind: 'candidate', value: true }, { kind: 'boolean', value: true });
    expect(c.status).toBe('type_mismatch');
    expect(c.agree).toBeUndefined();
  });

  it('flags unit mismatch (e.g. hours vs minutes)', () => {
    const c = compareFeature('overheadHours',
      { kind: 'numeric', value: 120, unit: 'minutes_per_day' },
      { kind: 'numeric', value: 2, unit: 'hours_per_day' });
    expect(c.status).toBe('unit_mismatch');
  });
});

describe('compareFeatureMap — mock ↔ annotation (§8.9)', () => {
  it('compares real mock output against a gold annotation', () => {
    const featureMap = generateMockFeatures(['overheadHours', 'squatDuration']);
    const gold = {
      overheadHours: { kind: 'numeric', value: 2.0, unit: 'hours_per_day' },     // mock 1.8 → 0.1
      squatDuration: { kind: 'numeric', value: 200, unit: 'minutes_per_day' },   // mock 180 → 0.1
    };
    const comparisons = compareFeatureMap(featureMap, gold);
    const oh = comparisons.find((c) => c.featureKey === 'overheadHours');
    expect(oh.errorRate).toBeCloseTo(0.1, 5);
    expect(oh.metric).toBe('time');

    const summary = summarizeErrors(comparisons);
    const ohSum = summary.find((s) => s.featureKey === 'overheadHours');
    expect(ohSum.meanErrorRate).toBeCloseTo(0.1, 5);
    expect(withinTolerance(ohSum)).toBe(true); // 0.1 <= 0.20
  });

  it('withinTolerance fails when time error rate exceeds threshold', () => {
    const summary = summarizeErrors(compareFeatureMap(
      { overheadHours: { kind: 'numeric', value: 3.0, unit: 'hours_per_day' } },
      { overheadHours: { kind: 'numeric', value: 2.0, unit: 'hours_per_day' } } // rate 0.5
    ));
    expect(withinTolerance(summary[0])).toBe(false);
  });

  it('does NOT pass a large error when gold=0 (Infinity rate propagates, not masked to 0)', () => {
    const summary = summarizeErrors(compareFeatureMap(
      { overheadHours: { kind: 'numeric', value: 1.0, unit: 'hours_per_day' } },
      { overheadHours: { kind: 'numeric', value: 0, unit: 'hours_per_day' } } // gold 0 → rate Infinity
    ));
    expect(summary[0].meanErrorRate).toBe(Infinity);
    expect(withinTolerance(summary[0])).toBe(false);
  });
});

describe('summarizeErrors', () => {
  it('aggregates numeric MAE/rate and boolean agreement across items', () => {
    const comparisons = [
      { featureKey: 'trunkPostureG', kind: 'numeric', metric: 'angle', absError: 10, errorRate: 0.1 },
      { featureKey: 'trunkPostureG', kind: 'numeric', metric: 'angle', absError: 20, errorRate: 0.2 },
      { featureKey: 'suspectedKneeTwist', kind: 'boolean', agree: true },
      { featureKey: 'suspectedKneeTwist', kind: 'boolean', agree: false },
      { featureKey: 'x', status: 'missing_extracted' }, // 제외
    ];
    const s = summarizeErrors(comparisons);
    const angle = s.find((e) => e.featureKey === 'trunkPostureG');
    expect(angle.mae).toBe(15);
    expect(angle.n).toBe(2);
    const bool = s.find((e) => e.featureKey === 'suspectedKneeTwist');
    expect(bool.agreement).toBe(0.5);
  });
});

describe('binaryMetrics (위험 역치 초과)', () => {
  it('computes sensitivity/specificity', () => {
    const m = binaryMetrics([
      { predicted: true, actual: true },   // tp
      { predicted: false, actual: true },  // fn
      { predicted: true, actual: false },  // fp
      { predicted: false, actual: false }, // tn
    ]);
    expect(m).toMatchObject({ tp: 1, fn: 1, fp: 1, tn: 1 });
    expect(m.sensitivity).toBeCloseTo(0.5, 5);
    expect(m.specificity).toBeCloseTo(0.5, 5);
  });
});

describe('EXAMPLE_TOLERANCES', () => {
  it('exposes §8.9 placeholder tolerances (real values decided in 6.0-B2)', () => {
    expect(EXAMPLE_TOLERANCES.angleMaeDegrees).toBe(12.5);
    expect(EXAMPLE_TOLERANCES.timeErrorRate).toBe(0.20);
  });
});
