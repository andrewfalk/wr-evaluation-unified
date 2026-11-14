// @vitest-environment jsdom
// src/platform 어댑터 단위 테스트(REFACTORING_ROADMAP Phase 2 P2-10).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeBridgeStub } from '../../testing/bridgeStub';
import {
  getAiBridge, getBridge, getDialogBridge, getEmrBridge, getFsBridge, getLegacyImportBridge, getLifecycleBridge,
  getMenuBridge, getMigrationBridge, hasBridge,
} from '../bridge';
import { detectRuntime, inferBuildTargetFromKeys } from '../runtime';
import {
  hasIntranetSession, isIntranetContext, isRefreshEligible, normalizeBaseUrl, resolveApiBaseUrl, resolveDataMode,
} from '../dataMode';
import { showAlert, showConfirm } from '../dialogs';

afterEach(() => {
  delete window.electron;
  vi.restoreAllMocks();
});

describe('detectRuntime — 구 셸·새 셸·{}·웹', () => {
  it('웹: window.electron 없음', () => {
    expect(detectRuntime()).toEqual({ host: 'web', buildTarget: 'web', hasNativeCloseGuard: false, hasLocalFileStore: false, hasDirectAi: false });
  });

  it('구 독립형 셸(buildTarget 없음): 키로 standalone 추측', () => {
    window.electron = makeBridgeStub('standalone');
    expect(detectRuntime()).toEqual({ host: 'electron', buildTarget: 'standalone', hasNativeCloseGuard: false, hasLocalFileStore: true, hasDirectAi: true });
  });

  it('구 인트라넷 셸(buildTarget 없음): 키로 intranet 추측', () => {
    window.electron = makeBridgeStub('intranet');
    expect(detectRuntime()).toEqual({ host: 'electron', buildTarget: 'intranet', hasNativeCloseGuard: true, hasLocalFileStore: false, hasDirectAi: false });
  });

  it('새 셸: preload가 밝힌 buildTarget을 그대로(키 추측보다 우선)', () => {
    expect(detectRuntime(makeBridgeStub('intranet', { buildTarget: 'intranet' })).buildTarget).toBe('intranet');
    expect(detectRuntime(makeBridgeStub('standalone', { buildTarget: 'standalone' })).buildTarget).toBe('standalone');
    // 밝힌 값이 키와 다르면 밝힌 값이 이긴다(추측은 구 셸 폴백일 뿐)
    expect(detectRuntime(makeBridgeStub('standalone', { buildTarget: 'intranet' })).buildTarget).toBe('intranet');
  });

  it('인트라넷 preload의 허용 안 된 origin({}): host=electron, buildTarget=unknown, 기능 없음', () => {
    window.electron = {};
    expect(detectRuntime()).toEqual({ host: 'electron', buildTarget: 'unknown', hasNativeCloseGuard: false, hasLocalFileStore: false, hasDirectAi: false });
  });

  it('모르는 buildTarget 값은 무시하고 키로 추측', () => {
    expect(detectRuntime({ ...makeBridgeStub('intranet'), buildTarget: 'something' }).buildTarget).toBe('intranet');
    expect(detectRuntime({ buildTarget: 'web' }).buildTarget).toBe('unknown');
  });

  it('inferBuildTargetFromKeys: 인트라넷 키 셋 중 하나만 있어도 intranet', () => {
    for (const key of ['setAccessToken', 'onQuitRequested', 'loadLocalMigrationData']) {
      expect(inferBuildTargetFromKeys({ [key]: () => {} })).toBe('intranet');
    }
    expect(inferBuildTargetFromKeys({ fsLoadAllPatients: () => {}, setAccessToken: () => {} })).toBe('standalone');
    expect(inferBuildTargetFromKeys({ showAlert: () => {} })).toBe('unknown');
  });
});

