// 끊김을 따르는 fetch 래퍼(REFACTORING_ROADMAP Phase 2 C9 P2-81b) — 테스트 전용.
//
// fetchRouter.js는 요청의 signal을 보지 않아, 끊긴(abort) 요청도 정상 응답으로 돌아온다(그 파일은 고치지 않는다). 그러면
// "새 검색이 앞 요청을 끊는" 화면이 운영과 다르게 얼려진다. 이 래퍼는 안쪽 fetch(보통 fetchRouter)를 감싸 브라우저처럼 움직인다:
//   · 이미 끊긴 signal로 부르면 안쪽을 부르지 않고 곧바로 AbortError(DOMException)로 거부한다.
//   · 응답이 오기 전에 끊기면 AbortError로 거부한다(안쪽 응답은 버린다). 응답이 온 뒤의 끊김은 무시한다.
// 그리고 요청마다 기록을 남긴다 — 메서드·주소·본문(JSON이면 풀어서)·헤더와 signal 상태. signal 상태는 **읽는 시점의 값**이다
// ('none' = signal 없음, 'live' = 아직 안 끊김, 'aborted' = 끊김). 그래서 단계를 적을 때 그 요청이 그 사이에 끊겼는지가 보인다.

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type SignalState = 'none' | 'live' | 'aborted';

export interface AbortableCall {
  method: string;
  url: string;
  body?: unknown;
  headers: unknown;
  /** 읽는 시점의 signal 상태. */
  readonly signal: SignalState;
  /** 이 요청이 안쪽 fetch까지 갔는지(이미 끊긴 signal이면 false). */
  readonly sent: boolean;
}

export interface AbortableFetch {
  fetch: FetchLike;
  calls: AbortableCall[];
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function parseBody(body: BodyInit | null | undefined): unknown {
  if (typeof body !== 'string') return body ?? undefined;
  try { return JSON.parse(body); } catch { return body; }
}

export function createAbortableFetch(inner: FetchLike): AbortableFetch {
  const calls: AbortableCall[] = [];

  function fetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const request = typeof input === 'object' && !(input instanceof URL) ? input : null;
    // fetch와 같이 init이 우선, 없으면 Request 객체의 signal·메서드.
    const signal = init.signal ?? request?.signal ?? null;
    const sent = !signal?.aborted;
    const call: AbortableCall = {
      method: (init.method || request?.method || 'GET').toUpperCase(),
      url,
      ...(init.body !== undefined && init.body !== null ? { body: parseBody(init.body) } : {}),
      headers: init.headers ?? {},
      get signal(): SignalState {
        if (!signal) return 'none';
        return signal.aborted ? 'aborted' : 'live';
      },
      sent,
    };
    calls.push(call);
    if (!signal) return inner(input, init);
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      inner(input, init).then(
        (response) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          resolve(response);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  return { fetch, calls };
}
