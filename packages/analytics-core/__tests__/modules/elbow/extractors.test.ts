import { describe, it, expect } from 'vitest';
import {
  extractElbowBurdenGradeMax,
  extractElbowTemporalRecentTaskChange,
  extractElbowTemporalTaskChangeDate,
  extractElbowTemporalSymptomOnsetInterval,
  extractElbowTemporalImprovesWithRest,
  extractElbowJobDiagnosisSelectedBkType,
  extractElbowJobDiagnosisMainTaskName,
  extractElbowJobDiagnosisDirectAnatomicLink,
  extractElbowJobDiagnosisExposureTypeRepetition,
  extractElbowJobDiagnosisExposureTypeForce,
  extractElbowJobDiagnosisRepetitionLevel,
  extractElbowJobDiagnosisForceLevel,
  extractElbowJobDiagnosisWorkPattern,
  extractElbowJobDiagnosisRestDistribution,
  extractElbowJobDiagnosisDailyExposureHours,
  extractElbowJobDiagnosisShiftSharePercent,
  extractElbowJobDiagnosisDaysPerWeek,
  extractElbowJobDiagnosisStaticHoldingLevel,
  extractElbowJobDiagnosisDirectPressureLevel,
  extractElbowJobDiagnosisVibrationExposure,
  extractElbowJobDiagnosisBk2101CycleSeconds,
  extractElbowJobDiagnosisBk2101RepetitionPerHour,
  extractElbowJobDiagnosisBk2101Monotony,
  extractElbowJobDiagnosisBk2101ForcedDorsalExtension,
  extractElbowJobDiagnosisBk2101Prosupination,
  extractElbowJobDiagnosisBk2105ElbowLeaning,
  extractElbowJobDiagnosisBk2103ToolPressing,
  extractElbowJobDiagnosisBk2103FrequentHighForceGrip,
  extractElbowJobDiagnosisBk2103DailyVibrationHours,
  extractElbowJobDiagnosisBk2105PressureSourceHardSurface,
  extractElbowJobDiagnosisBk2105PressureSourceToolEdge,
  extractElbowJobDiagnosisBk2105PressureSourceGroundContact,
  extractElbowJobDiagnosisBk2105PressureSourceCarryingContact,
  extractElbowJobDiagnosisBk2105PressureSourceOther,
  extractElbowJobDiagnosisBk2106PressureSourceHardSurface,
  extractElbowJobDiagnosisBk2106PressureSourceToolEdge,
  extractElbowJobDiagnosisBk2106PressureSourceGroundContact,
  extractElbowJobDiagnosisBk2106PressureSourceCarryingContact,
  extractElbowJobDiagnosisBk2106PressureSourceOther,
  extractElbowJobDiagnosisBk2103VibrationToolTypeGrinder,
  extractElbowJobDiagnosisBk2103VibrationToolTypeJackhammer,
  extractElbowJobDiagnosisBk2103VibrationToolTypeDemolitionHammer,
  extractElbowJobDiagnosisBk2103VibrationToolTypeChippingHammer,
  extractElbowJobDiagnosisBk2103VibrationToolTypeTampingMachine,
  extractElbowJobDiagnosisBk2103VibrationToolTypeRotaryHammer,
  extractElbowJobDiagnosisBk2103VibrationToolTypeCompactor,
  extractElbowJobDiagnosisBk2103VibrationToolTypeReciprocatingSaw,
  extractElbowJobDiagnosisBk2103VibrationToolTypeRivetHammer,
  extractElbowJobDiagnosisBk2103VibrationToolTypeRustHammer,
  extractElbowJobDiagnosisBk2103VibrationToolTypePowderActuatedTool,
  extractElbowJobDiagnosisBk2103VibrationToolTypeForgingHammer,
  extractElbowJobDiagnosisBk2103VibrationToolTypeOther,
} from '../../../modules/elbow/extractors';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

function baseCase(overrides: {
  jobs?: unknown[];
  diagnoses?: unknown[];
  jobEvaluations?: unknown[];
  temporalSequence?: unknown;
  activeModules?: string[];
  includeElbowModule?: boolean;
}) {
  const {
    jobs = [{ id: 'job-1', jobName: '조립공' }],
    diagnoses = [{ id: 'dx-1', code: 'M770', moduleId: 'elbow', side: 'right' }],
    jobEvaluations = [],
    temporalSequence = {},
    activeModules = ['elbow'],
    includeElbowModule = true,
  } = overrides;
  return {
    data: {
      shared: { jobs, diagnoses },
      modules: includeElbowModule ? { elbow: { jobEvaluations, temporalSequence } } : {},
      activeModules,
    },
  };
}

// BK2101 + 반복/고빈도/정적유지/휴식불충분까지 채워 riskFactorCount=5(core_exposure_present·
// daily_share_high·rest_unfavorable·bk2101_high_freq_example·bk2101_pattern_supported) —
// high burden gate도 만족해 burdenGrade='고도'.
const COMPLETE_ENTRY = {
  diagnosisId: 'dx-1',
  // 기본 fixture 진단(code: 'M770', 점 없음)은 inferElbowBkTypeFromDiagnosis 정규식(M77\.0)과
  // 안 맞아 자동추론이 ''가 된다 — bkSelectionMode:'manual'로 명시해 auto 재추론에 덮이지
  // 않게 한다.
  selectedBkType: 'BK2101',
  bkSelectionMode: 'manual',
  direct_anatomic_link: 'yes',
  exposure_types: ['repetition'],
  main_task_name: '문제 작업',
  repetition_level: 'frequent',
  daily_exposure_hours: '4',
  shift_share_percent: '50',
  days_per_week: '5',
  work_pattern: 'continuous',
  rest_distribution: 'insufficient',
  bk2101_cycle_seconds: '0.3',
  bk2101_monotony: 'yes',
  static_holding_level: 'frequent',
  bk2101_forced_dorsal_extension: 'yes',
  bk2101_prosupination: 'no',
};

