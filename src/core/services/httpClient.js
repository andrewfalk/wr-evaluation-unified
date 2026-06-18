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

  if (response.status === 401 && !_retry && _onRefresh) {
    let newSession;
    try {
      newSession = await _onRefresh({ baseUrl });
    } catch (refreshErr) {
      if (refreshErr?.retryable) {
        const err = new Error('일시적인 인증 조율 오류입니다. 잠시 후 다시 시도해 주세요.');
        err.status = 401; err.retryable = true; throw err;
      }
      _onLogout?.();
      const err = new Error('인증이 만료되었습니다. 다시 로그인해 주세요.');
      err.status = 401; throw err;
    }
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
