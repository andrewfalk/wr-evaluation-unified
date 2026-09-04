import { describe, it, expect } from 'vitest';
import {
  checkExposureLimit,
  computeJobExposures,
  mergeJobsWithExtras,
  computeShoulderCalc,
  isShoulderAssessmentComplete,
  EXPOSURE_LIMITS,
} from '../../../modules/shoulder/derived';

describe('checkExposureLimit', () => {
  it('is not exceeded when cumulativeHours is 0/falsy', () => {
    expect(checkExposureLimit(0, 100)).toEqual({ ratio: 0, exceeded: false });
  });
  it('is exceeded exactly at the limit (ratio >= 1.0)', () => {
    expect(checkExposureLimit(100, 100)).toEqual({ ratio: 1, exceeded: true });
  });
  it('is not exceeded just under the limit', () => {
    const { exceeded } = checkExposureLimit(99, 100);
    expect(exceeded).toBe(false);
  });
});

describe('computeJobExposures', () => {
  it('coerces blank/invalid numeric extras to 0 (matches original parseFloat(x)||0 behavior)', () => {
    const result = computeJobExposures({ overheadHours: 'abc', vibrationHours: '' }, 5, 250);
    const overhead = result.find((r) => r.key === 'overhead');
    expect(overhead?.dailyHours).toBe(0);
    expect(overhead?.cumulativeHours).toBe(0);
  });

  it('combines heavyLoadCount * heavyLoadSeconds / 3600 for the heavyLoad key', () => {
    const result = computeJobExposures({ heavyLoadCount: '10', heavyLoadSeconds: '360' }, 1, 250);
    const heavyLoad = result.find((r) => r.key === 'heavyLoad');
    expect(heavyLoad?.dailyHours).toBeCloseTo(1); // 10*360/3600 = 1
  });
});

describe('mergeJobsWithExtras', () => {
  it('matches extras by sharedJobId and defaults missing fields to blank', () => {
    const merged = mergeJobsWithExtras(
      [{ id: 'job-1' } as any],
      [{ sharedJobId: 'job-1', overheadHours: '2' }],
    );
    expect(merged[0]).toMatchObject({ id: 'job-1', overheadHours: '2', vibrationHours: '' });
  });
});

describe('computeShoulderCalc', () => {
  it('treats missing shared/module as empty objects (no throw)', () => {
    expect(() => computeShoulderCalc({})).not.toThrow();
  });

  it('anyExceeded is true when at least one of the 5 exposure totals exceeds its limit', () => {
    const result = computeShoulderCalc({
      shared: { jobs: [{ id: 'job-1', startDate: '2010-01-01', endDate: '2020-01-01' }] as any },
      module: { jobExtras: [{ sharedJobId: 'job-1', overheadHours: '2' }] }, // 10y*250d*2h=5000h > 3600h
    });
    expect(result.anyExceeded).toBe(true);
    expect(result.totals.find((t) => t.key === 'overhead')?.exceeded).toBe(true);
  });

  it('anyRepetitiveExceeded is an OR of repetitiveMedium/repetitiveFast only', () => {
    const result = computeShoulderCalc({
      shared: { jobs: [{ id: 'job-1', startDate: '2000-01-01', endDate: '2020-01-01' }] as any },
      module: { jobExtras: [{ sharedJobId: 'job-1', repetitiveFastHours: '2' }] }, // 20y*250d*2h=10000h > repetitiveFast(9400h)
    });
    expect(result.anyRepetitiveExceeded).toBe(true);
    expect(result.totals.find((t) => t.key === 'overhead')?.exceeded).toBe(false);
  });

  it('every EXPOSURE_LIMITS key appears in totals', () => {
    const result = computeShoulderCalc({ shared: { jobs: [] }, module: {} });
    expect(result.totals.map((t) => t.key).sort()).toEqual(Object.keys(EXPOSURE_LIMITS).sort());
  });
});

describe('isShoulderAssessmentComplete', () => {
  it('is false when there are no diagnoses', () => {
    expect(isShoulderAssessmentComplete({ shared: { diagnoses: [] }, module: {}, activeModules: [] })).toBe(false);
  });

  it('is true when the shoulder diagnosis has confirmed status and assessment on the affected side', () => {
    expect(
      isShoulderAssessmentComplete({
        shared: {
          diagnoses: [
            { code: 'M751', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' },
          ],
        },
        module: {},
        activeModules: ['shoulder'],
      }),
    ).toBe(true);
  });

  it('is false when assessment is "low" without a reason', () => {
    expect(
      isShoulderAssessmentComplete({
        shared: {
          diagnoses: [
            { code: 'M751', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: [] },
          ],
        },
        module: {},
        activeModules: ['shoulder'],
      }),
    ).toBe(false);
  });
});
