import { describe, it, expect } from 'vitest';
import { computeCervicalCalc, isCervicalAssessmentComplete, getCervicalBurdenGrade, getCervicalConclusionText } from '../../../modules/cervical/derived';
import { normalizeCervicalModuleData } from '../../../modules/cervical/legacyNormalize';

const JOBS = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }];

describe('computeCervicalCalc', () => {
  it('treats missing shared/module as empty objects (no throw)', () => {
    expect(() => computeCervicalCalc({})).not.toThrow();
    const result = computeCervicalCalc({});
    expect(result.jobSummaries).toEqual([]);
  });

  it('작업이 0건이면 "경추부담 작업 없음"이라는 유효한 상태(missingFields 없음, burdenGrade=low)', () => {
    const result = computeCervicalCalc({ shared: { jobs: JOBS, diagnoses: [] }, module: { tasks: [] }, activeModules: ['cervical'] });
    const jobSummary = result.jobSummaries[0];
    expect(jobSummary.totalTaskCount).toBe(0);
    expect(jobSummary.missingFields).toEqual([]);
    expect(jobSummary.burdenGrade).toBe('low');
    expect(jobSummary.narrative).toBe('경추부담 작업 없음');
  });

  it('BK2109 핵심 3요건(하중≥40kg·운반≥0.5h·강제자세)이 모두 충족되면 high_bk2109', () => {
    const result = computeCervicalCalc({
      shared: { jobs: JOBS, diagnoses: [] },
      module: {
        tasks: [
          {
            sharedJobId: 'job-1',
            name: '박스 운반',
            exposure_types: ['shoulder_heavy_load'],
            load_weight_kg: '45',
            carry_hours_per_shift: '2',
            forced_neck_posture: 'yes',
          },
        ],
      },
      activeModules: ['cervical'],
    });
    const jobSummary = result.jobSummaries[0];
    expect(jobSummary.hasBk2109CoreTask).toBe(true);
    expect(jobSummary.flags.bk2109_pattern_supported).toBe(true);
    expect(jobSummary.burdenGrade).toBe('high_bk2109');
    expect(jobSummary.cumulativeKgHours).toBeGreaterThan(0);
  });

  it('하중이 40kg 미만이면 heavy_load_present가 꺼져 BK2109 패턴이 지지되지 않는다', () => {
    const result = computeCervicalCalc({
      shared: { jobs: JOBS, diagnoses: [] },
      module: {
        tasks: [
          {
            sharedJobId: 'job-1',
            name: '박스 운반',
            exposure_types: ['shoulder_heavy_load'],
            load_weight_kg: '39',
            carry_hours_per_shift: '2',
            forced_neck_posture: 'yes',
          },
        ],
      },
      activeModules: ['cervical'],
    });
    const jobSummary = result.jobSummaries[0];
    expect(jobSummary.hasBk2109CoreTask).toBe(false);
    expect(jobSummary.cumulativeKgHours).toBe(0);
  });

  it('비중립·정적 목 부하 노출(daily_share/awkward)만으로는 burdenGrade가 present에 그친다', () => {
    const result = computeCervicalCalc({
      shared: { jobs: JOBS, diagnoses: [] },
      module: {
        tasks: [
          {
            sharedJobId: 'job-1',
            name: '정밀 조립',
            exposure_types: ['awkward_static_neck_load'],
            neck_nonneutral_hours_per_day: '4',
            combined_flexion_rotation_posture: 'yes',
            precision_work: 'yes',
          },
        ],
      },
      activeModules: ['cervical'],
    });
    const jobSummary = result.jobSummaries[0];
    expect(jobSummary.flags.awkward_static_neck_supported).toBe(true);
    expect(jobSummary.flags.daily_share_high).toBe(true);
    expect(jobSummary.burdenGrade).toBe('present');
  });

  it('필수 필드(name)가 비어있으면 missingFields에 반영된다', () => {
    const result = computeCervicalCalc({
      shared: { jobs: JOBS, diagnoses: [] },
      module: { tasks: [{ sharedJobId: 'job-1', name: '', exposure_types: ['shoulder_heavy_load'] }] },
      activeModules: ['cervical'],
    });
    expect(result.jobSummaries[0].missingFields.length).toBeGreaterThan(0);
  });
});

