// @vitest-environment jsdom
//
// ModalHost(P2-45a) ↔ 옛 AppModals 대조 — 같은 값을 주면 같은 DOM, 별칭 2개(계획 C6)는 가드된 쪽으로 간다.
// 옛 AppModals는 이 PR에서 지운다: 대조는 지우기 전 커밋에서 돌려 PR 본문에 결과를 적고, 지운 뒤에는 아래 "ModalHost" 블록만 남는다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { AppModals } from '../../../core/components/AppModals';
import { ModalHost } from '../ModalHost';
import { WorkspaceProvider } from '../../providers/WorkspaceContext';
import { AuthProvider } from '../../../core/auth/AuthContext';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const LOCAL_SESSION = { mode: 'local', status: 'ready', apiBaseUrl: '', user: { id: null } };
const PATIENT = { id: 'p1', data: { shared: { name: '홍길동', patientNo: 'WR-1', jobs: [{ id: 'j1', jobName: '용접공' }] }, modules: {}, activeModules: [] } };
const conflictOf = (conflict) => ({ ...PATIENT, sync: { syncStatus: 'conflict', serverId: 'p1', revision: 1, conflict } });

/** 모든 필드를 가진 작업 공간 값(함수는 vi.fn) — 모달이 읽는 이름만 채운다. */
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

/** 옛 App.jsx modalsProps와 같은 매핑(별칭 포함). */
function legacyProps(ws) {
  return {
    ...ws,
    logout: ws.handleLogout,
    handleSaveSettings: ws.handleSaveSettingsAndClose,
    hasUnsavedAssessmentDraft: !!ws.dirtyAssessmentPatientId,
    onBlockedByUnsavedDraft: ws.blockedByUnsavedDraftAlert,
  };
}

async function htmlOf(element) {
  // 모달 일부(비밀번호 변경 등)가 useAuth를 쓴다 — 두 렌더 모두 같은 실제 AuthProvider(로컬 세션) 아래에서.
  const { container, unmount } = render(<StrictMode><AuthProvider>{element}</AuthProvider></StrictMode>);
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const html = container.innerHTML;
  unmount();
  return html;
}

const CASES = [
  ['모든 불리언 모달 + 프리셋 2종', {
    showAdminConsole: true, showAccountProfile: true, showChangePassword: true, showSettings: true, showMigrationReport: true,
    showSaveModal: true, showLoadModal: true, presetModalJobId: 'j1', presetBrowseJobId: 'j1',
  }],
  ['신원 충돌(PatientIdentityConflictModal)', { conflictPatient: conflictOf({ kind: 'push', code: 'PATIENT_IDENTITY_CONFLICT' }) }],
  ['일반 충돌(ConflictResolveModal)', { conflictPatient: conflictOf({ kind: 'push', code: 'REVISION_CONFLICT' }) }],
];

describe('ModalHost ↔ 옛 AppModals(P2-45a)', () => {
  it.each(CASES)('%s: 같은 값 → 같은 DOM', async (_label, overrides) => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));
    const ws = makeWorkspace(overrides);
    const legacy = await htmlOf(<AppModals {...legacyProps(ws)} />);
    const host = await htmlOf(<WorkspaceProvider value={ws}><ModalHost /></WorkspaceProvider>);
    expect(legacy.length).toBeGreaterThan(0);
    expect(host).toBe(legacy);
  });
});
