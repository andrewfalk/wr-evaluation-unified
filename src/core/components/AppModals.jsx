import { AdminConsoleModal } from './AdminConsoleModal';
import { AccountProfileModal } from './AccountProfileModal';
import { ChangePasswordModal } from './ChangePasswordModal';
import { SettingsModal } from './SettingsModal';
import { MigrationReportModal } from './MigrationReportModal';
import { SaveModal, LoadModal } from './SaveLoadModals';
import { BatchImportModal } from './BatchImportModal';
import { PatientIdentityConflictModal } from './PatientIdentityConflictModal';
import { ConflictResolveModal } from './ConflictResolveModal';
import { PresetManageModal } from './PresetManageModal';
import { PresetBrowseModal } from './PresetBrowseModal';
import { isPatientIdentityPushConflict } from '../services/patientRecords';

// 공통 모달 렌더링 (App.jsx의 renderModals를 분리)
export function AppModals({
  session, settings, integrationStatus, syncState, syncNow, logout,
  patients, activePatient, steps,
  setActiveId, setCurrentStepIndex, setShowHome,

  showAdminConsole, setShowAdminConsole,
  showAccountProfile, setShowAccountProfile,
  showChangePassword, setShowChangePassword,
  showSettings, setShowSettings, handleSaveSettings,
  showMigrationReport, setShowMigrationReport,
  migrationStatus, migrationResult, startMigration, retryMigration, resetMigration,
  reloadPresets,

  showSaveModal, setShowSaveModal,
  saveName, setSaveName, savedItems, handleSave, handleOverwriteSave, handleDelete,
  showLoadModal, setShowLoadModal, legacyItems, handleLoad,

  showBatchImport, setShowBatchImport, handleBatchImport,

  conflictPatient, setConflictPatientId, handleResolveConflict, markRemoteDeleteConflict,

  presetModalJobId, setPresetModalJobId, presetEditingPreset, setPresetEditingPreset,
  presetBrowseJobId, setPresetBrowseJobId,
  presets, handleSaveCustomPreset, closePresetManageModal, handleDeleteCustomPreset, handlePresetSelect,
}) {
  return (
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
      {conflictPatient && isPatientIdentityPushConflict(conflictPatient.sync?.conflict) ? (
        <PatientIdentityConflictModal
          patient={conflictPatient}
          session={session}
          settings={settings}
          onUseServer={(serverPatient) =>
            handleResolveConflict('use-server', { patient: conflictPatient, serverPatient })
          }
          onEditIdentity={() => {
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
}
