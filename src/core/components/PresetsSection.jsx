import { useRef, useState } from 'react';
import {
  exportPresetsToJSON,
  importPresetsFromJSON,
  loadAllPresets,
} from '../services/presetRepository';

export function PresetsSection({ onPresetsImported, session }) {
  const fileInputRef = useRef(null);
  const [presetMsg, setPresetMsg] = useState(null);

  const handleExport = async () => {
    try {
      const { merged } = await loadAllPresets(session);
      exportPresetsToJSON(merged);
    } catch {
      setPresetMsg({ type: 'error', text: '내보내기 실패' });
    }
  };

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    try {
      const { addedCount } = await importPresetsFromJSON(file, session);
      setPresetMsg({ type: 'ok', text: `${addedCount}개 프리셋을 가져왔습니다.` });
      onPresetsImported?.();
    } catch {
      setPresetMsg({ type: 'error', text: '가져오기 실패: 파일 형식을 확인해주세요.' });
    }
  };

  const isServer = session?.mode === 'intranet';

  return (
    <div className="migration-presets-section">
      <div className="migration-presets-title">
        {isServer ? '직업 프리셋 (서버 저장)' : '직업 프리셋 (로컬 저장)'}
      </div>
      <p className="migration-presets-notice">
        {isServer
          ? '사용자 정의 직업 프리셋은 인트라넷 서버에 저장됩니다. 내보내기로 파일에 백업하거나 다른 계정으로 가져올 수 있습니다.'
          : '사용자 정의 직업 프리셋은 이 기기에만 저장됩니다. 다른 기기에서도 사용하려면 내보내기 후 해당 기기에서 가져오세요.'}
      </p>
      <div className="settings-inline-actions">
        <button className="btn btn-secondary btn-sm" onClick={handleExport}>
          프리셋 내보내기
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => fileInputRef.current?.click()}>
          프리셋 가져오기
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json"
          style={{ display: 'none' }}
          onChange={handleImportFile}
        />
      </div>
      {presetMsg && (
        <div className={`migration-preset-msg migration-preset-msg--${presetMsg.type}`}>
          {presetMsg.text}
        </div>
      )}
    </div>
  );
}
