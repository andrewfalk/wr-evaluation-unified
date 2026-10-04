// @vitest-environment jsdom
// 분석 목적 비호환 변수 처리(후보 비활성화·전환 시 정리) + 삭제된 변수(UNKNOWN_VARIABLE) 복구 안내를
// 실제 StatisticsWorkbench 렌더로 검증한다. 순수 계산은 workbenchTransitions.test.js가 따로 다룬다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
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

function variable(key, label, purposes, extra = {}) {
  return {
    key, label, group: '인적사항 · 공통', moduleId: 'patient',
    grain: 'case', type: 'continuous', unit: null, provenance: 'raw', dependsOn: [],
    availableAt: 'assessment', shownToAssessor: true,
    allowedAnalysisPurposes: purposes,
    sensitivity: 'non_sensitive', formulaFamily: `fam_${key}`,
    supportedFormulaPolicies: [], formulaVersionKey: null,
    ...extra,
  };
}

function catalogFixture(extraVariables = []) {
  return {
    catalogVersion: 'cv1',
    variables: [
      variable('p.assocOnly', '연관성 전용 변수', ['association']),
      variable('p.audit', '감사 가능 변수', ['association', 'formula_audit']),
      variable('p.pred', '예측 가능 변수', ['association', 'prediction'], { predictionRole: 'predictor' }),
      variable('g.assoc', '연관성 전용 그룹', ['association'], { type: 'categorical' }),
      variable('g.audit', '감사 가능 그룹', ['association', 'formula_audit'], { type: 'categorical' }),
      ...extraVariables,
    ],
    supportedGrains: ['case'],
    unsupportedGrains: [],
    minimumCohort: 10,
  };
}

async function waitForDebounce() {
  await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
}

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  window.innerWidth = 1920;
  previewStatsAnalysis.mockReturnValue(new Promise(() => {})); // 미리보기는 기본적으로 보류
});

describe('StatisticsWorkbench — 분석 목적과 변수 후보', () => {
  it('공식 감사로 바꾸면 선택돼 있던 비호환 변수가 해제되고 안내가 뜨며, 그 변수는 비활성화된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('checkbox', { name: /연관성 전용 변수/ }));
    await user.click(screen.getByRole('checkbox', { name: /감사 가능 변수/ }));
    await user.click(screen.getByRole('button', { name: '공식 감사' }));

    expect(screen.getByRole('status').textContent).toMatch(/연관성 전용 변수/);
    const assoc = screen.getByRole('checkbox', { name: /연관성 전용 변수/ });
    expect(assoc.checked).toBe(false);
    expect(assoc.disabled).toBe(true);
    expect(assoc.closest('label').getAttribute('title')).toMatch(/사용 가능한 목적: 연관성/);
    // 호환 변수는 선택이 유지된다.
    const audit = screen.getByRole('checkbox', { name: /감사 가능 변수/ });
    expect(audit.checked).toBe(true);
    expect(audit.disabled).toBe(false);
  });

  it('안내는 닫기 버튼으로 닫을 수 있다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await user.click(await screen.findByRole('checkbox', { name: /연관성 전용 변수/ }));
    await user.click(screen.getByRole('button', { name: '공식 감사' }));
    expect(screen.getByRole('status')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '안내 닫기' }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('예측 모드로 들어가면 예측 목적에서 쓸 수 없는 변수가 해제되고 예측 가능 변수는 유지된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('checkbox', { name: /연관성 전용 변수/ }));
    await user.click(screen.getByRole('checkbox', { name: /예측 가능 변수/ }));
    await user.click(within(screen.getByLabelText('분석 레시피')).getByRole('button', { name: '예측' }));

    expect(screen.getByRole('checkbox', { name: /연관성 전용 변수/ }).checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: /연관성 전용 변수/ }).disabled).toBe(true);
    expect(screen.getByRole('checkbox', { name: /예측 가능 변수/ }).checked).toBe(true);
  });

  it('미리보기가 PURPOSE_NOT_ALLOWED로 실패하면 내부 키가 아니라 변수명과 목적을 한글로 보여준다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    const err = new Error('Request failed (400)');
    err.status = 400;
    err.data = {
      code: 'INVALID_RECIPE',
      errors: [{ code: 'PURPOSE_NOT_ALLOWED', path: 'p.assocOnly', message: 'p.assocOnly는 analysisPurpose "association"를 허용하지 않는다(허용: prediction)' }],
    };
    previewStatsAnalysis.mockRejectedValue(err);
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('checkbox', { name: /연관성 전용 변수/ }));
    await waitForDebounce();
    const msg = await screen.findByText(/미리보기 실패/);
    expect(msg.textContent).toMatch(/'연관성 전용 변수'은\(는\) '연관성' 목적에서 쓸 수 없습니다/);
    expect(msg.textContent).not.toMatch(/analysisPurpose|p\.assocOnly/);
  });
});

