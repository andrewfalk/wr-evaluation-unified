// 공통 모달(REFACTORING_ROADMAP Phase 2 C3-C, P2-45a) — 옛 `src/core/components/AppModals.jsx`의 JSX 본문을 **그대로** 옮기고 값의
// 출처만 props → useWorkspace()로 바꿨다. 인라인 람다는 인라인 그대로, 직접 넘기던 참조는 직접 넘긴다(참조가 바뀌면 자식 effect가
// 다시 도는 값이 있다 — markRemoteDeleteConflict·settings·integrationStatus 등, 계획 C7).
// 렌더 위치는 옛 AppModals와 같은 두 곳(랜딩·작업 화면). 새 lazy 모달은 만들지 않는다(계획 C15 — 설정 창은 즉시 렌더).
//
// 이름만 같던 별칭 2개(계획 C6)는 Context에서 **다른 이름**이다:
//   모달의 로그아웃 = `handleLogout`(초안·미저장 확인·expectedGen 가드) — 원본 `logout`이 아니다
//   설정 창의 저장 = `handleSaveSettingsAndClose`(저장 뒤 창 닫기) — 원본 `handleSaveSettings`가 아니다
import { Suspense, type ChangeEvent, type ComponentType } from 'react';
import { AdminConsoleModal } from '../../core/components/AdminConsoleModal';
import { AccountProfileModal } from '../../core/components/AccountProfileModal';
import { ChangePasswordModal } from '../../core/components/ChangePasswordModal';
import { SettingsModal } from '../../core/components/SettingsModal';
import { MigrationReportModal } from '../../core/components/MigrationReportModal';
import { SaveModal, LoadModal } from '../../core/components/SaveLoadModals';
import { PatientIdentityConflictModal } from '../../core/components/PatientIdentityConflictModal';
import { ConflictResolveModal } from '../../core/components/ConflictResolveModal';
import { PresetManageModal } from '../../core/components/PresetManageModal';
import { PresetBrowseModal } from '../../core/components/PresetBrowseModal';
import { isPatientIdentityPushConflict } from '../../core/services/patientRecords';
import { resolveApiBaseUrl } from '../../platform/dataMode';
import { lazyWithReload } from '../../core/components/lazyWithReload';
import { useWorkspace } from '../providers/WorkspaceContext';

// 일괄입력 모달은 xlsx(약 490 KB)를 쓰므로 처음 열 때 내려받는다(P-2a, P2-22). 청크를 못 받으면 새로고침 안내.
interface BatchImportModalProps {
  onClose: () => void;
  onImport: unknown;
  existingPatients?: unknown[];
}
const BatchImportModal = lazyWithReload<BatchImportModalProps>(() => import('../../core/components/BatchImportModal')
  .then((m) => ({ default: m.BatchImportModal as unknown as ComponentType<BatchImportModalProps> })));

