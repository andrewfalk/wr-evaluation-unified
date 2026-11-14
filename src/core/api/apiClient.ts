// 요청 파이프라인 — REFACTORING_ROADMAP Phase 2 C2(P2-16).
//
// 전송 → 401 refresh(1벌) → 403 CSRF_INVALID 재시도(1벌) → 오류 추출(1벌). 예전 httpClient.js의 requestJson·requestBlob·
// requestBlobPost가 각자 갖고 있던 세 벌을 하나로 합치고, 함수별 차이는 아래 RequestOptions로 보존한다
// (httpClient.js는 같은 export를 가진 shim — P2-100에서 삭제). 동작 기준: httpClient.test.js·T6(httpClientBlob 특성화).
//
// 함수별 차이(2026-11-14 httpClient.js에서 확인 — 그대로 옵션으로):
//   | 옵션            | requestJson                    | requestBlob(GET)   | requestBlobPost(POST) |
//   | jsonRequest     | O(Content-Type·CSRF·JSON 본문) | X(세션 헤더만)     | O                     |
//   | parse           | 'json'(실패해도 null)          | 'blob'             | 'blob'                |
//   | readErrorBody   | O(401이면 refresh 전에 읽음)   | X(본문 안 읽음)    | O                     |
//   | notFoundAsNull  | X                              | O(404 → null)      | X                     |
//   | csrfRetry       | O                              | X                  | O                     |
//   | wrongPassword   | O(401 WRONG_CURRENT_PASSWORD는 refresh 안 함, 문구에 data.message 폴백) | X | X |
import { ApiError, errorCodeOf, errorMessageOf } from './errors';
import { isRefreshEligible, normalizeBaseUrl } from '../../platform/dataMode';

// 세션은 화면마다 모양이 넓어(사용자·토큰·모드…) 여기서는 필요한 만큼만 본다.
export type SessionLike = { mode?: string | null; accessToken?: string | null; [key: string]: unknown } | null | undefined;

export type RefreshHandler = (args: { baseUrl: string; forceCsrf?: boolean }) => Promise<SessionLike>;

export interface ApiClientDeps {
  /** 호출 시점의 fetch(테스트가 globalThis.fetch를 바꿔 끼운다). */
  fetchImpl?: typeof fetch;
  getCsrfToken: () => string | null | undefined;
  buildSessionHeaders: (session: SessionLike) => Record<string, string>;
}

export interface RequestOptions {
  baseUrl?: string;
  method?: string;
  body?: unknown;
  session?: SessionLike;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** true면 401 refresh·CSRF 재시도를 하지 않는다(예전 `_retry` — 재시도 요청 자신, 로그아웃 요청). */
  skipAuthRefresh?: boolean;
  parse?: 'json' | 'blob';
  jsonRequest?: boolean;
  readErrorBody?: boolean;
  notFoundAsNull?: boolean;
  csrfRetry?: boolean;
  wrongPasswordShortCircuit?: boolean;
  /** fetch의 credentials. 기본 'include', null이면 키를 넣지 않는다(브라우저 기본 same-origin — 외부 origin에 쿠키를 싣지 않음). */
  credentials?: RequestCredentials | null;
  /**
   * true면 HTTP 오류로 던지지 않고 `{ ok, status, data }`를 돌려준다(본문은 상태와 무관하게 JSON으로 읽고 실패하면 null).
   * refresh·CSRF 재시도도 하지 않는다. 네트워크 오류·AbortError는 그대로 던진다. 예전 raw fetch 자리(P2-17)용.
   */
  envelope?: boolean;
}

export interface ResponseEnvelope {
  ok: boolean;
  status: number;
  data: unknown;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function buildUrl(baseUrl: string | null | undefined, path: string): string {
  const base = normalizeBaseUrl(baseUrl);
  return base ? `${base}${path}` : path;
}

export interface ApiClient {
  configure(handlers: { onRefresh?: RefreshHandler | null; onLogout?: (() => void) | null }): void;
  request(path: string, options?: RequestOptions): Promise<unknown>;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  let onRefresh: RefreshHandler | null = null;
  let onLogout: (() => void) | null = null;
  const doFetch = (input: string, init: RequestInit): Promise<Response> => (deps.fetchImpl ?? globalThis.fetch)(input, init);

