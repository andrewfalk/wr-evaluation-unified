import { buildSessionHeaders } from '../auth/session';
import { requestJson } from './httpClient';

const SETTINGS_KEY = 'wrEvalUnifiedSettings';

function loadAISettings() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function buildAnalyzeUrl(settings, session) {
  const resolvedSettings = settings || loadAISettings();
  const baseUrl = String(resolvedSettings?.apiBaseUrl || session?.apiBaseUrl || '')
    .trim()
    .replace(/\/$/, '');
  return baseUrl ? `${baseUrl}/api/analyze` : '/api/analyze';
}

async function fetchAnalyze(url, payload, session) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildSessionHeaders(session),
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// input: 비식별 구조화 입력(buildAiInput). 인트라넷 서버는 이 값만 받고 프롬프트를 직접 조립한다.
// fullReport: 보고서 전문 — 서버가 병원 내부 LLM일 때(aiFullReportAllowed)만 호출부가 넘긴다.
// prompt/systemPrompt/model: 웹(Vercel)·Electron 직접 호출 경로 전용(hf7-3에서 같은 구조화 입력으로 바뀐다).
export async function analyzeAIRequest({ prompt, systemPrompt, input, fullReport, model, session, settings }) {
  // Intranet mode: route through the server proxy only.
  // Direct external LLM calls are prohibited by server policy (aiEnabled gate + CSP).
  if (session?.mode === 'intranet') {
    if (!input) {
      return {
        ok: false,
        status: 400,
        data: { error: { message: 'AI 분석 입력을 만들 수 없습니다. 입력값을 확인해 주세요.' } },
      };
    }
    try {
      const data = await requestJson('/api/ai/analyze', {
        baseUrl: session.apiBaseUrl || settings?.apiBaseUrl || '',
        method: 'POST',
        session,
        // 클라이언트 모델명은 보내지 않는다 — 서버가 승인된 모델을 쓴다.
        body: fullReport ? { input, fullReport } : { input },
      });
      return { ok: true, status: 200, data };
    } catch (err) {
      return {
        ok: false,
        status: err.status || 500,
        data: { error: { message: err.message || 'AI 분석 요청 실패' } },
      };
    }
  }

  // Electron (non-intranet): IPC path → direct Gemini/Claude with user API key.
  if (window.electron?.analyzeAI) {
    const aiSettings = loadAISettings();
    const isGemini = (model || '').startsWith('gemini');
    const apiKey = isGemini
      ? (aiSettings.geminiApiKey || '')
      : (aiSettings.claudeApiKey || '');
    const data = await window.electron.analyzeAI({ prompt, systemPrompt, model, apiKey });
    return { ok: !data?.error, status: data?.error ? 400 : 200, data };
  }

  // Web (non-intranet): Vercel serverless endpoint.
  const payload = { prompt, systemPrompt, model };
  const primaryUrl = buildAnalyzeUrl(settings, session);
  const result = await fetchAnalyze(primaryUrl, payload, session);

  if (!result.ok && primaryUrl !== '/api/analyze' && [404, 405, 501].includes(result.status)) {
    return fetchAnalyze('/api/analyze', payload, session);
  }

  return result;
}
