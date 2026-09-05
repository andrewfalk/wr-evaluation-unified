import { describe, it, expect } from 'vitest';
import {
  computeWristCalc,
  isWristAssessmentComplete,
  groupDiagnosesByBkType,
  groupSummariesByBkType,
  pickRepresentativeEntry,
  mergeBkGroupSummaries,
  getBk2101RepetitionPerHour,
  computeDiagnosisFlags,
  getWristBurdenGrade,
  type DiagnosisSummary,
} from '../../../modules/wrist/derived';
import { normalizeWristModuleData } from '../../../modules/wrist/legacyNormalize';

const JOBS = [{ id: 'job-1', jobName: '조립공' }];

describe('computeWristCalc', () => {
  it('treats missing shared/module as empty objects (no throw)', () => {
    expect(() => computeWristCalc({})).not.toThrow();
    const result = computeWristCalc({});
    expect(result.diagnosisSummaries).toEqual([]);
    expect(result.anyFlagged).toBe(false);
  });

  it('BK2113 자동추론(코드 G56.0) — 복합노출 플래그', () => {
    const result = computeWristCalc({
      shared: { jobs: JOBS, diagnoses: [{ id: 'dx-1', code: 'G56.0', moduleId: 'wrist', side: 'right' }] },
      module: {
        jobEvaluations: [
          {
            sharedJobId: 'job-1',
            diagnosisEntries: [
              {
                diagnosisId: 'dx-1',
                direct_anatomic_link: 'yes',
                exposure_types: ['repetition'],
                daily_exposure_hours: '4',
                shift_share_percent: '50',
                work_pattern: 'continuous',
                bk2113_repetitive_wrist_motion: 'yes',
                force_level: 'high',
              },
            ],
          },
        ],
      },
      activeModules: ['wrist'],
    });
    const summary = result.diagnosisSummaries[0];
    expect(summary.entry.selectedBkType).toBe('BK2113');
    expect(summary.flags.bk2113_pattern_supported).toBe(true);
    expect(summary.flags.bk2113_combined_exposure_present).toBe(true); // repetition+force 2개 이상
    expect(result.anyFlagged).toBe(true);
  });

  it('BK2101 자동추론(코드 M65.3) + 고빈도 반복 예시 플래그', () => {
    const result = computeWristCalc({
      shared: { jobs: JOBS, diagnoses: [{ id: 'dx-1', code: 'M65.3', moduleId: 'wrist', side: 'right' }] },
      module: {
        jobEvaluations: [
          {
            sharedJobId: 'job-1',
            diagnosisEntries: [
              {
                diagnosisId: 'dx-1',
                direct_anatomic_link: 'yes',
                exposure_types: ['repetition'],
                daily_exposure_hours: '4',
                shift_share_percent: '50',
                work_pattern: 'continuous',
                bk2101_cycle_seconds: '0.3', // 3600/0.3=12000회/시간 > 10000
                bk2101_forced_dorsal_extension: 'yes',
              },
            ],
          },
        ],
      },
      activeModules: ['wrist'],
    });
    const summary = result.diagnosisSummaries[0];
    expect(summary.entry.selectedBkType).toBe('BK2101');
    expect(summary.flags.bk2101_high_freq_example).toBe(true);
    expect(summary.flags.bk2101_pattern_supported).toBe(true);
    expect(result.anyFlagged).toBe(true);
  });

  it('direct_anatomic_link=no면 노출 세부평가를 건너뛰고 core_exposure_unclear만 남는다', () => {
    const result = computeWristCalc({
      shared: { jobs: JOBS, diagnoses: [{ id: 'dx-1', code: 'M65.3', moduleId: 'wrist', side: 'right' }] },
      module: {
        jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ diagnosisId: 'dx-1', direct_anatomic_link: 'no' }] }],
      },
      activeModules: ['wrist'],
    });
    const summary = result.diagnosisSummaries[0];
    expect(summary.flags).toEqual({ core_exposure_unclear: true });
    expect(summary.narrative).toMatch(/추가 노출 평가는 제한적입니다/);
  });

  it('temporal_fit_high — 최근 작업변화 있음 + 휴식 시 호전', () => {
    const result = computeWristCalc({
      shared: { jobs: JOBS, diagnoses: [] },
      module: { temporalSequence: { recent_task_change: 'increased_load', improves_with_rest: 'yes' } },
      activeModules: ['wrist'],
    });
    expect(result.temporalFlags.temporal_fit_high).toBe(true);
    expect(result.temporalFlagItems).toHaveLength(1);
  });

  it('레거시 diagnosisEvaluations(job별 flat 아님)를 첫 job에 배정하고 bkSelectionMode를 manual로 마킹', () => {
    const result = computeWristCalc({
      shared: { jobs: JOBS, diagnoses: [{ id: 'dx-1', code: 'M65.3', moduleId: 'wrist', side: 'right' }] },
      module: {
        diagnosisEvaluations: [{ diagnosisId: 'dx-1', selectedBkType: 'BK2106', direct_pressure_level: 'frequent' }],
      },
      activeModules: ['wrist'],
    });
    const summary = result.diagnosisSummaries[0];
    expect(summary.entry.selectedBkType).toBe('BK2106');
    expect(summary.entry.bkSelectionMode).toBe('manual');
  });
});

