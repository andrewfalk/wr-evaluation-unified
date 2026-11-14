// 요청 계층 오류 — REFACTORING_ROADMAP Phase 2 C2(P2-16).
//
// ApiError는 예전 httpClient가 던지던 `new Error(message)` + `status`·`data`·`retryable`과 **같은 모양**이다:
// 메시지·자기 속성(status, data는 있던 경우에만, retryable은 true일 때만)·name('Error')이 그대로라 기존 호출부의
// `err.status`·`err.data?.code`·`toMatchObject` 판정이 바뀌지 않는다. 덧붙인 것은 `instanceof ApiError`와 읽기 전용
// `code` 게터(서버 본문의 code 또는 error.code — 자기 속성이 아니라 기존 객체 비교에 영향 없음)뿐이다.
// AbortError(취소)는 감싸지 않고 그대로 던진다.

export class ApiError extends Error {
  // `declare` — 필드 선언이 자기 속성(값 undefined)을 만들지 않게 한다(target ES2022의 define 의미론). data·retryable은
  // 예전처럼 있을 때만 자기 속성이 된다.
  declare status: number;
  declare data?: unknown;
  declare retryable?: true;

  constructor(message: string, status: number, options: { data?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.status = status;
    if ('data' in options) this.data = options.data;
    if (options.retryable) this.retryable = true;
  }

  /** 서버 오류 본문의 code(`{code}` 또는 `{error: {code}}`). 없으면 undefined. */
  get code(): string | undefined {
    return errorCodeOf(this.data);
  }
}

// Error.prototype.name('Error')을 그대로 쓴다 — String(err)·로그 문구가 예전과 같도록 name을 덮지 않는다.

type ErrorBody = { code?: unknown; error?: unknown; message?: unknown } | null | undefined;

export function errorCodeOf(data: unknown): string | undefined {
  const body = data as ErrorBody;
  const nested = (body?.error && typeof body.error === 'object') ? (body.error as { code?: unknown }).code : undefined;
  // `||`(truthy) 폴백 — 예전 `data?.code || data?.error?.code`와 같게: 최상위 code가 빈 문자열이어도 중첩 code를 본다
  // (#296 Codex 1회차).
  const code = body?.code || nested;
  return typeof code === 'string' ? code : undefined;
}

/**
 * 서버 오류 본문에서 사용자에게 보일 문구: error.message → error(문자열) → (allowDataMessage면) message → 기본 문구.
 * allowDataMessage는 예전 requestJson의 WRONG_CURRENT_PASSWORD 분기에서만 쓰던 폴백이다.
 */
export function errorMessageOf(data: unknown, fallback: string, { allowDataMessage = false } = {}): string {
  const body = data as ErrorBody;
  const nested = body?.error;
  if (nested && typeof nested === 'object') {
    const message = (nested as { message?: unknown }).message;
    if (message) return String(message);
  }
  if (typeof nested === 'string' && nested) return nested;
  if (allowDataMessage && body?.message) return String(body.message);
  return fallback;
}
