import { useState } from 'react';
import { isElectron } from '../utils/platform';

export function SettingsModal({ settings, onSave, onClose }) {
  const [draft, setDraft] = useState({ ...settings });

  const update = (key, value) => setDraft(prev => ({ ...prev, [key]: value }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 500 }}>
        <h2>설정</h2>

        <div className="settings-section">
          <div className="settings-section-title">테마</div>
          <div className="radio-group">
            {[{ value: 'light', label: '라이트' }, { value: 'dark', label: '다크' }].map(opt => (
              <label key={opt.value} className="radio-label">
                <input type="radio" name="theme" value={opt.value}
                  checked={draft.theme === opt.value}
                  onChange={() => update('theme', opt.value)} />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div className="settings-section">
          <div className="settings-section-title">폰트 크기</div>
          <div className="radio-group">
            {[{ value: 'small', label: '작게' }, { value: 'medium', label: '보통' }, { value: 'large', label: '크게' }].map(opt => (
              <label key={opt.value} className="radio-label">
                <input type="radio" name="fontSize" value={opt.value}
                  checked={draft.fontSize === opt.value}
                  onChange={() => update('fontSize', opt.value)} />
                {opt.label}
              </label>
            ))}
          </div>
        </div>

        <div className="settings-section">
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

        <div className="settings-section">
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

        {isElectron() && (
          <div className="settings-section">
            <div className="settings-section-title">AI 설정 (Electron)</div>
            <div className="settings-row">
              <label>Gemini API Key</label>
              <input type="password" value={draft.geminiApiKey || ''} onChange={e => update('geminiApiKey', e.target.value)} placeholder="Google Gemini API Key" />
            </div>
            <div className="settings-row">
              <label>Claude API Key</label>
              <input type="password" value={draft.claudeApiKey || ''} onChange={e => update('claudeApiKey', e.target.value)} placeholder="Anthropic Claude API Key" />
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
              선택한 모델에 맞는 API 키가 필요합니다. 키는 로컬에만 저장됩니다.
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className="btn btn-primary" onClick={() => onSave(draft)}>저장</button>
        </div>
      </div>
    </div>
  );
}
