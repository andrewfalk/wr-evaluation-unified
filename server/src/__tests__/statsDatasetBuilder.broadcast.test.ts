// PR0-B4 개정(grain 단순화 + 공통변수 브로드캐스트) — buildRepeatedGrainDataset의 브로드캐스트
// 분기(statsDatasetBuilder.ts:300-314) 전용 테스트. person/case(+meta 2종)의 브로드캐스트
// 안전 변수가 job/disease grain에서도 case당 1회만 계산돼 그 case의 모든 entityKey 버킷에
// 그대로 복제되는지, canonical 모집단(행 수)은 절대 바뀌지 않는지를 직접 검증한다.
import { describe, it, expect } from 'vitest';
import { buildDataset } from '../statsDatasetBuilder';
import { buildStatsEngineRequest } from '../statsDescriptiveSuppression';
import { getIntegratedCatalog } from '../statsCatalog';
import { computePredictionDataStages } from '../statsPredictionCohort';
import { MINIMUM_COHORT } from '../statsPolicy';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe } from '@wr/contracts';

const CATALOG_BY_KEY = new Map(getIntegratedCatalog().map((v) => [v.key, v]));
const RECIPE_DIGEST = 'test-recipe-digest';

function jobSnapshotRow(
  id: string,
  personId: string,
  jobs: Array<Record<string, unknown>>,
  overrides: Partial<Pick<SnapshotRow, 'assignedDoctorUserId' | 'createdAt'>> & { gender?: string } = {},
): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: overrides.assignedDoctorUserId ?? null,
    createdAt: overrides.createdAt ?? new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: { shared: { jobs, gender: overrides.gender }, modules: {}, activeModules: [] },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'job',
    variableKeys: ['job.identity.jobNameNormalized'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

const JOB_A = { id: 'job-1', jobName: '용접공', startDate: '2015-01-01', endDate: '2020-01-01' };
const JOB_B = { id: 'job-2', jobName: '조립공', startDate: '2020-01-01', endDate: '2021-01-01' };

// jobSnapshotRow는 diagnoses를 지원하지 않는다 — 아래 case-grain 롤업 브로드캐스트
// 계산 시점 테스트는 jobs와 diagnoses를 동시에 필요로 해서 별도 헬퍼로 구성한다.
function caseSnapshotRow(
  id: string,
  personId: string,
  data: { jobs?: Array<Record<string, unknown>>; diagnoses?: Array<Record<string, unknown>> },
): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: { shared: { jobs: data.jobs ?? [], diagnoses: data.diagnoses ?? [] }, modules: {}, activeModules: [] },
    },
  };
}

