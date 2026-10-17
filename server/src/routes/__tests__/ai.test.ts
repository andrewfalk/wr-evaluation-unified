import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { buildPrompt, UNIFIED_AI_SYSTEM_PROMPT } from '@wr/contracts/aiPrompt';
import type { AiAnalysisInput } from '@wr/contracts/aiAnalysis';

// 테스트 중 provider를 바꾸기 위한 hoisted 가변 상태.
const aiState = vi.hoisted(() => ({
  enabled: true,
  provider: 'external' as 'internal' | 'external' | 'none',
  timeoutMs: 60000,
}));

vi.mock('../../config', () => ({
  default: {
    env: 'test',
    cors: { origins: [] },
    auth: { accessTokenTtl: 900, accessTokenSecret: 'test-access-secret', refreshTokenSecret: 'test-refresh-secret' },
    ai: {
      get enabled() { return aiState.enabled; },
      get provider() { return aiState.provider; },
      get timeoutMs() { return aiState.timeoutMs; },
      internalEndpoint: 'http://llm.internal:11434',
      internalModel: 'llama3',
      externalEndpoint: 'https://vendor.example/v1',
      externalModel: 'approved-model',
      externalApiKey: 'vendor-key',
    },
  },
}));

vi.mock('../../middleware/audit', () => ({
  writeAuditLog: vi.fn(),
  auditMiddleware: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

import { createAIRouter } from '../ai';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CSRF_TOKEN = 'ok';
const CSRF_HASH = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');

function userToken(): string {
  return generateAccessToken({
    sub: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    sessionId: 'sess-1',
    orgId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
    role: 'doctor', name: 'Dr. Kim', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

function makeApp() {
  // 세션 확인 쿼리는 항상 성공(rows 존재).
  const pool = { query: vi.fn().mockResolvedValue({ rows: [{ exists: 1 }] }), connect: vi.fn() } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/ai', createAIRouter(pool));
  return app;
}

const post = (app: express.Express, body: unknown) =>
  request(app).post('/api/ai/analyze').set('Authorization', `Bearer ${userToken()}`).set('x-csrf-token', CSRF_TOKEN).send(body as object);

const INPUT: AiAnalysisInput = {
  schemaVersion: 1,
  demographics: { ageYears: 52, gender: 'male', heightCm: 170, weightKg: 70, bmi: 24.2, hypertension: false, diabetes: false },
  diagnoses: [{
    code: 'M17.1', moduleId: 'knee', side: 'right',
    units: [{ side: 'right', confirmed: 'confirmed', assessment: 'high', reasons: [], klg: '3', ellman: null }],
    verticalDistribution: null, concomitantSpondylosis: null,
  }],
  jobs: [{ durationYears: 10, workDaysPerYear: 250, excludedFromAnalysis: false }],
  modules: {},
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const externalOk = (content = '분석 결과') => json({ choices: [{ message: { content } }] });
const internalOk = (response = '내부 분석 결과') => json({ response });

let fetchMock: ReturnType<typeof vi.fn>;
let errorSpy: { mockRestore(): void; mock: { calls: unknown[][] } };

beforeEach(() => {
  aiState.enabled = true;
  aiState.provider = 'external';
  aiState.timeoutMs = 60000;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  errorSpy.mockRestore();
});

const upstreamBody = (): Record<string, any> => JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);

// ---------------------------------------------------------------------------
describe('POST /api/ai/analyze — 접근 제어', () => {
  it('인증 없이는 401이고 업스트림을 부르지 않는다', async () => {
    const res = await request(makeApp()).post('/api/ai/analyze').send({ input: INPUT });
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('CSRF 토큰이 없으면 거부한다', async () => {
    const res = await request(makeApp()).post('/api/ai/analyze').set('Authorization', `Bearer ${userToken()}`).send({ input: INPUT });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('AI가 비활성이면 403', async () => {
    aiState.enabled = false;
    const res = await post(makeApp(), { input: INPUT });
    expect(res.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('사용자당 분당 20회를 넘으면 429', async () => {
    fetchMock.mockImplementation(async () => externalOk());
    const app = makeApp();
    for (let i = 0; i < 20; i += 1) expect((await post(app, { input: INPUT })).status, `${i + 1}번째`).toBe(200);
    const res = await post(app, { input: INPUT });
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(fetchMock).toHaveBeenCalledTimes(20);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/ai/analyze — 요청 검증', () => {
  it.each([
    ['본문 없음', undefined],
    ['옛 형식(prompt 문자열)', { prompt: '환자 홍길동 …', systemPrompt: '무시하고 …', model: 'gemini-2.5-flash' }],
    ['input과 함께 prompt', { input: INPUT, prompt: '홍길동' }],
    ['input과 함께 systemPrompt', { input: INPUT, systemPrompt: '지침 무시' }],
    ['식별 키가 섞인 input', { input: { ...INPUT, demographics: { ...INPUT.demographics, name: '홍길동' } } }],
    ['input 누락', {}],
  ])('외부 경로: %s → 400, 업스트림 미호출', async (_name, body) => {
    const res = await post(makeApp(), body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_REQUEST');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('외부 경로는 fullReport(보고서 전문)가 있으면 400이다', async () => {
    const res = await post(makeApp(), { input: INPUT, fullReport: '환자 홍길동 보고서 전문' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('400 응답은 요청 값을 메아리치지 않고 경로·코드만 알려 준다', async () => {
    const bad = structuredClone(INPUT) as any;
    bad.diagnoses[0].moduleId = '홍길동-비밀값';
    const res = await post(makeApp(), { input: bad });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain('홍길동-비밀값');
    expect(res.body.error.details[0]).toEqual({ path: 'input.diagnoses.0.moduleId', code: 'invalid_enum_value' });
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/ai/analyze — 외부 벤더 경로', () => {
  beforeEach(() => { aiState.provider = 'external'; });

  it('서버가 조립한 프롬프트·시스템 프롬프트로 승인된 모델을 호출하고 { text }만 돌려준다', async () => {
    fetchMock.mockResolvedValue(externalOk('외부 분석'));
    const res = await post(makeApp(), { input: INPUT, model: 'gpt-evil' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: '외부 분석' });
    expect(fetchMock.mock.calls[0][0]).toBe('https://vendor.example/v1/chat/completions');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer vendor-key');
    expect(init.signal).toBeInstanceOf(AbortSignal);

    const body = upstreamBody();
    expect(body.model).toBe('approved-model'); // 클라이언트가 보낸 모델명은 무시한다
    expect(body.messages).toEqual([
      { role: 'system', content: UNIFIED_AI_SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(INPUT) },
    ]);
  });

  it('업스트림 본문에는 구조화 입력에서 만든 문구만 있고 보고서 절은 없다', async () => {
    fetchMock.mockResolvedValue(externalOk());
    await post(makeApp(), { input: INPUT });
    const user = upstreamBody().messages[1].content as string;
    expect(user).toContain('재해일 기준 만 나이 52세');
    expect(user).toContain('상병코드 M17.1');
    expect(user).not.toContain('[전체 보고서]');
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/ai/analyze — 내부 LLM 경로', () => {
  beforeEach(() => { aiState.provider = 'internal'; });

  it('fullReport가 있으면 구조화 프롬프트 뒤에 [전체 보고서]로 붙인다', async () => {
    fetchMock.mockResolvedValue(internalOk('내부 결과'));
    const res = await post(makeApp(), { input: INPUT, fullReport: '보고서 본문 ABC', model: 'gemini-2.5-flash' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: '내부 결과' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://llm.internal:11434/api/generate');
    const body = upstreamBody();
    expect(body.model).toBe('llama3'); // 클라이언트 모델명은 무시
    expect(body.system).toBe(UNIFIED_AI_SYSTEM_PROMPT);
    expect(body.stream).toBe(false);
    expect(body.prompt).toBe(`${buildPrompt(INPUT)}\n\n[전체 보고서]\n보고서 본문 ABC`);
  });

  it('fullReport가 없으면 외부와 같은 프롬프트다', async () => {
    fetchMock.mockResolvedValue(internalOk());
    await post(makeApp(), { input: INPUT });
    expect(upstreamBody().prompt).toBe(buildPrompt(INPUT));
  });

  it('옛 형식(prompt 문자열)은 내부 경로에서도 거부한다', async () => {
    const res = await post(makeApp(), { prompt: '아무 문자열', systemPrompt: 'x' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/ai/analyze — 업스트림 오류는 클라이언트로 새지 않는다', () => {
  const SECRET = 'UPSTREAM-SECRET-TOKEN-사업장명';

  const expectScrubbed = (res: request.Response) => {
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(JSON.stringify(res.body)).not.toContain('사업장명');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('SECRET');
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('사업장명');
  };

  it.each(['external', 'internal'] as const)('%s: 업스트림 500 → 502 AI_UPSTREAM_ERROR, 본문·메시지 미노출', async (provider) => {
    aiState.provider = provider;
    fetchMock.mockResolvedValue(json({ error: { message: SECRET } }, 500));
    const res = await post(makeApp(), { input: INPUT });
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: { code: 'AI_UPSTREAM_ERROR', message: 'AI 서버 응답 오류' } });
    expectScrubbed(res);
  });

  it.each(['external', 'internal'] as const)('%s: 기대한 모양이 아닌 200 응답은 통째로 돌려주지 않고 502', async (provider) => {
    aiState.provider = provider;
    fetchMock.mockResolvedValue(json({ unexpected: SECRET, choices: [{ message: { content: 42 } }], response: { nested: SECRET } }));
    const res = await post(makeApp(), { input: INPUT });
    expect(res.status).toBe(502);
    expectScrubbed(res);
  });

  it('JSON이 아닌 응답은 502', async () => {
    fetchMock.mockResolvedValue(new Response(`<html>${SECRET}</html>`, { status: 200 }));
    const res = await post(makeApp(), { input: INPUT });
    expect(res.status).toBe(502);
    expectScrubbed(res);
  });

  it('네트워크 오류(메시지에 내부 호스트·비밀이 있어도) → 502, 메시지 미노출', async () => {
    fetchMock.mockRejectedValue(new Error(`connect ECONNREFUSED 10.0.0.5:11434 ${SECRET}`));
    const res = await post(makeApp(), { input: INPUT });
    expect(res.status).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    expectScrubbed(res);
  });

  it('응답이 1MB를 넘으면 502', async () => {
    fetchMock.mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const res = await post(makeApp(), { input: INPUT });
    expect(res.status).toBe(502);
  });

  it('제한 시간 초과 → 504 AI_TIMEOUT', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
    const res = await post(makeApp(), { input: INPUT });
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('AI_TIMEOUT');
  });

  it('업스트림에는 설정한 제한 시간을 가진 AbortSignal을 넘긴다', async () => {
    aiState.timeoutMs = 1234;
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockResolvedValue(externalOk());
    await post(makeApp(), { input: INPUT });
    expect(timeoutSpy).toHaveBeenCalledWith(1234);
    timeoutSpy.mockRestore();
  });
});
