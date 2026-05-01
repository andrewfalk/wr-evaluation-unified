import { useEffect, useMemo, useState } from 'react';
import { inspectIntegrationStatus } from '../services/integrationStatus';
import { isElectron } from '../utils/platform';

function normalizeUrl(value = '') {
  return String(value || '').trim().replace(/\/$/, '');
}

function buildPreviewSession(session, draft) {
  return {
    ...session,
    mode: draft.integrationMode === 'intranet' ? 'intranet' : 'local',
    apiBaseUrl: normalizeUrl(draft.apiBaseUrl || ''),
  };
}

function formatCheckedAt(value) {
  if (!value) return '-';

  try {
    return new Date(value).toLocaleString('ko-KR');
  } catch {
    return value;
  }
}

function formatBoolean(value) {
  if (value === true) return '있음';
  if (value === false) return '없음';
  return '-';
}

function getStatusTitle(status) {
  if (status?.connectivity === 'fallback') return '로컬 폴백';
  if (status?.connectivity === 'connected' && status?.mock) return 'Mock 인트라넷 연결됨';
  if (status?.connectivity === 'connected') return '인트라넷 연결됨';
  if (status?.connectivity === 'checking') return '서버 확인 중';
  return '로컬 저장소';
}

function getStatusTone(status) {
  if (status?.connectivity === 'fallback') return 'fallback';
  if (status?.connectivity === 'connected' && status?.mock) return 'mock';
  if (status?.connectivity === 'connected') return 'connected';
  if (status?.connectivity === 'checking') return 'checking';
  return 'local';
}

function DiagnosticItem({ label, value }) {
  return (
    <div className="settings-diagnostic-item">
      <div className="settings-diagnostic-label">{label}</div>
      <div className="settings-diagnostic-value">{value || '-'}</div>
    </div>
  );
}

export function SettingsModal({ settings, session, integrationStatus, onSave, onClose, onLogout }) {
  const isIntranetLocked = session?.mode === 'intranet';
  const [draft, setDraft] = useState({ ...settings });
  const [diagnostic, setDiagnostic] = useState(integrationStatus);
  const [isCheckingConnection, setIsCheckingConnection] = useState(false);

  useEffect(() => {
    setDraft({ ...settings });
  }, [settings]);

  useEffect(() => {
    setDiagnostic(integrationStatus);
  }, [integrationStatus]);

  const update = (key, value) => setDraft(prev => ({ ...prev, [key]: value }));

  const hasConnectionDraftChanges = useMemo(() => (
    draft.integrationMode !== settings.integrationMode
    || normalizeUrl(draft.apiBaseUrl) !== normalizeUrl(settings.apiBaseUrl)
  ), [draft.apiBaseUrl, draft.integrationMode, settings.apiBaseUrl, settings.integrationMode]);

  const handleCheckConnection = async () => {
    setIsCheckingConnection(true);

    try {
      const result = await inspectIntegrationStatus({
        session: buildPreviewSession(session, draft),
        settings: {
          ...draft,
          apiBaseUrl: normalizeUrl(draft.apiBaseUrl),
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
  const baseUrl = normalizeUrl(diagnostic?.baseUrl || draft.apiBaseUrl || '');

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
          <div className="settings-row">
            <label>의사명</label>
            <input type="text" value={draft.doctorName} onChange={e => update('doctorName', e.target.value)} />
          </div>
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
                onClick={() => { onLogout(); onClose(); }}
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
              value={draft.apiBaseUrl || ''}
              onChange={e => update('apiBaseUrl', e.target.value)}
              placeholder="https://intranet.example.com 또는 http://localhost:3002"
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
            <DiagnosticItem label="저장 방식" value={draft.integrationMode === 'intranet' ? '인트라넷' : '로컬'} />
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
                <DiagnosticItem label="워크스페이스 수" value={String(diagnostic.mockDetails.workspaceCount ?? '-')} />
                <DiagnosticItem label="자동저장 존재" value={formatBoolean(diagnostic.mockDetails.hasAutosave)} />
                <DiagnosticItem label="저장 파일" value={diagnostic.mockDetails.storageFile} />
              </div>
            </div>
          )}

          {!diagnostic?.mockDetails && diagnostic?.remoteDetails && (
            <div className="settings-diagnostic-card">
              <div className="settings-diagnostic-card-title">원격 서버 응답 요약</div>
              <div className="settings-diagnostic-grid">
                <DiagnosticItem label="워크스페이스 수" value={String(diagnostic.remoteDetails.workspaceCount ?? '-')} />
              </div>
            </div>
          )}
        </div>

        {isElectron() && !!window.electron?.analyzeAI && (
          <div className="settings-section modal-section pattern-surface">
            <div className="settings-section-title">AI 설정 (Electron)</div>
            <div className="settings-row">
              <label>Gemini API Key</label>
              <input
                type="password"
                value={draft.geminiApiKey || ''}
                onChange={e => update('geminiApiKey', e.target.value)}
                placeholder="Google Gemini API Key"
              />
            </div>
            <div className="settings-row">
              <label>Claude API Key</label>
              <input
                type="password"
                value={draft.claudeApiKey || ''}
                onChange={e => update('claudeApiKey', e.target.value)}
                placeholder="Anthropic Claude API Key"
              />
            </div>
            <div className="settings-help-text">
              선택한 모델에 맞는 API 키가 필요합니다. 키는 로컬에만 저장됩니다.
            </div>
          </div>
        )}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className="btn btn-primary" onClick={() => onSave(draft)}>저장</button>
        </div>
      </div>
    </div>
  );
}