describe('normalizeWristModuleData — BK군 대표값 자동복사(donor)', () => {
  it('같은 BK유형인데 아직 값이 없는 entry는 이미 채워진 entry의 값을 복사한다', () => {
    const diagnoses = [
      { id: 'dx-1', code: 'M65.3', moduleId: 'wrist' },
      { id: 'dx-2', code: 'M65.4', moduleId: 'wrist' },
    ];
    const moduleData = {
      jobEvaluations: [
        {
          sharedJobId: 'job-1',
          diagnosisEntries: [
            { diagnosisId: 'dx-1', direct_anatomic_link: 'yes', main_task_name: '작업A', daily_exposure_hours: '5' },
          ],
        },
      ],
    };
    const result = normalizeWristModuleData(moduleData, JOBS, diagnoses, ['wrist']);
    const entries = result.moduleData.jobEvaluations[0].diagnosisEntries ?? [];
    const donorEntry = entries.find((e) => e.diagnosisId === 'dx-1');
    const copiedEntry = entries.find((e) => e.diagnosisId === 'dx-2');
    expect(donorEntry?.selectedBkType).toBe('BK2101');
    expect(copiedEntry?.selectedBkType).toBe('BK2101');
    expect(copiedEntry?.main_task_name).toBe('작업A');
    expect(copiedEntry?.daily_exposure_hours).toBe('5');
    expect(copiedEntry?.bkAutoSyncedFrom).toBe('dx-1');
  });

  it('_pendingPreset은 정규화 결과에 남지 않는다(UI 전용, analytics-core 미지원)', () => {
    const diagnoses = [{ id: 'dx-1', code: 'M65.3', moduleId: 'wrist' }];
    const moduleData = {
      jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [], _pendingPreset: { main_task_name: '프리셋값' } }],
    };
    const result = normalizeWristModuleData(moduleData, JOBS, diagnoses, ['wrist']);
    expect(result.moduleData.jobEvaluations[0]._pendingPreset).toBeUndefined();
  });

  it('isWristDiagnosis: 코드/이름 매핑이 없어도 BK유형이 추론되면 wrist로 인식한다', () => {
    // 드퀘르벵병은 ICD_MODULE_MAP/NAME_MODULE_MAP(diagnosisMapping.ts)에 없어
    // resolveDiagnosisModule이 null을 반환하지만, inferWristBkTypeFromDiagnosis는
    // 성공(BK2101)한다 — wrist 전용 2차 판정 분기(elbow에는 없음).
    const diagnoses = [{ id: 'dx-1', code: '', name: '드퀘르벵병' }];
    const result = normalizeWristModuleData({}, JOBS, diagnoses, ['wrist']);
    expect(result.wristDiagnoses).toHaveLength(1);
  });
});

describe('isWristAssessmentComplete', () => {
  it('진단이 없으면 false', () => {
    expect(isWristAssessmentComplete({ shared: { diagnoses: [] }, module: {}, activeModules: ['wrist'] })).toBe(false);
  });

  it('직력이 없으면 false', () => {
    expect(
      isWristAssessmentComplete({
        shared: { jobs: [], diagnoses: [{ id: 'dx-1', code: 'M65.3', moduleId: 'wrist', side: 'right' }] },
        module: {},
        activeModules: ['wrist'],
      }),
    ).toBe(false);
  });

  it('assessmentRight=low인데 reasonRight가 비어있으면 false', () => {
    const result = isWristAssessmentComplete({
      shared: {
        jobs: JOBS,
        diagnoses: [
          { id: 'dx-1', code: 'M65.3', moduleId: 'wrist', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'low', reasonRight: [] },
        ],
      },
      module: { temporalSequence: { recent_task_change: 'none', improves_with_rest: 'no' } },
      activeModules: ['wrist'],
    });
    expect(result).toBe(false);
  });
});

