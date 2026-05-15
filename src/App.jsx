import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { getModule, getAllModules } from './core/moduleRegistry';
import { SettingsModal } from './core/components/SettingsModal';
import { MigrationReportModal } from './core/components/MigrationReportModal';
import { ConflictResolveModal } from './core/components/ConflictResolveModal';
import { BatchImportModal } from './core/components/BatchImportModal';
import { PresetManageModal } from './core/components/PresetManageModal';
import { PresetBrowseModal } from './core/components/PresetBrowseModal';
import { SaveModal, LoadModal } from './core/components/SaveLoadModals';
import { LandingScreen } from './core/components/LandingScreen';
import { IntakeWizard } from './core/components/IntakeWizard';
import { PatientSidebar } from './core/components/PatientSidebar';
import { StepContent } from './core/components/StepContent';
import { MainHeader } from './core/components/MainHeader';
import { StepIndicator } from './core/components/StepIndicator';
import { useAuth } from './core/auth/AuthContext';
import { useServerConfig } from './core/hooks/useServerConfig';
import { useAIAvailable } from './core/hooks/useAIAvailable';
import { configureHttpClient } from './core/services/httpClient';
import { getCsrfToken } from './core/utils/csrfCookie';
import { normalizeSession } from './core/auth/session';
import { runRefreshWithBroadcast, onAuthBroadcast, broadcastLogout } from './core/auth/authChannel';
import { useIntegrationStatus } from './core/hooks/useIntegrationStatus';
import { usePatientList } from './core/hooks/usePatientList';
import { DEFAULT_SETTINGS, FONT_SIZE_MAP } from './core/utils/data';
import { useExportHandlers } from './core/hooks/useExportHandlers';
import { usePresetManagement } from './core/hooks/usePresetManagement';
import { useEMRIntegration } from './core/hooks/useEMRIntegration';
import { useStepNavigation } from './core/hooks/useStepNavigation';
import { useIntakeWizard } from './core/hooks/useIntakeWizard';
import { useWorkspacePersistence } from './core/hooks/useWorkspacePersistence';
import { useMigration } from './core/hooks/useMigration';
import { useOpsStatus } from './core/hooks/useOpsStatus';
import { usePatientCrud } from './core/hooks/usePatientCrud';
import { usePatientSync } from './core/hooks/usePatientSync';
import { resolvePatientConflictInList } from './core/services/patientConflictResolution';
import { deletePatientOnServer } from './core/services/patientServerRepository';
import { suggestModules } from './core/utils/diagnosisMapping';
import { showAlert, showConfirm } from './core/utils/platform';
import { getSyncedEvaluationDate } from './core/utils/patientCompletion';
import { generateUnifiedReport } from './core/utils/reportGenerator';
import { buildSteps } from './core/utils/steps';
import { isRedactedPatientRecord, touchPatientRecord } from './core/services/patientRecords';
import {
  clearAutoSavedWorkspace,
  loadAppSettings,
  loadAppSettingsAsync,
  saveAppSettings,
} from './core/services/workspaceRepository';
import { LoginModal } from './core/components/LoginModal';
import { ChangePasswordModal } from './core/components/ChangePasswordModal';
import { AdminConsoleModal } from './core/components/AdminConsoleModal';
import { AccountProfileModal } from './core/components/AccountProfileModal';

const DEFAULT_PATIENT_FILTERS = {
  searchQuery: '',
  statusFilter: 'all',
  moduleFilter: 'all',
  jobFilter: '',
  registrationFrom: '',
  registrationTo: '',
  completionFrom: '',
  completionTo: '',
  sortKey: 'default',
  sortDirection: 'asc',
};

function getDefaultPatientScope(session) {
  return session?.mode === 'intranet' && session?.user?.role !== 'doctor'
    ? 'all'
    : 'mine';
}

