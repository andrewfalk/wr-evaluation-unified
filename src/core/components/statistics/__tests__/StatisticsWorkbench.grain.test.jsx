// @vitest-environment jsdom
// grain 단순화 + 공통변수 브로드캐스트(PR0-B4 개정, person grain 삭제 후속) — grain 선택
// UI가 최종 3개 grain(case/job/disease)을 노출하고, case의 브로드캐스트 안전 변수가
// job/disease grain의 후보로도 뜨는지(반대로 브로드캐스트 제외 변수는 안 뜨는지)를
// 실측한다. person grain은 case와 실질적으로 구분되지 않아 다시 삭제됐다 — 라벨도
// "한글(영문)" 패턴으로 통일했다(job이 "직업"으로만 표기되던 불일치 정정). PR0-B3
// Part A의 기존 요구사항(조건 키 반영·선택 초기화·FilterEditor 재마운트)은 grain
// 이름만 바뀌었을 뿐 그대로 유지한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fetchStatsCatalog = vi.fn();
const previewStatsAnalysis = vi.fn();
const runStatsAnalysis = vi.fn();
const exportStatsAggregate = vi.fn();
vi.mock('../../../services/statsRepository', () => ({
  fetchStatsCatalog: (...a) => fetchStatsCatalog(...a),
  previewStatsAnalysis: (...a) => previewStatsAnalysis(...a),
  runStatsAnalysis: (...a) => runStatsAnalysis(...a),
  exportStatsAggregate: (...a) => exportStatsAggregate(...a),
}));

import { StatisticsWorkbench } from '../StatisticsWorkbench.jsx';

const SESSION = { apiBaseUrl: 'https://intranet.local', accessToken: 'tok' };

function catalogFixture() {
  return {
    catalogVersion: 'cv1',
    variables: [
      // case grain, 브로드캐스트 안전(non_sensitive/categorical) → job/disease 후보에도 뜬다.
      {
        key: 'patient.identity.gender', label: '성별', group: '인적사항 · 공통', moduleId: 'patient',
        grain: 'case', type: 'categorical', unit: null, provenance: 'raw', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association'],
        sensitivity: 'non_sensitive', formulaFamily: 'patient_identity',
        supportedFormulaPolicies: [], formulaVersionKey: null,
      },
      // case grain — 브로드캐스트 안전 → job/disease 후보에도 뜬다.
      {
        key: 'knee.relatedness.max', label: '신체부담기여도(최대)', group: '무릎 · 파생지표', moduleId: 'knee',
        grain: 'case', type: 'continuous', unit: '%', provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'knee_relatedness',
        supportedFormulaPolicies: ['recompute_recorded_version'], formulaVersionKey: null,
      },
      // case grain, quasi_identifier — 브로드캐스트 제외(자기 grain=case에서만 후보).
      {
        key: 'job.rollup.longestTenureJobNameNormalized', label: '대표 직종명(근속 최장)', group: '직업력 · 공통', moduleId: 'job',
        grain: 'case', type: 'high_cardinality', unit: null, provenance: 'derived', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association'],
        sensitivity: 'quasi_identifier', formulaFamily: 'job_rollup_longest_tenure',
        supportedFormulaPolicies: [], formulaVersionKey: null,
      },
      {
        key: 'knee.diagnosisSide.klGrade', label: 'K-L Grade', group: '무릎 · 진단별 판정', moduleId: 'knee',
        grain: 'disease', type: 'ordinal', unit: null, provenance: 'clinician_judgment', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'knee_kl_grade_side',
        supportedFormulaPolicies: [], formulaVersionKey: null,
      },
      {
        key: 'job.identity.jobNameNormalized', label: '직종명(정규화)', group: '직업력 · 공통', moduleId: 'job',
        grain: 'job', type: 'high_cardinality', unit: null, provenance: 'raw', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association'],
        sensitivity: 'quasi_identifier', formulaFamily: 'job_identity',
        supportedFormulaPolicies: [], formulaVersionKey: null,
      },
      // 필터 전용 변수 계약(analysisRole) — case grain 등록일.
      {
        key: 'case.meta.registeredAt', label: '등록일', group: '사례 메타 · 공통', moduleId: 'meta',
        grain: 'case', type: 'date', unit: null, provenance: 'raw', dependsOn: [],
        availableAt: 'assessment', shownToAssessor: true,
        allowedAnalysisPurposes: ['association', 'formula_audit'],
        sensitivity: 'non_sensitive', formulaFamily: 'case_meta_registered_at',
        supportedFormulaPolicies: [], formulaVersionKey: null, analysisRole: 'filter_only',
      },
    ],
    supportedGrains: ['case', 'job', 'disease'],
    unsupportedGrains: [],
    minimumCohort: 10,
  };
}

