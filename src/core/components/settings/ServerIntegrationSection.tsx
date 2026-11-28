// 설정 창 조각(P2-86c, Phase 2 C9 구간 A) — 서버 연동 구역. SettingsModal.tsx의 JSX를 그대로 옮겼다(상태는 본체가 쥔다).
import { DEFAULT_INTRANET_URL } from './connectionStatus';
import type { SettingsDraft } from './types';

export interface ServerIntegrationSectionProps {
  isIntranetLocked: boolean;
  onLogout?: () => Promise<boolean | undefined | void>;
  onClose: () => void;
  draft: SettingsDraft;
  update: (key: string, value: unknown) => void;
  serverUrlInputValue: string;
}

export function ServerIntegrationSection({ isIntranetLocked, onLogout, onClose, draft, update, serverUrlInputValue }: ServerIntegrationSectionProps) {
  return (
    <div className="settings-section modal-section pattern-surface">
      <div className="settings-section-title">서버 연동</div>
      {isIntranetLocked && (
        <div className="settings-help-text settings-help-text--locked">
          인트라넷 모드로 로그인 중입니다. 서버 연동 설정은 관리자만 변경할 수 있습니다.
        </div>
      )}
      {isIntranetLocked && onLogout && (
        <div className="settings-row">
          <label>계정</label>
          <button
            className="btn btn-secondary btn-sm"
            onClick={async () => {
              // 확인창에서 취소하면(저장되지 않은 환자가 있을 때) 설정 창을 닫지 않는다(AS-5).
              const started = await onLogout();
              if (started !== false) onClose();
            }}
          >
            로그아웃
          </button>
        </div>
      )}
      <div className="settings-row">
        <label>데이터 저장 방식</label>
        <select
          value={draft.integrationMode || 'local'}
          onChange={e => update('integrationMode', e.target.value)}
          disabled={isIntranetLocked}
        >
          <option value="local">로컬 저장</option>
          <option value="intranet">인트라넷 서버</option>
        </select>
      </div>
      <div className="settings-row">
        <label>서버 주소</label>
        <input
          type="text"
          value={serverUrlInputValue}
          onChange={e => update('apiBaseUrl', e.target.value)}
          placeholder={DEFAULT_INTRANET_URL}
          disabled={isIntranetLocked}
          readOnly={isIntranetLocked}
        />
      </div>
      {!isIntranetLocked && (
        <div className="settings-help-text">
          인트라넷 서버 모드에서는 저장소와 AI 호출이 지정한 서버를 우선 사용합니다.
        </div>
      )}
    </div>

  );
}
