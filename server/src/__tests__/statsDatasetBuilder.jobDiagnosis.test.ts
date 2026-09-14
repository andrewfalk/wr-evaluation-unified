// PR0-B4 Slice 8b — buildDataset의 반복 grain(job_diagnosis) 경로 전용 테스트.
// enumerateJobDiagnosisEntities가 elbow+wrist 두 모듈의 cross join을 하나의 grain으로
// 합치므로, 각 모듈 전용 extractor가 다른 모듈 origin 행에 not_applicable을 반환하는지도
// buildDataset 레벨에서 확인한다(§job_diagnosis 계약).
import { describe, it, expect } from 'vitest';
import { buildDataset } from '../statsDatasetBuilder';
import { getFullVariableCatalog } from '@wr/analytics-core/catalog';
import type { SnapshotRow } from '../statsSnapshot';
import type { StatsAnalysisRecipe } from '@wr/contracts';

const CATALOG_BY_KEY = new Map(getFullVariableCatalog().map((v) => [v.key, v]));
const RECIPE_DIGEST = 'test-recipe-digest';

function jobDiagnosisSnapshotRow(
  id: string,
  personId: string,
  jobs: Array<Record<string, unknown>>,
  diagnoses: Array<Record<string, unknown>>,
  modules: Record<string, unknown>,
  activeModules: string[],
): SnapshotRow {
  return {
    id,
    patientPersonId: personId,
    assignedDoctorUserId: null,
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    payload: {
      data: { shared: { jobs, diagnoses }, modules, activeModules },
    },
  };
}

function recipe(overrides: Partial<StatsAnalysisRecipe> = {}): StatsAnalysisRecipe {
  return {
    grain: 'job_diagnosis',
    variableKeys: ['elbow.jobDiagnosis.selectedBkType'],
    filters: [],
    analysisPurpose: 'association',
    formulaPolicies: {},
    analysisMode: 'descriptive',
    ...overrides,
  };
}

const JOBS = [{ id: 'job-1', jobName: '조립공' }];
const ELBOW_DX = [{ id: 'dx-e1', code: 'M770', name: '', moduleId: 'elbow', side: 'right' }];
const GATED_ELBOW_ENTRY = {
  diagnosisId: 'dx-e1',
  selectedBkType: 'BK2101',
  bkSelectionMode: 'manual',
  direct_anatomic_link: 'yes',
  exposure_types: ['repetition'],
  main_task_name: '박스 운반',
  daily_exposure_hours: '4',
};

