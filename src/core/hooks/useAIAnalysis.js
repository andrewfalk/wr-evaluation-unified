import { useState, useCallback } from 'react';
import { useAuth } from '../auth/AuthContext';
import { analyzeAIRequest } from '../services/analysisClient';

export function useAIAnalysis() {
  const { session } = useAuth();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  // input: 비식별 구조화 입력(세 경로 공통), inputError: 입력을 못 만든 사유, fullReport: 내부 LLM일 때만, model: 웹·Electron 선택 모델.
  const analyze = useCallback(async ({ input, inputError, fullReport, model } = {}) => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const response = await analyzeAIRequest({
        input,
        inputError,
        fullReport,
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

      // 세 경로(인트라넷 서버 · Vercel · Electron) 모두 { text }만 돌려준다.
      const text = data?.text || '';

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
