import { describe, it, expect } from 'vitest';
import {
  checkExposureLimit,
  computeJobExposures,
  mergeJobsWithExtras,
  computeShoulderCalc,
  isShoulderAssessmentComplete,
  EXPOSURE_LIMITS,
  type ShoulderJobLike,
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
      [{ id: 'job-1' }],
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
      shared: { jobs: [{ id: 'job-1', startDate: '2010-01-01', endDate: '2020-01-01' }] },
      module: { jobExtras: [{ sharedJobId: 'job-1', overheadHours: '2' }] }, // 10y*250d*2h=5000h > 3600h
    });
    expect(result.anyExceeded).toBe(true);
    expect(result.totals.find((t) => t.key === 'overhead')?.exceeded).toBe(true);
  });

  it('anyRepetitiveExceeded is an OR of repetitiveMedium/repetitiveFast only', () => {
    const result = computeShoulderCalc({
      shared: { jobs: [{ id: 'job-1', startDate: '2000-01-01', endDate: '2020-01-01' }] },
      module: { jobExtras: [{ sharedJobId: 'job-1', repetitiveFastHours: '2' }] }, // 20y*250d*2h=10000h > repetitiveFast(9400h)
    });
    expect(result.anyRepetitiveExceeded).toBe(true);
    expect(result.totals.find((t) => t.key === 'overhead')?.exceeded).toBe(false);
  });

  it('every EXPOSURE_LIMITS key appears in totals', () => {
    const result = computeShoulderCalc({ shared: { jobs: [] }, module: {} });
    expect(result.totals.map((t) => t.key).sort()).toEqual(Object.keys(EXPOSURE_LIMITS).sort());
  });

  // workDaysPerYear는 원본(j.workDaysPerYear || 250)과 동일하게 Number()로 강제 변환하지
  // 않는다 — '0'/'abc' 같은 문자열이 250일로 둔갑하면 노출 초과 여부가 실제로 바뀐다(리뷰 지적).
  describe('workDaysPerYear coercion parity with legacy (j.workDaysPerYear || 250, no Number())', () => {
    const jobFor = (workDaysPerYear: string | number): ShoulderJobLike[] => [
      { id: 'job-1', startDate: '2015-01-01', endDate: '2020-01-01', workDaysPerYear },
    ];
    // overhead 한도 3600h. 5y * 3h/day * wdpy 계산.

    it("workDaysPerYear: '0' (string) — truthy이므로 250으로 대체되지 않고 그대로 0 취급되어 누적 0h", () => {
      const result = computeShoulderCalc({
        shared: { jobs: jobFor('0') },
        module: { jobExtras: [{ sharedJobId: 'job-1', overheadHours: '3' }] },
      });
      expect(result.jobBurdens[0].exposures.find((e) => e.key === 'overhead')?.cumulativeHours).toBe(0);
      expect(result.totals.find((t) => t.key === 'overhead')?.exceeded).toBe(false);
    });

    it("workDaysPerYear: 0 (number) — falsy이므로 250으로 대체되어 5y*3h*250=3750h > 3600h", () => {
      const result = computeShoulderCalc({
        shared: { jobs: jobFor(0) },
        module: { jobExtras: [{ sharedJobId: 'job-1', overheadHours: '3' }] },
      });
      expect(result.totals.find((t) => t.key === 'overhead')?.exceeded).toBe(true);
    });

    it("workDaysPerYear: 'abc' — 원본처럼 raw 그대로 두어 산술에서 NaN이 되고 reduce의 ||0으로 흡수된다", () => {
      const result = computeShoulderCalc({
        shared: { jobs: jobFor('abc') },
        module: { jobExtras: [{ sharedJobId: 'job-1', overheadHours: '3' }] },
      });
      expect(result.totals.find((t) => t.key === 'overhead')?.totalHours).toBe(0);
      expect(result.totals.find((t) => t.key === 'overhead')?.exceeded).toBe(false);
    });

    it("workDaysPerYear: 250 (number) — 명시값 그대로 사용, 5y*3h*250=3750h > 3600h", () => {
      const result = computeShoulderCalc({
        shared: { jobs: jobFor(250) },
        module: { jobExtras: [{ sharedJobId: 'job-1', overheadHours: '3' }] },
      });
      expect(result.totals.find((t) => t.key === 'overhead')?.exceeded).toBe(true);
    });
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
