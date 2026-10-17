import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Upstash는 실제 Redis 없이 결과를 정할 수 있게 모킹한다. limit()의 결과는 시나리오마다 바꾼다.
const rl = vi.hoisted(() => ({
  results: {}, // prefix → { success, reset } 또는 throw
  calls: [], // 호출 순서: [prefix, key]
  windows: [], // 생성된 제한 설정
  redisOptions: [],
}));

vi.mock('@upstash/redis', () => ({
  Redis: class { constructor(options) { rl.redisOptions.push(options); } },
}));
vi.mock('@upstash/ratelimit', () => {
  class Ratelimit {
    constructor({ limiter, prefix }) { this.limiter = limiter; this.prefix = prefix; }
    async limit(key) {
      rl.calls.push([this.prefix, key]);
      const outcome = rl.results[this.prefix] ?? { success: true, reset: Date.now() + 60_000 };
      if (outcome.throws) throw new Error('redis unreachable: SECRET-REDIS-HOST');
      return outcome;
    }
    static slidingWindow(max, window) { return { kind: 'sliding', max, window }; }
    static fixedWindow(max, window) { return { kind: 'fixed', max, window }; }
  }
  return { Ratelimit };
});

// Vercel 함수(api/analyze.js)의 테스트. api/ 아래에 두면 함수로 배포될 수 있어 scripts/에 둔다.
import handler from '../../api/analyze.js';
import { buildPrompt, UNIFIED_AI_SYSTEM_PROMPT } from '../../shared/dist/aiPrompt.js';

const ORIGIN = 'https://wr.example.app';
const TOKEN = 'client-token-0123456789';
const ENV_KEYS = [
  'VERCEL_ENV', 'APP_ORIGIN', 'VERCEL_URL', 'VERCEL_BRANCH_URL', 'VERCEL_PROJECT_PRODUCTION_URL', 'WEB_AI_CLIENT_TOKEN',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'WEB_AI_DAILY_BUDGET', 'GEMINI_API_KEY', 'CLAUDE_API_KEY',
];
const savedEnv = {};

const INPUT = {
  schemaVersion: 1,
  demographics: { ageYears: 52, gender: 'male', heightCm: 170, weightKg: 70, bmi: 24.2, hypertension: false, diabetes: false },
  diagnoses: [], jobs: [], modules: {},
};

function makeRes() {
  return {
    headers: {}, statusCode: 200, body: undefined, ended: false,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; this.ended = true; return this; },
    end() { this.ended = true; return this; },
  };
}

