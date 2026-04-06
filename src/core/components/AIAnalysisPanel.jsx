import { useState } from 'react';
import { useAIAnalysis } from '../hooks/useAIAnalysis';

export function AIAnalysisPanel({ generatePrompt, systemPrompt, title = 'AI 분석' }) {
  const { analyze, loading, result, error, reset } = useAIAnalysis();
  const [model, setModel] = useState('gemini-2.5-flash');

  const handleAnalyze = async () => {
    const prompt = generatePrompt();
    if (!prompt) return;
    await analyze(prompt, systemPrompt, model);
  };

  return (
    <div className="section">
      <h2 className="section-title"><span className="section-icon">AI</span>{title}</h2>
      <div className="modal-section pattern-surface ai-panel-shell">
        <div className="ai-toolbar">
          <div className="ai-model-group">
            <label className="ai-toolbar-label" htmlFor="ai-model-select">모델 선택</label>
            <select
              id="ai-model-select"
              className="ai-model-select"
              value={model}
              onChange={e => setModel(e.target.value)}
            >
              <optgroup label="Google Gemini">
                <option value="gemini-2.5-flash">Gemini 2.5 Flash (빠름/저비용)</option>
                <option value="gemini-2.5-pro">Gemini 2.5 Pro (정밀)</option>
              </optgroup>
              <optgroup label="Anthropic Claude">
                <option value="claude-haiku-4-5-20251001">Haiku 4.5 (빠름/저비용)</option>
                <option value="claude-sonnet-4-6-20250514">Sonnet 4.6 (정밀)</option>
              </optgroup>
            </select>
          </div>
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
              <span className="report-preview-hint">{model}</span>
            </div>
            <div className="preview-section ai-result-content">{result}</div>
          </div>
        )}
      </div>
    </div>
  );
}
