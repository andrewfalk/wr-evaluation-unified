import { describe, it, expect } from 'vitest';
import {
  calculatePhysicalBurden,
  calculateWorkRelatedness,
  evaluateCumulativeBurden,
  mergeJobsWithExtras,
  resolveKneeCalculationJobs,
  computeKneeCalc,
  isKneeAssessmentComplete,
} from '../../../modules/knee/derived';

describe('calculatePhysicalBurden', () => {
  it('classifies burden level by weight/time thresholds', () => {
    expect(calculatePhysicalBurden(3000, 120).level).toBe('고도');
    expect(calculatePhysicalBurden(3000, 60).level).toBe('중등도상');
    expect(calculatePhysicalBurden(2000, 60).level).toBe('중등도하');
    expect(calculatePhysicalBurden(0, 0).level).toBe('경도');
  });
});

describe('calculateWorkRelatedness', () => {
  it('returns {min:0, max:0} when age <= 30 (explicit early return, business rule)', () => {
    expect(calculateWorkRelatedness([{ weight: 3000, squatting: 120, startDate: '2000-01-01', endDate: '2010-01-01' }], 30)).toEqual({
      min: 0,
      max: 0,
    });
  });

  it('returns {min:0, max:0} when there are no jobs', () => {
    expect(calculateWorkRelatedness([], 40)).toEqual({ min: 0, max: 0 });
    expect(calculateWorkRelatedness(undefined, 40)).toEqual({ min: 0, max: 0 });
  });

  it('computes a positive percentage for a valid job with age > 30', () => {
    const result = calculateWorkRelatedness(
      [{ weight: 3000, squatting: 120, startDate: '2000-01-01', endDate: '2010-01-01' }],
      40,
    );
    expect(Number(result.max)).toBeGreaterThan(0);
  });
});

describe('evaluateCumulativeBurden', () => {
  it('is 충분함 when the average of min/max is >= 50', () => {
    expect(evaluateCumulativeBurden('60', '40')).toBe('충분함');
    expect(evaluateCumulativeBurden('10', '10')).toBe('불충분함');
  });
});

describe('mergeJobsWithExtras', () => {
  it('joins shared.jobs with knee jobExtras by sharedJobId', () => {
    const merged = mergeJobsWithExtras(
      [{ id: 'job-1', jobName: 'A' }],
      [{ sharedJobId: 'job-1', weight: '3000', squatting: '120' }],
    );
    expect(merged).toEqual([
      {
        id: 'job-1',
        jobName: 'A',
        weight: '3000',
        squatting: '120',
        evidenceSources: [],
        stairs: false,
        kneeTwist: false,
        startStop: false,
        tightSpace: false,
        kneeContact: false,
        jumpDown: false,
      },
    ]);
  });

  it('defaults to blank/false extras when no matching jobExtras entry exists', () => {
    const merged = mergeJobsWithExtras([{ id: 'job-1' }], []);
    expect(merged[0].weight).toBe('');
    expect(merged[0].stairs).toBe(false);
  });
});

describe('resolveKneeCalculationJobs', () => {
  it('uses module.jobs (legacy) when present, ignoring shared.jobs+jobExtras', () => {
    const jobs = resolveKneeCalculationJobs(
      { jobs: [{ id: 'shared-job' }] },
      { jobs: [{ id: 'legacy-job' }], jobExtras: [{ sharedJobId: 'shared-job' }] },
    );
    expect(jobs).toEqual([{ id: 'legacy-job' }]);
  });

  it('merges shared.jobs+jobExtras when module.jobs is absent', () => {
    const jobs = resolveKneeCalculationJobs(
      { jobs: [{ id: 'shared-job' }] },
      { jobExtras: [{ sharedJobId: 'shared-job', weight: '10' }] },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].weight).toBe('10');
  });
});

describe('computeKneeCalc', () => {
  it('accepts the exact {shared, module} shape used by App.jsx', () => {
    const result = computeKneeCalc({
      shared: {
        birthDate: '1980-01-01',
        injuryDate: '2020-01-01',
        jobs: [{ id: 'job-1', startDate: '2000-01-01', endDate: '2010-01-01' }],
      },
      module: { jobExtras: [{ sharedJobId: 'job-1', weight: '3000', squatting: '120' }] },
    });
    expect(result.age).toBe(40);
    expect(Number(result.relatedness.max)).toBeGreaterThan(0);
  });

  it('treats missing shared/module as empty objects (no throw)', () => {
    expect(() => computeKneeCalc({})).not.toThrow();
  });
});

describe('isKneeAssessmentComplete', () => {
  it('is false when there are no diagnoses', () => {
    expect(isKneeAssessmentComplete({ shared: { diagnoses: [] } })).toBe(false);
  });

  it('is true when the knee diagnosis has confirmed status and assessment on the affected side', () => {
    expect(
      isKneeAssessmentComplete({
        shared: {
          diagnoses: [
            { code: 'M17.1', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' },
          ],
        },
        activeModules: ['knee'],
      }),
    ).toBe(true);
  });
});
