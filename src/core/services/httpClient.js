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
  _retry = false,
} = {}) {
  const response = await fetch(buildUrl(baseUrl, path), {
    method,
    credentials: 'include',
    headers: buildHeaders(method, session, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // 401 → attempt one token refresh, then retry the original request.
  // _retry flag prevents infinite loops if the retry itself gets a 401.
  if (response.status === 401 && !_retry && _onRefresh) {
    let newSession;
    try {
      newSession = await _onRefresh();
    } catch {
      _onLogout?.();
      const err = new Error('인증이 만료되었습니다. 다시 로그인해 주세요.');
      err.status = 401;
      throw err;
    }
    return requestJson(path, { baseUrl, method, body, session: newSession, headers, _retry: true });
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}
