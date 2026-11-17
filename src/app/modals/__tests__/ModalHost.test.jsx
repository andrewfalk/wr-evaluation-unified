// @vitest-environment jsdom
//
// ModalHost(REFACTORING_ROADMAP Phase 2 C3-C P2-45a) — 작업 공간 Context 값으로 모달을 렌더한다.
// 옛 AppModals와의 DOM 대조는 AppModals를 지우기 전 커밋(a65b26c)에서 돌렸다(3사례 같은 DOM — PR 본문). 여기서는 App 스모크(G9m)가 닿지 못하는
// 충돌 모달 2종의 분기와, 이름만 같던 별칭 2개(계획 C6)가 **가드된 쪽**으로 가는지를 지킨다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ModalHost } from '../ModalHost';
import { WorkspaceProvider, useWorkspace } from '../../providers/WorkspaceContext';
import { AuthProvider } from '../../../core/auth/AuthContext';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const LOCAL_SESSION = { mode: 'local', status: 'ready', apiBaseUrl: '', user: { id: null } };
const INTRANET_SESSION = { mode: 'intranet', status: 'ready', apiBaseUrl: 'https://srv.test', user: { id: 'u1', role: 'doctor', displayName: '김의사' } };
const PATIENT = { id: 'p1', data: { shared: { name: '홍길동', patientNo: 'WR-1', jobs: [{ id: 'j1', jobName: '용접공' }] }, modules: {}, activeModules: [] } };
const conflictOf = (conflict) => ({ ...PATIENT, sync: { syncStatus: 'conflict', serverId: 'p1', revision: 1, conflict } });

function makeWorkspace(overrides = {}) {
  const fn = () => vi.fn();
  return {
    session: LOCAL_SESSION, settings: { integrationMode: 'local' }, integrationStatus: null, syncState: {}, syncNow: fn(),
    handleLogout: fn(), logout: fn(),
    patients: [PATIENT], activePatient: PATIENT, steps: [{ id: 'info' }, { id: 'diagnosis' }],
    setActiveId: fn(), setCurrentStepIndex: fn(), setShowHome: fn(),
    dirtyAssessmentPatientId: null, blockedByUnsavedDraftAlert: fn(),
    showAdminConsole: false, setShowAdminConsole: fn(),
    showAccountProfile: false, setShowAccountProfile: fn(),
    showChangePassword: false, setShowChangePassword: fn(),
    showSettings: false, setShowSettings: fn(), handleSaveSettings: fn(), handleSaveSettingsAndClose: fn(),
    showMigrationReport: false, setShowMigrationReport: fn(),
    migrationStatus: 'idle', migrationResult: null, startMigration: fn(), retryMigration: fn(), resetMigration: fn(),
    reloadPresets: fn(),
    showSaveModal: false, setShowSaveModal: fn(),
    saveName: '', setSaveName: fn(), savedItems: [], handleSave: fn(), handleOverwriteSave: fn(), handleDelete: fn(),
    showLoadModal: false, setShowLoadModal: fn(), legacyItems: [], handleLoad: fn(),
    showBatchImport: false, setShowBatchImport: fn(), handleBatchImport: fn(),
    conflictPatient: undefined, setConflictPatientId: fn(), handleResolveConflict: fn(), handleCorrectServerIdentity: fn(),
    markRemoteDeleteConflict: fn(),
    presetModalJobId: null, setPresetModalJobId: fn(), presetEditingPreset: null, setPresetEditingPreset: fn(),
    presetBrowseJobId: null, setPresetBrowseJobId: fn(),
    presets: [], handleSaveCustomPreset: fn(), closePresetManageModal: fn(), handleDeleteCustomPreset: fn(), handlePresetSelect: fn(),
    ...overrides,
  };
}

// 모달 일부(비밀번호 변경)가 useAuth를 쓴다 — 실제 AuthProvider(로컬 세션) 아래에서.
const renderHost = (ws) => render(
  <StrictMode><AuthProvider><WorkspaceProvider value={ws}><ModalHost /></WorkspaceProvider></AuthProvider></StrictMode>,
);

describe('ModalHost(P2-45a)', () => {
  it('신원 충돌이면 등록번호 충돌 창, 닫기는 setConflictPatientId(null)', () => {
    const ws = makeWorkspace({ conflictPatient: conflictOf({ kind: 'push', code: 'PATIENT_IDENTITY_CONFLICT' }) });
    renderHost(ws);
    expect(screen.getByRole('heading', { name: '등록번호 충돌' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Resolve Conflict' })).toBeNull();
  });

  it('그 밖의 충돌이면 Resolve Conflict 창', () => {
    const ws = makeWorkspace({ conflictPatient: conflictOf({ kind: 'push', code: 'REVISION_CONFLICT' }) });
    renderHost(ws);
    expect(screen.getByRole('heading', { name: 'Resolve Conflict' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '등록번호 충돌' })).toBeNull();
  });

  it('설정 창의 저장은 handleSaveSettingsAndClose(저장 뒤 닫기) — 원본 handleSaveSettings가 아니다', () => {
    const ws = makeWorkspace({ showSettings: true });
    renderHost(ws);
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(ws.handleSaveSettingsAndClose).toHaveBeenCalledTimes(1);
    expect(ws.handleSaveSettings).not.toHaveBeenCalled();
  });

  it('내 계정 창의 로그아웃은 handleLogout(가드) — 원본 logout이 아니다', () => {
    const ws = makeWorkspace({ showAccountProfile: true, session: INTRANET_SESSION });
    renderHost(ws);
    fireEvent.click(within(screen.getByRole('heading', { name: '내 계정' }).closest('div').parentElement).getByRole('button', { name: '로그아웃' }));
    expect(ws.handleLogout).toHaveBeenCalledTimes(1);
    expect(ws.logout).not.toHaveBeenCalled();
  });

  it('useWorkspace는 Provider 밖에서 던진다', () => {
    function Probe() { useWorkspace(); return null; }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/WorkspaceProvider/);
    spy.mockRestore();
  });
});
