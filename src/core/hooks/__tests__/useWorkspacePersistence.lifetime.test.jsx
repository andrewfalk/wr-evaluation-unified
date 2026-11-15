// @vitest-environment jsdom
//
// 로컬 자동저장 복원과 화면 수명(계정 전환 수정 AS-4, R19). 계정이 바뀌면 화면(App)이 다시 띄워진다 — 읽기·확인창을 기다리던
// 이전 화면의 복원 처리가 뒤늦게 로컬 자동저장의 유일한 사본을 지우면 안 된다. 복원을 수락했을 때 저장본 삭제는 복원된 목록이
// 커밋된 뒤에 한다(그 전에 화면이 내려가면 저장본은 디스크에 남아, 다음에 로컬 모드에서 다시 복원 안내가 뜬다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useWorkspacePersistence } from '../useWorkspacePersistence.js';
import { useLocalWorkBeforeLogin } from '../../../app/useLocalWorkBeforeLogin';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

vi.mock('../../services/workspaceRepository', () => ({
  clearAutoSavedWorkspace: vi.fn(async () => {}),
  deleteWorkspaceSnapshot: vi.fn(),
  hasDuplicateWorkspaceName: vi.fn(() => false),
  loadAutoSavedWorkspace: vi.fn(async () => null),
  loadSavedWorkspaces: vi.fn(async () => []),
  migrateWorkspaceStorage: vi.fn(),
  saveAutoSavedWorkspace: vi.fn(async () => {}),
  saveWorkspaceSnapshot: vi.fn(),
}));

import { showAlert, showConfirm } from '../../utils/platform';
import { clearAutoSavedWorkspace, loadAutoSavedWorkspace } from '../../services/workspaceRepository';

const SAVED = {
  savedAt: '2026-11-01T01:02:03.000Z',
  patients: [{ id: 'p1', data: { shared: { name: '로컬환자' }, modules: {}, activeModules: [] }, sync: { syncStatus: 'local-only' } }],
};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function render({ onSetPatients } = {}) {
  return renderHook(() => {
    const [patients, setPatientsState] = useState([]);
    const setPatients = (tx) => { onSetPatients?.(tx); setPatientsState(tx); };
    useWorkspacePersistence({
      patients, setPatients,
      session: { mode: 'local' }, settings: { autoSaveInterval: 0 }, serverConfig: {},
      setActiveId: vi.fn(), setCurrentStepIndex: vi.fn(), setIntakeShared: vi.fn(), setShowHome: vi.fn(),
      setShowSaveModal: vi.fn(), setShowLoadModal: vi.fn(),
      disabled: false,
      dirtyAssessmentPatientId: null, onBlockedByUnsavedDraft: vi.fn(),
    });
    return { patients };
  }, { wrapper: StrictMode });
}

