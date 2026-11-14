// 앱 전체가 쓰는 요청 클라이언트 인스턴스 — REFACTORING_ROADMAP Phase 2 C2(P2-16).
// 401 refresh·로그아웃 처리기는 부팅 때 useAuthSync가 configureApiClient()로 꽂는다(예전 configureHttpClient).
import { buildSessionHeaders } from '../auth/session';
import { getCsrfToken } from '../utils/csrfCookie';
import { createApiClient, type RefreshHandler, type RequestOptions, type ResponseEnvelope, type SessionLike } from './apiClient';
import { requestMultipartWith, type MultipartOptions } from './multipart';

// session.js·csrfCookie.js는 아직 JS(타입 추론값이 좁다) — 여기서 계약 타입으로 맞춘다.
const deps = {
  getCsrfToken: (): string | null => getCsrfToken() ?? null,
  buildSessionHeaders: (session: SessionLike): Record<string, string> => ({ ...buildSessionHeaders(session) }),
};

export const apiClient = createApiClient(deps);

export function configureApiClient(handlers: { onRefresh?: RefreshHandler | null; onLogout?: (() => void) | null }): void {
  apiClient.configure(handlers);
}

type CommonOptions = Pick<RequestOptions, 'baseUrl' | 'session' | 'headers' | 'signal' | 'skipAuthRefresh'>;

/** JSON 요청(기본). 성공 본문이 JSON이 아니면 null. */
export function requestJson(path: string, options: CommonOptions & Pick<RequestOptions, 'method' | 'body'> = {}): Promise<unknown> {
  return apiClient.request(path, { ...options, parse: 'json', wrongPasswordShortCircuit: true });
}

/** 인증 바이너리 다운로드(GET). 200 → Blob, 404 → null, 그 밖 → ApiError(본문 안 읽음). CSRF 재시도 없음. */
export function requestBlob(path: string, options: CommonOptions = {}): Promise<Blob | null> {
  return apiClient.request(path, {
    ...options, method: 'GET', parse: 'blob', jsonRequest: false, readErrorBody: false, notFoundAsNull: true, csrfRetry: false,
  }) as Promise<Blob | null>;
}

/** POST 본문 + CSRF가 필요한 다운로드(통계 CSV 등). 성공 → Blob, 실패 본문은 JSON으로 읽어 오류 문구를 만든다. */
export function requestBlobPost(path: string, options: CommonOptions & Pick<RequestOptions, 'body'> = {}): Promise<Blob> {
  return apiClient.request(path, { ...options, method: 'POST', parse: 'blob' }) as Promise<Blob>;
}

/** 대용량 multipart 업로드(XHR, 진행률). refresh·재시도 없음. */
export function requestMultipart(path: string, options: MultipartOptions = {}): Promise<unknown> {
  return requestMultipartWith(deps, path, options);
}

/**
 * HTTP 상태와 본문을 그대로 돌려받는 요청(`{ ok, status, data }`) — 오류로 던지지 않고, refresh·CSRF 재시도도 하지 않는다.
 * 예전 raw fetch 자리(정적 JSON·외부 AI 엔드포인트·인증 부트스트랩)가 쓴다. 헤더는 headers로 직접 준다(jsonRequest=false).
 */
export function requestEnvelope(
  path: string,
  options: Pick<RequestOptions, 'baseUrl' | 'method' | 'body' | 'session' | 'headers' | 'signal' | 'credentials'> = {},
): Promise<ResponseEnvelope> {
  return apiClient.request(path, {
    ...options, envelope: true, jsonRequest: false, skipAuthRefresh: true,
  }) as Promise<ResponseEnvelope>;
}
