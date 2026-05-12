import { useState } from 'react';
import { IntegrationStatusBadge } from './IntegrationStatusBadge';

const ROLE_LABELS = { admin: '관리자', doctor: '의사', nurse: '간호사', staff: '직원' };

function AccountMenu({ session, onShowAdminConsole, onLogout, onChangePassword }) {
  const [open, setOpen] = useState(false);
  if (session?.mode !== 'intranet') return null;

  const user      = session.user;
  const roleLabel = ROLE_LABELS[user?.role] || user?.role || '';
  const displayName = user?.displayName || user?.name || '사용자';

  return (
    <div className="action-menu account-menu">
      <button
        className="btn btn-secondary btn-sm account-menu-trigger"
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
      >
        {displayName} <span className="account-role-chip">{roleLabel}</span> ▾
      </button>
      {open && (
        <div className="export-dropdown account-dropdown" onClick={() => setOpen(false)}>
          {user?.role === 'admin' && (
            <button onClick={onShowAdminConsole}>관리자 콘솔</button>
          )}
          <button onClick={onChangePassword}>비밀번호 변경</button>
          <button onClick={onLogout}>로그아웃</button>
        </div>
      )}
    </div>
  );
}

function ExportMenu({ activePatient, activeModules, selectedIds, patients, exportDropdown, setExportDropdown, exportHandlers }) {
  const {
    onExportSingle, onExportBatchFormatSingle,
    onExportSelected, onExportBatchFormatSelected,
    onExportBatch, onExportBatchFormatAll,
  } = exportHandlers;

  if (!((activePatient && activeModules.length > 0) || selectedIds.size > 0 || patients.length > 0)) return null;

  return (
    <>
      {activePatient && activeModules.length > 0 && (
        <div className="action-menu">
          <button className="btn btn-success btn-sm" onClick={e => { e.stopPropagation(); setExportDropdown(v => v === 'single' ? null : 'single'); }}>Excel(현재) ▾</button>
          {exportDropdown === 'single' && (
            <div className="export-dropdown" onClick={() => setExportDropdown(null)}>
              <button onClick={onExportSingle}>EMR 형식</button>
              <button onClick={onExportBatchFormatSingle}>일괄입력용</button>
            </div>
          )}
        </div>
      )}
      {selectedIds.size > 0 && (
        <div className="action-menu">
          <button className="btn btn-success btn-sm" onClick={e => { e.stopPropagation(); setExportDropdown(v => v === 'selected' ? null : 'selected'); }}>Excel(선택 {selectedIds.size}) ▾</button>
          {exportDropdown === 'selected' && (
            <div className="export-dropdown" onClick={() => setExportDropdown(null)}>
              <button onClick={onExportSelected}>EMR 형식</button>
              <button onClick={onExportBatchFormatSelected}>일괄입력용</button>
            </div>
          )}
        </div>
      )}
      {patients.length > 0 && (
        <div className="action-menu">
          <button className="btn btn-success btn-sm" onClick={e => { e.stopPropagation(); setExportDropdown(v => v === 'batch' ? null : 'batch'); }}>Excel(전체) ▾</button>
          {exportDropdown === 'batch' && (
            <div className="export-dropdown" onClick={() => setExportDropdown(null)}>
              <button onClick={onExportBatch}>EMR 형식</button>
              <button onClick={onExportBatchFormatAll}>일괄입력용</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function EMRButtons({ activePatient, activeModules, selectedIds, extractProgress, emrHandlers }) {
  const { onEmrExtractBatch, onExtractConsultation, onInjectEMR, onInjectConsultReply } = emrHandlers;

  return (
    <>
      {window.electron?.extractRecord && (selectedIds.size > 0 || activePatient?.data?.shared?.patientNo) && (
        <button className="btn btn-primary btn-sm" onClick={onEmrExtractBatch} disabled={!!extractProgress}>
          {selectedIds.size > 0 ? `EMR 추출 (${selectedIds.size})` : 'EMR 추출'}
        </button>
      )}
      {window.electron?.extractConsultation && activePatient && (
        <button className="btn btn-primary btn-sm" onClick={onExtractConsultation}>다학제 추출</button>
      )}
      {window.electron?.injectEMR && activePatient && activeModules.length > 0 && (
        <button className="btn btn-primary btn-sm" onClick={onInjectEMR}>EMR 직접입력</button>
      )}
      {window.electron?.injectEMR && activePatient && (
        <button className="btn btn-primary btn-sm" onClick={onInjectConsultReply}>다학제 보내기</button>
      )}
    </>
  );
}

export function MainHeader({
  title, lastAutoSave, integrationStatus,
  session, onShowAdminConsole, onLogout, onChangePassword,
  patients, activePatient, activeModules, selectedIds,
  extractProgress, setExtractProgress,
  exportDropdown, setExportDropdown,
  onShowHome, onResetPatients, onToggleSidebar,
  onShowSaveModal, onOpenLoadModal, onShowSettings,
  exportHandlers, emrHandlers,
}) {
  return (
    <>
      <header className="header pattern-surface pattern-surface-hero">
        <div className="header-title-row">
          <h1>{title}</h1>
          {lastAutoSave && <span className="header-meta">자동저장 {lastAutoSave.toLocaleTimeString('ko-KR')}</span>}
        </div>
        <IntegrationStatusBadge status={integrationStatus} />
        <div className="header-actions action-bar">
          <div className="action-group">
            <button className="btn btn-secondary btn-sm" onClick={onShowHome} title="대시보드로 이동">대시보드</button>
            <button className="btn btn-danger btn-sm" onClick={onResetPatients} title="환자 목록 초기화">초기화</button>
            <button className="btn btn-secondary btn-sm sidebar-toggle" onClick={onToggleSidebar}>환자 ({patients.length})</button>
            {session?.mode !== 'intranet' && (
              <>
                <button className="btn btn-secondary btn-sm" onClick={onShowSaveModal}>저장</button>
                <button className="btn btn-secondary btn-sm" onClick={onOpenLoadModal}>불러오기</button>
              </>
            )}
            <button className="btn btn-secondary btn-sm" onClick={onShowSettings}>설정</button>
            <AccountMenu
              session={session}
              onShowAdminConsole={onShowAdminConsole}
              onLogout={onLogout}
              onChangePassword={onChangePassword}
            />
            <ExportMenu
              activePatient={activePatient}
              activeModules={activeModules}
              selectedIds={selectedIds}
              patients={patients}
              exportDropdown={exportDropdown}
              setExportDropdown={setExportDropdown}
              exportHandlers={exportHandlers}
            />
            <EMRButtons
              activePatient={activePatient}
              activeModules={activeModules}
              selectedIds={selectedIds}
              extractProgress={extractProgress}
              emrHandlers={emrHandlers}
            />
          </div>
        </div>
      </header>

      {/* EMR 추출 프로그레스 바 */}
      {extractProgress && (
        <div className="emr-progress-bar">
          <div className="emr-progress-inner" style={{ width: `${(extractProgress.current / extractProgress.total) * 100}%` }} />
          <span className="emr-progress-text">
            {extractProgress.status === 'done'
              ? `${extractProgress.total}명 추출 완료 (성공 ${extractProgress.successCount}, 실패 ${extractProgress.failCount})`
              : `${extractProgress.total}명 중 ${extractProgress.current}번째 ${extractProgress.currentName} 데이터 가져오는 중...`
            }
          </span>
          {extractProgress.status === 'done' && (
            <button className="emr-progress-close" onClick={() => setExtractProgress(null)}>&times;</button>
          )}
        </div>
      )}
    </>
  );
}
