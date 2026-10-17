import { useState } from 'react';
import { MODEL_OPTIONS, DEFAULT_GEMINI_MODEL } from '@contracts/aiModels';
import { useAuth } from '../auth/AuthContext';
import { useAIAnalysis } from '../hooks/useAIAnalysis';

// buildInput: () => ({ input, error }) — 환자 → 비식별 구조화 입력(buildAiInputResult). 세 경로(인트라넷 · 웹 · Electron) 모두
//   이 input만 AI로 나가고, 만들지 못하면 input은 null이며 error는 사용자에게 보일 사유다.
// generatePrompt/fullReportAllowed: 보고서 전문은 서버가 병원 내부 LLM일 때(인트라넷, fullReportAllowed)만 함께 보낸다.
//   외부 AI(웹·Electron)에는 보고서 전문을 보내지 않는다.
export function AIAnalysisPanel({ generatePrompt, buildInput, fullReportAllowed = false, title = 'AI 분석', aiAvailable = true }) {
  const { session } = useAuth();
  const { analyze, loading, result, error, reset } = useAIAnalysis();
  const [model, setModel] = useState(DEFAULT_GEMINI_MODEL);
  const isIntranet = session?.mode === 'intranet';

  const handleAnalyze = async () => {
    // 입력을 만들지 못하면 input은 null — analyzeAIRequest가 사유를 안내하고 분석은 보내지 않는다(보고서 전문도 만들지 않는다).
    const { input = null, error: inputError } = (buildInput && buildInput()) || {};
    const fullReport = isIntranet && input && fullReportAllowed ? generatePrompt() : undefined;
    await analyze({
      input,
      inputError,
      fullReport: fullReport || undefined,
      model: isIntranet ? undefined : model, // 인트라넷은 서버가 승인된 모델을 쓴다
    });
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