function normalizeBaseUrl(baseUrl = '') {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

// 모듈 등록 (사이드이펙트 import)
import './modules/knee';
import './modules/spine';
import './modules/cervical';
import './modules/shoulder';
import './modules/elbow';
import './modules/wrist';


function applyAuthUpdate(currentSession, authUpdate) {
  const patch = typeof authUpdate === 'string'
    ? { accessToken: authUpdate }
    : (authUpdate || {});
  const next = {
    ...(currentSession || {}),
    status: 'ready',
  };
  if (patch.accessToken !== undefined) next.accessToken = patch.accessToken;
  if (patch.accessExpiresAt !== undefined) next.accessExpiresAt = patch.accessExpiresAt;
  if (patch.user) next.user = { ...(currentSession?.user || {}), ...patch.user };
  return normalizeSession(next);
}

function App() {
  const { session, setSession, resetToLocalSession, isAuthenticated, sessionVerified, logout } = useAuth();
  const [patients, setPatients] = useState([]);
  const [patientScope, setPatientScope] = useState(() => getDefaultPatientScope(session));
  const [patientSyncPaused, setPatientSyncPaused] = useState(false);
  const [activeId, setActiveId] = useState(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [errors, setErrors] = useState({});
  const [showSidebar, setShowSidebar] = useState(false);
  const [patientFilters, setPatientFilters] = useState(DEFAULT_PATIENT_FILTERS);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [settings, setSettings] = useState(() => loadAppSettings(DEFAULT_SETTINGS));
  const [showSettings, setShowSettings] = useState(false);
  const [showAdminConsole, setShowAdminConsole] = useState(false);
  const [showAccountProfile, setShowAccountProfile] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showMigrationReport, setShowMigrationReport] = useState(false);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [showHome, setShowHome] = useState(false);
  const [conflictPatientId, setConflictPatientId] = useState(null);
  const { serverConfig, configLoading, configError } = useServerConfig({ session, settings });
  const { aiAvailable } = useAIAvailable({ serverConfig, session });
  const isIntranetMode =
    session?.mode === 'intranet' || settings?.integrationMode === 'intranet';
  const canUseMinePatientScope = session?.mode !== 'intranet' || session?.user?.role === 'doctor';
  const effectivePatientScope = canUseMinePatientScope ? patientScope : 'all';
  const { status: integrationStatus } = useIntegrationStatus({ session, settings });
  const activePatient = patients.find(p => p.id === activeId);
  const conflictPatient = patients.find(
    p => p.id === conflictPatientId && p.sync?.syncStatus === 'conflict'
  );
  const activeModules = isRedactedPatientRecord(activePatient) ? [] : (activePatient?.data?.activeModules || []);

  const {
    presets, presetMeta, presetError,
    presetModalJobId, presetEditingPreset, presetBrowseJobId,
    setPresetModalJobId, setPresetEditingPreset, setPresetBrowseJobId,
    reloadPresets,
    handlePresetSelect, handleSaveCustomPreset, closePresetManageModal, handleDeleteCustomPreset,
  } = usePresetManagement({ activeId, activeModules, session, setPatients });

  const {
    status: migrationStatus,
    result: migrationResult,
    start:  startMigration,
    retry:  retryMigration,
    reset:  resetMigration,
  } = useMigration({ session, settings });

  const isAdmin = session?.user?.role === 'admin' && isAuthenticated;
  const { showBanner: showOpsBanner, bannerMessage: opsBannerMessage } = useOpsStatus({ session, enabled: isAdmin });

  const {
    exportDropdown, setExportDropdown,
    handleExportSingle, handleExportSelected, handleExportBatch,
    handleExportBatchFormatSingle, handleExportBatchFormatSelected, handleExportBatchFormatAll,
  } = useExportHandlers({ activePatient, patients, selectedIds });

  const {
    extractProgress, setExtractProgress,
    handleInjectEMR, handleInjectConsultReply,
    handleEmrExtractBatch, handleExtractConsultation,
  } = useEMRIntegration({ activePatient, patients, selectedIds, session, setPatients });

  const handleStartIntakeRef = useRef(null);
  const handleResetPatientsRef = useRef(null);
  const skipNextSettingsUrlResetRef = useRef(false);

  // Keep a stable ref to the latest session so the refresh handler never
  // captures a stale closure value.
  const sessionRef = useRef(session);
  useEffect(() => { sessionRef.current = session; }, [session]);

  // Wire up httpClient's 401-refresh interceptor once at mount.
  useEffect(() => {
    configureHttpClient({
      // baseUrl comes from the original failed request so we always hit the
      // same server, even if session.apiBaseUrl is momentarily out of sync.
      onRefresh: ({ baseUrl: requestBaseUrl, forceCsrf = false } = {}) =>
        runRefreshWithBroadcast(
          // doRefresh: this tab won the lock and performs the actual refresh.
          async () => {
            const current = sessionRef.current;
            const base = (
              requestBaseUrl ?? current?.apiBaseUrl ?? ''
            ).trim().replace(/\/$/, '');

            let csrfToken = getCsrfToken();

            // CSRF cookie missing: call /api/auth/csrf first (no CSRF required
            // for this endpoint). It re-validates the HttpOnly refresh cookie,
            // sets a new wr_csrf cookie, and returns a fresh accessToken.
            if (forceCsrf || !csrfToken) {
              const csrfRes = await fetch(`${base}/api/auth/csrf`, {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
              });
              if (!csrfRes.ok) throw new Error('CSRF renewal failed');
              const csrfData = await csrfRes.json();
              const newSession = applyAuthUpdate(sessionRef.current, csrfData);
              setSession(newSession);
              return newSession;
            }

            const res = await fetch(`${base}/api/auth/refresh`, {
              method: 'POST',
              credentials: 'include',
              headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
              },
            });
            if (!res.ok) throw new Error('Refresh failed');
            const data = await res.json();
            const newSession = applyAuthUpdate(sessionRef.current, data);
            setSession(newSession);
            return newSession;
          },
          // applyToken: another tab broadcast REFRESH_SUCCESS — update this
          // tab's session without a server round-trip.
          (authUpdate) => {
            const newSession = applyAuthUpdate(sessionRef.current, authUpdate);
            setSession(newSession);
            return newSession;
          },
        ),
      onLogout: () => { broadcastLogout(); resetToLocalSession(); },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync session state when another tab refreshes or logs out.
  useEffect(() => {
    return onAuthBroadcast((msg) => {
      if (msg?.type === 'REFRESH_SUCCESS' && msg.accessToken) {
        setSession(prev => applyAuthUpdate(prev, msg));
      } else if (msg?.type === 'LOGOUT') {
        resetToLocalSession();
      }
    });
  }, [setSession, resetToLocalSession]);

  // 현재 환자의 스텝 목록
  const steps = useMemo(() => buildSteps(activeModules), [activeModules]);
  const { currentStepIndex, setCurrentStepIndex, goToStep, goNext, goPrev, switchPatient } = useStepNavigation({ steps, activeId, setActiveId, setShowSidebar });
  const { intakeShared, setIntakeShared, handleStartIntake, handleIntakeComplete } = useIntakeWizard({ settings, session, setPatients, setActiveId, setCurrentStepIndex, setShowHome });
  handleStartIntakeRef.current = handleStartIntake;

  useEffect(() => {
    setPatientScope(getDefaultPatientScope(session));
    setPatientSyncPaused(false);
  }, [session?.mode, session?.user?.id, session?.user?.role]);

  useEffect(() => {
    if (patients.length > 0 || intakeShared) {
      setPatientSyncPaused(false);
    }
  }, [patients.length, intakeShared]);

  const { syncState, syncNow } = usePatientSync({
    patients,
    setPatients,
    activeId,
    setActiveId,
    session,
    settings,
    scope: effectivePatientScope,
    enabled:
      isIntranetMode &&
      isAuthenticated &&
      sessionVerified &&
      !session?.user?.mustChangePassword &&
      !configLoading &&
      !configError &&
      !patientSyncPaused,
  });

  const {
    savedItems, setSavedItems, saveName, setSaveName, lastAutoSave, legacyItems,
    handleSave, handleOverwriteSave, handleLoad, handleDelete, openLoadModal,
  } = useWorkspacePersistence({
    patients, setPatients,
    session, settings, serverConfig,
    setActiveId, setCurrentStepIndex, setIntakeShared, setShowHome,
    setShowSaveModal, setShowLoadModal,
    disabled: isIntranetMode && (configLoading || !!configError),
  });
  const currentStep = steps[currentStepIndex] || steps[0];

  // 현재 스텝의 모듈 정보
  const activeModuleId = currentStep?.moduleId || null;
  const activeModule = activeModuleId ? getModule(activeModuleId) : null;

  const {
    updatePatient, updateShared, updateActiveModules,
    updateModule, updateModuleById, updateDiagnoses,
    addPatient, removePatient, removeSelectedPatients,
    handleBatchImport, handleLoadTestData,
  } = usePatientCrud({
    activeId, activeModuleId, session, settings,
    patients, setPatients,
    selectedIds, setSelectedIds,
    errors, setErrors,
    setActiveId, setCurrentStepIndex,
    setIntakeShared, setShowHome,
    handleStartIntake,
  });

  // 테마/폰트 적용
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.documentElement.style.fontSize = FONT_SIZE_MAP[settings.fontSize] || '16px';
  }, [settings.theme, settings.fontSize]);

  // Sync apiBaseUrl into session when settings change.
  // session.mode is intentionally NOT synced here — it is only set to 'intranet'
  // by login() after server authentication, preventing unauthenticated local
  // sessions from being treated as authenticated by the isAuthenticated gate.
  // If the URL changes while an intranet session is active, the existing auth is
  // invalid for the new server — reset to local so the LoginModal re-prompts.
  useEffect(() => {
    const prev = session;
    const nextBaseUrl = normalizeBaseUrl(settings.apiBaseUrl);
    const prevBaseUrl = normalizeBaseUrl(prev.apiBaseUrl);
    const skipReset = skipNextSettingsUrlResetRef.current;
    skipNextSettingsUrlResetRef.current = false;
    if (prevBaseUrl === nextBaseUrl) return;
    if (skipReset) {
      if (prev.mode !== 'intranet') {
        setSession(s => ({ ...s, apiBaseUrl: nextBaseUrl }));
      }
      return;
    }
    if (prev.mode === 'intranet') {
      resetToLocalSession();
    } else {
      setSession(s => ({ ...s, apiBaseUrl: nextBaseUrl }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiBaseUrl]); // intentionally excludes session/setSession/resetToLocalSession — URL-change only

  // Electron: 파일 기반 설정 비동기 로드
  useEffect(() => {
    let cancelled = false;
    loadAppSettingsAsync(DEFAULT_SETTINGS).then(s => {
      if (cancelled) return;
      skipNextSettingsUrlResetRef.current = true;
      setSettings(s);
    });
    return () => { cancelled = true; };
  }, []);

  // 평가 완료 시 evaluationDate 자동 설정
  useEffect(() => {
    if (!activeId) return;
    const p = patients.find(x => x.id === activeId);
    if (!p || isRedactedPatientRecord(p) || !p.data) return;

    const nextEvaluationDate = getSyncedEvaluationDate(p);
    const currentEvaluationDate = p.data?.shared?.evaluationDate || '';
    if (currentEvaluationDate === nextEvaluationDate) return;

    setPatients(prev => prev.map(x =>
      x.id === activeId
        ? touchPatientRecord(
          { ...x, data: { ...x.data, shared: { ...x.data.shared, evaluationDate: nextEvaluationDate } } },
          { session }
        )
        : x
    ));
  }, [activeId, patients, session]);

  // Electron 메뉴 이벤트
  useEffect(() => {
    const unsubs = [];
    if (window.electron?.onMenuNew) {
      unsubs.push(window.electron.onMenuNew(() => { handleResetPatientsRef.current?.(); }));
    }
    if (window.electron?.onGotoModule) {
      unsubs.push(window.electron.onGotoModule(() => { handleStartIntakeRef.current?.(); }));
    }
    return () => unsubs.forEach(fn => fn?.());
  }, []);

  const displayPatients = usePatientList(patients, patientFilters);

  // 계산 결과
  const calc = useMemo(() => {
    if (!activePatient || isRedactedPatientRecord(activePatient) || !activePatient.data || !activeModule?.computeCalc) return {};
    return activeModule.computeCalc({
      shared: activePatient.data.shared || {},
      module: activePatient.data.modules?.[activeModuleId] || {}
    });
  }, [activePatient, activeModule, activeModuleId]);

  // 통합 미리보기 텍스트
  const unifiedPreviewText = useMemo(() => {
    if (!activePatient || isRedactedPatientRecord(activePatient) || activeModules.length === 0) return '';
    return generateUnifiedReport(activePatient);
  }, [activePatient, activeModules]);

  // --- 핸들러 ---

  const handleSaveSettings = (newSettings) => {
    setSettings(newSettings);
    saveAppSettings(newSettings);
    const nextBaseUrl = normalizeBaseUrl(newSettings.apiBaseUrl);
    const switchingToLocal = newSettings.integrationMode !== 'intranet';
    // Reset intranet session when: switching to local mode, or changing the server URL.
    // Either case means the existing auth token is no longer valid for the new context.
    if (session.mode === 'intranet' && (switchingToLocal || normalizeBaseUrl(session.apiBaseUrl) !== nextBaseUrl)) {
      resetToLocalSession();
    } else {
      setSession(prev => ({ ...prev, apiBaseUrl: nextBaseUrl }));
    }
    setShowSettings(false);
  };

  const handleResetPatients = async () => {
    const ok = await showConfirm('현재 작업 중인 환자 목록을 모두 삭제하시겠습니까?');
    if (!ok) return;
    setPatientSyncPaused(true);
    setPatients([]);
    setActiveId(null);
    setSelectedIds(new Set());
    setIntakeShared(null);
    setShowHome(true);
    clearAutoSavedWorkspace({ session, settings, serverConfig })
      .catch(error => {
        console.warn('[autosave-clear]', error);
      });
  };
  handleResetPatientsRef.current = handleResetPatients;

  const applyResolvedConflict = (patientId, resolution, options = {}) => {
    setPatients(prev => {
      const next = resolvePatientConflictInList(prev, patientId, resolution, options);
      if (activeId === patientId && !next.some(p => p.id === patientId)) {
        queueMicrotask(() => {
          setActiveId(next[0]?.id || null);
          setCurrentStepIndex(0);
        });
      }
      return next;
    });
    setConflictPatientId(null);
  };

  const markRemoteDeleteConflict = useCallback((patientId) => {
    if (!patientId) return;
    setPatients(prev => prev.map(p => (
      p.id === patientId
        ? {
            ...p,
            sync: {
              ...(p.sync || {}),
              syncStatus: 'conflict',
              conflict: {
                ...(p.sync?.conflict || {}),
                kind: 'remote-delete',
                serverRevision: null,
              },
            },
          }
        : p
    )));
  }, [setPatients]);

  const handleResolveConflict = async (resolution, { patient, serverPatient, mergedData } = {}) => {
    if (!patient) return;
    const conflict = patient.sync?.conflict || {};
    const conflictKind = conflict.kind;

    if (resolution === 'use-local' && conflictKind === 'delete') {
      try {
        await deletePatientOnServer(
          patient.sync.serverId,
          serverPatient?.sync?.revision ?? conflict.serverRevision ?? patient.sync.revision,
          { session, settings }
        );
        applyResolvedConflict(patient.id, resolution, { serverPatient });
      } catch (error) {
        if (error?.status === 404) {
          applyResolvedConflict(patient.id, resolution, { serverPatient });
          return;
        }
        setPatients(prev => prev.map(p => (
          p.id === patient.id
            ? {
                ...p,
                sync: {
                  ...(p.sync || {}),
                  syncStatus: 'conflict',
                  conflict: {
                    ...(p.sync?.conflict || {}),
                    serverRevision: error?.data?.currentRevision ?? p.sync?.conflict?.serverRevision ?? null,
                  },
                },
              }
            : p
        )));
        await showAlert(`Delete failed. ${error?.message || 'Please try again.'}`);
      }
      return;
    }

    const needsNewLocalId = conflictKind === 'remote-delete' && (
      resolution === 'use-local' || resolution === 'merge'
    );
    applyResolvedConflict(patient.id, resolution, {
      serverPatient,
      mergedData,
      newId: needsNewLocalId ? crypto.randomUUID() : null,
    });
  };

  // 공통 모달 렌더링
  const renderModals = () => (
    <>
      {showAdminConsole && (
        <AdminConsoleModal
          session={session}
          onClose={() => setShowAdminConsole(false)}
          onPatientAssignmentChanged={() => syncNow({ pull: true, reason: 'assignment-change' })}
        />
      )}
      {showAccountProfile && (
        <AccountProfileModal
          session={session}
          settings={settings}
          syncState={syncState}
          onClose={() => setShowAccountProfile(false)}
          onLogout={logout}
          onChangePassword={() => { setShowAccountProfile(false); setShowChangePassword(true); }}
          onShowAdminConsole={() => { setShowAccountProfile(false); setShowAdminConsole(true); }}
        />
      )}
      {showChangePassword && (
        <ChangePasswordModal
          apiBaseUrl={session?.apiBaseUrl || settings?.apiBaseUrl || ''}
          onClose={() => setShowChangePassword(false)}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={settings}
          session={session}
          integrationStatus={integrationStatus}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
          onLogout={logout}
          onMigrate={() => { setShowSettings(false); setShowMigrationReport(true); }}
          onPresetsImported={reloadPresets}
        />
      )}
      {showMigrationReport && (
        <MigrationReportModal
          status={migrationStatus}
          result={migrationResult}
          onStart={startMigration}
          onRetry={retryMigration}
          onReset={resetMigration}
          onClose={() => setShowMigrationReport(false)}
          onPresetsImported={reloadPresets}
          session={session}
        />
      )}
      {showSaveModal && <SaveModal patientCount={patients.length} saveName={saveName} onSaveNameChange={e => setSaveName(e.target.value)} savedItems={savedItems} onSave={handleSave} onOverwriteSave={handleOverwriteSave} onDelete={handleDelete} onClose={() => setShowSaveModal(false)} />}
      {showLoadModal && <LoadModal legacyItems={legacyItems} savedItems={savedItems} onLoad={handleLoad} onDelete={handleDelete} onClose={() => setShowLoadModal(false)} />}
      {showBatchImport && <BatchImportModal onClose={() => setShowBatchImport(false)} onImport={handleBatchImport} existingPatients={patients} />}
      {conflictPatient && (
        <ConflictResolveModal
          patient={conflictPatient}
          session={session}
          settings={settings}
          onResolve={handleResolveConflict}
          onRemoteDeleteDetected={markRemoteDeleteConflict}
          onClose={() => setConflictPatientId(null)}
        />
      )}
      {presetModalJobId && activePatient && (
        <PresetManageModal
          jobId={presetModalJobId}
          patient={activePatient}
          presets={presets}
          editingPreset={presetEditingPreset}
          onSave={handleSaveCustomPreset}
          onClose={closePresetManageModal}
          session={session}
        />
      )}
      {presetBrowseJobId && activePatient && (
        <PresetBrowseModal
          job={(activePatient.data?.shared?.jobs || []).find(job => job.id === presetBrowseJobId)}
          presets={presets}
          onDelete={handleDeleteCustomPreset}
          onEdit={(preset) => {
            setPresetEditingPreset(preset);
            setPresetModalJobId(presetBrowseJobId);
            setPresetBrowseJobId(null);
          }}
          onSelect={async (preset) => {
            await handlePresetSelect(presetBrowseJobId, preset);
            setPresetBrowseJobId(null);
          }}
          onClose={() => setPresetBrowseJobId(null)}
        />
      )}
    </>
  );

  // ===========================================
  // 인트라넷 모드 부팅 게이팅
  // ===========================================
  if (isIntranetMode && configLoading) {
    return (
      <div className="app-boot-overlay">
        <div className="app-boot-box">
          <p>서버에 연결 중입니다…</p>
        </div>
      </div>
    );
  }

  if (isIntranetMode && configError) {
    const serverUrl = session?.apiBaseUrl || settings?.apiBaseUrl || '';
    return (
      <div className="app-boot-overlay">
        <div className="app-boot-box app-boot-error">
          <h2>서버 연결 실패</h2>
          <p>{configError}</p>
          <p className="app-boot-hint">
            인트라넷 서버({serverUrl})에 연결할 수 없습니다.<br />
            서버 상태를 확인하거나 관리자에게 문의하세요.
          </p>
          <button
            className="btn btn-secondary"
            onClick={() => window.location.reload()}
          >
            다시 시도
          </button>
        </div>
      </div>
    );
  }

  // Boot-time session verification in progress (persisted intranet session, not yet confirmed).
  // session.mode==='intranet' && !sessionVerified means the /api/auth/csrf check is in flight.
  if (isIntranetMode && session?.mode === 'intranet' && !sessionVerified) {
    return (
      <div className="app-boot-overlay">
        <div className="app-boot-box">
          <p>세션을 확인하는 중입니다…</p>
        </div>
      </div>
    );
  }

  // Login guard: intranet mode but not authenticated (no persisted session, or
  // verification failed and session was reset to local). Non-dismissable.
  if (isIntranetMode && !isAuthenticated) {
    return (
      <LoginModal apiBaseUrl={session?.apiBaseUrl || settings?.apiBaseUrl || ''} />
    );
  }

  // Password change guard: server flagged must_change_password (e.g. seed admin first login).
  // Blocks all other UI until the password is changed. Non-dismissable.
  if (isIntranetMode && isAuthenticated && session?.user?.mustChangePassword) {
    return (
      <ChangePasswordModal apiBaseUrl={session?.apiBaseUrl || settings?.apiBaseUrl || ''} />
    );
  }

  // ===========================================
  // 랜딩 화면
  // ===========================================
  if ((patients.length === 0 && !activeId && !intakeShared) || showHome) {
    return (
      <div className="app-layout landing-layout">
        <LandingScreen
          patients={patients}
          onStartIntake={handleStartIntake}
          onOpenLoadModal={openLoadModal}
          onShowSaveModal={() => setShowSaveModal(true)}
          onShowBatchImport={() => setShowBatchImport(true)}
          onLoadTestData={handleLoadTestData}
          onShowSettings={() => setShowSettings(true)}
          onGoBack={() => setShowHome(false)}
          onResetPatients={handleResetPatients}
          onSelectPatient={(id) => { setActiveId(id); setCurrentStepIndex(0); setShowHome(false); }}
          isIntranetMode={session?.mode === 'intranet'}
        />
        {renderModals()}
      </div>
    );
  }

  // ===========================================
  // 신규 환자 위자드 (환자 생성 전)
  // ===========================================
  if (intakeShared) {
    return (
      <IntakeWizard
        shared={intakeShared}
        onSharedChange={setIntakeShared}
        hasExistingPatients={patients.length > 0}
        onCancel={() => { setIntakeShared(null); if (patients.length > 0) setActiveId(patients[0].id); }}
        onComplete={handleIntakeComplete}
        errors={errors}
        presets={presets}
        presetMeta={presetMeta}
        presetError={presetError}
        session={session}
      />
    );
  }

  // ===========================================
  // 메인 작업 화면 (위자드 전체 흐름)
  // ===========================================
  const shared = activePatient?.data?.shared || {};
  const diagnoses = shared.diagnoses || [];
  const allModules = getAllModules();
  const suggested = suggestModules(diagnoses);

  // 현재 스텝의 모듈에 대한 EvaluationComponent
  const EvaluationComponent = activeModule?.EvaluationComponent;


  // 헤더 타이틀
  const headerTitle = currentStep?.group === 'shared'
    ? currentStep.label
    : `${currentStep?.icon || ''} ${currentStep?.moduleName || ''} - ${currentStep?.label || ''}`;

  return (
    <div className="app-layout">
      <PatientSidebar
        showSidebar={showSidebar}
        onClose={() => setShowSidebar(false)}
        patients={patients}
        displayPatients={displayPatients}
        activeId={activeId}
        filters={patientFilters}
        setFilters={setPatientFilters}
        selectedIds={selectedIds}
        setSelectedIds={setSelectedIds}
        onAddPatient={addPatient}
        onShowBatchImport={() => setShowBatchImport(true)}
        onSwitchPatient={switchPatient}
        onRemovePatient={removePatient}
        onRemoveSelectedPatients={removeSelectedPatients}
        onResolveConflict={setConflictPatientId}
        scope={effectivePatientScope}
        onScopeChange={scope => {
          setPatientSyncPaused(false);
          setPatientScope(canUseMinePatientScope ? scope : 'all');
        }}
        session={session}
        serverUnassignedCount={syncState?.serverUnassignedCount ?? null}
      />

      {/* 메인 영역 */}
      <div className="main-area">
        <MainHeader
          title={headerTitle}
          lastAutoSave={lastAutoSave}
          integrationStatus={integrationStatus}
          session={session}
          onShowAdminConsole={() => setShowAdminConsole(true)}
          onLogout={logout}
          onChangePassword={() => setShowChangePassword(true)}
          onShowAccountProfile={() => setShowAccountProfile(true)}
          patients={patients}
          activePatient={activePatient}
          activeModules={activeModules}
          selectedIds={selectedIds}
          extractProgress={extractProgress}
          setExtractProgress={setExtractProgress}
          exportDropdown={exportDropdown}
          setExportDropdown={setExportDropdown}
          onShowHome={() => setShowHome(true)}
          onResetPatients={handleResetPatients}
          onToggleSidebar={() => setShowSidebar(v => !v)}
          onShowSaveModal={() => setShowSaveModal(true)}
          onOpenLoadModal={openLoadModal}
          onShowSettings={() => setShowSettings(true)}
          exportHandlers={{
            onExportSingle: handleExportSingle,
            onExportSelected: handleExportSelected,
            onExportBatch: handleExportBatch,
            onExportBatchFormatSingle: handleExportBatchFormatSingle,
            onExportBatchFormatSelected: handleExportBatchFormatSelected,
            onExportBatchFormatAll: handleExportBatchFormatAll,
          }}
          emrHandlers={{
            onEmrExtractBatch: handleEmrExtractBatch,
            onExtractConsultation: handleExtractConsultation,
            onInjectEMR: handleInjectEMR,
            onInjectConsultReply: handleInjectConsultReply,
          }}
        />

        {showOpsBanner && (
          <button
            className="ops-alert-banner"
            type="button"
            onClick={() => setShowAdminConsole(true)}
          >
            {opsBannerMessage}
          </button>
        )}

        {false && showOpsBanner && (
          <button
            className="ops-alert-banner"
            type="button"
            onClick={() => setShowAdminConsole(true)}
          >
            백업 이상 감지 — 관리자 콘솔 &gt; 운영 상태 탭에서 확인하세요
          </button>
        )}

        {activePatient && (
          <>
            {/* 스텝 인디케이터 */}
            <StepIndicator steps={steps} currentStepIndex={currentStepIndex} goToStep={goToStep} />

            {/* 콘텐츠 */}
            <div className={`main-content ${currentStep.id === 'info' ? 'main-content-dual' : currentStep.id === 'assessment' ? '' : 'main-content-single'}`}>
              <StepContent
                currentStep={currentStep}
                activePatient={activePatient}
                shared={shared}
                diagnoses={diagnoses}
                activeModules={activeModules}
                allModules={allModules}
                suggested={suggested}
                activeModuleId={activeModuleId}
                EvaluationComponent={EvaluationComponent}
                calc={calc}
                unifiedPreviewText={unifiedPreviewText}
                errors={errors}
                settings={settings}
                session={session}
                presets={presets}
                presetMeta={presetMeta}
                presetError={presetError}
                aiAvailable={aiAvailable}
                updateShared={updateShared}
                updateModule={updateModule}
                updateModuleById={updateModuleById}
                updateDiagnoses={updateDiagnoses}
                updateActiveModules={updateActiveModules}
                handlePresetSelect={handlePresetSelect}
                setPresetModalJobId={setPresetModalJobId}
                setPresetBrowseJobId={setPresetBrowseJobId}
              />
            </div>

            {/* 이전/다음 버튼 */}
            <div className="wizard-nav">
              <button className="btn btn-secondary" onClick={goPrev} disabled={currentStepIndex === 0}>
                &larr; 이전
              </button>
              <span className="wizard-nav-count">
                {currentStepIndex + 1} / {steps.length}
              </span>
              <button className="btn btn-primary" onClick={goNext} disabled={currentStepIndex >= steps.length - 1}>
                다음 &rarr;
              </button>
            </div>
          </>
        )}
      </div>

      {/* 모달들 */}
      {renderModals()}
    </div>
  );
}

export default App;
