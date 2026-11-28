// 설정 창(Phase 2 C9 P2-86c에서 서버 연동·연결 진단·AI 키 구역과 연결 상태 함수를 settings/로 나눴다 — 상태와 '연결 확인' 흐름은 여기).
import { useEffect, useMemo, useState } from 'react';
import { inspectIntegrationStatus } from '../services/integrationStatus';
import { detectRuntime } from '../../platform/runtime';
import { PresetsSection } from './PresetsSection';

import { hasIntranetSession, normalizeBaseUrl } from '../../platform/dataMode';
import { buildPreviewSession, getEffectiveServerUrl, getStatusTitle, getStatusTone } from './settings/connectionStatus';
import { AiKeySection } from './settings/AiKeySection';
import { ConnectionDiagnosticSection } from './settings/ConnectionDiagnosticSection';
import { ServerIntegrationSection } from './settings/ServerIntegrationSection';
import type { DiagnosticStatus, SettingsDraft, SettingsModalProps } from './settings/types';

export function SettingsModal({ settings, session, integrationStatus, onSave, onClose, onLogout, onMigrate, onPresetsImported }: SettingsModalProps) {
  const isIntranetLocked = hasIntranetSession(session);
  const [draft, setDraft] = useState<SettingsDraft>({ ...settings });
  const [diagnostic, setDiagnostic] = useState(integrationStatus as DiagnosticStatus | null | undefined);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);

  useEffect(() => {
    setDraft({ ...settings });
  }, [settings]);

  useEffect(() => {
    setDiagnostic(integrationStatus as DiagnosticStatus | null | undefined);
  }, [integrationStatus]);

  const update = (key: string, value: unknown) => setDraft(prev => ({ ...prev, [key]: value }));

  const hasConnectionDraftChanges = useMemo(() => (
    draft.integrationMode !== settings.integrationMode
    || normalizeBaseUrl(draft.apiBaseUrl) !== normalizeBaseUrl(settings.apiBaseUrl)
  ), [draft.apiBaseUrl, draft.integrationMode, settings.apiBaseUrl, settings.integrationMode]);

  const handleCheckConnection = async () => {
    setIsCheckingConnection(true);

    try {
      const result = await inspectIntegrationStatus({
        session: buildPreviewSession(session, draft),
        settings: {
          ...draft,
          apiBaseUrl: normalizeBaseUrl(draft.apiBaseUrl),
        },
        source: 'settings-diagnostic',
      });

      setDiagnostic(result);
    } finally {
      setIsCheckingConnection(false);
    }
  };

  const tone = getStatusTone(diagnostic);
  const statusTitle = getStatusTitle(diagnostic);
  const baseUrl = getEffectiveServerUrl({ session, diagnostic, draft });
  const serverUrlInputValue = isIntranetLocked
    ? baseUrl
    : (draft.apiBaseUrl || '');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>설정</h2>
            <p className="modal-section-description">테마, 저장소, 기본값, AI 연결 옵션을 관리합니다.</p>
          </div>
        </div>

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">테마</div>
          <div className="radio-group">
            {[{ value: 'light', label: '라이트' }, { value: 'dark', label: '다크' }].map(opt => (
              <label key={opt.value} className="radio-label">
                <input
                  type="radio"
                  name="theme"
                  value={opt.value}
                  checked={draft.theme === opt.value}
                  onChange={() => update('theme', opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">폰트 크기</div>
          <div className="radio-group">
            {[{ value: 'small', label: '작게' }, { value: 'medium', label: '보통' }, { value: 'large', label: '크게' }].map(opt => (
              <label key={opt.value} className="radio-label">
                <input
                  type="radio"
                  name="fontSize"
                  value={opt.value}
                  checked={draft.fontSize === opt.value}
                  onChange={() => update('fontSize', opt.value)}
                />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">새 환자 기본값</div>
          <div className="settings-row">
            <label>병원명</label>
            <input type="text" value={draft.hospitalName} onChange={e => update('hospitalName', e.target.value)} />
          </div>
          <div className="settings-row">
            <label>진료과</label>
            <input type="text" value={draft.department} onChange={e => update('department', e.target.value)} />
          </div>
          {!isIntranetLocked && (
            <div className="settings-row">
              <label>의사명</label>
              <input type="text" value={draft.doctorName} onChange={e => update('doctorName', e.target.value)} />
            </div>
          )}
        </div>

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">자동 저장</div>
          <div className="settings-row">
            <label>저장 간격</label>
            <select value={draft.autoSaveInterval} onChange={e => update('autoSaveInterval', Number(e.target.value))}>
              <option value={15}>15초</option>
              <option value={30}>30초</option>
              <option value={60}>60초</option>
              <option value={0}>사용안함</option>
            </select>
          </div>
        </div>

        <ServerIntegrationSection
          isIntranetLocked={isIntranetLocked}
          onLogout={onLogout}
          onClose={onClose}
          draft={draft}
          update={update}
          serverUrlInputValue={serverUrlInputValue}
        />

        <ConnectionDiagnosticSection
          tone={tone}
          statusTitle={statusTitle}
          diagnostic={diagnostic}
          handleCheckConnection={handleCheckConnection}
          isCheckingConnection={isCheckingConnection}
          hasConnectionDraftChanges={hasConnectionDraftChanges}
          draft={draft}
          baseUrl={baseUrl}
        />

        {detectRuntime().hasDirectAi && (
          <AiKeySection draft={draft} update={update} />
        )}

        {isIntranetLocked && onMigrate && (
          <div className="settings-section modal-section pattern-surface">
            <div className="settings-section-title">데이터 마이그레이션</div>
            <div className="settings-help-text">
              이 PC의 로컬 환자 데이터를 인트라넷 서버로 이전합니다.
              환자 데이터만 이전되며 사용자 설정·프리셋·워크스페이스는 별도입니다.
              중복 등록되지 않도록 처리합니다.
            </div>
            <div className="settings-inline-actions">
              <button className="btn btn-secondary btn-sm" onClick={onMigrate}>
                이 PC의 로컬 환자 데이터를 서버로 이전
              </button>
            </div>
          </div>
        )}

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">직업 프리셋</div>
          <PresetsSection onPresetsImported={onPresetsImported} session={session} />
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className="btn btn-primary" onClick={() => onSave(draft)}>저장</button>
        </div>
      </div>
    </div>
  );
}
