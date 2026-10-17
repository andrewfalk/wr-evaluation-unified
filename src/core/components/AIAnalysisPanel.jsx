import { useState } from 'react';
import { MODEL_OPTIONS, DEFAULT_GEMINI_MODEL } from '@contracts/aiModels';
import { useAuth } from '../auth/AuthContext';
import { useAIAnalysis } from '../hooks/useAIAnalysis';

// buildInput: 환자 → 비식별 구조화 입력(buildAiInput). 인트라넷 서버로는 이 값만 나간다.
// fullReportAllowed: 서버가 병원 내부 LLM일 때만 true — 이때만 보고서 전문(generatePrompt)을 함께 보낸다.
// generatePrompt/systemPrompt: 웹(Vercel)·Electron 직접 호출 경로 전용(hf7-3에서 구조화 입력으로 바뀐다).
export function AIAnalysisPanel({ generatePrompt, systemPrompt, buildInput, fullReportAllowed = false, title = 'AI 분석', aiAvailable = true }) {
  const { session } = useAuth();
  const { analyze, loading, result, error, reset } = useAIAnalysis();
  const [model, setModel] = useState(DEFAULT_GEMINI_MODEL);
  const isIntranet = session?.mode === 'intranet';

  const handleAnalyze = async () => {
    if (isIntranet) {
      // 입력을 만들지 못하면 null — analyzeAIRequest가 오류 안내를 돌려준다(분석을 보내지 않는다).
      const input = buildInput ? buildInput() : null;
      const fullReport = input && fullReportAllowed ? generatePrompt() : undefined;
      await analyze({ input, fullReport: fullReport || undefined });
      return;
    }
    const prompt = generatePrompt();
    if (!prompt) return;
    await analyze({ prompt, systemPrompt, model });
  };

  if (!aiAvailable) {
    return (
      <div className="section">
        <h2 className="section-title"><span className="section-icon">AI</span>{title}</h2>
        <div className="modal-section pattern-surface ai-panel-shell">
          <div className="ai-status-card">
            <p className="ai-status-text">AI 분석이 이 서버에서 비활성화되어 있습니다.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="section">
      <h2 className="section-title"><span className="section-icon">AI</span>{title}</h2>
      <div className="modal-section pattern-surface ai-panel-shell">
        <div className="ai-toolbar">
          {!isIntranet && (
            <div className="ai-model-group">
              <label className="ai-toolbar-label" htmlFor="ai-model-select">모델 선택</label>
              <select
                id="ai-model-select"
                className="ai-model-select"
                value={model}
                onChange={e => setModel(e.target.value)}
              >
                {MODEL_OPTIONS.map(group => (
                  <optgroup key={group.group} label={group.group}>
                    {group.options.map(option => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          )}
          <div className="action-group">
            <button className="btn btn-primary" onClick={handleAnalyze} disabled={loading}>
              {loading ? '분석 중...' : 'AI 분석 실행'}
            </button>
            {result && <button className="btn btn-secondary btn-sm" onClick={reset}>초기화</button>}
          </div>
        </div>

        {loading && (
          <div className="ai-status-card">
            <div className="loading-spinner"></div>
            <p className="ai-status-text">AI가 분석 중입니다...</p>
          </div>
        )}

        {error && (
          <div className="error-message">{error}</div>
        )}

        {result && (
          <div className="report-preview ai-result-panel">
            <div className="report-preview-toolbar">
              <span className="report-preview-label">AI 분석 결과</span>
              <span className="report-preview-hint">{isIntranet ? '서버 지정 모델' : model}</span>
            </div>
            <div className="preview-section ai-result-content">{result}</div>
          </div>
        )}
      </div>
    </div>
  );
}
