import { useState, useCallback } from 'react';

export function useAIAnalysis() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const analyze = useCallback(async (prompt, systemPrompt, model) => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      let data;

      if (window.electron?.analyzeAI) {
        // Electron: IPC를 통해 main process에서 직접 API 호출
        data = await window.electron.analyzeAI({ prompt, systemPrompt, model });
      } else {
        // 웹: Vercel 서버리스 함수 경유
        const res = await fetch('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, systemPrompt, model })
        });
        if (!res.ok) {
          try {
            const errData = await res.json();
            setError(errData.error?.message || `서버 오류 (${res.status})`);
          } catch {
            if (res.status === 404) {
              setError('AI 분석 서버를 찾을 수 없습니다. vercel dev를 실행하거나 배포 환경에서 시도하세요.');
            } else {
              setError(`서버 오류 (${res.status})`);
            }
          }
          return null;
        }
        data = await res.json();
      }

      if (data.error) {
        setError(data.error.message || 'AI 분석 중 오류가 발생했습니다.');
        return null;
      }

      const text = data.content?.[0]?.text || '';
      setResult(text);
      return text;
    } catch (err) {
      setError('서버 연결 오류. 잠시 후 다시 시도해주세요.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { analyze, loading, result, error, reset };
}