function runManifest(id) {
  return {
    analysisRunId: id, snapshotAsOf: '2024-01-01T00:00:00.000Z',
    recipeDigest: 'r', sourceDigest: 's', resultDigest: 'd',
    catalogVersion: 'cv1', extractorVersion: 'cv1', migrationVersion: 'mv1',
    formulaPolicies: {}, estimabilityPolicyVersion: 'v1', engineVersion: 'e1', serializerVersion: 'sv1',
  };
}

function readyPreview() {
  return {
    runManifest: runManifest('11111111-1111-1111-1111-111111111111'),
    counts: { personCount: 20, caseCount: 20, observationCount: 20, suppressed: false, minimumCohort: 10, reasonCode: null },
    estimability: { completeCaseN: 20, missingRatesByVariable: {}, distinctAssignedDoctorClusters: 2, candidateParameterCount: null, eventNonEvent: [], estimabilityPolicyVersion: 'v1' },
    availableMethods: [], methodCatalogVersion: null,
    differencing: { queryFamilyDigest: 'q', windowMinutes: 15, remaining: 29 },
  };
}

async function waitForDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
}

function discreteAnalyzeResponse(variableKey, level) {
  return {
    runManifest: runManifest('33333333-3333-3333-3333-333333333333'),
    result: {
      continuous: [],
      discrete: [{
        variableKey, kind: 'discrete', suppressed: false,
        n: 20, missingCount: 0, missingPatterns: [],
        levels: [{ level, count: 20, proportion: 1 }], mode: level,
      }],
    },
  };
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  window.innerWidth = 1920;
});