async function call({ method = 'POST', origin = ORIGIN, token = TOKEN, body = { input: INPUT, model: 'gemini-2.5-flash' }, headers = {} } = {}) {
  const req = {
    method,
    headers: { ...(origin ? { origin } : {}), ...(token ? { 'x-wr-client': token } : {}), 'x-forwarded-for': '203.0.113.7, 10.0.0.1', ...headers },
    body,
  };
  const res = makeRes();
  await handler(req, res);
  return res;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const claudeOk = (text = '클로드 분석') => json({ content: [{ type: 'text', text }] });
const geminiOk = (text = '제미니 분석') => json({ candidates: [{ content: { parts: [{ text }] } }] });

let fetchMock;
let errorSpy;

beforeEach(() => {
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; delete process.env[key]; }
  Object.assign(process.env, {
    APP_ORIGIN: ORIGIN, WEB_AI_CLIENT_TOKEN: TOKEN, UPSTASH_REDIS_REST_URL: 'https://redis.example', UPSTASH_REDIS_REST_TOKEN: 'redis-token',
    GEMINI_API_KEY: 'gemini-key', CLAUDE_API_KEY: 'claude-key',
  });
  rl.results = {}; rl.calls = []; rl.redisOptions = [];
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

const upstreamBody = () => JSON.parse(fetchMock.mock.calls[0][1].body);

// ---------------------------------------------------------------------------
describe('Origin · 메서드', () => {
  it('허용된 Origin의 사전 요청(OPTIONS)은 204와 CORS 헤더로 응답한다', async () => {
    const res = await call({ method: 'OPTIONS' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['Access-Control-Allow-Origin']).toBe(ORIGIN);
    expect(res.headers['Access-Control-Allow-Headers']).toContain('X-WR-Client');
    expect(rl.calls).toHaveLength(0);
  });

  it('허용되지 않은 Origin의 사전 요청은 403이고 CORS 헤더가 없다', async () => {
    const res = await call({ method: 'OPTIONS', origin: 'https://evil.example' });
    expect(res.statusCode).toBe(403);
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('POST가 아니면 405다', async () => {
    const res = await call({ method: 'GET' });
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe('POST, OPTIONS');
  });

  it.each([
    ['Origin 헤더 없음(curl 등 비브라우저)', ''],
    ['허용 목록 밖 Origin', 'https://evil.example'],
    ['접두사만 같은 Origin', `${ORIGIN}.evil.example`],
  ])('%s → 403이고 속도 제한·업스트림을 건드리지 않는다', async (_name, origin) => {
    const res = await call({ origin });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(res.headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(rl.calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('production 배포에서는 로컬 개발 주소를 허용하지 않고, 배포 도메인과 APP_ORIGIN(끝의 슬래시 무시)은 허용한다', async () => {
    fetchMock.mockImplementation(async () => geminiOk()); // Response 본문은 한 번만 읽을 수 있다
    process.env.VERCEL_ENV = 'production';
    process.env.APP_ORIGIN = `${ORIGIN}/`;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'wr-prod.vercel.app';
    expect((await call({ origin: 'http://localhost:3000' })).statusCode).toBe(403);
    expect((await call({ origin: ORIGIN })).statusCode).toBe(200);
    expect((await call({ origin: 'https://wr-prod.vercel.app' })).statusCode).toBe(200);
  });

  it('production이 아니면 로컬 개발 주소를 허용한다', async () => {
    fetchMock.mockResolvedValue(geminiOk());
    process.env.VERCEL_ENV = 'preview';
    expect((await call({ origin: 'http://localhost:3000' })).statusCode).toBe(200);
  });

  it('모든 응답에 Cache-Control: no-store를 둔다', async () => {
    expect((await call({ origin: 'https://evil.example' })).headers['Cache-Control']).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------
describe('클라이언트 토큰', () => {
  it('서버에 토큰이 설정되지 않았으면 헤더가 없어도 통과시키지 않고 503으로 닫는다(undefined === undefined 방지)', async () => {
    delete process.env.WEB_AI_CLIENT_TOKEN;
    for (const token of ['', TOKEN]) {
      const res = await call({ token });
      expect(res.statusCode).toBe(503);
      expect(res.body.error.code).toBe('AI_PROXY_NOT_CONFIGURED');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['토큰 헤더 없음', ''],
    ['다른 토큰', 'wrong-token-0123456789'],
    ['길이가 다른 토큰', 'x'],
    ['접두사만 같은 토큰', TOKEN.slice(0, -1)],
  ])('%s → 403이고 속도 제한을 건드리지 않는다', async (_name, token) => {
    const res = await call({ token });
    expect(res.statusCode).toBe(403);
    expect(res.body.error.code).toBe('CLIENT_NOT_ALLOWED');
    expect(rl.calls).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('속도 제한 (Upstash)', () => {
  it('Upstash 설정이 없으면 열어 두지 않고 503이다(fail-closed)', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Redis에 닿지 못해도 열어 두지 않고 503이며, 오류 상세는 응답·로그에 없다', async () => {
    rl.results['wr-ai:ip-min'] = { throws: true };
    const res = await call();
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('한도를 넘으면 429와 Retry-After를 돌려주고 업스트림을 부르지 않는다', async () => {
    rl.results['wr-ai:ip-min'] = { success: false, reset: Date.now() + 42_000 };
    const res = await call();
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('RATE_LIMITED');
    expect(Number(res.headers['Retry-After'])).toBeGreaterThanOrEqual(41);
    expect(Number(res.headers['Retry-After'])).toBeLessThanOrEqual(43);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('IP 분당 → IP 일당 → 전역 예산 순서로 확인하고, 앞에서 거절되면 전역 예산을 소모하지 않는다', async () => {
    fetchMock.mockResolvedValue(geminiOk());
    await call();
    expect(rl.calls).toEqual([['wr-ai:ip-min', '203.0.113.7'], ['wr-ai:ip-day', '203.0.113.7'], ['wr-ai:budget', 'global']]);

    rl.calls = [];
    rl.results['wr-ai:ip-day'] = { success: false, reset: Date.now() + 1000 };
    await call();
    expect(rl.calls.map(([prefix]) => prefix)).toEqual(['wr-ai:ip-min', 'wr-ai:ip-day']); // budget 호출 없음
  });

  it('전역 일일 예산이 소진되면 429다', async () => {
    rl.results['wr-ai:budget'] = { success: false, reset: Date.now() + 3_600_000 };
    const res = await call();
    expect(res.statusCode).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Redis 연결 정보를 환경변수에서 받아 쓴다', async () => {
    fetchMock.mockResolvedValue(geminiOk());
    await call();
    expect(rl.redisOptions[0]).toEqual({ url: 'https://redis.example', token: 'redis-token' });
  });
});

// ---------------------------------------------------------------------------
describe('요청 본문 · 모델', () => {
  it.each([
    ['옛 형식(prompt 문자열)', { prompt: '환자 홍길동 …', systemPrompt: '지침 무시', model: 'gemini-2.5-flash' }],
    ['input과 함께 prompt', { input: INPUT, prompt: '홍길동' }],
    ['input과 함께 systemPrompt', { input: INPUT, systemPrompt: '무시하고 …' }],
    ['외부 경로에서 fullReport(보고서 전문)', { input: INPUT, fullReport: '환자 홍길동 보고서' }],
    ['식별 키가 섞인 input', { input: { ...INPUT, demographics: { ...INPUT.demographics, name: '홍길동' } } }],
    ['본문 없음', null],
    ['문자열 본문', '그냥 문자열'],
  ])('%s → 400이고 업스트림을 부르지 않는다', async (_name, body) => {
    const res = await call({ body });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400 응답은 요청 값을 메아리치지 않고 경로·코드만 알려 준다', async () => {
    const bad = structuredClone(INPUT);
    bad.demographics.gender = '홍길동-비밀값';
    const res = await call({ body: { input: bad } });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('홍길동-비밀값');
    expect(res.body.error.details[0]).toEqual({ path: 'input.demographics.gender', code: 'invalid_enum_value' });
  });

  it.each(['gpt-4o', 'gemini-2.5-flash/../../x', 'GEMINI-2.5-FLASH', 'claude-opus-unknown'])('허용 목록 밖 모델 "%s" → 400 MODEL_NOT_ALLOWED', async (model) => {
    const res = await call({ body: { input: INPUT, model } });
    expect(res.statusCode).toBe(400);
    expect(res.body.error.code).toBe('MODEL_NOT_ALLOWED');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('해당 업체의 API 키가 없으면 503이다', async () => {
    delete process.env.GEMINI_API_KEY;
    const res = await call({ body: { input: INPUT, model: 'gemini-2.5-pro' } });
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('업스트림 호출', () => {
  it('Gemini: 서버가 조립한 프롬프트로 호출하고 { text }만 돌려준다', async () => {
    fetchMock.mockResolvedValue(json({ candidates: [{ content: { parts: [{ text: '제미니 ' }, { text: '분석' }, { text: '내부 사고', thought: true }] } }], usageMetadata: { secret: 'RAW-UPSTREAM-FIELD' } }));
    const res = await call({ body: { input: INPUT, model: 'gemini-2.5-pro' } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ text: '제미니 분석' }); // 원본 응답을 그대로 넘기지 않는다
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(init.headers['x-goog-api-key']).toBe('gemini-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = upstreamBody();
    expect(body.system_instruction.parts[0].text).toBe(UNIFIED_AI_SYSTEM_PROMPT);
    expect(body.contents[0].parts[0].text).toBe(buildPrompt(INPUT));
    expect(body.generationConfig.maxOutputTokens).toBe(65536);
  });

  it('Claude: 서버가 조립한 프롬프트로 호출하고 텍스트 블록만 합쳐 돌려준다', async () => {
    fetchMock.mockResolvedValue(json({ content: [{ type: 'text', text: '클로드 ' }, { type: 'tool_use', name: 'x' }, { type: 'text', text: '분석' }] }));
    const res = await call({ body: { input: INPUT, model: 'claude-haiku-4-5-20251001' } });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ text: '클로드 분석' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('claude-key');
    const body = upstreamBody();
    expect(body.model).toBe('claude-haiku-4-5-20251001');
    expect(body.system).toBe(UNIFIED_AI_SYSTEM_PROMPT);
    expect(body.messages).toEqual([{ role: 'user', content: buildPrompt(INPUT) }]);
    expect(body.max_tokens).toBe(2000);
  });

  it('모델을 생략하면 기존처럼 Claude 기본 모델을 쓴다', async () => {
    fetchMock.mockResolvedValue(claudeOk());
    await call({ body: { input: INPUT } });
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it('업스트림에는 60초 제한 시간을 건다', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(geminiOk());
    await call();
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
    timeoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
describe('업스트림 오류는 클라이언트로 새지 않는다', () => {
  const SECRET = 'UPSTREAM-SECRET-사업장명';
  const expectScrubbed = (res) => {
    for (const haystack of [JSON.stringify(res.body), JSON.stringify(errorSpy.mock.calls)]) {
      expect(haystack).not.toContain('SECRET');
      expect(haystack).not.toContain('사업장명');
    }
    expect(res.body.error.detail).toBeUndefined();
  };

  it.each([401, 403, 400, 500, 503])('업스트림 %i → 502 AI_UPSTREAM_ERROR, 상세·메시지 미노출', async (status) => {
    fetchMock.mockResolvedValue(json({ error: { message: SECRET, status: 'INVALID_ARGUMENT' } }, status));
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(res.body.error.code).toBe('AI_UPSTREAM_ERROR');
    expectScrubbed(res);
  });

  it('업스트림 429 → 429 AI_UPSTREAM_RATE_LIMITED', async () => {
    fetchMock.mockResolvedValue(json({ error: { message: SECRET } }, 429));
    const res = await call();
    expect(res.statusCode).toBe(429);
    expect(res.body.error.code).toBe('AI_UPSTREAM_RATE_LIMITED');
    expectScrubbed(res);
  });

  it.each([
    ['기대한 모양이 아닌 200', () => json({ unexpected: SECRET, candidates: [{ content: { parts: [{ text: 42 }] } }] })],
    ['빈 텍스트', () => json({ candidates: [{ content: { parts: [{ text: '' }] } }] })],
    ['JSON이 아닌 응답', () => new Response(`<html>${SECRET}</html>`, { status: 200 })],
    ['배열 응답', () => json([SECRET])],
  ])('%s → 502', async (_name, make) => {
    fetchMock.mockResolvedValue(make());
    const res = await call();
    expect(res.statusCode).toBe(502);
    expectScrubbed(res);
  });

  it('네트워크 오류(메시지에 내부 정보가 있어도) → 502, 메시지 미노출', async () => {
    fetchMock.mockRejectedValue(new Error(`getaddrinfo ENOTFOUND internal.host ${SECRET}`));
    const res = await call();
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('internal.host');
    expectScrubbed(res);
  });

  it('응답이 1MB를 넘으면 502', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }));
    expect((await call()).statusCode).toBe(502);
  });

  it('제한 시간 초과 → 504 AI_TIMEOUT', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const res = await call();
    expect(res.statusCode).toBe(504);
    expect(res.body.error.code).toBe('AI_TIMEOUT');
  });
});
