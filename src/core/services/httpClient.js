// 호환 shim(REFACTORING_ROADMAP Phase 2 C2, P2-16) — 구현은 src/core/api/(apiClient.ts·client.ts·multipart.ts)로 옮겼다.
// 같은 export 5개를 같은 인자로 유지한다(importer 제품 15파일은 건드릴 때 '../api/client'로 이전, P2-100에서 삭제).
// 예전 옵션 `_retry`(401 refresh·CSRF 재시도를 하지 않음)는 새 옵션 `skipAuthRefresh`로 넘긴다.
import {
  configureApiClient,
  requestBlob as apiRequestBlob,
  requestBlobPost as apiRequestBlobPost,
  requestJson as apiRequestJson,
  requestMultipart as apiRequestMultipart,
} from '../api/client';

const withRetryFlag = ({ _retry = false, ...options } = {}) => ({ ...options, skipAuthRefresh: _retry });

export function configureHttpClient({ onRefresh, onLogout }) {
  configureApiClient({ onRefresh, onLogout });
}

// JS 호출부가 응답 필드를 바로 읽으므로(예전 그대로) 반환 타입은 any로 둔다 — 새 TS 코드는 '../api/client'를 쓴다.
/** @returns {Promise<any>} */
export function requestJson(path, options = {}) {
  return apiRequestJson(path, withRetryFlag(options));
}

/** @returns {Promise<Blob | null>} */
export function requestBlob(path, options = {}) {
  return apiRequestBlob(path, withRetryFlag(options));
}

/** @returns {Promise<Blob>} */
export function requestBlobPost(path, options = {}) {
  return apiRequestBlobPost(path, withRetryFlag(options));
}

/** @returns {Promise<any>} */
export function requestMultipart(path, options = {}) {
  return apiRequestMultipart(path, options);
}