async function flush(rounds = 10) {
  for (let i = 0; i < rounds; i += 1) await act(async () => { await Promise.resolve(); });
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('R19 — 자동저장 복원 중 화면이 내려가면 저장본을 지우지 않는다', () => {
  it('읽기가 보류된 동안 화면이 내려감 → 뒤늦게 읽기가 끝나도 확인창·삭제 없음', async () => {
    const read = deferred();
    loadAutoSavedWorkspace.mockImplementationOnce(() => read.promise);
    const view = render();
    await flush(2);
    expect(loadAutoSavedWorkspace).toHaveBeenCalledTimes(1);
    view.unmount();
    await act(async () => { read.resolve(SAVED); });
    await flush();
    expect(showConfirm).not.toHaveBeenCalled();
    expect(clearAutoSavedWorkspace).not.toHaveBeenCalled();
  });

  it('확인창을 기다리는 동안 화면이 내려감 → 뒤늦게 수락·거절해도 삭제 없음', async () => {
    loadAutoSavedWorkspace.mockResolvedValueOnce(SAVED);
    const answer = deferred();
    showConfirm.mockImplementationOnce(() => answer.promise);
    const view = render();
    await waitFor(() => expect(showConfirm).toHaveBeenCalledTimes(1));
    view.unmount();
    await act(async () => { answer.resolve(true); });
    await flush();
    expect(clearAutoSavedWorkspace).not.toHaveBeenCalled();
    expect(showAlert).not.toHaveBeenCalled();
  });

  it('복원을 수락하고 같은 틱에 화면이 내려가면(복원 목록이 커밋되기 전) 저장본을 지우지 않는다', async () => {
    loadAutoSavedWorkspace.mockResolvedValueOnce(SAVED);
    let view;
    view = render({ onSetPatients: () => { view.unmount(); } });
    await flush();
    expect(showConfirm).toHaveBeenCalledTimes(1);
    expect(clearAutoSavedWorkspace).not.toHaveBeenCalled();
  });

  it('복원을 수락하면 복원된 목록이 커밋된 뒤 저장본을 지운다', async () => {
    loadAutoSavedWorkspace.mockResolvedValueOnce(SAVED);
    const view = render();
    await waitFor(() => expect(view.result.current.patients).toHaveLength(1));
    await waitFor(() => expect(clearAutoSavedWorkspace).toHaveBeenCalledTimes(1));
  });

  it('복원을 거절하면 지금처럼 저장본을 지운다', async () => {
    loadAutoSavedWorkspace.mockResolvedValueOnce(SAVED);
    showConfirm.mockResolvedValueOnce(false);
    const view = render();
    await waitFor(() => expect(clearAutoSavedWorkspace).toHaveBeenCalledTimes(1));
    expect(view.result.current.patients).toHaveLength(0);
  });
});

describe('자동저장 복원과 로그인 직전 로컬 보존의 직렬화', () => {
  it('복원 확인이 진행 중이면 보존은 복원이 끝날 때까지 기다리고, 복원된 목록을 저장한 뒤 돌아간다', async () => {
    const saves = [];
    window.electron = {
      fsLoadAllPatients: async () => [],
      fsSaveAutoSave: vi.fn((data) => { const d = deferred(); saves.push({ data, d }); return d.promise; }),
    };
    try {
      loadAutoSavedWorkspace.mockResolvedValueOnce(SAVED);
      const answer = deferred();
      showConfirm.mockImplementationOnce(() => answer.promise);
      const local = { id: 'L1', data: { shared: { name: '화면의 로컬 환자' }, modules: {}, activeModules: [] }, sync: { syncStatus: 'local-only' } };
      const view = renderHook(() => {
        const [patients, setPatients] = useState([local]);
        const persistence = useWorkspacePersistence({
          patients, setPatients,
          session: { mode: 'local' }, settings: { autoSaveInterval: 0 }, serverConfig: {},
          setActiveId: vi.fn(), setCurrentStepIndex: vi.fn(), setIntakeShared: vi.fn(), setShowHome: vi.fn(),
          setShowSaveModal: vi.fn(), setShowLoadModal: vi.fn(),
          disabled: false, dirtyAssessmentPatientId: null, onBlockedByUnsavedDraft: vi.fn(),
        });
        const beforeLogin = useLocalWorkBeforeLogin({
          patients, getWorkspaceOwner: () => null, waitForPendingRestore: persistence.waitForAutosaveRestore,
        });
        return { patients, beforeLogin };
      }, { wrapper: StrictMode });
      await waitFor(() => expect(showConfirm).toHaveBeenCalledTimes(1));

      let done = false;
      let pending;
      act(() => { pending = view.result.current.beforeLogin().then(() => { done = true; }); });
      await flush(3);
      expect(saves).toHaveLength(0); // 복원이 끝나기 전에는 쓰지 않는다

      await act(async () => { answer.resolve(true); }); // 복원 수락
      await waitFor(() => expect(saves).toHaveLength(1));
      expect(saves[0].data.patients.map((p) => p.id)).toEqual(['p1']); // 복원된 목록
      expect(clearAutoSavedWorkspace).toHaveBeenCalledTimes(1); // 복원본 삭제가 먼저, 재기록이 나중
      expect(done).toBe(false);
      await act(async () => { saves[0].d.resolve(); await pending; });
      expect(done).toBe(true);
      expect(saves).toHaveLength(1);
    } finally {
      delete window.electron;
    }
  });
});

describe('자동저장 복원이 다시 시작되면 이전 복원은 끝나고 적용되지 않는다', () => {
  it('로컬→인트라넷→로컬로 두 복원이 겹치고 응답이 한꺼번에 도착해도: 대기가 풀리고, 나중 복원만 적용·삭제 1회', async () => {
    const reads = [deferred(), deferred()];
    loadAutoSavedWorkspace.mockImplementationOnce(() => reads[0].promise).mockImplementationOnce(() => reads[1].promise);
    const old = { savedAt: SAVED.savedAt, patients: [{ ...SAVED.patients[0], id: 'old' }] };
    const fresh = { savedAt: SAVED.savedAt, patients: [{ ...SAVED.patients[0], id: 'new' }] };
    const view = renderHook(({ settings }) => {
      const [patients, setPatients] = useState([]);
      const persistence = useWorkspacePersistence({
        patients, setPatients,
        session: { mode: 'local' }, settings, serverConfig: {},
        setActiveId: vi.fn(), setCurrentStepIndex: vi.fn(), setIntakeShared: vi.fn(), setShowHome: vi.fn(),
        setShowSaveModal: vi.fn(), setShowLoadModal: vi.fn(),
        disabled: false, dirtyAssessmentPatientId: null, onBlockedByUnsavedDraft: vi.fn(),
      });
      return { patients, wait: persistence.waitForAutosaveRestore };
    }, { initialProps: { settings: { autoSaveInterval: 0 } }, wrapper: StrictMode });
    await flush(2);
    view.rerender({ settings: { autoSaveInterval: 0, integrationMode: 'intranet' } });
    view.rerender({ settings: { autoSaveInterval: 0 } });
    await flush(2);
    expect(loadAutoSavedWorkspace).toHaveBeenCalledTimes(2);

    let settled = false;
    const waiting = view.result.current.wait().then(() => { settled = true; });
    await act(async () => { reads[1].resolve(fresh); reads[0].resolve(old); });
    await flush();
    await act(async () => { await waiting; });

    expect(settled).toBe(true);
    expect(view.result.current.patients.map((p) => p.id)).toEqual(['new']);
    expect(clearAutoSavedWorkspace).toHaveBeenCalledTimes(1);
    expect(showConfirm).toHaveBeenCalledTimes(1); // 대체된 복원은 묻지도 않는다
  });
});
