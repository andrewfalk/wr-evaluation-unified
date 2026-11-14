// 메인 작업 화면(사이드바·헤더·단계 표시·단계 내용·이전/다음) — REFACTORING_ROADMAP Phase 2 C3-A(P2-24).
// App.jsx의 마지막 렌더 블록을 **글자 그대로** 옮긴 것이다(로직 변경 0, .jsx 유지 — TS 전환은 다음 PR). App이 쓰던 지역 값은
// 모두 props로 받는다(이름 그대로). prop 수를 줄이는 일은 C3-C(AppProviders·ModalHost)에서 한다.
import { AppModals } from '../../core/components/AppModals';
import { MainHeader } from '../../core/components/MainHeader';
import { PatientSidebar } from '../../core/components/PatientSidebar';
import { StepContent } from '../../core/components/StepContent';
import { StepIndicator } from '../../core/components/StepIndicator';
import { canEditPatient } from '../../core/utils/patientOwnership';
import { getAllModules } from '../../core/moduleRegistry';
import { normalizePatientScopeForSession } from '../../core/utils/patientScope';
import { suggestModules } from '../../core/utils/diagnosisMapping';

export function WorkspaceScreen({
  activeId,
  activeModule,
  activeModuleId,
  activeModules,
  activePatient,
  addPatient,
  aiAvailable,
  calc,
  canMutateActivePatient,
  currentStep,
  currentStepIndex,
  displayPatients,
  doctorRoster,
  effectivePatientScope,
  errors,
  exportDropdown,
  extractProgress,
  goNext,
  goPrev,
  goToStep,
  handleAssessmentEditingChange,
  handleEmrExtractBatch,
  handleExportBatch,
  handleExportBatchFormatAll,
  handleExportBatchFormatSelected,
  handleExportBatchFormatSingle,
  handleExportBatchTemplate,
  handleExportSelected,
  handleExportSingle,
  handleExtractConsultation,
  handleForceTakeover,
  handleInjectConsultReply,
  handleInjectEMR,
  handleLogout,
  handleOpenStatistics,
  handlePresetSelect,
  handleResetPatients,
  handleShowHome,
  handleSwitchPatient,
  integrationStatus,
  isIntranetMode,
  lastAutoSave,
  lockState,
  modalsProps,
  onVideoServerApplied,
  openLoadModal,
  opsBannerMessage,
  patientFilters,
  patients,
  presetError,
  presetMeta,
  presets,
  removePatient,
  removeSelectedPatients,
  selectedIds,
  serverConfig,
  session,
  setConflictPatientId,
  setDashboardScope,
  setExportDropdown,
  setExtractProgress,
  setPatientFilters,
  setPatientScope,
  setPatientSyncPaused,
  setPresetBrowseJobId,
  setPresetModalJobId,
  setSelectedIds,
  setShowAccountProfile,
  setShowAdminConsole,
  setShowBatchImport,
  setShowChangePassword,
  setShowSaveModal,
  setShowSettings,
  setShowSidebar,
  settings,
  showOpsBanner,
  showSidebar,
  statsAvailable,
  steps,
  syncState,
  syncSummary,
  unifiedPreviewText,
  updateActiveModules,
  updateDiagnoses,
  updateModule,
  updateModuleById,
  updatePatient,
  updateShared,
}) {
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
        onSwitchPatient={handleSwitchPatient}
        onRemovePatient={removePatient}
        onRemoveSelectedPatients={removeSelectedPatients}
        onResolveConflict={setConflictPatientId}
        scope={effectivePatientScope}
        onScopeChange={scope => {
          setPatientSyncPaused(false);
          // normalizePatientScopeForSession: admin의 'mine'만 'all'로 치환하고,
          // 의사 userId/'__unassigned__'/'all'은 그대로 통과시킨다(서버가 재검증).
          const next = normalizePatientScopeForSession(session, scope);
          setPatientScope(next);
          // 대시보드 스코프도 함께 맞춰 로드된 데이터와 통계 뷰가 어긋나지 않게 한다
          // (예: 대시보드에서 특정 의사를 보던 중 사이드바를 토글한 경우).
          setDashboardScope(next);
        }}
        doctorRoster={doctorRoster}
        session={session}
        serverUnassignedCount={syncState?.serverUnassignedCount ?? null}
      />

      {/* 메인 영역 */}
      <div className="main-area">
        {isIntranetMode && (syncSummary.conflictCount > 0 || syncSummary.lockLostCount > 0 || syncSummary.pendingCount > 0 || syncSummary.offline) && (
          <div className="sync-status-banner" role="status">
            {syncSummary.conflictCount > 0 && (
              <button
                type="button"
                className="sync-status-badge sync-status-badge--conflict"
                onClick={() => setShowSidebar(true)}
                title="사이드바에서 충돌 환자의 Resolve 버튼으로 해결하세요"
              >충돌 {syncSummary.conflictCount}건</button>
            )}
            {syncSummary.lockLostCount > 0 && (
              <button
                type="button"
                className="sync-status-badge sync-status-badge--lock"
                onClick={() => setShowSidebar(true)}
                title="다른 사용자가 편집 중이어서 저장되지 못한 환자가 있습니다"
              >락 상실 {syncSummary.lockLostCount}건</button>
            )}
            {syncSummary.pendingCount > 0 && (
              <span className="sync-status-badge sync-status-badge--pending">저장 대기 {syncSummary.pendingCount}건</span>
            )}
            {syncSummary.offline && (
              <span className="sync-status-badge sync-status-badge--offline">동기화 오류(오프라인 등) — 잠시 후 재시도됩니다</span>
            )}
          </div>
        )}
        <MainHeader
          title={headerTitle}
          lastAutoSave={lastAutoSave}
          integrationStatus={integrationStatus}
          session={session}
          onShowAdminConsole={() => setShowAdminConsole(true)}
          onLogout={handleLogout}
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
          onShowHome={handleShowHome}
          onShowStatistics={handleOpenStatistics}
          statsAvailable={statsAvailable}
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
            onExportBatchTemplate: handleExportBatchTemplate,
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

        {activePatient && (
          <>
            {/* 스텝 인디케이터 */}
            <StepIndicator steps={steps} currentStepIndex={currentStepIndex} goToStep={goToStep} />

            {/* 권한 없는 환자 안내 (스텝 탭 ↔ 콘텐츠 사이) */}
            {!canEditPatient(activePatient, session) && (
              <div className="read-only-banner" role="status">
                담당 의사가 아니므로 조회만 가능합니다.
              </div>
            )}

            {/* 편집 권한은 있지만 다른 사용자가 활발히 편집 중이거나(락 선점), 락을 상실한 경우 */}
            {canEditPatient(activePatient, session) && lockState.status === 'held-by-other' && (
              <div className="read-only-banner" role="status">
                {lockState.holder?.holderName ? `${lockState.holder.holderName}님이` : '다른 사용자가'} 편집 중입니다. 조회만 가능합니다.
                <button type="button" className="btn btn-secondary btn-xs" style={{ marginLeft: 8 }} onClick={handleForceTakeover}>
                  강제로 편집 권한 가져오기
                </button>
              </div>
            )}
            {canEditPatient(activePatient, session) && lockState.status === 'lost' && (
              <div className="read-only-banner" role="status">
                편집 권한을 상실했습니다(세션 만료 또는 담당의 변경). 새로고침 후 다시 시도하세요.
              </div>
            )}

            {/* 동기화 권한 거부 알림: 다른 디바이스에서 만든 dirty 환자가 더 이상 본인 담당이 아닐 때 */}
            {syncState?.lastPermissionDeniedCount > 0 && (
              <div className="read-only-banner" role="status" style={{ background: '#fde2e2', color: '#9b1c1c', borderColor: '#f5b5b5' }}>
                권한 없음으로 동기화되지 않은 환자: {syncState.lastPermissionDeniedCount}건. 담당 의사 변경 또는 관리자 문의가 필요합니다.
              </div>
            )}

            {/* 콘텐츠 */}
            <div className={`main-content ${currentStep.id === 'info' ? 'main-content-dual' : (currentStep.id === 'assessment' || currentStep.id === 'videoAnalysis') ? '' : 'main-content-single'}`}>
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
                videoAnalysisFixtureMode={!!serverConfig?.videoAnalysisFixtureMode}
                serverConfig={serverConfig}
                updatePatient={updatePatient}
                onVideoServerApplied={onVideoServerApplied}
                updateShared={updateShared}
                updateModule={updateModule}
                updateModuleById={updateModuleById}
                updateDiagnoses={updateDiagnoses}
                updateActiveModules={updateActiveModules}
                handlePresetSelect={handlePresetSelect}
                onAssessmentEditingChange={handleAssessmentEditingChange}
                setPresetModalJobId={setPresetModalJobId}
                setPresetBrowseJobId={setPresetBrowseJobId}
                canMutate={canMutateActivePatient}
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
      <AppModals {...modalsProps} />
    </div>
  );
}
