// Vercel 함수(api/analyze.js)를 실제 @upstash/ratelimit·@upstash/redis로 돌린다 — 모킹 없음.
// Redis가 연결은 받지만 응답하지 않는 장애(로컬 HTTP 서버)에서 AI 호출이 열리지 않는지 확인한다.
//
// 배경: Upstash는 시간 안에 응답이 없으면 예외 대신 { success: true, reason: 'timeout' }을 돌려준다. 이를 정상 허용으로
// 처리하면 한도를 확인하지 못한 채 AI를 호출한다(fail-open). vercelAnalyze.test.mjs는 반환 형태를 모킹으로 검증하고,
// 이 파일은 실제 라이브러리가 그 형태를 만들어 내는 경로 전체를 검증한다.
import http from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import handler from '../../api/analyze.js';

const ORIGIN = 'https://wr.example.app';
const TOKEN = 'client-token-0123456789';
const ENV_KEYS = ['APP_ORIGIN', 'WEB_AI_CLIENT_TOKEN', 'GEMINI_API_KEY', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'];
const savedEnv = {};
const INPUT = {
  schemaVersion: 1,
  demographics: { ageYears: 50, gender: 'male', heightCm: 170, weightKg: 70, bmi: 24, hypertension: null, diabetes: null },
  diagnoses: [], jobs: [], modules: {},
};

let hangingRedis;
let redisUrl;
let upstreamCalls;

beforeAll(async () => {
  hangingRedis = http.createServer(() => { /* 요청을 받고도 응답하지 않는다 */ });
  await new Promise((resolve) => hangingRedis.listen(0, '127.0.0.1', resolve));
  redisUrl = `http://127.0.0.1:${hangingRedis.address().port}`;
});
afterAll(() => {
  hangingRedis.closeAllConnections?.();
  hangingRedis.close();
});

beforeEach(() => {
  for (const key of ENV_KEYS) { savedEnv[key] = process.env[key]; }
  Object.assign(process.env, {
    APP_ORIGIN: ORIGIN, WEB_AI_CLIENT_TOKEN: TOKEN, GEMINI_API_KEY: 'gemini-key',
    UPSTASH_REDIS_REST_URL: redisUrl, UPSTASH_REDIS_REST_TOKEN: 'redis-token',
  });
  upstreamCalls = 0;
  const realFetch = globalThis.fetch;
  // Redis(로컬 서버)로 가는 요청은 그대로 두고, AI 벤더로 가는 요청만 가로채 센다.
  vi.stubGlobal('fetch', async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    upstreamCalls += 1;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'AI 응답' }] } }] }), { status: 200 });
  });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  for (const key of ENV_KEYS) { if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key]; }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeRes() {
  return {
    headers: {}, statusCode: 200, body: undefined,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

describe('Redis가 응답하지 않을 때 (실제 Upstash 라이브러리)', () => {
  it('AI를 호출하지 않고 약 2초 안에 503으로 닫는다', async () => {
    const req = {
      method: 'POST',
      headers: { origin: ORIGIN, 'x-wr-client': TOKEN, 'x-forwarded-for': '203.0.113.7' },
      body: { input: INPUT, model: 'gemini-2.5-flash' },
    };
    const res = makeRes();
    const started = Date.now();
    await handler(req, res);
    const elapsed = Date.now() - started;

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('RATE_LIMIT_UNAVAILABLE');
    expect(upstreamCalls).toBe(0);
    // 제한 시간 2초가 적용됐다: 라이브러리 기본값(5초)이었다면 최소 5초가 걸리고, 세 번 모두 기다리면 15초다.
    expect(elapsed).toBeGreaterThanOrEqual(1800);
    expect(elapsed).toBeLessThan(4500);
  }, 20_000);
});
