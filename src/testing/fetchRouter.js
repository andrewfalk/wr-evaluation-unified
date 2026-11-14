// fetch 스텁(REFACTORING_ROADMAP Phase 2 P2-02) — 등록한 경로만 응답하고 나머지는 실패시킨다.
//
//   const router = createFetchRouter({
//     'GET /api/config/public': { deploymentMode: 'intranet' },           // 200 JSON
//     'POST /api/auth/csrf': () => ({ status: 200, body: { csrfToken: 't' } }),
//     'GET /api/patients': (req) => ({ body: { items: [] } }),
//   });
//   globalThis.fetch = router.fetch;
//   router.count('POST /api/auth/csrf')   // 호출 수(부팅 무한루프 감지용 상한 단언)
//   router.unhandled                       // 등록 안 된 요청 목록 — 테스트 끝에 비어 있어야 함
//
// 키는 "METHOD /path"(쿼리 제외, 호스트 무시). 경로 조각 `:name`은 아무 값과 맞고 req.params.name으로
// 들어온다(예: 'POST /api/patients/:id/lock'). 정확히 같은 키가 패턴보다 먼저다. 값이 함수면 요청 정보를 받아 { status?, body?, headers? }
// 또는 Response를 돌려준다. 값이 함수가 아니면 200 JSON 본문으로 쓴다. 등록 안 된 요청은 TypeError로
// reject(브라우저의 네트워크 실패와 같은 모양)하고 unhandled에 기록한다.

function toResponse(result) {
  if (typeof Response !== 'undefined' && result instanceof Response) return result;
  const { status = 200, body = null, headers = {} } = result ?? {};
  const isText = typeof body === 'string';
  return new Response(body === null ? null : isText ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': isText ? 'text/plain' : 'application/json', ...headers },
  });
}

function matchPattern(pattern, key) {
  const [pMethod, pPath] = pattern.split(' ');
  const [kMethod, kPath] = key.split(' ');
  if (pMethod !== kMethod || !pPath.includes('/:')) return null;
  const pParts = pPath.split('/');
  const kParts = kPath.split('/');
  if (pParts.length !== kParts.length) return null;
  const params = {};
  for (let i = 0; i < pParts.length; i += 1) {
    if (pParts[i].startsWith(':')) params[pParts[i].slice(1)] = decodeURIComponent(kParts[i]);
    else if (pParts[i] !== kParts[i]) return null;
  }
  return params;
}

export function createFetchRouter(initialRoutes = {}) {
  const routes = new Map(Object.entries(initialRoutes));
  const resolve = (key) => {
    if (routes.has(key)) return { handler: routes.get(key), params: {}, route: key };
    for (const [pattern, handler] of routes) {
      const params = matchPattern(pattern, key);
      if (params) return { handler, params, route: pattern };
    }
    return null;
  };
  const calls = [];
  const unhandled = [];

  async function fetch(input, init = {}) {
    const rawUrl = typeof input === 'string' ? input : input.url;
    const method = (init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const url = new URL(rawUrl, 'http://localhost');
    const key = `${method} ${url.pathname}`;
    let body = init.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* keep text */ }
    }
    const match = resolve(key);
    const req = {
      method, url: rawUrl, path: url.pathname, query: Object.fromEntries(url.searchParams), body,
      headers: init.headers ?? {}, params: match?.params ?? {}, route: match?.route ?? null,
    };
    calls.push(req);
    if (!match) {
      unhandled.push(key);
      throw new TypeError(`fetchRouter: unregistered request ${key}`);
    }
    const { handler } = match;
    const result = typeof handler === 'function' ? await handler(req) : { body: handler };
    return toResponse(result);
  }

  return {
    fetch,
    calls,
    unhandled,
    set(key, handler) { routes.set(key, handler); },
    /** key가 경로면 그 경로 호출 수, 패턴(`:id`)이면 그 패턴에 맞은 호출 수. */
    count(key) { return calls.filter((c) => `${c.method} ${c.path}` === key || c.route === key).length; },
  };
}
