// 설정 창 조각(P2-86c, Phase 2 C9 구간 A) — 연결 진단 구역. SettingsModal.tsx의 JSX를 그대로 옮겼다(진단 상태·'연결 확인' 핸들러는 본체가 쥔다).
import { isIntranetContext } from '../../../platform/dataMode';
import { formatBoolean, formatCheckedAt } from './connectionStatus';
import type { DiagnosticStatus, SettingsDraft } from './types';

export function DiagnosticItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="settings-diagnostic-item">
      <div className="settings-diagnostic-label">{label}</div>
      <div className="settings-diagnostic-value">{value || '-'}</div>
    </div>
  );
}

export interface ConnectionDiagnosticSectionProps {
  tone: string;
  statusTitle: string;
  diagnostic: DiagnosticStatus | null | undefined;
  handleCheckConnection: () => void;
  isCheckingConnection: boolean;
  hasConnectionDraftChanges: boolean;
  draft: SettingsDraft;
  baseUrl: string;
}

export function ConnectionDiagnosticSection({
  tone, statusTitle, diagnostic, handleCheckConnection, isCheckingConnection, hasConnectionDraftChanges, draft, baseUrl,
}: ConnectionDiagnosticSectionProps) {
  return (
    <div className="settings-section modal-section pattern-surface">
      <div className="settings-section-title">연결 진단</div>
      <div className={`integration-status integration-status-${tone}`}>
        <div className="integration-status-title-row">
          <span className="integration-status-pill">{statusTitle}</span>
          <span className="integration-status-time">확인 {formatCheckedAt(diagnostic?.lastCheckedAt)}</span>
        </div>
        <div className="integration-status-detail">{diagnostic?.message || '상태 정보 없음'}</div>
      </div>

      <div className="settings-inline-actions">
        <button className="btn btn-secondary btn-sm" onClick={handleCheckConnection} disabled={isCheckingConnection}>
          {isCheckingConnection ? '확인 중...' : '연결 확인'}
        </button>
        <span className="settings-inline-hint">
          {hasConnectionDraftChanges
            ? '저장되지 않은 입력값으로 진단합니다.'
            : '현재 적용된 설정으로 진단합니다.'}
        </span>
      </div>

      <div className="settings-diagnostic-grid">
        <DiagnosticItem label="진단 기준" value={hasConnectionDraftChanges ? '미저장 입력값' : '현재 설정'} />
        <DiagnosticItem label="저장 방식" value={isIntranetContext({ settings: draft }) ? '인트라넷' : '로컬'} />
        <DiagnosticItem label="대상 URL" value={baseUrl || '(기본 /api)'} />
        <DiagnosticItem label="활성 저장소" value={diagnostic?.activeStore || '-'} />
        <DiagnosticItem label="사용자 ID" value={diagnostic?.sessionInfo?.userId} />
        <DiagnosticItem label="조직 ID" value={diagnostic?.sessionInfo?.organizationId} />
        {diagnostic?.meDetails && (<>
          <DiagnosticItem label="사용자명" value={diagnostic.meDetails.userName} />
          <DiagnosticItem label="역할" value={diagnostic.meDetails.userRole} />
          <DiagnosticItem label="소속 기관" value={diagnostic.meDetails.orgName} />
          <DiagnosticItem label="AI 기능" value={diagnostic.meDetails.capabilities?.ai ? '활성' : '비활성'} />
        </>)}
      </div>

      {diagnostic?.lastError && (
        <div className="settings-diagnostic-error">
          마지막 오류: {diagnostic.lastError}
        </div>
      )}

      {diagnostic?.mockDetails && (
        <div className="settings-diagnostic-card">
          <div className="settings-diagnostic-card-title">Mock 서버 상세</div>
          <div className="settings-diagnostic-grid">
            <DiagnosticItem label="Scope Key" value={diagnostic.mockDetails.scopeKey} />
            <DiagnosticItem label="사용자" value={diagnostic.mockDetails.userId} />
            <DiagnosticItem label="조직" value={diagnostic.mockDetails.organizationId} />
            <DiagnosticItem label="저장된 환자 목록 수" value={String(diagnostic.mockDetails.workspaceCount ?? '-')} />
            <DiagnosticItem label="자동저장 존재" value={formatBoolean(diagnostic.mockDetails.hasAutosave)} />
            <DiagnosticItem label="저장 파일" value={diagnostic.mockDetails.storageFile} />
          </div>
        </div>
      )}

      {!diagnostic?.mockDetails && diagnostic?.remoteDetails && (
        <div className="settings-diagnostic-card">
          <div className="settings-diagnostic-card-title">원격 서버 응답 요약</div>
          <div className="settings-diagnostic-grid">
            <DiagnosticItem label="저장된 환자 목록 수" value={String(diagnostic.remoteDetails.workspaceCount ?? '-')} />
          </div>
        </div>
      )}
    </div>

  );
}