describe('buildRepeatedGrainDataset — 공통변수 브로드캐스트(case → job)', () => {
  it('job이 2개인 case에서 브로드캐스트 값(성별)이 정확히 2행에 복제된다', () => {
    const rows = [jobSnapshotRow('case-1', 'person-1', [JOB_A, JOB_B], { gender: 'female' })];
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['job.identity.jobNameNormalized', 'patient.identity.gender'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(2);
    for (const row of result.rows) {
      expect(row.values['patient.identity.gender']).toEqual({ value: 'female', missing: null, qualityFlags: [] });
    }
  });

  it('선택 변수 조합이 달라져도(브로드캐스트 키 포함 여부와 무관) canonical 행 수는 불변이다', () => {
    const rows = [jobSnapshotRow('case-1', 'person-1', [JOB_A, JOB_B], { gender: 'male' })];
    const withoutBroadcast = buildDataset(rows, recipe({ variableKeys: ['job.identity.jobNameNormalized'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const withBroadcast = buildDataset(
      rows,
      recipe({ variableKeys: ['job.identity.jobNameNormalized', 'patient.identity.gender'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(withBroadcast.observationCount).toBe(withoutBroadcast.observationCount);
    expect(withBroadcast.rows.map((r) => r.entityKey)).toEqual(withoutBroadcast.rows.map((r) => r.entityKey));
  });

  it('job이 0개인 case는 브로드캐스트 키를 요청해도 가짜 행을 만들지 않는다', () => {
    const rows = [jobSnapshotRow('case-1', 'person-1', [], { gender: 'male' })];
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['job.identity.jobNameNormalized', 'patient.identity.gender'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(0);
    expect(result.rows).toEqual([]);
  });

  it('브로드캐스트 필터(성별)와 job 고유 필터(근속연수)가 AND로 결합된다', () => {
    const rows = [
      jobSnapshotRow('case-1', 'person-1', [JOB_A], { gender: 'male' }), // tenure 5년, male
      jobSnapshotRow('case-2', 'person-2', [{ ...JOB_A, id: 'job-3', startDate: '2019-01-01' }], { gender: 'male' }), // tenure 1년, male
      jobSnapshotRow('case-3', 'person-3', [{ ...JOB_A, id: 'job-4' }], { gender: 'female' }), // tenure 5년, female
    ];
    const result = buildDataset(
      rows,
      recipe({
        variableKeys: ['job.identity.tenureYears'],
        filters: [
          { key: 'patient.identity.gender', operator: 'eq', value: 'male' },
          { key: 'job.identity.tenureYears', operator: 'gt', value: 3 },
        ],
      }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].caseId).toBe('case-1');
  });

  it('assignedDoctorUserId/registeredAt은 extractSnapshotColumnValue 경로로 브로드캐스트되고 missing/qualityFlags가 보존된다', () => {
    const rows = [
      jobSnapshotRow('case-1', 'person-1', [JOB_A, JOB_B], {
        assignedDoctorUserId: 'doctor-1',
        createdAt: new Date('2024-03-15T00:00:00.000Z'),
      }),
      jobSnapshotRow('case-2', 'person-2', [JOB_A], { assignedDoctorUserId: null }),
    ];
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['job.identity.jobNameNormalized', 'case.staff.assignedDoctorUserId', 'case.meta.registeredAt'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(3);
    const case1Rows = result.rows.filter((r) => r.caseId === 'case-1');
    expect(case1Rows).toHaveLength(2);
    for (const row of case1Rows) {
      expect(row.values['case.staff.assignedDoctorUserId']).toEqual({ value: 'doctor-1', missing: null, qualityFlags: [] });
      expect(row.values['case.meta.registeredAt']).toEqual({ value: '2024-03-15', missing: null, qualityFlags: [] });
    }
    const case2Row = result.rows.find((r) => r.caseId === 'case-2')!;
    expect(case2Row.values['case.staff.assignedDoctorUserId']).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('personCount/caseCount/observationCount은 브로드캐스트 존재 여부와 무관하게 정확히 계산된다', () => {
    const rows = [
      jobSnapshotRow('case-1', 'person-1', [JOB_A, JOB_B], { gender: 'male' }), // 2 jobs
      jobSnapshotRow('case-2', 'person-2', [JOB_A], { gender: 'female' }), // 1 job
    ];
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['job.identity.jobNameNormalized', 'patient.identity.gender'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.personCount).toBe(2);
    expect(result.caseCount).toBe(2);
    expect(result.observationCount).toBe(3);
  });

  // 계획 "검증 방법" §5의 Tier-3 등가 fixture — 남성 10명(각 job 3개)·여성 10명(각 job 1개),
  // job grain + 브로드캐스트된 성별로 실제 엔진 요청을 만들면 값이 사람 수(20)가 아니라
  // 관측 행 수(40) 기준으로 30:10이 되는지를 buildDataset→buildStatsEngineRequest 실제
  // 프로덕션 경로로 직접 증명한다(리뷰 지적 — 이 계산을 자동 회귀로 고정한 테스트가 없었음).
  it('남성 10명(job 3개씩)·여성 10명(job 1개씩) — job grain 엔진 요청의 성별 값은 30:10(행 기준, 인원 기준 아님)', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) =>
        jobSnapshotRow(`male-case-${i}`, `male-person-${i}`, [
          { ...JOB_A, id: `male-${i}-job-1` },
          { ...JOB_B, id: `male-${i}-job-2` },
          { ...JOB_A, id: `male-${i}-job-3`, startDate: '2010-01-01' },
        ], { gender: 'male' }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        jobSnapshotRow(`female-case-${i}`, `female-person-${i}`, [{ ...JOB_A, id: `female-${i}-job-1` }], { gender: 'female' }),
      ),
    ];
    const dataset = buildDataset(
      rows,
      recipe({ grain: 'job', variableKeys: ['patient.identity.gender'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(dataset.personCount).toBe(20);
    expect(dataset.caseCount).toBe(20);
    expect(dataset.observationCount).toBe(40);

    const engineRequest = buildStatsEngineRequest(dataset.rows, ['patient.identity.gender'], CATALOG_BY_KEY);
    const genderValues = engineRequest.variables.find((v) => v.key === 'patient.identity.gender')!.values;
    expect(genderValues).toHaveLength(40);
    expect(genderValues.filter((v) => v === 'male')).toHaveLength(30);
    expect(genderValues.filter((v) => v === 'female')).toHaveLength(10);
  });

  // 대조군 — 같은 사람에게 job을 20개 넣어도(관측 행 20개) 고유 인원은 1명뿐이라
  // MINIMUM_COHORT(statsAnalysisContext.ts가 dataset.personCount로 직접 판정) 미달로
  // 요청 전체가 억제돼야 한다. 행 복제로 관측 수가 아무리 늘어도 인원 보호는 독립적으로
  // 작동한다는 걸 증명한다(observationCount가 아니라 personCount를 본다는 게 핵심).
  it('한 사람이 job 20개를 가지면 observationCount=20이어도 personCount=1이라 MINIMUM_COHORT 미달이다', () => {
    const jobs = Array.from({ length: 20 }, (_, i) => ({ ...JOB_A, id: `solo-job-${i}` }));
    const rows = [jobSnapshotRow('solo-case', 'solo-person', jobs, { gender: 'male' })];
    const dataset = buildDataset(
      rows,
      recipe({ grain: 'job', variableKeys: ['patient.identity.gender'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(dataset.observationCount).toBe(20);
    expect(dataset.personCount).toBe(1);
    expect(dataset.personCount).toBeLessThan(MINIMUM_COHORT);
  });

  // Case-grain 롤업 변수 3종 추가 — 계획서 "브로드캐스트 계산 시점" 절: 브로드캐스트
  // 값은 필터 이전에 케이스 전체로 1회 계산돼 복제되므로, 그 후 필터로 일부 행이
  // 사라져도 이미 복제된 값 자체는 바뀌지 않는다.
  it('무릎 low·어깨 high 케이스에서 disease grain 필터로 무릎 행만 남겨도 anyHighRelatedness 브로드캐스트 값은 여전히 true', () => {
    const dxKnee = { id: 'dx-knee', code: 'M17.1', name: '무릎관절증', side: 'right', assessmentRight: 'low' };
    const dxShoulder = { id: 'dx-shoulder', code: 'M75.1', name: '회전근개파열', side: 'right', assessmentRight: 'high' };
    const rows = [caseSnapshotRow('case-1', 'person-1', { diagnoses: [dxKnee, dxShoulder] })];
    const result = buildDataset(
      rows,
      recipe({
        grain: 'disease',
        variableKeys: ['diagnosis.identity.moduleGroup', 'diagnosis.rollup.anyHighRelatedness'],
        filters: [{ key: 'diagnosis.identity.moduleGroup', operator: 'eq', value: 'knee' }],
      }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].values['diagnosis.identity.moduleGroup']).toEqual({ value: 'knee', missing: null, qualityFlags: [] });
    // 어깨(high) 상병이 필터로 화면에 안 보여도, 브로드캐스트 값은 케이스 전체 기준으로
    // 이미 계산된 것이라 true 그대로다.
    expect(result.rows[0].values['diagnosis.rollup.anyHighRelatedness']).toEqual({ value: true, missing: null, qualityFlags: [] });
  });

  it('job 필터로 대표 직력에 해당하는 job 행이 결과에서 사라져도, 남은 job 행에 복제된 longestTenureYears 값은 필터 전 계산값 그대로다', () => {
    const longJob = { id: 'job-long', jobName: '용접공', startDate: '2010-01-01', endDate: '2020-01-01' }; // 10년(대표)
    const shortJob = { id: 'job-short', jobName: '조립공', startDate: '2020-01-01', endDate: '2021-01-01' }; // 1년
    const rows = [caseSnapshotRow('case-1', 'person-1', { jobs: [longJob, shortJob] })];
    const result = buildDataset(
      rows,
      recipe({
        grain: 'job',
        variableKeys: ['job.identity.jobNameNormalized', 'job.rollup.longestTenureYears'],
        filters: [{ key: 'job.identity.tenureYears', operator: 'lt', value: 5 }],
      }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].values['job.identity.jobNameNormalized']).toEqual({ value: '조립공', missing: null, qualityFlags: [] });
    // 대표 직력(용접공, 10년)에 해당하는 job 행 자체는 필터로 사라졌지만, 브로드캐스트된
    // longestTenureYears는 필터 전 케이스 전체 기준(10년, 날짜차 계산이라 365.25일
    // 기준 근사치)이지 남은 job(조립공, 1년) 기준이 아니다.
    const longestTenureYearsResult = result.rows[0].values['job.rollup.longestTenureYears'];
    expect(longestTenureYearsResult.missing).toBeNull();
    expect(longestTenureYearsResult.value).toBeCloseTo(10, 1);
  });
});

// 어깨·경추 case grain 합계(2026-10-02) — 신규 6개 변수는 isGrainCompatible의 범용 broadcast 규칙으로
// job/disease grain에서도 선택된다. 별도 per-variable 코드 없이도 value뿐 아니라 missing·
// qualityFlags까지(특히 손상값 결측 not_entered + invalid) 모든 하위 행에 그대로 복제되는지 고정한다.
function moduleSnapshotRow(
  id: string,
  personId: string,
  data: {
    jobs: Array<Record<string, unknown>>;
    diagnoses?: Array<Record<string, unknown>>;
    jobExtras?: unknown[];
    tasks?: unknown[];
    gender?: string;
  },
): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: {
        shared: { jobs: data.jobs, diagnoses: data.diagnoses ?? [], gender: data.gender },
        modules: { shoulder: { jobExtras: data.jobExtras ?? [] }, cervical: { tasks: data.tasks ?? [] } },
        activeModules: ['shoulder', 'cervical'],
      },
    },
  };
}

const CASE_SUM_KEYS = [
  'shoulder.case.sumOverheadHours',
  'shoulder.case.sumRepetitiveMediumHours',
  'shoulder.case.sumRepetitiveFastHours',
  'shoulder.case.sumHeavyLoadHoursPerDay',
  'shoulder.case.sumVibrationHours',
  'cervical.case.totalNonNeutralHoursPerDay',
  'cervical.case.maxJobCumulativeKgHours',
] as const;

const SHOULDER_DX = { id: 'dx-1', code: 'M75.1', name: '회전근개 병변', side: 'both' };
const AWKWARD_TASK = {
  id: 'task-a',
  sharedJobId: 'job-1',
  name: '모니터 작업',
  exposure_types: ['awkward_static_neck_load'],
  neck_nonneutral_hours_per_day: '2',
  combined_flexion_rotation_posture: 'yes',
  precision_work: 'no',
};

describe('어깨·경추 case 합계 변수의 job/disease broadcast', () => {
  it('disease grain: side=both 진단 2행 모두에 정상 값이 같은 value·missing·qualityFlags로 복제된다', () => {
    const rows = [
      moduleSnapshotRow('case-1', 'person-1', {
        jobs: [JOB_A],
        diagnoses: [SHOULDER_DX],
        jobExtras: [{ sharedJobId: 'job-1', overheadHours: '2', heavyLoadCount: '10', heavyLoadSeconds: '360' }],
        tasks: [AWKWARD_TASK],
      }),
    ];
    const result = buildDataset(
      rows,
      recipe({ grain: 'disease', variableKeys: [...CASE_SUM_KEYS] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(2); // side=both explode — 행 모집단은 진단 기준이며 변수 선택과 무관
    for (const row of result.rows) {
      expect(row.values['shoulder.case.sumOverheadHours']).toEqual({ value: 2, missing: null, qualityFlags: [] });
      expect(row.values['shoulder.case.sumHeavyLoadHoursPerDay']).toEqual({ value: 1, missing: null, qualityFlags: [] });
      expect(row.values['shoulder.case.sumVibrationHours']).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
      expect(row.values['cervical.case.totalNonNeutralHoursPerDay']).toEqual({ value: 2, missing: null, qualityFlags: [] });
    }
  });

  it('disease grain: 손상값 결측(not_entered + invalid)이 value 없이 모든 행에 그대로 복제된다', () => {
    const rows = [
      moduleSnapshotRow('case-1', 'person-1', {
        jobs: [JOB_A],
        diagnoses: [SHOULDER_DX],
        jobExtras: [{ sharedJobId: 'job-1', overheadHours: '2h' }],
        tasks: [{ ...AWKWARD_TASK, exposure_types: ['typo'] }],
      }),
    ];
    const result = buildDataset(
      rows,
      recipe({
        grain: 'disease',
        variableKeys: ['shoulder.case.sumOverheadHours', 'cervical.case.totalNonNeutralHoursPerDay', 'cervical.case.maxJobCumulativeKgHours'],
      }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(2);
    const corrupted = { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
    for (const row of result.rows) {
      expect(row.values['shoulder.case.sumOverheadHours']).toEqual(corrupted);
      expect(row.values['cervical.case.totalNonNeutralHoursPerDay']).toEqual(corrupted);
      expect(row.values['cervical.case.maxJobCumulativeKgHours']).toEqual(corrupted);
    }
  });

  it('job grain: job이 2개인 case에서 합계 값이 2행에 복제되고 행 수는 변수 선택과 무관하다', () => {
    const rows = [
      moduleSnapshotRow('case-1', 'person-1', {
        jobs: [JOB_A, JOB_B],
        jobExtras: [
          { sharedJobId: 'job-1', overheadHours: '2' },
          { sharedJobId: 'job-2', overheadHours: '3' },
        ],
      }),
    ];
    const result = buildDataset(
      rows,
      recipe({ variableKeys: ['job.identity.jobNameNormalized', 'shoulder.case.sumOverheadHours'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );
    expect(result.observationCount).toBe(2);
    for (const row of result.rows) {
      expect(row.values['shoulder.case.sumOverheadHours']).toEqual({ value: 5, missing: null, qualityFlags: [] });
    }
  });

  it('신규 6개는 브로드캐스트 안전 변수(non_sensitive·continuous)라 job/disease에서 선택 가능하다', () => {
    for (const key of CASE_SUM_KEYS) {
      const variable = CATALOG_BY_KEY.get(key)!;
      expect(variable.grain, key).toBe('case');
      expect(variable.type, key).toBe('continuous');
      expect(variable.sensitivity, key).toBe('non_sensitive');
      expect(variable.predictionRole, key).toBe('predictor');
    }
  });
});

// 예측 코호트는 missing만 보고 qualityFlags는 보지 않는다(statsPredictionCohort.ts S2 필터).
// 손상값이 value 0 + invalid 플래그로 나갔다면 분석에 포함됐을 것이다 — 결측으로 반환하므로
// S2에서 제외된다. (outcome은 성별로 대신한다: 이 테스트의 관심사는 predictor 쪽 제외 경로다.)
describe('어깨·경추 case 합계 변수 — 예측 코호트 S2 제외', () => {
  it('손상 입력 case는 predictor 결측으로 S2에서 제외되고 정상 case만 남는다', () => {
    const rows = [
      moduleSnapshotRow('case-ok', 'person-1', {
        jobs: [JOB_A],
        diagnoses: [SHOULDER_DX],
        gender: 'male',
        jobExtras: [{ sharedJobId: 'job-1', overheadHours: '2' }],
        tasks: [AWKWARD_TASK],
      }),
      moduleSnapshotRow('case-corrupt-shoulder', 'person-2', {
        jobs: [JOB_A],
        diagnoses: [SHOULDER_DX],
        gender: 'female',
        jobExtras: [{ sharedJobId: 'job-1', overheadHours: '2h' }],
        tasks: [AWKWARD_TASK],
      }),
      moduleSnapshotRow('case-corrupt-cervical', 'person-3', {
        jobs: [JOB_A],
        diagnoses: [SHOULDER_DX],
        gender: 'male',
        jobExtras: [{ sharedJobId: 'job-1', overheadHours: '2' }],
        tasks: [{ ...AWKWARD_TASK, neck_nonneutral_hours_per_day: '-2' }],
      }),
    ];
    const predictorKeys = ['shoulder.case.sumOverheadHours', 'cervical.case.totalNonNeutralHoursPerDay'];
    const dataset = buildDataset(
      rows,
      recipe({ grain: 'case', variableKeys: ['patient.identity.gender', ...predictorKeys] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
      { cohortDigest: 'cohort-digest-1' },
    );
    const stages = computePredictionDataStages(dataset.rows, 'patient.identity.gender', predictorKeys);
    expect(stages.s1Rows.map((r) => r.caseId).sort()).toEqual(['case-corrupt-cervical', 'case-corrupt-shoulder', 'case-ok']);
    expect(stages.s2Rows.map((r) => r.caseId)).toEqual(['case-ok']);
  });
});