  function buildHeaders(method: string, session: SessionLike, extra: Record<string, string>, jsonRequest: boolean) {
    if (!jsonRequest) return { ...deps.buildSessionHeaders(session), ...extra };
    const csrfToken = MUTATING.has(method.toUpperCase()) ? deps.getCsrfToken() : null;
    return {
      'Content-Type': 'application/json',
      ...deps.buildSessionHeaders(session),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
      ...extra,
    };
  }

  async function readJson(response: Response): Promise<unknown> {
    try { return await response.json(); } catch { return null; }
  }

  async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const {
      baseUrl = '', method = 'GET', body, session, headers = {}, signal, skipAuthRefresh = false,
      parse = 'json', jsonRequest = true, readErrorBody = true, notFoundAsNull = false, csrfRetry = true,
      wrongPasswordShortCircuit = false, credentials = 'include', envelope = false,
    } = options;

    const init: RequestInit = { method };
    if (credentials !== null) init.credentials = credentials;
    init.headers = buildHeaders(method, session, headers, jsonRequest);
    if (jsonRequest || body !== undefined) init.body = body === undefined ? undefined : JSON.stringify(body);
    if (signal !== undefined) init.signal = signal;
    const response = await doFetch(buildUrl(baseUrl, path), init);

    if (envelope) {
      return { ok: response.ok, status: response.status, data: await readJson(response) } satisfies ResponseEnvelope;
    }

    // 오류 본문은 한 번만 읽을 수 있어 먼저 읽어 둔다(401이면 refresh 판단에 code가 필요).
    let data: unknown = null;
    let bodyRead = false;
    if (readErrorBody && !response.ok) {
      data = await readJson(response);
      bodyRead = true;
    }

    const canRetry = !skipAuthRefresh && !!onRefresh && isRefreshEligible(session);
    const retry = (newSession: SessionLike) => request(path, { ...options, session: newSession, skipAuthRefresh: true });

    // 1) 401 → refresh 1회 뒤 재시도
    if (response.status === 401 && canRetry && onRefresh) {
      if (wrongPasswordShortCircuit && errorCodeOf(data) === 'WRONG_CURRENT_PASSWORD') {
        // 새 토큰으로도 고칠 수 없는 도메인 오류 — refresh하지 않는다.
        throw new ApiError(errorMessageOf(data, `Request failed (${response.status})`, { allowDataMessage: true }), 401, { data });
      }
      let newSession: SessionLike;
      try {
        newSession = await onRefresh({ baseUrl });
      } catch (refreshErr) {
        // 탭 간 락 경합 같은 일시 오류는 로그아웃하지 않는다 — 이 요청만 실패, 다음 401이 다시 refresh에 들어온다.
        if ((refreshErr as { retryable?: boolean } | null)?.retryable) {
          throw new ApiError('일시적인 인증 조율 오류입니다. 잠시 후 다시 시도해 주세요.', 401, { retryable: true });
        }
        onLogout?.();
        throw new ApiError('인증이 만료되었습니다. 다시 로그인해 주세요.', 401);
      }
      return retry(newSession);
    }

    // 2) 403 CSRF_INVALID → CSRF 갱신(forceCsrf) 1회 뒤 재시도
    if (csrfRetry && response.status === 403 && errorCodeOf(data) === 'CSRF_INVALID' && canRetry && onRefresh) {
      let newSession: SessionLike;
      try {
        newSession = await onRefresh({ baseUrl, forceCsrf: true });
      } catch {
        throw new ApiError('CSRF token renewal failed', 403, { data });
      }
      return retry(newSession);
    }

    // 3) 결과
    if (notFoundAsNull && response.status === 404) return null;

    if (!response.ok) {
      const fallback = `Request failed (${response.status})`;
      if (!readErrorBody) throw new ApiError(fallback, response.status); // 본문을 읽지 않는 경로(requestBlob)는 data 없음
      throw new ApiError(errorMessageOf(data, fallback), response.status, { data });
    }

    if (parse === 'blob') return response.blob();
    return bodyRead ? data : readJson(response);
  }

  return {
    configure(handlers) {
      onRefresh = handlers.onRefresh ?? null;
      onLogout = handlers.onLogout ?? null;
    },
    request,
  };
}
