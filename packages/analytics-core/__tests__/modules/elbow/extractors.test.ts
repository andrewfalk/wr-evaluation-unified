import { describe, it, expect } from 'vitest';
import { extractElbowBurdenGradeMax } from '../../../modules/elbow/extractors';
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