describe('extractElbowBurdenGradeMax — 우선순위 사슬(§1-1a)', () => {
  it('순서 1: 모듈이 activeModules에 없으면 structural_missing', () => {
    const result = extractElbowBurdenGradeMax(migrate(baseCase({ activeModules: [] })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 1: activeModules엔 있는데 data.modules.elbow가 plain object가 아니면 structural_missing', () => {
    const result = extractElbowBurdenGradeMax(migrate(baseCase({ includeElbowModule: false })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('순서 2: 팔꿈치 진단이 없으면 not_entered', () => {
    const result = extractElbowBurdenGradeMax(migrate(baseCase({ diagnoses: [] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 2: shared.jobs가 비어있으면 not_entered', () => {
    const result = extractElbowBurdenGradeMax(migrate(baseCase({ jobs: [] })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3: 진단 entry가 아예 없으면(필수 필드 전부 미입력) not_entered', () => {
    const result = extractElbowBurdenGradeMax(migrate(baseCase({})));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3: 필수 필드 일부만 입력되면 not_entered', () => {
    const result = extractElbowBurdenGradeMax(
      migrate(
        baseCase({
          jobEvaluations: [
            { sharedJobId: 'job-1', diagnosisEntries: [{ diagnosisId: 'dx-1', direct_anatomic_link: 'yes', exposure_types: ['repetition'] }] },
          ],
        }),
      ),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 3: 시간적 선후관계 공통 필드 미입력이면 not_entered(진단 entry는 완전해도)', () => {
    const result = extractElbowBurdenGradeMax(
      migrate(
        baseCase({
          jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [COMPLETE_ENTRY] }],
          temporalSequence: { recent_task_change: 'increased_load' }, // improves_with_rest 미입력
        }),
      ),
    );
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('순서 4: 정상 입력 — high burden gate 충족 시 value: "고도"', () => {
    const result = extractElbowBurdenGradeMax(
      migrate(
        baseCase({
          jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [COMPLETE_ENTRY] }],
          temporalSequence: { recent_task_change: 'none', improves_with_rest: 'no' },
        }),
      ),
    );
    expect(result).toEqual({ value: '고도', missing: null, qualityFlags: [] });
  });

  // anyFlagged(구 대표변수, 2026-09-05 리뷰로 폐기)는 core_exposure_present/unclear·
  // daily_share_* 중 하나가 완전한 평가에서 항상 켜져 근본적으로 "항상 true"에 가까운
  // 무의미한 비교 변수였다. burdenGrade는 RISK_FACTOR_FLAGS만 세는 riskFactorCount 기반이라
  // 실제로 분산이 있다 — 이 테스트는 위험요인이 1개뿐이면(daily_share_low·핵심노출 확인 등
  // 비위험 항목은 세지 않고) burdenGrade가 실제로 '부담 작업 아님'으로 낮게 나옴을 확인한다.
  it('순서 4: 정상 입력 — 위험요인이 1개뿐이면 value: "부담 작업 아님"', () => {
    const lowRiskEntry = {
      diagnosisId: 'dx-1',
      selectedBkType: 'BK2105',
      bkSelectionMode: 'manual',
      main_task_name: '문제 작업',
      direct_anatomic_link: 'yes',
      exposure_types: ['repetition'],
      repetition_level: 'occasional',
      daily_exposure_hours: '0.1',
      shift_share_percent: '1',
      days_per_week: '1',
      work_pattern: 'intermittent',
      rest_distribution: 'adequate',
      direct_pressure_level: 'none',
      bk2105_elbow_leaning: 'no',
    };
    const result = extractElbowBurdenGradeMax(
      migrate(
        baseCase({
          jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [lowRiskEntry] }],
          temporalSequence: { recent_task_change: 'none', improves_with_rest: 'yes' },
        }),
      ),
    );
    expect(result).toEqual({ value: '부담 작업 아님', missing: null, qualityFlags: [] });
  });

  it('순서 4: 직력이 2개면 그중 더 심각한(worst) 등급을 case 대표값으로 낸다', () => {
    const lowRiskEntryForJob2 = {
      diagnosisId: 'dx-1',
      selectedBkType: 'BK2105',
      bkSelectionMode: 'manual',
      main_task_name: '문제 작업',
      direct_anatomic_link: 'yes',
      exposure_types: ['repetition'],
      repetition_level: 'occasional',
      daily_exposure_hours: '0.1',
      shift_share_percent: '1',
      days_per_week: '1',
      work_pattern: 'intermittent',
      rest_distribution: 'adequate',
      direct_pressure_level: 'none',
      bk2105_elbow_leaning: 'no',
    };
    const result = extractElbowBurdenGradeMax(
      migrate(
        baseCase({
          jobs: [
            { id: 'job-1', jobName: '조립공' },
            { id: 'job-2', jobName: '포장공' },
          ],
          jobEvaluations: [
            { sharedJobId: 'job-1', diagnosisEntries: [lowRiskEntryForJob2] },
            { sharedJobId: 'job-2', diagnosisEntries: [COMPLETE_ENTRY] },
          ],
          temporalSequence: { recent_task_change: 'none', improves_with_rest: 'no' },
        }),
      ),
    );
    expect(result).toEqual({ value: '고도', missing: null, qualityFlags: [] });
  });

  it('순서 3b: 비어있지 않은 숫자 필드가 파싱 실패면 invalid qualityFlag(값은 그대로 계산)', () => {
    const invalidEntry = { ...COMPLETE_ENTRY, daily_exposure_hours: 'abc' };
    const result = extractElbowBurdenGradeMax(
      migrate(
        baseCase({
          jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [invalidEntry] }],
          temporalSequence: { recent_task_change: 'none', improves_with_rest: 'no' },
        }),
      ),
    );
    expect(result.missing).toBeNull();
    expect(result.qualityFlags).toEqual(['invalid']);
  });

  it('배열 원소 방어: shared.jobs/diagnoses에 null이 섞여 있어도 예외를 던지지 않는다', () => {
    expect(() =>
      extractElbowBurdenGradeMax(
        migrate(
          baseCase({
            jobs: [null, { id: 'job-1', jobName: '조립공' }] as unknown[],
            diagnoses: [null, { id: 'dx-1', code: 'M770', moduleId: 'elbow', side: 'right' }] as unknown[],
          }),
        ),
      ),
    ).not.toThrow();
  });

  // §리뷰 지적(2026-09-05): deterministicMigrate()는 modules.elbow 내부의 중첩 구조까지는
  // 검증하지 않는다 — jobEvaluations/diagnosisEntries 원소가 null이거나 exposure_types가
  // 배열이 아니면 정규화 함수가 예외를 던졌다. 세 가지 반례를 각각 고정한다.
  it('배열 원소 방어: modules.elbow.jobEvaluations에 null이 섞여 있어도 예외를 던지지 않는다', () => {
    expect(() =>
      extractElbowBurdenGradeMax(
        migrate(
          baseCase({
            jobEvaluations: [null, { sharedJobId: 'job-1', diagnosisEntries: [] }] as unknown[],
          }),
        ),
      ),
    ).not.toThrow();
  });

  it('배열 원소 방어: jobEvaluations[].diagnosisEntries에 null이 섞여 있어도 예외를 던지지 않는다', () => {
    expect(() =>
      extractElbowBurdenGradeMax(
        migrate(
          baseCase({
            jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [null, COMPLETE_ENTRY] as unknown[] }],
            temporalSequence: { recent_task_change: 'none', improves_with_rest: 'no' },
          }),
        ),
      ),
    ).not.toThrow();
  });

  it('필드 타입 방어: exposure_types가 배열이 아니라 문자열이어도 예외를 던지지 않는다', () => {
    const malformedEntry = { ...COMPLETE_ENTRY, exposure_types: 'repetition' as unknown as string[] };
    expect(() =>
      extractElbowBurdenGradeMax(
        migrate(
          baseCase({
            jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [malformedEntry] }],
            temporalSequence: { recent_task_change: 'none', improves_with_rest: 'no' },
          }),
        ),
      ),
    ).not.toThrow();
  });

  // §리뷰 지적(2026-09-05, wrist에서 먼저 발견): exposure_types 외에 bk2105_pressure_source/
  // bk2106_pressure_source/bk2103_vibration_tool_type도 배열이어야 하는데 검증이 빠져
  // 있었다 — derived.ts의 formatList가 이 값에 .map()을 호출해 "arr.map is not a function"
  // 으로 예외가 났다.
  it('필드 타입 방어: bk2103_vibration_tool_type이 배열이 아니라 문자열이어도 예외를 던지지 않는다', () => {
    const malformedEntry = {
      ...COMPLETE_ENTRY,
      selectedBkType: 'BK2103',
      vibration_exposure: 'present',
      bk2103_vibration_tool_type: 'grinder' as unknown as string[],
      bk2103_daily_vibration_hours: '2',
    };
    expect(() =>
      extractElbowBurdenGradeMax(
        migrate(
          baseCase({
            jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [malformedEntry] }],
            temporalSequence: { recent_task_change: 'none', improves_with_rest: 'no' },
          }),
        ),
      ),
    ).not.toThrow();
  });

  it('필드 타입 방어: bk2105_pressure_source가 배열이 아니라 문자열이어도 예외를 던지지 않는다', () => {
    const malformedEntry = {
      ...COMPLETE_ENTRY,
      selectedBkType: 'BK2105',
      direct_pressure_level: 'frequent',
      bk2105_pressure_source: 'hard_surface' as unknown as string[],
      bk2105_elbow_leaning: 'yes',
    };
    expect(() =>
      extractElbowBurdenGradeMax(
        migrate(
          baseCase({
            jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [malformedEntry] }],
            temporalSequence: { recent_task_change: 'none', improves_with_rest: 'no' },
          }),
        ),
      ),
    ).not.toThrow();
  });

  // §리뷰 지적(2026-09-05): metadata.ts의 diagnosisEvaluations[] dependsOn이 diagnosisId/
  // linkedJobId/selectedBkType 3개뿐이었는데, buildLegacyEntryMap이 레거시 entry 전체를
  // 스프레드해서 direct_anatomic_link 하나만 바뀌어도 결과가 달라진다 — 이 실제 동작을
  // 고정한다(metadata의 dependsOn이 이 필드를 빠뜨리면 coverage inventory가 놓친다).
  it('레거시 diagnosisEvaluations: direct_anatomic_link만 바뀌어도 결과가 달라진다("부담 작업 아님" → not_entered)', () => {
    const baseLegacyEntry = {
      diagnosisId: 'dx-1',
      selectedBkType: 'BK2105',
      main_task_name: '문제 작업',
      exposure_types: ['repetition'],
      repetition_level: 'occasional',
      daily_exposure_hours: '0.1',
      shift_share_percent: '1',
      days_per_week: '1',
      work_pattern: 'intermittent',
      rest_distribution: 'adequate',
      direct_pressure_level: 'none',
      bk2105_elbow_leaning: 'no',
    };
    const withNo = extractElbowBurdenGradeMax(
      migrate({
        data: {
          shared: { jobs: [{ id: 'job-1', jobName: '조립공' }], diagnoses: [{ id: 'dx-1', code: 'M770', moduleId: 'elbow', side: 'right' }] },
          modules: { elbow: { diagnosisEvaluations: [{ ...baseLegacyEntry, direct_anatomic_link: 'no' }], temporalSequence: { recent_task_change: 'none', improves_with_rest: 'yes' } } },
          activeModules: ['elbow'],
        },
      }),
    );
    const withBlank = extractElbowBurdenGradeMax(
      migrate({
        data: {
          shared: { jobs: [{ id: 'job-1', jobName: '조립공' }], diagnoses: [{ id: 'dx-1', code: 'M770', moduleId: 'elbow', side: 'right' }] },
          modules: { elbow: { diagnosisEvaluations: [{ ...baseLegacyEntry, direct_anatomic_link: '' }], temporalSequence: { recent_task_change: 'none', improves_with_rest: 'yes' } } },
          activeModules: ['elbow'],
        },
      }),
    );
    expect(withNo.value).toBe('부담 작업 아님');
    expect(withBlank).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });
});

