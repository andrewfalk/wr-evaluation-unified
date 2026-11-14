// @vitest-environment jsdom
//
// T9·T10 특성화(REFACTORING_ROADMAP Phase 2 P2-08) — 테스트가 없던 훅의 현재 동작을 얼린다.
//   T9  useElectronMenuEvents(P2-14 코드모드 B 대상) · useAppSettings · useAIAvailable
//   T10 usePatientList/filterPatients의 jobFilter — 기본값 'all'이 "직종명에 all이 든 환자만"으로 동작하던 잠복 버그를
//       P2-08에서 그대로 기록했고, P2-28(flagged)에서 고치며 기대를 의도대로 바꿨다(App은 ''을 넘겨 드러나지 않았다).
// 새 훅 테스트 규칙: StrictMode 렌더(cleanup에서만 값을 세우는 ref가 없는지 함께 본다).
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { makeBridgeStub } from '../../../testing/bridgeStub';
import { useElectronMenuEvents } from '../useElectronMenuEvents';
import { normalizeBaseUrl, useAppSettings } from '../useAppSettings';
import { useAIAvailable } from '../useAIAvailable';
import { filterPatients, usePatientList } from '../usePatientList';
import goldenPatients from '../../fixtures/goldenPatients.json';

const SETTINGS_KEY = 'wrEvalUnifiedSettings';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete window.electron;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.style.fontSize = '';
});

describe('T9 useElectronMenuEvents', () => {
  const refs = () => ({
    handleResetPatientsRef: { current: vi.fn() },
    handleStartIntakeRef: { current: vi.fn() },
    handleOpenStatisticsRef: { current: vi.fn() },
  });

  it('셸 메뉴 3종을 구독하고 이벤트마다 ref의 현재 함수를 부른다(StrictMode 뒤에도 구독 1개씩)', () => {
    const bridge = makeBridgeStub('standalone');
    window.electron = bridge;
    const r = refs();
    const { unmount } = renderHook(() => useElectronMenuEvents(r), { wrapper: StrictMode });
    for (const key of ['onMenuNew', 'onGotoModule', 'onOpenStatistics']) expect(bridge.__listenerCount(key)).toBe(1);
    bridge.__emit('onMenuNew');
    bridge.__emit('onGotoModule', 'knee');
    bridge.__emit('onOpenStatistics');
    expect(r.handleResetPatientsRef.current).toHaveBeenCalledTimes(1);
    expect(r.handleStartIntakeRef.current).toHaveBeenCalledTimes(1);
    expect(r.handleOpenStatisticsRef.current).toHaveBeenCalledTimes(1);
    // ref를 갈아 끼우면 다음 이벤트는 새 함수로(재구독 없이)
    const next = vi.fn();
    r.handleResetPatientsRef.current = next;
    bridge.__emit('onMenuNew');
    expect(next).toHaveBeenCalledTimes(1);
    unmount();
    for (const key of ['onMenuNew', 'onGotoModule', 'onOpenStatistics']) expect(bridge.__listenerCount(key)).toBe(0);
  });

  it('웹(window.electron 없음)과 구독 함수가 없는 셸에서는 아무것도 하지 않는다', () => {
    expect(() => renderHook(() => useElectronMenuEvents(refs()), { wrapper: StrictMode }).unmount()).not.toThrow();
    window.electron = {};
    expect(() => renderHook(() => useElectronMenuEvents(refs()), { wrapper: StrictMode }).unmount()).not.toThrow();
  });
});