describe('bridge 접근자 — 예전 키 존재 검사와 같은 조건', () => {
  it('웹이면 전부 null/undefined/false', () => {
    expect(getBridge()).toBeUndefined();
    expect(hasBridge()).toBe(false);
    for (const get of [getFsBridge, getEmrBridge, getMenuBridge, getLifecycleBridge, getDialogBridge, getAiBridge, getMigrationBridge, getLegacyImportBridge]) {
      expect(get()).toBeNull();
    }
  });

  it('호출 시점에 읽는다(나중에 꽂은 브리지도 보인다)', () => {
    expect(getFsBridge()).toBeNull();
    window.electron = makeBridgeStub('standalone');
    expect(getFsBridge()).toBe(window.electron);
  });

  it('독립형: fs·AI·옛 데이터 가져오기 있음, 이관 IPC 없음', () => {
    window.electron = makeBridgeStub('standalone');
    expect(getFsBridge()).toBe(window.electron);
    expect(typeof getAiBridge().analyzeAI).toBe('function');
    expect(typeof getLegacyImportBridge().loadLegacyData).toBe('function');
    expect(getMigrationBridge()).toBeNull();
  });

  it('인트라넷: fs·AI 없음, 이관 IPC·수명 신호 있음', () => {
    window.electron = makeBridgeStub('intranet');
    expect(getFsBridge()).toBeNull();
    expect(getAiBridge()).toBeNull();
    expect(typeof getMigrationBridge().loadLocalMigrationData).toBe('function');
    expect(typeof getLifecycleBridge().setHasUnsavedDraft).toBe('function');
  });

  it('{}(허용 안 된 origin): hasBridge는 true지만 기능 접근자는 키가 없다', () => {
    window.electron = {};
    expect(hasBridge()).toBe(true);
    expect(getFsBridge()).toBeNull();
    expect(getEmrBridge()?.injectEMR).toBeUndefined();
    expect(getMenuBridge()?.onMenuNew).toBeUndefined();
  });
});

describe('dataMode 술어 3개 — T1 진리표와 같다', () => {
  const modes = [undefined, 'local', 'intranet'];
  const ctx = (s, t) => ({
    session: s === undefined ? {} : { mode: s },
    settings: t === undefined ? {} : { integrationMode: t },
  });

  it('isIntranetContext = session OR settings, hasIntranetSession = session만, resolveDataMode', () => {
    for (const s of modes) {
      for (const t of modes) {
        const c = ctx(s, t);
        expect(isIntranetContext(c)).toBe(s === 'intranet' || t === 'intranet');
        expect(hasIntranetSession(c.session)).toBe(s === 'intranet');
        expect(resolveDataMode(c)).toBe(s === 'intranet' ? 'intranet' : t === 'intranet' ? 'intranet-pending' : 'local');
      }
    }
    expect(isIntranetContext()).toBe(false);
    expect(isIntranetContext({ session: null, settings: null })).toBe(false);
    expect(resolveDataMode()).toBe('local');
  });

  it('isRefreshEligible: 모드 없음·intranet → true, local → false', () => {
    expect([undefined, null, {}, { mode: '' }, { mode: 'local' }, { mode: 'intranet' }].map(isRefreshEligible))
      .toEqual([true, true, true, true, false, true]);
  });

  it('resolveApiBaseUrl: session → settings → "", 정규화', () => {
    expect(resolveApiBaseUrl({ session: { apiBaseUrl: ' https://s/ ' }, settings: { apiBaseUrl: 'https://t' } })).toBe('https://s');
    expect(resolveApiBaseUrl({ session: { apiBaseUrl: '' }, settings: { apiBaseUrl: 'https://t/' } })).toBe('https://t');
    expect(resolveApiBaseUrl({})).toBe('');
    expect(resolveApiBaseUrl()).toBe('');
    expect(normalizeBaseUrl(null)).toBe('');
    expect(normalizeBaseUrl('https://a//')).toBe('https://a/'); // 끝 "/" 하나만(예전 식과 같음)
  });
});

describe('dialogs', () => {
  it('셸이면 IPC, 웹이면 브라우저 alert/confirm', async () => {
    const alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await showAlert('a');
    await expect(showConfirm('c')).resolves.toBe(true);
    expect(alertSpy).toHaveBeenCalledWith('a');
    expect(confirmSpy).toHaveBeenCalledWith('c');
    window.electron = makeBridgeStub('standalone', { overrides: { showConfirm: async () => false } });
    await showAlert('b');
    await expect(showConfirm('d')).resolves.toBe(false);
    expect(window.electron.__callsOf('showAlert')).toEqual([['b']]);
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });
});
