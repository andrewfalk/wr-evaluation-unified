import { buildSessionHeaders } from '../auth/session';

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
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  return { ok: res.ok, status: res.status, data };
}

export async function analyzeAIRequest({ prompt, systemPrompt, model, session, settings }) {
  if (window.electron?.analyzeAI) {
    const aiSettings = loadAISettings();
    const isGemini = (model || '').startsWith('gemini');
    const apiKey = isGemini
      ? (aiSettings.geminiApiKey || '')
      : (aiSettings.claudeApiKey || '');

    const data = await window.electron.analyzeAI({
      prompt,
      systemPrompt,
      model,
      apiKey,
    });

    return { ok: !data?.error, status: data?.error ? 400 : 200, data };
  }

  const payload = { prompt, systemPrompt, model };
  const primaryUrl = buildAnalyzeUrl(settings, session);
  const result = await fetchAnalyze(primaryUrl, payload, session);

  if (!result.ok && primaryUrl !== '/api/analyze' && [404, 405, 501].includes(result.status)) {
    return fetchAnalyze('/api/analyze', payload, session);
  }

  return result;
}
