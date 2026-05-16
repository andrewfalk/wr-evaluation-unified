import { useState, useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { analyzeAIRequest } from '../services/analysisClient';

export function useAIAnalysis() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const analyze = useCallback(async (prompt, systemPrompt, model) => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await analyzeAIRequest({
        prompt,
        systemPrompt,
        model,
        session,
      });

      if (!response.ok) {
        const msg = response.data?.error?.message || `서버 오류 (${response.status})`;
        setError(msg);
        return null;
      }

      const data = response.data;
      if (data?.error) {
        setError(data.error.message || 'AI 분석 중 오류가 발생했습니다.');
        return null;
      }

      const text = data?.content?.[0]?.text
        || data?.candidates?.[0]?.content?.parts?.[0]?.text
        || data?.text
        || '';

      setResult(text);
      return text;
    } catch {
      setError('서버 연결 오류. 잠시 후 다시 시도해주세요.');
      return null;
    } finally {
      setLoading(false);
    }
  }, [session]);

  const reset = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { analyze, loading, result, error, reset };
}