export function ModalHost() {
  const {
    session, settings, integrationStatus, syncState, syncNow, handleLogout,
    patients, activePatient, steps,
    setActiveId, setCurrentStepIndex, setShowHome,
    dirtyAssessmentPatientId, blockedByUnsavedDraftAlert,

    showAdminConsole, setShowAdminConsole, adminConsoleTab, setAdminConsoleTab, refreshOpsStatus,
    showAccountProfile, setShowAccountProfile,
    showChangePassword, setShowChangePassword,
    showSettings, setShowSettings, handleSaveSettingsAndClose,
    showMigrationReport, setShowMigrationReport,
    migrationStatus, migrationResult, startMigration, retryMigration, resetMigration,
    reloadPresets,

    showSaveModal, setShowSaveModal,
    saveName, setSaveName, savedItems, handleSave, handleOverwriteSave, handleDelete,
    showLoadModal, setShowLoadModal, legacyItems, handleLoad,

    showBatchImport, setShowBatchImport, handleBatchImport,

    conflictPatient, setConflictPatientId, handleResolveConflict, handleCorrectServerIdentity, markRemoteDeleteConflict,

    presetModalJobId, setPresetModalJobId, presetEditingPreset, setPresetEditingPreset,
    presetBrowseJobId, setPresetBrowseJobId,
    presets, handleSaveCustomPreset, closePresetManageModal, handleDeleteCustomPreset, handlePresetSelect,
  } = useWorkspace();
  const hasUnsavedAssessmentDraft = !!dirtyAssessmentPatientId;
  const onBlockedByUnsavedDraft = blockedByUnsavedDraftAlert;

  return (
    <>
      {showAdminConsole && (
        <AdminConsoleModal
          session={session}
          initialTab={adminConsoleTab}
          onClose={() => { setShowAdminConsole(false); setAdminConsoleTab(null); }}
          onPatientAssignmentChanged={() => syncNow({ pull: true, reason: 'assignment-change' })}
          onOpsStatusChanged={refreshOpsStatus}
        />
      )}
      {showAccountProfile && (
        <AccountProfileModal
          session={session}
          settings={settings}
          syncState={syncState}
          onClose={() => setShowAccountProfile(false)}
          onLogout={handleLogout}
          onChangePassword={() => { setShowAccountProfile(false); setShowChangePassword(true); }}
          onShowAdminConsole={() => { setShowAccountProfile(false); setShowAdminConsole(true); }}
        />
      )}
      {showChangePassword && (
        <ChangePasswordModal
          apiBaseUrl={resolveApiBaseUrl({ session, settings })}
          onClose={() => setShowChangePassword(false)}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={settings}
          session={session}
          integrationStatus={integrationStatus}
          onSave={handleSaveSettingsAndClose}
          onClose={() => setShowSettings(false)}
          onLogout={handleLogout}
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
      {showSaveModal && <SaveModal patientCount={patients.length} saveName={saveName} onSaveNameChange={(e: ChangeEvent<HTMLInputElement>) => setSaveName(e.target.value)} savedItems={savedItems} onSave={handleSave} onOverwriteSave={handleOverwriteSave} onDelete={handleDelete} onClose={() => setShowSaveModal(false)} />}
      {showLoadModal && <LoadModal legacyItems={legacyItems} savedItems={savedItems} onLoad={handleLoad} onDelete={handleDelete} onClose={() => setShowLoadModal(false)} />}
      {showBatchImport && (
        <Suspense fallback={null}>
          <BatchImportModal onClose={() => setShowBatchImport(false)} onImport={handleBatchImport} existingPatients={patients} />
        </Suspense>
      )}
      {conflictPatient && isPatientIdentityPushConflict(conflictPatient.sync?.conflict) ? (
        <PatientIdentityConflictModal
          patient={conflictPatient}
          session={session}
          settings={settings}
          onUseServer={(serverPatient: unknown) =>
            handleResolveConflict('use-server', { patient: conflictPatient, serverPatient })
          }
          onCorrectServer={({ birthDate, reasonCode }: { birthDate: unknown; reasonCode: unknown }) =>
            handleCorrectServerIdentity({ patient: conflictPatient, birthDate, reasonCode })
          }
          onEditIdentity={() => {
            // 정정 화면(기본정보 스텝)으로 강제 이동한다 — 지금 다른 환자의 종합소견을
            // 편집 중이면 그 draft가 통째로 사라지므로 먼저 마무리하게 한다.
            if (hasUnsavedAssessmentDraft) { onBlockedByUnsavedDraft?.(); return; }
            setConflictPatientId(null);
            setActiveId(conflictPatient.id);
            setShowHome(false);
            const infoIdx = steps.findIndex(s => s.id === 'info');
            if (infoIdx >= 0) setCurrentStepIndex(infoIdx);
          }}
          onClose={() => setConflictPatientId(null)}
        />
      ) : conflictPatient ? (
        <ConflictResolveModal
          patient={conflictPatient}
          session={session}
          settings={settings}
          onResolve={handleResolveConflict}
          onRemoteDeleteDetected={markRemoteDeleteConflict}
          onClose={() => setConflictPatientId(null)}
        />
      ) : null}
      {presetModalJobId && activePatient && (
        <PresetManageModal
          jobId={presetModalJobId}
          patient={activePatient}
          presets={presets}
          editingPreset={presetEditingPreset as null} // JS 기본값(null)으로 추론된 prop 타입 — 실제 값은 프리셋 객체 또는 null
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
          onEdit={(preset: unknown) => {
            setPresetEditingPreset(preset);
            setPresetModalJobId(presetBrowseJobId);
            setPresetBrowseJobId(null);
          }}
          onSelect={async (preset: unknown) => {
            await handlePresetSelect(presetBrowseJobId, preset);
            setPresetBrowseJobId(null);
          }}
          onClose={() => setPresetBrowseJobId(null)}
          session={session}
        />
      )}
    </>
  );
}
