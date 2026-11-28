// 설정 창 조각(P2-86c, Phase 2 C9 구간 A) — AI 키 구역(Electron 독립형에서만 — 그릴지는 본체가 detectRuntime()으로 정한다).
// SettingsModal.tsx의 JSX를 그대로 옮겼다(입력값은 본체의 draft·update).
import type { SettingsDraft } from './types';

export interface AiKeySectionProps {
  draft: SettingsDraft;
  update: (key: string, value: unknown) => void;
}

export function AiKeySection({ draft, update }: AiKeySectionProps) {
  return (
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
  );
}
