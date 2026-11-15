// @ts-nocheck
import { buildSessionHeaders } from '../auth/session';
import { getCsrfToken } from '../utils/csrfCookie';
import { sessionIdentityOf } from '../../platform/dataMode';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Configured once at app boot via configureHttpClient().
let _onRefresh = null; // async () => newSession — called on 401
let _onLogout = null;  // () => void — called when refresh also fails
let _getCurrentSession = null; // () => session — 지금 화면의 세션(요청 신원 고정, 계정 전환 수정)

export function configureHttpClient({ onRefresh, onLogout, getCurrentSession }) {
  _onRefresh = onRefresh;
  _onLogout = onLogout;
  _getCurrentSession = getCurrentSession ?? null;
}

// 요청 신원 고정(계정 전환 수정) — 요청에 실린 세션이 인트라넷 신원(서버 주소 + 사용자·조직)을 가질 때만 본다(신원 없는 요청은 예전 흐름).
//  - 요청 신원 ≠ 지금 화면의 신원 → 이미 떠난 계정의 요청이다. 갱신도 로그아웃도 하지 않는다.
//  - 갱신 결과의 신원 ≠ 요청 신원(또는 기다리는 사이 화면의 계정이 바뀜) → 그 세션으로 같은 본문을 다시 보내지 않는다.
function identityChangedError() {
  const err = new Error('인증이 만료되었습니다. 다시 로그인해 주세요.');
  err.status = 401;
  return err;
}

function leftAccount(requestIdentity) {
  return requestIdentity !== null && !!_getCurrentSession
    && sessionIdentityOf(_getCurrentSession()) !== requestIdentity;
}

// 401(forceCsrf=false) 또는 403 CSRF_INVALID(forceCsrf=true) 뒤 인증을 갱신하고 다시 보낼 세션을 돌려준다. 다시 보내면
// 안 되면 던진다. 다섯 재시도 자리(requestBlob·requestJson·requestBlobPost)가 같은 규칙을 쓴다.
async function refreshForRetry({ session, baseUrl, forceCsrf = false, csrfData }) {
  const requestIdentity = sessionIdentityOf(session);
  if (leftAccount(requestIdentity)) throw identityChangedError();
  let newSession;
  try {
    newSession = await _onRefresh(forceCsrf ? { baseUrl, forceCsrf: true } : { baseUrl });
  } catch (refreshErr) {
    if (forceCsrf) {
      const err = new Error('CSRF token renewal failed');
      err.status = 403;
      err.data = csrfData;
      throw err;
    }
    // Retryable coordination errors (e.g. cross-tab lock contention) should not
    // log the user out — only this request fails; the next 401 will re-enter refresh.
    if (refreshErr?.retryable) {
      const err = new Error('일시적인 인증 조율 오류입니다. 잠시 후 다시 시도해 주세요.');
      err.status = 401;
      err.retryable = true;
      throw err;
    }
    // 갱신을 기다리는 사이 화면의 계정이 바뀌었으면 이전 계정 요청의 실패로 지금 계정을 로그아웃시키지 않는다.
    if (leftAccount(requestIdentity)) throw identityChangedError();
    _onLogout?.();
    const err = new Error('인증이 만료되었습니다. 다시 로그인해 주세요.');
    err.status = 401;
    throw err;
  }
  if (requestIdentity !== null && (sessionIdentityOf(newSession) !== requestIdentity || leftAccount(requestIdentity))) {
    throw identityChangedError();
  }
  return newSession;
}