describe('BK 그룹 helper', () => {
  it('groupDiagnosesByBkType — 같은 BK유형은 한 그룹, 미선택은 진단별 개별 그룹', () => {
    const diagnoses = [{ id: 'dx-1' }, { id: 'dx-2' }, { id: 'dx-3' }];
    const jobEvaluation = {
      diagnosisEntries: [
        { diagnosisId: 'dx-1', selectedBkType: 'BK2101' },
        { diagnosisId: 'dx-2', selectedBkType: 'BK2101' },
        { diagnosisId: 'dx-3', selectedBkType: '' },
      ],
    };
    const groups = groupDiagnosesByBkType(diagnoses, jobEvaluation);
    expect(groups).toHaveLength(2);
    const bk2101Group = groups.find((g) => g.bkType === 'BK2101');
    expect(bk2101Group?.items).toHaveLength(2);
    expect(bk2101Group?.isGrouped).toBe(true);
    const noneGroup = groups.find((g) => g.bkType === '');
    expect(noneGroup?.isGrouped).toBe(false);
  });

  it('pickRepresentativeEntry — 값이 가장 많이 채워진 entry를 대표로 고른다', () => {
    const items = [
      { entry: { diagnosisId: 'dx-1', main_task_name: 'a' } },
      { entry: { diagnosisId: 'dx-2', main_task_name: 'b', daily_exposure_hours: '3', shift_share_percent: '10' } },
    ];
    expect(pickRepresentativeEntry(items).diagnosisId).toBe('dx-2');
  });

  it('mergeBkGroupSummaries — flagItems/riskFactorItems를 key 기준으로 합집합한다', () => {
    const summaries = [
      {
        diagnosisId: 'dx-1',
        entry: {},
        missingFields: ['A'],
        flagItems: [{ key: 'core_exposure_present', label: 'x', description: '', tone: 'positive', icon: '' }],
        riskFactorItems: [{ key: 'core_exposure_present', label: 'x', description: '', tone: 'positive', icon: '' }],
      },
      {
        diagnosisId: 'dx-2',
        entry: { main_task_name: 'filled' },
        missingFields: ['B'],
        flagItems: [{ key: 'daily_share_high', label: 'y', description: '', tone: 'positive', icon: '' }],
        riskFactorItems: [{ key: 'daily_share_high', label: 'y', description: '', tone: 'positive', icon: '' }],
      },
    ];
    const merged = mergeBkGroupSummaries(summaries as unknown as DiagnosisSummary[]);
    expect(merged.diagnosisId).toBe('dx-2'); // score가 더 높은 쪽이 대표(primary)
    expect(merged.missingFields.sort()).toEqual(['A', 'B']);
    expect(merged.flagItems.map((f) => f.key).sort()).toEqual(['core_exposure_present', 'daily_share_high']);
    expect(merged.riskFactorCount).toBe(2);
  });

  it('groupSummariesByBkType', () => {
    const summaries = [
      { diagnosisId: 'dx-1', entry: { selectedBkType: 'BK2103' } },
      { diagnosisId: 'dx-2', entry: { selectedBkType: 'BK2103' } },
    ];
    const groups = groupSummariesByBkType(summaries as unknown as DiagnosisSummary[]);
    expect(groups).toHaveLength(1);
    expect(groups[0].summaries).toHaveLength(2);
  });
});

describe('getBk2101RepetitionPerHour', () => {
  it('cycleSeconds가 있으면 3600/cycleSeconds를 우선한다', () => {
    expect(getBk2101RepetitionPerHour({ bk2101_cycle_seconds: '0.36', bk2101_repetition_per_hour: '1' })).toBeCloseTo(10000);
  });

  it('cycleSeconds가 없으면 repetition_per_hour로 폴백한다', () => {
    expect(getBk2101RepetitionPerHour({ bk2101_repetition_per_hour: '20' })).toBe(20);
  });

  it('둘 다 비어있으면 0', () => {
    expect(getBk2101RepetitionPerHour({})).toBe(0);
  });
});

describe('computeDiagnosisFlags / getWristBurdenGrade', () => {
  it('riskFactorCount<=1이면 부담 작업 아님', () => {
    expect(getWristBurdenGrade(1, {})).toBe('부담 작업 아님');
    expect(getWristBurdenGrade(0, {})).toBe('부담 작업 아님');
  });

  it('riskFactorCount>=5이면 고도', () => {
    expect(getWristBurdenGrade(5, {})).toBe('고도');
  });

  it('high burden gate(핵심노출+고노출량+BK패턴지지)가 충족되면 riskFactorCount와 무관하게 고도', () => {
    const flags = { core_exposure_present: true, daily_share_high: true, bk2101_pattern_supported: true };
    expect(getWristBurdenGrade(2, flags)).toBe('고도');
  });

  it('사용자 정의 thresholds를 넘기면 그 기준으로 등급을 매긴다', () => {
    const customThresholds = { highByCount: 3, noneMax: 0, mildAt: 1, moderateMax: 2 };
    expect(getWristBurdenGrade(3, {}, customThresholds)).toBe('고도');
    expect(getWristBurdenGrade(1, {}, customThresholds)).toBe('경도');
  });

  it('direct_anatomic_link가 비어있으면(미평가) 세부 플래그를 전혀 계산하지 않는다', () => {
    const flags = computeDiagnosisFlags({}, {});
    expect(flags).toEqual({});
  });
});