// PR0-B4 Slice 8a — temporal 4개(case grain, 병합 결과 기준).
describe('extractElbowTemporal* — case grain(temporalSequence/temporalRelation 병합 결과)', () => {
  it('모듈 비활성이면 structural_missing', () => {
    const result = extractElbowTemporalRecentTaskChange(migrate(baseCase({ activeModules: [] })));
    expect(result).toEqual({ value: null, missing: 'structural_missing', qualityFlags: [] });
  });

  it('temporalSequence가 비어있으면 not_entered', () => {
    const result = extractElbowTemporalRecentTaskChange(migrate(baseCase({ temporalSequence: {} })));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('recentTaskChange — 정상 도메인 값은 그대로 통과, 도메인 밖 값은 invalid', () => {
    const ok = extractElbowTemporalRecentTaskChange(migrate(baseCase({ temporalSequence: { recent_task_change: 'new_task' } })));
    expect(ok).toEqual({ value: 'new_task', missing: null, qualityFlags: [] });
    const bad = extractElbowTemporalRecentTaskChange(migrate(baseCase({ temporalSequence: { recent_task_change: 'unknown_value' } })));
    expect(bad).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('taskChangeDate — 정상 ISO 날짜 통과, 형식 불일치는 invalid', () => {
    const ok = extractElbowTemporalTaskChangeDate(migrate(baseCase({ temporalSequence: { task_change_date: '2024-03-01' } })));
    expect(ok).toEqual({ value: '2024-03-01', missing: null, qualityFlags: [] });
    const bad = extractElbowTemporalTaskChangeDate(migrate(baseCase({ temporalSequence: { task_change_date: '2024/03/01' } })));
    expect(bad).toEqual({ value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
  });

  it('symptomOnsetInterval — 자유 문자열은 그대로 통과', () => {
    const result = extractElbowTemporalSymptomOnsetInterval(migrate(baseCase({ temporalSequence: { symptom_onset_interval: '2주' } })));
    expect(result).toEqual({ value: '2주', missing: null, qualityFlags: [] });
  });

  it('improvesWithRest — yes/no만 boolean으로 변환, 그 외는 invalid', () => {
    expect(extractElbowTemporalImprovesWithRest(migrate(baseCase({ temporalSequence: { improves_with_rest: 'yes' } })))).toEqual({
      value: true, missing: null, qualityFlags: [],
    });
    expect(extractElbowTemporalImprovesWithRest(migrate(baseCase({ temporalSequence: { improves_with_rest: 'no' } })))).toEqual({
      value: false, missing: null, qualityFlags: [],
    });
    expect(extractElbowTemporalImprovesWithRest(migrate(baseCase({ temporalSequence: { improves_with_rest: 'maybe' } })))).toEqual({
      value: null, missing: 'not_entered', qualityFlags: ['invalid'],
    });
  });

  it('temporalRelation(legacy alias)만 있어도 동일하게 읽힌다', () => {
    const payload = {
      data: {
        shared: { jobs: [{ id: 'job-1', jobName: '조립공' }], diagnoses: [] },
        modules: { elbow: { temporalRelation: { recent_task_change: 'process_change' } } },
        activeModules: ['elbow'],
      },
    };
    expect(extractElbowTemporalRecentTaskChange(migrate(payload))).toEqual({ value: 'process_change', missing: null, qualityFlags: [] });
  });
});

// PR0-B4 Slice 8b — job_diagnosis grain 공통 필드. entityKey=[jobId, diagnosisId].
describe('extractElbowJobDiagnosis* — job_diagnosis grain(cross join, direct_anatomic_link 게이트)', () => {
  const GATED_ENTRY = {
    diagnosisId: 'dx-1',
    selectedBkType: 'BK2101',
    bkSelectionMode: 'manual',
    direct_anatomic_link: 'yes',
    exposure_types: ['repetition'],
    main_task_name: '  박스   운반  ',
    repetition_level: 'frequent',
    force_level: 'high',
    work_pattern: 'continuous',
    rest_distribution: 'insufficient',
    daily_exposure_hours: '4',
    shift_share_percent: '50',
    days_per_week: '5',
  };

  it('cross join — 진단이 있으면 job×diagnosis 조합 전부가 행이 된다(손 안 댄 조합도 포함)', () => {
    const result = extractElbowJobDiagnosisSelectedBkType(migrate(baseCase({})));
    expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
  });

  it('selectedBkType — 정상 도메인 값 통과, 도메인 밖 값은 invalid, 미입력은 not_entered', () => {
    const ok = extractElbowJobDiagnosisSelectedBkType(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [GATED_ENTRY] }] })),
    );
    expect(ok).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 'BK2101', missing: null, qualityFlags: [] }]);
    const bad = extractElbowJobDiagnosisSelectedBkType(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, selectedBkType: 'BK9999' }] }] })),
    );
    expect(bad).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('direct_anatomic_link !== "yes"이면 게이트된 필드 전부 not_applicable(main_task_name 예시)', () => {
    const closed = extractElbowJobDiagnosisMainTaskName(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, direct_anatomic_link: 'no' }] }] })),
    );
    expect(closed).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('main_task_name — 게이트 열림 + job.identity.jobNameNormalized와 동일한 정규화(공백 정리)', () => {
    const result = extractElbowJobDiagnosisMainTaskName(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [GATED_ENTRY] }] })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: '박스 운반', missing: null, qualityFlags: [] }]);
  });

  it('exposureType.repetition/.force — exposure_types 배열 포함 여부를 그대로 반영', () => {
    const mr = migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [GATED_ENTRY] }] }));
    expect(extractElbowJobDiagnosisExposureTypeRepetition(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
    expect(extractElbowJobDiagnosisExposureTypeForce(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
  });

  it('repetitionLevel — 이중 게이트: exposure_types에 repetition이 없으면 not_applicable', () => {
    const result = extractElbowJobDiagnosisRepetitionLevel(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, exposure_types: ['force'] }] }] })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('repetitionLevel/forceLevel — 게이트 열림 + 정상 도메인 값 통과', () => {
    const mr = migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, exposure_types: ['repetition', 'force'] }] }] }));
    expect(extractElbowJobDiagnosisRepetitionLevel(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 'frequent', missing: null, qualityFlags: [] }]);
    expect(extractElbowJobDiagnosisForceLevel(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 'high', missing: null, qualityFlags: [] }]);
  });

  it('workPattern/restDistribution — exposure_types와 무관하게 direct_anatomic_link만 게이트', () => {
    const mr = migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, exposure_types: [] }] }] }));
    expect(extractElbowJobDiagnosisWorkPattern(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 'continuous', missing: null, qualityFlags: [] }]);
    expect(extractElbowJobDiagnosisRestDistribution(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 'insufficient', missing: null, qualityFlags: [] }]);
  });

  it('dailyExposureHours/shiftSharePercent/daysPerWeek — 정상 통과 + 상한/음수 위반은 invalid', () => {
    const mr = migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [GATED_ENTRY] }] }));
    expect(extractElbowJobDiagnosisDailyExposureHours(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 4, missing: null, qualityFlags: [] }]);
    expect(extractElbowJobDiagnosisShiftSharePercent(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 50, missing: null, qualityFlags: [] }]);
    expect(extractElbowJobDiagnosisDaysPerWeek(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 5, missing: null, qualityFlags: [] }]);

    const overPercent = extractElbowJobDiagnosisShiftSharePercent(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, shift_share_percent: '150' }] }] })),
    );
    expect(overPercent).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);

    const overDays = extractElbowJobDiagnosisDaysPerWeek(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, days_per_week: '8' }] }] })),
    );
    expect(overDays).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);

    const negative = extractElbowJobDiagnosisDailyExposureHours(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, daily_exposure_hours: '-1' }] }] })),
    );
    expect(negative).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('배열로 감싼 값·빈 배열은 강제변환으로 통과시키지 않는다(9차 검토 원칙)', () => {
    const result = extractElbowJobDiagnosisDailyExposureHours(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ENTRY, daily_exposure_hours: [4] as unknown }] }] })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
  });

  it('bkAutoSyncedFrom이 있으면 inferred_link 플래그가 붙는다(selectedBkType 자체는 제외)', () => {
    const synced = { ...GATED_ENTRY, bkAutoSyncedFrom: 'dx-0' };
    const mr = migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [synced] }] }));
    expect(extractElbowJobDiagnosisMainTaskName(mr)[0].qualityFlags).toContain('inferred_link');
    expect(extractElbowJobDiagnosisSelectedBkType(mr)[0].qualityFlags).not.toContain('inferred_link');
  });

  it('wrist 전용 상병(moduleId=wrist)에 대해서는 elbow extractor가 not_applicable을 반환한다', () => {
    const payload = {
      data: {
        shared: {
          jobs: [{ id: 'job-1', jobName: '조립공' }],
          diagnoses: [{ id: 'dx-w', code: 'G560', moduleId: 'wrist', side: 'right' }],
        },
        modules: { wrist: { jobEvaluations: [] }, elbow: { jobEvaluations: [] } },
        activeModules: ['elbow', 'wrist'],
      },
    };
    const result = extractElbowJobDiagnosisSelectedBkType(migrate(payload));
    expect(result).toEqual([{ entityKey: ['job-1', 'dx-w'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });
});

// PR0-B4 Slice 8c — BK유형별 세부 분기 필드 35개. 게이트 3단계(외곽 direct_anatomic_link,
// 내곽 selectedBkType, 필드레벨 direct_pressure_level/vibration_exposure)와 §다중선택
// 배열 계약을 검증한다.
describe('extractElbowJobDiagnosis* — Slice 8c: BK유형별 세부 분기 필드', () => {
  it('외곽 게이트: direct_anatomic_link !== "yes"이면 not_applicable(bk2101_monotony 예시)', () => {
    const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2101',  bkSelectionMode: 'manual', direct_anatomic_link: 'no', bk2101_monotony: 'yes' };
    const result = extractElbowJobDiagnosisBk2101Monotony(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('내곽 게이트: selectedBkType이 해당 BK유형이 아니면 not_applicable(BK2101 필드에 BK2103 진단)', () => {
    const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2103',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', bk2101_monotony: 'yes' };
    const result = extractElbowJobDiagnosisBk2101Monotony(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] })),
    );
    expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('bkAutoSyncedFrom이 있으면 inferred_link 플래그가 붙는다(vibrationExposure 예시)', () => {
    const synced = {
      diagnosisId: 'dx-1',
      selectedBkType: 'BK2103',  bkSelectionMode: 'manual',
      direct_anatomic_link: 'yes',
      vibration_exposure: 'present',
      bkAutoSyncedFrom: 'dx-0',
    };
    const result = extractElbowJobDiagnosisVibrationExposure(
      migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [synced] }] })),
    );
    expect(result[0].qualityFlags).toContain('inferred_link');
  });

  describe('staticHoldingLevel/directPressureLevel — FREQUENCY_WITH_NONE(none/occasional/frequent) 도메인', () => {
    it('staticHoldingLevel — BK2101/BK2106에서만 열림, BK2105는 not_applicable', () => {
      const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2105',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', static_holding_level: 'frequent' };
      const result = extractElbowJobDiagnosisStaticHoldingLevel(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] })),
      );
      expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
    });

    it('staticHoldingLevel — BK2106에서 정상 값 통과 + 미입력 not_entered + 도메인 밖 invalid', () => {
      const mk = (v: unknown) => ({ diagnosisId: 'dx-1', selectedBkType: 'BK2106',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', static_holding_level: v });
      expect(
        extractElbowJobDiagnosisStaticHoldingLevel(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('none')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 'none', missing: null, qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisStaticHoldingLevel(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisStaticHoldingLevel(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('sometimes')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
    });

    it('directPressureLevel — BK2105/BK2106에서만 열림, BK2101은 not_applicable', () => {
      const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2101',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', direct_pressure_level: 'frequent' };
      const result = extractElbowJobDiagnosisDirectPressureLevel(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] })),
      );
      expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
    });

    it('directPressureLevel — BK2105에서 정상 값 통과', () => {
      const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2105',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', direct_pressure_level: 'occasional' };
      const result = extractElbowJobDiagnosisDirectPressureLevel(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] })),
      );
      expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 'occasional', missing: null, qualityFlags: [] }]);
    });
  });

  describe('vibrationExposure — BK2103 전용, present/none/invalid/blank', () => {
    const mk = (v: unknown) => ({ diagnosisId: 'dx-1', selectedBkType: 'BK2103',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', vibration_exposure: v });

    it('present → true, none → false, blank → not_entered, 그 외 → invalid', () => {
      expect(
        extractElbowJobDiagnosisVibrationExposure(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('present')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisVibrationExposure(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('none')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisVibrationExposure(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisVibrationExposure(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('maybe')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
    });

    it('BK2103이 아니면 not_applicable', () => {
      const result = extractElbowJobDiagnosisVibrationExposure(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...mk('present'), selectedBkType: 'BK2101' }] }] })),
      );
      expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
    });
  });

  describe('bk2101 숫자 필드 — cycle_seconds/repetition_per_hour(비음수, 재계산 없이 raw 통과)', () => {
    const mk = (field: string, v: unknown) => ({ diagnosisId: 'dx-1', selectedBkType: 'BK2101',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', [field]: v });

    it('cycleSeconds — 정상 숫자문자열 통과 + 음수/비숫자 invalid + 공백 not_entered', () => {
      expect(
        extractElbowJobDiagnosisBk2101CycleSeconds(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('bk2101_cycle_seconds', '0.5')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 0.5, missing: null, qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisBk2101CycleSeconds(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('bk2101_cycle_seconds', '-1')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
      expect(
        extractElbowJobDiagnosisBk2101CycleSeconds(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('bk2101_cycle_seconds', 'abc')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
      expect(
        extractElbowJobDiagnosisBk2101CycleSeconds(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('bk2101_cycle_seconds', '')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
    });

    it('repetitionPerHour — readOnly 계산 필드지만 raw 저장값을 재계산 없이 그대로 통과시킨다', () => {
      const result = extractElbowJobDiagnosisBk2101RepetitionPerHour(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('bk2101_repetition_per_hour', '9999')] }] })),
      );
      expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 9999, missing: null, qualityFlags: [] }]);
    });
  });

  describe('yes/no 필드 — monotony/forced_dorsal_extension/prosupination/elbow_leaning/tool_pressing/frequent_high_force_grip', () => {
    it('bk2101_monotony — yes/no/invalid/blank 도메인 대표 검증', () => {
      const mk = (v: unknown) => ({ diagnosisId: 'dx-1', selectedBkType: 'BK2101',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', bk2101_monotony: v });
      expect(
        extractElbowJobDiagnosisBk2101Monotony(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('yes')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisBk2101Monotony(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('no')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisBk2101Monotony(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: [] }]);
      expect(
        extractElbowJobDiagnosisBk2101Monotony(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [mk('unsure')] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
    });

    it('나머지 yes/no 필드 5개 — 각자의 BK 게이트에서 정상 값 통과(배선 확인)', () => {
      const check = (fn: (mr: ReturnType<typeof migrate>) => unknown, field: string, bkType: string) => {
        const entry = { diagnosisId: 'dx-1', selectedBkType: bkType, bkSelectionMode: 'manual', direct_anatomic_link: 'yes', [field]: 'yes' };
        const result = fn(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] })));
        expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      };
      check(extractElbowJobDiagnosisBk2101ForcedDorsalExtension, 'bk2101_forced_dorsal_extension', 'BK2101');
      check(extractElbowJobDiagnosisBk2101Prosupination, 'bk2101_prosupination', 'BK2101');
      check(extractElbowJobDiagnosisBk2105ElbowLeaning, 'bk2105_elbow_leaning', 'BK2105');
      check(extractElbowJobDiagnosisBk2103ToolPressing, 'bk2103_tool_pressing', 'BK2103');
      check(extractElbowJobDiagnosisBk2103FrequentHighForceGrip, 'bk2103_frequent_high_force_grip', 'BK2103');
    });
  });

  describe('bk2103DailyVibrationHours — BK2103 + vibration_exposure==="present" 이중 게이트', () => {
    it('vibration_exposure가 present가 아니면 not_applicable(selectedBkType은 BK2103이어도)', () => {
      const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2103',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', vibration_exposure: 'none', bk2103_daily_vibration_hours: '2' };
      const result = extractElbowJobDiagnosisBk2103DailyVibrationHours(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] })),
      );
      expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
    });

    it('게이트 열림 + 정상 숫자 통과, 음수는 invalid', () => {
      const okEntry = { diagnosisId: 'dx-1', selectedBkType: 'BK2103',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', vibration_exposure: 'present', bk2103_daily_vibration_hours: '3.5' };
      expect(
        extractElbowJobDiagnosisBk2103DailyVibrationHours(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [okEntry] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: 3.5, missing: null, qualityFlags: [] }]);
      const badEntry = { ...okEntry, bk2103_daily_vibration_hours: '-2' };
      expect(
        extractElbowJobDiagnosisBk2103DailyVibrationHours(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [badEntry] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);
    });
  });

  describe('다중선택 — bk2105_pressure_source/bk2106_pressure_source/bk2103_vibration_tool_type(§다중선택 배열 계약)', () => {
    it('bk2105_pressure_source — 미입력(cross join 손 안 댄 조합)은 정상 false, 비배열·null 원본값은 normalizeDiagnosisEntry의 _corruptedArrayFields 마커로 invalid 유지(§다중선택 배열 계약 리뷰 지적 수정), 원소손상·정상 배열은 기존대로', () => {
      const base = { diagnosisId: 'dx-1', selectedBkType: 'BK2105',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', direct_pressure_level: 'frequent' };

      // 필드 자체를 아예 건드리지 않은 cross join 조합 — job_diagnosis 계약상 정상 false.
      expect(
        extractElbowJobDiagnosisBk2105PressureSourceHardSurface(migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [base] }] }))),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);

      // 원본값이 명시적으로 존재하지만 배열이 아님(문자열) — invalid.
      expect(
        extractElbowJobDiagnosisBk2105PressureSourceHardSurface(
          migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...base, bk2105_pressure_source: 'hard_surface' }] }] })),
        ),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);

      // 원본값이 명시적으로 null — invalid(리뷰 지적 재현 케이스).
      expect(
        extractElbowJobDiagnosisBk2105PressureSourceHardSurface(
          migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...base, bk2105_pressure_source: null }] }] })),
        ),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);

      expect(
        extractElbowJobDiagnosisBk2105PressureSourceHardSurface(
          migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...base, bk2105_pressure_source: [123] }] }] })),
        ),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] }]);

      expect(
        extractElbowJobDiagnosisBk2105PressureSourceHardSurface(
          migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...base, bk2105_pressure_source: [] }] }] })),
        ),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);

      expect(
        extractElbowJobDiagnosisBk2105PressureSourceHardSurface(
          migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...base, bk2105_pressure_source: ['hard_surface', 'legacy_weird_value'] }] }] })),
        ),
      ).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: ['legacy_unknown'] }]);
    });

    it('BK 자동복사(donor-copy) — 도너의 손상 필드를 물려받은 entry도 손상 상태 그대로 유지한다(§리뷰 지적 — 복사한다고 값의 신뢰성이 회복되지 않는다)', () => {
      // 자동복사는 "같은 job 안에서 같은 selectedBkType을 공유하는 서로 다른 진단" 사이에서
      // 일어난다(legacyNormalize.ts의 diagnosisEntries.forEach) — dx-1은 압박원이 손상값
      // (문자열)이지만 다른 필드가 채워져 있어 scoreDiagnosisEntry > 0 → donor 자격을 얻고,
      // dx-2("팔꿈치 점액낭염" — inferElbowBkTypeFromDiagnosis 규칙상 BK2105로 자동추론)는
      // entry 자체가 없어 완전히 비어있는(score=0) 자동복사 대상이 된다.
      const donor = {
        diagnosisId: 'dx-1',
        selectedBkType: 'BK2105',
        bkSelectionMode: 'manual',
        direct_anatomic_link: 'yes',
        direct_pressure_level: 'frequent',
        bk2105_elbow_leaning: 'yes',
        bk2105_pressure_source: 'hard_surface',
      };
      const mr = migrate(
        baseCase({
          diagnoses: [
            { id: 'dx-1', code: 'M770', moduleId: 'elbow', side: 'right' },
            { id: 'dx-2', code: 'M770', name: '팔꿈치 점액낭염', moduleId: 'elbow', side: 'right' },
          ],
          jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [donor] }],
        }),
      );
      const results = extractElbowJobDiagnosisBk2105PressureSourceHardSurface(mr);
      const donorResult = results.find((r) => r.entityKey[1] === 'dx-1');
      const receiverResult = results.find((r) => r.entityKey[1] === 'dx-2');
      expect(donorResult).toEqual({ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_entered', qualityFlags: ['invalid'] });
      // 도너의 압박원이 손상값이었으므로, 그 값을 물려받은 entry도 손상 상태를 그대로
      // 이어받아 invalid가 붙어야 한다 — inferred_link만 붙고 invalid가 빠지면 손상값이
      // 정상 미선택으로 집계되는 리뷰 지적 그 자체다.
      expect(receiverResult).toEqual({ entityKey: ['job-1', 'dx-2'], value: null, missing: 'not_entered', qualityFlags: ['inferred_link', 'invalid'] });
    });

    it('BK 자동복사(donor-copy) — 도너 필드가 정상이면 수신자에 남아있던 이전 손상 표시를 지운다', () => {
      // dx-2 자신의 원본값이 손상(문자열)이었지만, bkSelectionMode:'auto'라 진단명 기반
      // 재추론으로 selectedBkType이 BK2101→BK2105로 "방금 바뀐" 상태가 된다
      // (bkTypeJustChanged) — 그러면서 다른 실입력이 전혀 없어 score=0이 되어 자동복사
      // 대상이 되고, 도너(dx-1)는 압박원이 정상 배열이다.
      const donor = {
        diagnosisId: 'dx-1',
        selectedBkType: 'BK2105',
        bkSelectionMode: 'manual',
        direct_anatomic_link: 'yes',
        direct_pressure_level: 'frequent',
        bk2105_elbow_leaning: 'yes',
        bk2105_pressure_source: ['tool_edge'],
      };
      const staleReceiver = {
        diagnosisId: 'dx-2',
        selectedBkType: 'BK2101',
        bkSelectionMode: 'auto',
        bk2105_pressure_source: 'garbage-string',
      };
      const mr = migrate(
        baseCase({
          diagnoses: [
            { id: 'dx-1', code: 'M770', moduleId: 'elbow', side: 'right' },
            { id: 'dx-2', code: 'M770', name: '팔꿈치 점액낭염', moduleId: 'elbow', side: 'right' },
          ],
          jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [donor, staleReceiver] }],
        }),
      );
      const results = extractElbowJobDiagnosisBk2105PressureSourceToolEdge(mr);
      const receiverResult = results.find((r) => r.entityKey[1] === 'dx-2');
      // 도너 값이 정상 배열이므로 이전에 dx-2 자신이 갖고 있던 손상 표시는 사라지고,
      // 도너로부터 물려받은 값이 그대로 반영되어 invalid 없이 true여야 한다.
      expect(receiverResult).toEqual({ entityKey: ['job-1', 'dx-2'], value: true, missing: null, qualityFlags: ['inferred_link'] });
    });

    it('bk2105_pressure_source — 게이트: direct_pressure_level이 없거나 "none"이면 not_applicable(selectedBkType=BK2105이어도)', () => {
      const closedBlank = extractElbowJobDiagnosisBk2105PressureSourceHardSurface(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ diagnosisId: 'dx-1', selectedBkType: 'BK2105',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', bk2105_pressure_source: ['hard_surface'] }] }] })),
      );
      expect(closedBlank).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);

      const closedNone = extractElbowJobDiagnosisBk2105PressureSourceHardSurface(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ diagnosisId: 'dx-1', selectedBkType: 'BK2105',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', direct_pressure_level: 'none', bk2105_pressure_source: ['hard_surface'] }] }] })),
      );
      expect(closedNone).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
    });

    it('bk2105_pressure_source — 5개 옵션 전부 배선 확인', () => {
      const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2105',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', direct_pressure_level: 'frequent', bk2105_pressure_source: ['hard_surface', 'carrying_contact'] };
      const mr = migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] }));
      expect(extractElbowJobDiagnosisBk2105PressureSourceHardSurface(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2105PressureSourceToolEdge(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2105PressureSourceGroundContact(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2105PressureSourceCarryingContact(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2105PressureSourceOther(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
    });

    it('bk2106_pressure_source — bk2105와 별도 필드·네임스페이스(elbow는 동일 옵션셋), 5개 옵션 전부 배선 확인', () => {
      const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2106',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', direct_pressure_level: 'occasional', bk2106_pressure_source: ['tool_edge', 'other'] };
      const mr = migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] }));
      expect(extractElbowJobDiagnosisBk2106PressureSourceHardSurface(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2106PressureSourceToolEdge(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2106PressureSourceGroundContact(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2106PressureSourceCarryingContact(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2106PressureSourceOther(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      // bk2105 전용 extractor는 BK2106 진단에 대해 selectedBkType 불일치로 not_applicable
      expect(extractElbowJobDiagnosisBk2105PressureSourceHardSurface(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
    });

    it('bk2103_vibration_tool_type(13개 옵션) — 게이트: vibration_exposure==="present"에서만 열림, 옵션 배선 확인', () => {
      const entry = {
        diagnosisId: 'dx-1',
        selectedBkType: 'BK2103',  bkSelectionMode: 'manual',
        direct_anatomic_link: 'yes',
        vibration_exposure: 'present',
        bk2103_vibration_tool_type: ['grinder', 'rivet_hammer', 'other'],
      };
      const mr = migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] }));
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeGrinder(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeJackhammer(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeDemolitionHammer(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeChippingHammer(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeTampingMachine(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeRotaryHammer(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeCompactor(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeReciprocatingSaw(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeRivetHammer(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeRustHammer(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypePowderActuatedTool(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeForgingHammer(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: false, missing: null, qualityFlags: [] }]);
      expect(extractElbowJobDiagnosisBk2103VibrationToolTypeOther(mr)).toEqual([{ entityKey: ['job-1', 'dx-1'], value: true, missing: null, qualityFlags: [] }]);
    });

    it('bk2103_vibration_tool_type — vibration_exposure가 present가 아니면 not_applicable', () => {
      const entry = { diagnosisId: 'dx-1', selectedBkType: 'BK2103',  bkSelectionMode: 'manual', direct_anatomic_link: 'yes', vibration_exposure: 'none', bk2103_vibration_tool_type: ['grinder'] };
      const result = extractElbowJobDiagnosisBk2103VibrationToolTypeGrinder(
        migrate(baseCase({ jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [entry] }] })),
      );
      expect(result).toEqual([{ entityKey: ['job-1', 'dx-1'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
    });
  });
});