describe('StatisticsWorkbench — 삭제된 변수 복구', () => {
  function unknownVariableError(path) {
    const err = new Error('Request failed (400)');
    err.status = 400;
    err.data = { code: 'INVALID_RECIPE', errors: [{ code: 'UNKNOWN_VARIABLE', path, message: `카탈로그에 없는 변수 key: ${path}` }] };
    return err;
  }

  it('UNKNOWN_VARIABLE로 거부되면 복구 버튼이 뜨고, 새로 불러온 카탈로그에 없는 키만 선택에서 제거된다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    // 서버가 먼저 p.assocOnly를 모른다고 거부(오래 열린 탭), 재조회한 카탈로그에는 그 변수가 없다.
    previewStatsAnalysis.mockRejectedValueOnce(unknownVariableError('p.assocOnly'));
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('checkbox', { name: /연관성 전용 변수/ }));
    await user.click(screen.getByRole('checkbox', { name: /감사 가능 변수/ }));
    await waitForDebounce();

    const reloadBtn = await screen.findByRole('button', { name: '카탈로그 새로 불러오기' });
    const fresh = catalogFixture();
    fresh.variables = fresh.variables.filter((v) => v.key !== 'p.assocOnly');
    fetchStatsCatalog.mockResolvedValueOnce(fresh);
    await user.click(reloadBtn);

    // 정상 변수는 보존, 사라진 키는 제거 + 제거 안내.
    const audit = await screen.findByRole('checkbox', { name: /감사 가능 변수/ });
    expect(audit.checked).toBe(true);
    expect(screen.queryByRole('checkbox', { name: /연관성 전용 변수/ })).toBeNull();
    await waitFor(() => expect(screen.getByText(/카탈로그에 없는 변수 1개를 선택에서 제거했습니다/)).toBeTruthy());
    expect(fetchStatsCatalog).toHaveBeenCalledTimes(2);
    // 복구 버튼은 더 이상 필요 없다.
    await waitFor(() => expect(screen.queryByRole('button', { name: '카탈로그 새로 불러오기' })).toBeNull());
  });

  it('재조회가 끝나기 전에는 선택을 지우지 않고, 성공 후에도 카탈로그에 남아 있는 변수는 그대로 둔다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    previewStatsAnalysis.mockRejectedValueOnce(unknownVariableError('p.unknown'));
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);

    await user.click(await screen.findByRole('checkbox', { name: /감사 가능 변수/ }));
    await waitForDebounce();
    const reloadBtn = await screen.findByRole('button', { name: '카탈로그 새로 불러오기' });

    let resolveReload;
    fetchStatsCatalog.mockReturnValueOnce(new Promise((r) => { resolveReload = r; }));
    await user.click(reloadBtn);
    // 로딩 중(catalogByKey가 빈 맵인 구간)에는 어떤 정리도 일어나지 않는다.
    expect(screen.queryByText(/선택에서 제거했습니다/)).toBeNull();

    await act(async () => { resolveReload(catalogFixture()); });
    const audit = await screen.findByRole('checkbox', { name: /감사 가능 변수/ });
    expect(audit.checked).toBe(true);
    expect(screen.queryByText(/선택에서 제거했습니다/)).toBeNull();
  });

  it('재조회가 실패해도 복구 버튼이 유지되고, 카탈로그 오류 화면의 "다시 시도"로 복구를 이어갈 수 있다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    previewStatsAnalysis.mockRejectedValueOnce(unknownVariableError('p.unknown'));
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await user.click(await screen.findByRole('checkbox', { name: /감사 가능 변수/ }));
    await waitForDebounce();

    // 1차 재조회: 네트워크 오류로 실패
    fetchStatsCatalog.mockRejectedValueOnce(new Error('network down'));
    await user.click(await screen.findByRole('button', { name: '카탈로그 새로 불러오기' }));
    await screen.findByText(/카탈로그를 불러오지 못했습니다/);
    // 복구 필요 상태는 유지되고(버튼 그대로), 오류 화면에도 재시도 버튼이 있다.
    expect(screen.getByRole('button', { name: '카탈로그 새로 불러오기' })).toBeTruthy();
    const retry = screen.getByRole('button', { name: '다시 시도' });

    // 2차: 재시도 성공 → 화면 복구 + 복구 버튼 해제 + 정상 선택 보존
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    await user.click(retry);
    const audit = await screen.findByRole('checkbox', { name: /감사 가능 변수/ });
    expect(audit.checked).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: '카탈로그 새로 불러오기' })).toBeNull());
    expect(fetchStatsCatalog).toHaveBeenCalledTimes(3);
  });
});

describe('StatisticsWorkbench — 그룹 변수 후보와 분석 목적', () => {
  it('공식 감사에서는 연관성 전용 변수를 그룹 변수로 고를 수 없고, 연관성에서는 고를 수 있다', async () => {
    const user = userEvent.setup();
    fetchStatsCatalog.mockResolvedValueOnce(catalogFixture());
    render(<StatisticsWorkbench session={SESSION} statsAvailable onClose={() => {}} />);
    await screen.findByRole('checkbox', { name: /감사 가능 변수/ });

    const groupSelect = () => within(screen.getByLabelText('분석 레시피')).getByLabelText('그룹 변수');
    const optionLabels = () => Array.from(groupSelect().querySelectorAll('option')).map((o) => o.textContent);
    expect(optionLabels()).toContain('연관성 전용 그룹');

    await user.click(within(screen.getByLabelText('분석 레시피')).getByRole('button', { name: '공식 감사' }));
    expect(optionLabels()).toContain('감사 가능 그룹');
    expect(optionLabels()).not.toContain('연관성 전용 그룹');
  });
});