describe('T9 useAppSettings', () => {
  // 실제 앱처럼 저장된 설정의 apiBaseUrl은 세션과 같게 둔다(다르면 마운트 직후 URL 동기화 effect가 인트라넷 세션을
  // 리셋한다 — 그 동작은 아래 별도 테스트).
  function setup({ session = { mode: 'local', apiBaseUrl: '' }, storedSettings } = {}) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(storedSettings ?? { apiBaseUrl: session.apiBaseUrl ?? '' }));
    let current = session;
    const setSession = vi.fn((next) => { current = typeof next === 'function' ? next(current) : next; return current; });
    // AuthContext.resetToLocalSession처럼 세션을 깨끗한 로컬 세션으로 바꾼다.
    const resetToLocalSession = vi.fn(() => { current = { mode: 'local', apiBaseUrl: '' }; });
    const hook = renderHook(
      (props) => useAppSettings({ session: props?.session ?? current, setSession, resetToLocalSession }),
      { wrapper: StrictMode },
    );
    return { hook, setSession, resetToLocalSession, getSession: () => current };
  }

  it('normalizeBaseUrl: 공백·끝 "/" 제거', () => {
    expect(normalizeBaseUrl(' https://a/ ')).toBe('https://a');
    expect(normalizeBaseUrl(null)).toBe('');
  });

  it('저장된 설정으로 시작하고 테마·글자 크기를 문서에 적용한다', async () => {
    const { hook } = setup({ storedSettings: { theme: 'dark', fontSize: 'large', apiBaseUrl: '' } });
    expect(hook.result.current.settings.theme).toBe('dark');
    await waitFor(() => expect(document.documentElement.getAttribute('data-theme')).toBe('dark'));
    expect(document.documentElement.style.fontSize).not.toBe('');
  });

  it('로컬 세션에서 설정 저장: 설정·localStorage 갱신, 세션에는 apiBaseUrl만(정규화) 반영', async () => {
    const { hook, setSession, resetToLocalSession, getSession } = setup();
    act(() => { hook.result.current.handleSaveSettings({ ...hook.result.current.settings, apiBaseUrl: 'https://srv/ ', integrationMode: 'intranet' }); });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)).apiBaseUrl).toBe('https://srv/ ');
    expect(setSession).toHaveBeenCalled();
    expect(getSession()).toMatchObject({ mode: 'local', apiBaseUrl: 'https://srv' });
    expect(resetToLocalSession).not.toHaveBeenCalled();
  });

  it('인트라넷 세션에서 로컬로 전환하거나 서버 URL을 바꾸면 세션을 로컬로 리셋한다', () => {
    const session = { mode: 'intranet', apiBaseUrl: 'https://srv' };
    const a = setup({ session });
    act(() => { a.hook.result.current.handleSaveSettings({ ...a.hook.result.current.settings, apiBaseUrl: 'https://srv', integrationMode: 'local' }); });
    expect(a.resetToLocalSession).toHaveBeenCalledTimes(1);
    const b = setup({ session });
    act(() => { b.hook.result.current.handleSaveSettings({ ...b.hook.result.current.settings, apiBaseUrl: 'https://other', integrationMode: 'intranet' }); });
    expect(b.resetToLocalSession).toHaveBeenCalledTimes(1);
    const c = setup({ session });
    act(() => { c.hook.result.current.handleSaveSettings({ ...c.hook.result.current.settings, apiBaseUrl: 'https://srv/', integrationMode: 'intranet' }); });
    expect(c.resetToLocalSession).not.toHaveBeenCalled();
  });

  it('저장된 설정 URL이 인트라넷 세션 URL과 다르면 마운트 직후 세션을 로컬로 리셋한다(StrictMode 이중 effect로 2회)', () => {
    const { resetToLocalSession } = setup({ session: { mode: 'intranet', apiBaseUrl: 'https://srv' }, storedSettings: { apiBaseUrl: '' } });
    expect(resetToLocalSession).toHaveBeenCalledTimes(2);
  });

  it('Electron 독립형: fsLoadSettings 값으로 갱신하고, 그 갱신은 인트라넷 세션을 리셋하지 않는다(skip 1회)', async () => {
    window.electron = makeBridgeStub('standalone', { overrides: { fsLoadSettings: async () => ({ theme: 'dark', apiBaseUrl: 'https://fs' }) } });
    const { hook, resetToLocalSession } = setup({ session: { mode: 'intranet', apiBaseUrl: 'https://old' } });
    await waitFor(() => expect(hook.result.current.settings.apiBaseUrl).toBe('https://fs'));
    expect(hook.result.current.settings.theme).toBe('dark');
    expect(resetToLocalSession).not.toHaveBeenCalled();
  });

  it('switchToLocalMode: 확인창에서 취소하면 아무것도 바꾸지 않는다', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { hook, resetToLocalSession } = setup({ session: { mode: 'intranet', apiBaseUrl: 'https://srv' } });
    const before = hook.result.current.settings;
    act(() => { hook.result.current.switchToLocalMode(); });
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(confirmSpy.mock.calls[0][0]).toContain('로컬 모드로 전환하면 서버 동기화가 중단되고');
    expect(hook.result.current.settings).toBe(before);
    expect(resetToLocalSession).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('T9 useAIAvailable', () => {
  it('비인트라넷은 항상 true, 인트라넷 세션은 serverConfig.aiEnabled === true일 때만', () => {
    expect(useAIAvailable()).toEqual({ aiAvailable: true });
    expect(useAIAvailable({ session: { mode: 'local' } })).toEqual({ aiAvailable: true });
    expect(useAIAvailable({ session: { mode: 'intranet' } })).toEqual({ aiAvailable: false });
    expect(useAIAvailable({ session: { mode: 'intranet' }, serverConfig: { aiEnabled: 'true' } })).toEqual({ aiAvailable: false });
    expect(useAIAvailable({ session: { mode: 'intranet' }, serverConfig: { aiEnabled: true } })).toEqual({ aiAvailable: true });
  });
});

describe('T10 usePatientList — jobFilter(P2-28에서 잠복 버그를 고쳐 의도 갱신)', () => {
  const patients = goldenPatients.slice(0, 6);
  const withJob = (p, jobName) => ({ ...p, data: { ...p.data, shared: { ...p.data.shared, jobs: [{ id: 'j', jobName }] } } });

  it("App 기본값(jobFilter '')이면 직종으로 거르지 않는다", () => {
    expect(filterPatients(patients, { jobFilter: '' })).toHaveLength(patients.length);
  });

  // 예전(P2-08 특성화): filters를 생략하면 기본값 'all'이 "직종명에 all 포함" 필터로 동작해 결과가 []였다.
  // P2-28(flagged): 기본값을 ''로 — filters를 생략해도 직종으로 거르지 않는다.
  it('filters 인자를 생략하면 직종으로 거르지 않는다(기본 jobFilter = "")', () => {
    expect(filterPatients(patients)).toHaveLength(patients.length);
    expect(filterPatients(patients, {})).toHaveLength(patients.length);
    const tall = withJob(patients[0], 'Install 기사');
    expect(filterPatients([tall, patients[1]]).map((p) => p.id)).toEqual([tall.id, patients[1].id]);
    const { result } = renderHook(() => usePatientList(patients), { wrapper: StrictMode });
    expect(result.current).toHaveLength(patients.length);
  });

  it('jobFilter는 앞뒤 공백을 무시하고 대소문자 구분 없이 직종명 부분 일치', () => {
    const a = withJob(patients[0], '건설 현장 배근공');
    const b = withJob(patients[1], '사무직');
    expect(filterPatients([a, b], { jobFilter: '  배근 ' }).map((p) => p.id)).toEqual([a.id]);
    expect(filterPatients([withJob(patients[0], 'Welder')], { jobFilter: 'weld' })).toHaveLength(1);
  });
});