describe('normalizeCervicalModuleData', () => {
  it('task 배열 원소가 plain object가 아니면(null 등) 걸러낸다', () => {
    const result = normalizeCervicalModuleData({ tasks: [null, { sharedJobId: 'job-1', name: 'A' }] as any }, JOBS);
    expect(result.moduleData.tasks).toHaveLength(1);
    expect(result.moduleData.tasks[0].name).toBe('A');
  });

  it('exposure_types가 배열이 아니면(문자열 등) 빈 배열로 취급한다', () => {
    const result = normalizeCervicalModuleData(
      { tasks: [{ sharedJobId: 'job-1', name: 'A', exposure_types: 'shoulder_heavy_load' as any }] },
      JOBS,
    );
    expect(result.moduleData.tasks[0].exposure_types).toEqual([]);
  });

  it('sharedJobId가 비어있으면 첫 job에 배정한다', () => {
    const result = normalizeCervicalModuleData({ tasks: [{ name: 'A' }] }, JOBS);
    expect(result.moduleData.tasks[0].sharedJobId).toBe('job-1');
  });

  it('원본에 없는 id는 만들지 않는다(비결정성 회피)', () => {
    const result = normalizeCervicalModuleData({ tasks: [{ name: 'A' }] }, JOBS);
    expect(result.moduleData.tasks[0].id).toBeUndefined();
  });

  it('원본에 id가 있으면 그대로 보존한다', () => {
    const result = normalizeCervicalModuleData({ tasks: [{ id: 'fixed-id', name: 'A' }] }, JOBS);
    expect(result.moduleData.tasks[0].id).toBe('fixed-id');
  });
});

describe('isCervicalAssessmentComplete', () => {
  it('진단이 없으면 false', () => {
    expect(isCervicalAssessmentComplete({ shared: { jobs: JOBS, diagnoses: [] }, module: { tasks: [] }, activeModules: ['cervical'] })).toBe(false);
  });

  it('직력이 없으면 false', () => {
    expect(
      isCervicalAssessmentComplete({
        shared: { jobs: [], diagnoses: [{ id: 'dx-1', code: 'M50', moduleId: 'cervical', confirmedRight: 'confirmed', assessmentRight: 'high' }] },
        module: { tasks: [] },
        activeModules: ['cervical'],
      }),
    ).toBe(false);
  });

  it('작업이 0건이면(유효한 상태) 진단 완료 조건만 만족해도 true', () => {
    expect(
      isCervicalAssessmentComplete({
        shared: { jobs: JOBS, diagnoses: [{ id: 'dx-1', code: 'M50', moduleId: 'cervical', confirmedRight: 'confirmed', assessmentRight: 'high' }] },
        module: { tasks: [] },
        activeModules: ['cervical'],
      }),
    ).toBe(true);
  });

  it('assessmentRight=low인데 reasonRight가 비어있으면 false', () => {
    expect(
      isCervicalAssessmentComplete({
        shared: { jobs: JOBS, diagnoses: [{ id: 'dx-1', code: 'M50', moduleId: 'cervical', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: [] }] },
        module: { tasks: [] },
        activeModules: ['cervical'],
      }),
    ).toBe(false);
  });

  it('side 필드와 무관하게 Right 필드만 검사하는 비대칭 판정(원본 그대로, 수정 범위 아님)', () => {
    // confirmedLeft/assessmentLeft가 있어도 무시되고 confirmedRight/assessmentRight만 본다.
    expect(
      isCervicalAssessmentComplete({
        shared: {
          jobs: JOBS,
          diagnoses: [{ id: 'dx-1', code: 'M50', moduleId: 'cervical', confirmedLeft: 'confirmed', assessmentLeft: 'high' }],
        },
        module: { tasks: [] },
        activeModules: ['cervical'],
      }),
    ).toBe(false); // Right 필드가 없으므로 false(Left만 채워도 소용없음)
  });
});

describe('getCervicalBurdenGrade / getCervicalConclusionText', () => {
  it('bk2109_pattern_supported가 있으면 항상 high_bk2109', () => {
    expect(getCervicalBurdenGrade({ bk2109_pattern_supported: true })).toBe('high_bk2109');
  });

  it('플래그가 전혀 없으면 low', () => {
    expect(getCervicalBurdenGrade({})).toBe('low');
  });

  it('등급별 결론 문구가 다르다', () => {
    expect(getCervicalConclusionText('high_bk2109')).toMatch(/BK2109.*강하게 지지/);
    expect(getCervicalConclusionText('present')).toMatch(/지지는 제한적/);
    expect(getCervicalConclusionText('low')).toMatch(/뚜렷하게 지지하기 어렵습니다/);
  });
});
