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
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12 }}>
        <select value={model} onChange={e => setModel(e.target.value)} style={{ padding: '6px 10px', borderRadius: 6, border: '2px solid var(--border-color)', background: 'var(--input-bg)', color: 'var(--text-primary)', fontSize: '0.85rem' }}>
          <optgroup label="Google Gemini">
            <option value="gemini-2.5-flash">Gemini 2.5 Flash (빠름/저비용)</option>
            <option value="gemini-2.5-pro">Gemini 2.5 Pro (정밀)</option>
          </optgroup>
          <optgroup label="Anthropic Claude">
            <option value="claude-haiku-4-5-20251001">Haiku 4.5 (빠름/저비용)</option>
            <option value="claude-sonnet-4-6-20250514">Sonnet 4.6 (정밀)</option>
          </optgroup>
        </select>
        <button className="btn btn-primary" onClick={handleAnalyze} disabled={loading}>
          {loading ? '분석 중...' : 'AI 분석 실행'}
        </button>
        {result && <button className="btn btn-secondary btn-sm" onClick={reset}>초기화</button>}
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 20 }}>
          <div className="loading-spinner"></div>
          <p style={{ color: 'var(--text-muted)' }}>AI가 분석 중입니다...</p>
        </div>
      )}

      {error && (
        <div className="error-message" style={{ marginBottom: 12 }}>{error}</div>
      )}

      {result && (
        <div className="preview-section" style={{ height: 'auto', maxHeight: '500px', whiteSpace: 'pre-wrap' }}>
          {result}
        </div>
      )}
    </div>
  );
}
