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

// 웹 클라이언트 토큰(Vercel 빌드 환경변수 VITE_WEB_AI_TOKEN). 번들에 들어가므로 비밀이 아니다 — 서버(api/analyze.js)가
// 봇·스캐너를 걸러 내는 필터로만 쓴다. 실질적인 보호는 Origin 허용 목록 + 속도 제한 + 일일 예산이다.
function webClientHeaders() {
  const token = import.meta.env.VITE_WEB_AI_TOKEN;
  return token ? { 'X-WR-Client': token } : {};
}

async function fetchAnalyze(url, payload, session) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...buildSessionHeaders(session),
      ...webClientHeaders(),
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

const INPUT_ERROR_FALLBACK = 'AI 분석 입력을 만들 수 없습니다. 입력값을 확인해 주세요.';

// input: 비식별 구조화 입력(buildAiInput) — 세 경로(인트라넷 서버 · Electron 직접 호출 · 웹 Vercel) 모두 이 값만 보낸다.
//   프롬프트는 받는 쪽이 @wr/contracts 빌더로 직접 조립하므로 임의 문자열이 AI 벤더로 전달될 경로가 없다.
// inputError: 입력을 만들지 못한 사유(buildAiInputResult) — 사용자에게 그대로 보인다.
// fullReport: 보고서 전문 — 서버가 병원 내부 LLM일 때(aiFullReportAllowed)만 호출부가 넘기고, 인트라넷 경로에서만 보낸다.
// model: 웹·Electron에서 사용자가 고른 모델(허용 목록은 받는 쪽이 검증). 인트라넷은 서버가 승인된 모델을 쓴다.
export async function analyzeAIRequest({ input, inputError, fullReport, model, session, settings }) {
  if (!input) {
    return { ok: false, status: 400, data: { error: { message: inputError || INPUT_ERROR_FALLBACK } } };
  }

  // Intranet mode: route through the server proxy only.
  // Direct external LLM calls are prohibited by server policy (aiEnabled gate + CSP).
  if (session?.mode === 'intranet') {
    try {
      const data = await requestJson('/api/ai/analyze', {
        baseUrl: session.apiBaseUrl || settings?.apiBaseUrl || '',
        method: 'POST',
        session,
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
    const data = await window.electron.analyzeAI({ input, model, apiKey });
    return { ok: !data?.error, status: data?.error ? 400 : 200, data };
  }

  // Web (non-intranet): Vercel serverless endpoint. 보고서 전문은 외부 벤더로 나가지 않으므로 보내지 않는다.
  const payload = { input, model };
  const primaryUrl = buildAnalyzeUrl(settings, session);
  const result = await fetchAnalyze(primaryUrl, payload, session);

  if (!result.ok && primaryUrl !== '/api/analyze' && [404, 405, 501].includes(result.status)) {
    return fetchAnalyze('/api/analyze', payload, session);
  }

  return result;
}
