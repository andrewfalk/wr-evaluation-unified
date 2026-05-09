import { PresetsSection } from './PresetsSection';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MigrationSummaryRow({ label, count, tone }) {
  return (
    <div className={`migration-summary-row migration-summary-row--${tone}`}>
      <span className="migration-summary-label">{label}</span>
      <span className="migration-summary-count">{count}명</span>
    </div>
  );
}

function FailedPatientItem({ patient, name }) {
  return (
    <li className="migration-failed-item">
      <span className="migration-failed-name">{name || patient.id}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Main modal
//
// Migration state (status/result/onStart/onRetry) is owned by App.jsx so that
// failed patients persist across modal open/close cycles.
// onPresetsImported: triggers usePresetManagement.reloadPresets in App.jsx
// ---------------------------------------------------------------------------
export function MigrationReportModal({
  status,
  result,
  onStart,
  onRetry,
  onReset,
  onClose,
  onPresetsImported,
  session,
}) {
  const migrated      = result?.migrated      ?? [];
  const alreadySynced = result?.alreadySynced ?? [];
  const failed        = result?.failed        ?? [];
  const hasFailed     = failed.length > 0;
  const allSucceeded  = status === 'done' && !hasFailed;

  const handleRetry = () => onRetry(failed.map(f => f.patient));

  // done + 성공만 있는 경우: 닫을 때 state 초기화 (다음 열기 시 idle로 시작)
  // done + 실패 있는 경우: 닫아도 실패 큐 유지 (재오픈 시 결과 화면 유지)
  const handleClose = () => {
    if (allSucceeded) onReset?.();
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={status === 'running' ? undefined : handleClose}>
      <div className="modal migration-modal" onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="modal-section-header">
          <div>
            <h2>로컬 데이터 서버 마이그레이션</h2>
            <p className="modal-section-description">
              이 기기의 로컬 환자 데이터를 인트라넷 서버로 이전합니다.
            </p>
          </div>
        </div>

        {/* ── Idle ── */}
        {status === 'idle' && (
          <div className="migration-content">
            <div className="migration-info">
              <p>
                저장된 환자 목록과 자동저장에서 환자 데이터를 수집하여
                인트라넷 서버에 등록합니다.
              </p>
              <ul className="migration-info-list">
                <li>이미 서버에 등록된 환자는 건너뜁니다.</li>
                <li>동일한 환자를 중복 등록하지 않습니다 (멱등 처리).</li>
                <li>실패한 항목은 결과 화면에서 재시도할 수 있습니다.</li>
              </ul>
            </div>
            <PresetsSection onPresetsImported={onPresetsImported} session={session} />
          </div>
        )}

        {/* ── Running ── */}
        {status === 'running' && (
          <div className="migration-content migration-content--centered">
            <div className="migration-spinner" />
            <p className="migration-running-text">마이그레이션 진행 중…</p>
          </div>
        )}

        {/* ── Done ── */}
        {status === 'done' && (
          <div className="migration-content">
            <div className="migration-summary">
              <MigrationSummaryRow label="서버 등록 완료"     count={migrated.length}      tone="success" />
              <MigrationSummaryRow label="이미 등록됨 (건너뜀)" count={alreadySynced.length} tone="neutral" />
              <MigrationSummaryRow label="실패"               count={failed.length}        tone={hasFailed ? 'error' : 'neutral'} />
            </div>

            {hasFailed && (
              <div className="migration-failed-section">
                <div className="migration-failed-header">
                  실패한 환자 목록
                  <button
                    className="btn btn-secondary btn-sm migration-retry-btn"
                    onClick={handleRetry}
                  >
                    실패 재시도
                  </button>
                </div>
                <ul className="migration-failed-list">
                  {failed.map(({ patient }) => (
                    <FailedPatientItem
                      key={patient.id}
                      patient={patient}
                      name={patient.data?.shared?.name}
                    />
                  ))}
                </ul>
              </div>
            )}

            {allSucceeded && (
              <p className="migration-success-note">
                마이그레이션이 완료되었습니다. 앱을 재시작하면 서버의 환자 목록이 로드됩니다.
              </p>
            )}

            <PresetsSection onPresetsImported={onPresetsImported} session={session} />
          </div>
        )}

        {/* ── Error ── */}
        {status === 'error' && (
          <div className="migration-content">
            <div className="migration-error">
              마이그레이션 중 오류가 발생했습니다:&nbsp;
              {result?.error?.message ?? '알 수 없는 오류'}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="modal-actions">
          {status === 'idle' && (
            <>
              <button className="btn btn-secondary" onClick={handleClose}>취소</button>
              <button className="btn btn-primary" onClick={onStart}>마이그레이션 시작</button>
            </>
          )}
          {status === 'running' && (
            <button className="btn btn-secondary" disabled>진행 중…</button>
          )}
          {(status === 'done' || status === 'error') && (
            <>
              <button className="btn btn-secondary" onClick={handleClose}>닫기</button>
              {/* done + 실패 있을 때: 실패 큐 초기화 후 처음부터 재실행 */}
              {status === 'done' && hasFailed && (
                <button
                  className="btn btn-secondary"
                  onClick={() => { onReset?.(); onStart(); }}
                >
                  새로 실행
                </button>
              )}
              {status === 'error' && (
                <button className="btn btn-primary" onClick={onStart}>다시 시도</button>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}