describe('buildDataset(grain=job_diagnosis) — 기본 모집단(cross join)', () => {
  it('한 case에 job×diagnosis 조합이 여러 개면 case당 여러 행을 낸다', () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    const row = jobDiagnosisSnapshotRow(
      'case-1', 'person-1', jobs, ELBOW_DX,
      { elbow: { jobEvaluations: [] } }, ['elbow'],
    );
    const result = buildDataset([row], recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    // 2 jobs × 1 diagnosis = 2 관측치.
    expect(result.observationCount).toBe(2);
    expect(result.caseCount).toBe(1);
  });

  it('elbow/wrist 둘 다 비활성인 case는 이 grain에서 행을 0개 낸다', () => {
    const row = jobDiagnosisSnapshotRow('case-1', 'person-1', JOBS, ELBOW_DX, {}, []);
    const result = buildDataset([row], recipe(), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(0);
  });
});

describe('buildDataset(grain=job_diagnosis) — elbow/wrist 상호 배타(§job_diagnosis 계약)', () => {
  it('wrist 진단 행에는 elbow 전용 변수가 not_applicable로 채워진다', () => {
    const wristDx = [{ id: 'dx-w1', code: 'Z00', name: '', moduleId: 'wrist', side: 'right' }];
    const row = jobDiagnosisSnapshotRow(
      'case-1', 'person-1', JOBS, wristDx,
      { wrist: { jobEvaluations: [] } }, ['wrist'],
    );
    const result = buildDataset([row], recipe({ variableKeys: ['elbow.jobDiagnosis.selectedBkType'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.observationCount).toBe(1);
    expect(result.rows[0].values['elbow.jobDiagnosis.selectedBkType'].missing).toBe('not_applicable');
  });

  it('elbow+wrist 동시 활성 — 전체 관측치 수는 elbow(잡×진단) + wrist(잡×진단)', () => {
    const wristDx = [{ id: 'dx-w1', code: 'Z00', name: '', moduleId: 'wrist', side: 'right' }];
    const row = jobDiagnosisSnapshotRow(
      'case-1', 'person-1', JOBS, [...ELBOW_DX, ...wristDx],
      { elbow: { jobEvaluations: [] }, wrist: { jobEvaluations: [] } },
      ['elbow', 'wrist'],
    );
    const result = buildDataset([row], recipe({ variableKeys: ['elbow.jobDiagnosis.selectedBkType'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    // 1 job × (1 elbow dx + 1 wrist dx) = 2.
    expect(result.observationCount).toBe(2);
  });
});

describe('buildDataset(grain=job_diagnosis) — 게이트된 변수(direct_anatomic_link 의존)', () => {
  it('direct_anatomic_link !== "yes"면 mainTaskName은 not_applicable', () => {
    const row = jobDiagnosisSnapshotRow(
      'case-1', 'person-1', JOBS, ELBOW_DX,
      { elbow: { jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [{ ...GATED_ELBOW_ENTRY, direct_anatomic_link: 'no' }] }] } },
      ['elbow'],
    );
    const result = buildDataset([row], recipe({ variableKeys: ['elbow.jobDiagnosis.mainTaskName'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.rows[0].values['elbow.jobDiagnosis.mainTaskName'].missing).toBe('not_applicable');
  });

  it('게이트가 열려 있으면 정상 추출된다', () => {
    const row = jobDiagnosisSnapshotRow(
      'case-1', 'person-1', JOBS, ELBOW_DX,
      { elbow: { jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [GATED_ELBOW_ENTRY] }] } },
      ['elbow'],
    );
    const result = buildDataset([row], recipe({ variableKeys: ['elbow.jobDiagnosis.mainTaskName'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(result.rows[0].values['elbow.jobDiagnosis.mainTaskName']).toEqual({ value: '박스 운반', missing: null, qualityFlags: [] });
  });
});

describe('buildDataset(grain=job_diagnosis) — 변수 선택과 무관하게 엔터티 모집단 불변', () => {
  it('selectedBkType만 요청·mainTaskName만 요청·둘 다 요청 — 세 경우 모두 행 개수·entityKey가 같다', () => {
    const row = jobDiagnosisSnapshotRow(
      'case-1', 'person-1', JOBS, ELBOW_DX,
      { elbow: { jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [GATED_ELBOW_ENTRY] }] } },
      ['elbow'],
    );

    const onlyBk = buildDataset([row], recipe({ variableKeys: ['elbow.jobDiagnosis.selectedBkType'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const onlyTask = buildDataset([row], recipe({ variableKeys: ['elbow.jobDiagnosis.mainTaskName'] }), RECIPE_DIGEST, CATALOG_BY_KEY);
    const both = buildDataset(
      [row],
      recipe({ variableKeys: ['elbow.jobDiagnosis.selectedBkType', 'elbow.jobDiagnosis.mainTaskName'] }),
      RECIPE_DIGEST,
      CATALOG_BY_KEY,
    );

    expect(onlyBk.observationCount).toBe(1);
    expect(onlyTask.observationCount).toBe(1);
    expect(both.observationCount).toBe(1);
    expect(onlyBk.rows[0].entityKey).toEqual(onlyTask.rows[0].entityKey);
    expect(onlyBk.rows[0].entityKey).toEqual(both.rows[0].entityKey);
    expect(onlyBk.rows[0].entityKey).toEqual(['job-1', 'dx-e1']);
  });
});

describe('buildDataset(grain=job_diagnosis) — 결정성', () => {
  it('동일 입력을 2회 실행하면 fact rows와 digest가 완전히 동일하다(byte-identical)', () => {
    const row = jobDiagnosisSnapshotRow(
      'case-1', 'person-1', JOBS, ELBOW_DX,
      { elbow: { jobEvaluations: [{ sharedJobId: 'job-1', diagnosisEntries: [GATED_ELBOW_ENTRY] }] } },
      ['elbow'],
    );
    const r = recipe({ variableKeys: ['elbow.jobDiagnosis.selectedBkType', 'elbow.jobDiagnosis.mainTaskName'] });
    const first = buildDataset([row], r, RECIPE_DIGEST, CATALOG_BY_KEY);
    const second = buildDataset([row], r, RECIPE_DIGEST, CATALOG_BY_KEY);
    expect(first.rows).toEqual(second.rows);
    expect(first.internalResultDigest).toBe(second.internalResultDigest);
  });
});