// A local (non-intranet) session has no server auth state to renew, so an auth
// failure on one cannot be fixed by refreshing — and the failed refresh calls
// onLogout, which resets session state and can re-trigger whatever issued the
// request in the first place. Skipping refresh here keeps an unauthenticated probe
// (e.g. the pre-login integration-status check hitting /api/auth/me) from
// cascading into that cycle.
// Only skip when the session positively declares a non-intranet mode; callers that
// pass no session — or one without a mode — keep the previous behaviour.
function canRefreshSession(session) {
  return !session?.mode || session.mode === 'intranet';
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

// 영상 등 대용량 multipart 업로드(M3-7a). 진행률(onProgress)이 필요해 fetch 대신 XHR 사용
// (fetch는 업로드 progress 미지원). JSON 재시도 루프(requestJson)는 멱등 업로드에 부적합 →
// 401/403은 단순 에러로 던지고 사용자 재시도에 맡긴다. win7 호환: XHR·FormData만 사용.
export function requestMultipart(path, {
  baseUrl = '',
  fields = {},
  fileField = 'file',
  file,
  session,
  headers = {},
  onProgress,
  signal,
} = {}) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const key in fields) {
      if (Object.prototype.hasOwnProperty.call(fields, key) && fields[key] !== undefined) {
        form.append(key, fields[key]);
      }
    }
    if (file !== undefined) form.append(fileField, file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUrl(baseUrl, path), true);
    xhr.withCredentials = true;

    // Content-Type은 지정하지 않는다(브라우저가 boundary 포함해 설정). 그 외 인증/CSRF 헤더만.
    const csrfToken = getCsrfToken();
    const extra = { ...buildSessionHeaders(session), ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...headers };
    for (const key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key) && extra[key] != null) {
        xhr.setRequestHeader(key, extra[key]);
      }
    }

    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
      };
    }

    const fail = (message, status, data) => {
      const err = new Error(message);
      err.status = status;
      if (data !== undefined) err.data = data;
      reject(err);
    };

    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      const message = data?.error?.message
        || (typeof data?.error === 'string' ? data.error : null)
        || `Upload failed (${xhr.status})`;
      fail(message, xhr.status, data);
    };
    xhr.onerror = () => fail('업로드 중 네트워크 오류가 발생했습니다.', 0);
    xhr.ontimeout = () => fail('업로드 시간이 초과되었습니다.', 0);
    xhr.onabort = () => fail('업로드가 취소되었습니다.', 0);

    if (signal) {
      // 이미 abort된 경우 xhr.abort()의 onabort가 안 올 수 있어 직접 reject(promise pending 방지).
      if (signal.aborted) { fail('업로드가 취소되었습니다.', 0); return; }
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }

    xhr.send(form);
  });
}

// 인증 바이너리 다운로드(이미지 등). requestJson과 동일한 세션 헤더·credentials·401 refresh를 공유한다
// (raw fetch로 인증 갱신 흐름을 우회하지 않게). 200→Blob, 404→null, 그 외→throw. GET 전용.
export async function requestBlob(path, { baseUrl = '', session, headers = {}, signal, _retry = false } = {}) {
  const response = await fetch(buildUrl(baseUrl, path), {
    method: 'GET',
    credentials: 'include',
    headers: { ...buildSessionHeaders(session), ...headers },
    ...(signal !== undefined ? { signal } : {}),
  });

  if (response.status === 401 && !_retry && _onRefresh && canRefreshSession(session)) {
    const newSession = await refreshForRetry({ session, baseUrl });
    return requestBlob(path, { baseUrl, session: newSession, headers, signal, _retry: true });
  }

  if (response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.blob();
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

  if (response.status === 401 && !_retry && _onRefresh && canRefreshSession(session)) {
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

    const newSession = await refreshForRetry({ session, baseUrl });
    return requestJson(path, { baseUrl, method, body, session: newSession, headers, signal, _retry: true });
  }

  const errCode = data?.code || data?.error?.code;
  if (
    response.status === 403
    && errCode === 'CSRF_INVALID'
    && !_retry
    && _onRefresh
    && canRefreshSession(session)
  ) {
    const newSession = await refreshForRetry({ session, baseUrl, forceCsrf: true, csrfData: data });
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

// PR2 §9 — POST 바디 + CSRF를 실어 보내야 하는 다운로드(예: 통계 집계결과 CSV 내보내기).
// requestJson은 성공 응답에도 항상 response.json()을 호출하므로 바이너리/CSV를 못 받고,
// requestBlob(위)은 GET 전용이라 POST 바디·CSRF가 안 된다 — requestJson과 동일한 인증
// 갱신·CSRF 재시도 로직을 그대로 따르되, 성공 응답만 response.blob()으로 받는다(에러
// 응답은 JSON 본문을 기대하므로 그쪽만 json()으로 파싱).
export async function requestBlobPost(path, {
  baseUrl = '',
  body,
  session,
  headers = {},
  signal,
  _retry = false,
} = {}) {
  const method = 'POST';
  const response = await fetch(buildUrl(baseUrl, path), {
    method,
    credentials: 'include',
    headers: buildHeaders(method, session, headers),
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal !== undefined ? { signal } : {}),
  });

  let data = null;
  if (!response.ok) {
    try { data = await response.json(); } catch { data = null; }
  }

  if (response.status === 401 && !_retry && _onRefresh && canRefreshSession(session)) {
    const newSession = await refreshForRetry({ session, baseUrl });
    return requestBlobPost(path, { baseUrl, body, session: newSession, headers, signal, _retry: true });
  }

  const errCode = data?.code || data?.error?.code;
  if (
    response.status === 403
    && errCode === 'CSRF_INVALID'
    && !_retry
    && _onRefresh
    && canRefreshSession(session)
  ) {
    const newSession = await refreshForRetry({ session, baseUrl, forceCsrf: true, csrfData: data });
    return requestBlobPost(path, { baseUrl, body, session: newSession, headers, signal, _retry: true });
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

  return response.blob();
}
