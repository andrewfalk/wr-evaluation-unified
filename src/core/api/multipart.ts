// 대용량 multipart 업로드(영상 — M3-7a) — REFACTORING_ROADMAP Phase 2 C2(P2-16)에서 httpClient.js에서 그대로 옮겼다.
// 진행률(onProgress)이 필요해 fetch 대신 XHR을 쓴다(fetch는 업로드 progress 미지원). 멱등이 아닌 업로드라 401/403도
// refresh·재시도하지 않고 단순 오류로 던져 사용자 재시도에 맡긴다. win7 호환: XHR·FormData만 사용.
import { ApiError, errorMessageOf } from './errors';
import { buildUrl, type SessionLike } from './apiClient';

export interface MultipartDeps {
  getCsrfToken: () => string | null | undefined;
  buildSessionHeaders: (session: SessionLike) => Record<string, string>;
}

export interface MultipartOptions {
  baseUrl?: string;
  fields?: Record<string, string | Blob | undefined>;
  fileField?: string;
  file?: Blob;
  session?: SessionLike;
  headers?: Record<string, string>;
  onProgress?: (progress: { loaded: number; total: number }) => void;
  signal?: AbortSignal;
}

export function requestMultipartWith(deps: MultipartDeps, path: string, {
  baseUrl = '',
  fields = {},
  fileField = 'file',
  file,
  session,
  headers = {},
  onProgress,
  signal,
}: MultipartOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const key in fields) {
      const value = fields[key];
      if (Object.prototype.hasOwnProperty.call(fields, key) && value !== undefined) {
        form.append(key, value);
      }
    }
    if (file !== undefined) form.append(fileField, file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', buildUrl(baseUrl, path), true);
    xhr.withCredentials = true;

    // Content-Type은 지정하지 않는다(브라우저가 boundary 포함해 설정). 그 외 인증/CSRF 헤더만.
    const csrfToken = deps.getCsrfToken();
    const extra: Record<string, string | null | undefined> = {
      ...deps.buildSessionHeaders(session),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...headers,
    };
    for (const key in extra) {
      const value = extra[key];
      if (Object.prototype.hasOwnProperty.call(extra, key) && value != null) {
        xhr.setRequestHeader(key, value);
      }
    }

    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress({ loaded: e.loaded, total: e.total });
      };
    }

    const fail = (message: string, status: number, data?: unknown) => {
      reject(data !== undefined ? new ApiError(message, status, { data }) : new ApiError(message, status));
    };

    xhr.onload = () => {
      let data: unknown = null;
      try { data = JSON.parse(xhr.responseText); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      fail(errorMessageOf(data, `Upload failed (${xhr.status})`), xhr.status, data);
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