describe('StatisticsWorkbench — grain 선택(person grain 삭제 후속)', () => {
  it('supportedGrains의 3개 grain(사례/직업/상병)이 모두 선택지로 보이고, 사례(case)가 기본 선택이다', async () => {
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    const caseBtn = await screen.findByRole('button', { name: '사례(case)' });
    expect(caseBtn.className).toMatch(/active/);
    expect(screen.getByRole('button', { name: '직업(job)' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '상병(disease)' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /person/ })).toBeNull();
  });

  it('case grain에서는 case 변수(브로드캐스트 제외 변수 포함)가 후보로 보인다', async () => {
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await screen.findByRole('checkbox', { name: /신체부담기여도/ });
    expect(screen.getByRole('checkbox', { name: /대표 직종명/ })).toBeTruthy();
  });

  it('직업(job) grain으로 바꾸면 브로드캐스트 안전 변수(성별·신체부담기여도)는 후보로 뜨지만, 브로드캐스트 제외 변수(대표 직종명, quasi_identifier)는 안 뜬다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('checkbox', { name: /신체부담기여도/ }));
    await user.click(screen.getByRole('button', { name: '직업(job)' }));

    // grain 전환 시 선택 상태가 초기화된다.
    expect(screen.getByRole('checkbox', { name: /직종명\(정규화\)/ }).checked).toBe(false);
    // 브로드캐스트 안전 case 변수는 job grain 후보에도 뜬다.
    expect(screen.getByRole('checkbox', { name: /성별/ })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: /신체부담기여도/ })).toBeTruthy();
    // quasi_identifier 브로드캐스트 제외 변수는 자기 grain(case)이 아니면 후보에서 빠진다.
    expect(screen.queryByRole('checkbox', { name: /대표 직종명/ })).toBeNull();
  });

  // 리뷰 지적 — job/disease는 관측 행 기준 집계라 브로드캐스트된 인적사항도 그 행 수만큼
  // 반영된다는 사실이 화면에 없으면 "고유 인원 분포"로 오해할 수 있다.
  it('job/disease grain에서는 관측 행 기준 집계라는 안내가 뜨고, case에서는 뜨지 않는다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    expect(screen.queryByText(/관측 행 기준/)).toBeNull();

    await user.click(await screen.findByRole('button', { name: '직업(job)' }));
    // job의 예시는 "직업 개수"를 들어야 한다 — disease와 같은 문장을 재사용하면 안 된다.
    expect(await screen.findByText(/관측 행 기준/)).toBeTruthy();
    expect(screen.getByText(/직업을 3개 가지면/)).toBeTruthy();
    expect(screen.queryByText(/좌·우/)).toBeNull();

    await user.click(screen.getByRole('button', { name: '상병(disease)' }));
    // disease의 행 수는 직업 수와 무관하다 — "좌·우 2행" 예시로 분기돼야 한다(리뷰 지적).
    expect(await screen.findByText(/관측 행 기준/)).toBeTruthy();
    expect(screen.getByText(/좌·우 2행/)).toBeTruthy();
    expect(screen.queryByText(/직업을 3개 가지면/)).toBeNull();

    await user.click(screen.getByRole('button', { name: '사례(case)' }));
    expect(screen.queryByText(/관측 행 기준/)).toBeNull();
  });

  it('grain 변경이 조건 키에 반영돼 새 grain으로 preview가 재요청된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: '직업(job)' }));
    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await user.click(screen.getByRole('checkbox', { name: /직종명\(정규화\)/ }));
    await waitForDebounce();

    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'job', variableKeys: ['job.identity.jobNameNormalized'] }),
      SESSION,
      expect.anything(),
    );
  });

  it('브로드캐스트 안전 변수(성별)를 job grain에서 선택하면 recipe의 variableKeys에 grain 그대로 포함된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: '직업(job)' }));
    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await user.click(screen.getByRole('checkbox', { name: /성별/ }));
    await waitForDebounce();

    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'job', variableKeys: ['patient.identity.gender'] }),
      SESSION,
      expect.anything(),
    );
  });

  it('case grain에서 필터를 추가한 뒤 직업(job)으로 전환해도 새 grain의 필터를 정상적으로 추가할 수 있다(FilterEditor 재마운트)', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    const caseFilterKeySelect = await screen.findByDisplayValue('성별');
    expect(caseFilterKeySelect).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '직업(job)' }));

    const jobFilterKeySelect = screen.getByDisplayValue('성별');
    expect(jobFilterKeySelect).toBeTruthy();
    // job grain 고유 변수(직종명)도 여전히 필터 후보에 남아 있는지 확인한 뒤 그걸로 필터를 추가한다.
    await user.selectOptions(jobFilterKeySelect, '직종명(정규화)');

    await user.type(screen.getByPlaceholderText('값'), '용접공');
    await user.click(screen.getByRole('button', { name: '필터 추가' }));

    expect(await screen.findByText(/직종명.*용접공/)).toBeTruthy();
  });

  it('상병(disease) grain에서 변수 선택 → preview → 분석 실행까지 전체 경로가 동작하고 결과가 표시된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('button', { name: '상병(disease)' }));

    previewStatsAnalysis.mockResolvedValueOnce(readyPreview());
    await user.click(screen.getByRole('checkbox', { name: /K-L Grade/ }));
    await waitForDebounce();
    expect(previewStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'disease', variableKeys: ['knee.diagnosisSide.klGrade'] }),
      SESSION,
      expect.anything(),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: /분석 실행/ }).disabled).toBe(false));

    runStatsAnalysis.mockResolvedValueOnce(discreteAnalyzeResponse('knee.diagnosisSide.klGrade', '2'));
    await user.click(screen.getByRole('button', { name: /분석 실행/ }));

    await waitFor(() => expect(screen.getByText(/최빈값=2/)).toBeTruthy());
    expect(runStatsAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ grain: 'disease', variableKeys: ['knee.diagnosisSide.klGrade'] }),
      SESSION,
    );
  });

  it('필터 전용 변수(등록일)는 분석 변수 체크박스에 없지만 필터 후보에는 있다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await screen.findByRole('checkbox', { name: /신체부담기여도/ });
    expect(screen.queryByRole('checkbox', { name: /등록일/ })).toBeNull();

    await user.selectOptions(await screen.findByDisplayValue('성별'), '등록일');
    expect(await screen.findByDisplayValue('등록일')).toBeTruthy();
  });
});
