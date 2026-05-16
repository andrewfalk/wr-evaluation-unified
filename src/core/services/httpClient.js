import { buildSessionHeaders } from '../auth/session';
import { getCsrfToken } from '../utils/csrfCookie';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Configured once at app boot via configureHttpClient().
let _onRefresh = null; // async () => newSession — called on 401
let _onLogout = null;  // () => void — called when refresh also fails

export function configureHttpClient({ onRefresh, onLogout }) {
  _onRefresh = onRefresh;
  _onLogout = onLogout;
}

function normalizeBaseUrl(baseUrl = '') {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

function buildUrl(baseUrl, path) {
  const base = normalizeBaseUrl(baseUrl);
  return base ? `${base}${path}` : path;
}

function buildHeaders(method, session, extraHeaders) {
  const isMutating = MUTATING.has((method || 'GET').toUpperCase());
  const csrfToken = isMutating ? getCsrfToken() : null;
  return {
    'Content-Type': 'application/json',
    ...buildSessionHeaders(session),
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
    ...extraHeaders,
  };
}

export async function requestJson(path, {
  baseUrl = '',
  method = 'GET',
  body,
  session,
  headers = {},
  signal,
  _retry = false,
} = {}) {
  const response = await fetch(buildUrl(baseUrl, path), {
    method,
    credentials: 'include',
    headers: buildHeaders(method, session, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });

  // 401 → attempt one token refresh, then retry the original request.
  // _retry flag prevents infinite loops if the retry itself gets a 401.
  // Pass baseUrl so the refresh handler uses the same server as this request.
  // For 401s, read the body first so we can inspect the error code before deciding
  // whether to attempt a token refresh. Body reading is one-shot, so we cache it.
  let data = null;
  if (response.status === 401 || !response.ok) {
    try { data = await response.json(); } catch { data = null; }
  }

  if (response.status === 401 && !_retry && _onRefresh) {
    // Skip refresh for domain errors where a fresh token won't help.
    const errCode = data?.code || data?.error?.code;
    if (errCode === 'WRONG_CURRENT_PASSWORD') {
      const message = data?.error?.message
        || (typeof data?.error === 'string' ? data.error : null)
        || data?.message
        || `Request failed (${response.status})`;
      const err = new Error(message);
      err.status = 401;
      err.data = data;
      throw err;
    }

    let newSession;
    try {
      newSession = await _onRefresh({ baseUrl });
    } catch (refreshErr) {
      // Retryable coordination errors (e.g. cross-tab lock contention) should not
      // log the user out — only this request fails; the next 401 will re-enter refresh.
      if (refreshErr?.retryable) {
        const err = new Error('일시적인 인증 조율 오류입니다. 잠시 후 다시 시도해 주세요.');
        err.status = 401;
        err.retryable = true;
        throw err;
      }
      _onLogout?.();
      const err = new Error('인증이 만료되었습니다. 다시 로그인해 주세요.');
      err.status = 401;
      throw err;
    }
    return requestJson(path, { baseUrl, method, body, session: newSession, headers, signal, _retry: true });
  }

  const errCode = data?.code || data?.error?.code;
  if (response.status === 403 && errCode === 'CSRF_INVALID' && !_retry && _onRefresh) {
    let newSession;
    try {
      newSession = await _onRefresh({ baseUrl, forceCsrf: true });
    } catch {
      const err = new Error('CSRF token renewal failed');
      err.status = 403;
      err.data = data;
      throw err;
    }
    return requestJson(path, { baseUrl, method, body, session: newSession, headers, signal, _retry: true });
  }

  // Success responses and non-401 errors haven't had their body read yet.
  if (data === null) {
    try { data = await response.json(); } catch { data = null; }
  }

  if (!response.ok) {
    const message = data?.error?.message
      || (typeof data?.error === 'string' ? data.error : null)
      || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}
