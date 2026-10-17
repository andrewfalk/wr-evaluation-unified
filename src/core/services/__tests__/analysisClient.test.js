import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../httpClient', () => ({ requestJson: vi.fn() }));
vi.mock('../../auth/session', () => ({ buildSessionHeaders: () => ({}) }));

import { requestJson } from '../httpClient';
import { analyzeAIRequest } from '../analysisClient';

const INTRANET = { mode: 'intranet', apiBaseUrl: 'https://wr.test' };
const INPUT = { schemaVersion: 1, marker: 'structured-input' };

beforeEach(() => { vi.mocked(requestJson).mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); delete globalThis.window; });

describe('analyzeAIRequest — 인트라넷', () => {
  it('구조화 입력만 서버로 보낸다(프롬프트·시스템 프롬프트·모델명은 보내지 않는다)', async () => {
    vi.mocked(requestJson).mockResolvedValue({ text: '결과' });
    // 옛 호출부처럼 prompt/systemPrompt/model을 넘겨도 본문에는 실리지 않는다.
    const res = await analyzeAIRequest({ input: INPUT, prompt: '환자 홍길동 …', systemPrompt: '지침', model: 'gemini-2.5-flash', session: INTRANET });

    expect(res).toEqual({ ok: true, status: 200, data: { text: '결과' } });
    const [path, options] = vi.mocked(requestJson).mock.calls[0];
    expect(path).toBe('/api/ai/analyze');
    expect(options.method).toBe('POST');
    expect(options.baseUrl).toBe('https://wr.test');
    expect(options.body).toEqual({ input: INPUT });
    expect(Object.keys(options.body)).toEqual(['input']);
  });

  it('보고서 전문(fullReport)을 넘기면 함께 보낸다', async () => {
    vi.mocked(requestJson).mockResolvedValue({ text: 'ok' });
    await analyzeAIRequest({ input: INPUT, fullReport: '보고서 본문', session: INTRANET });
    expect(vi.mocked(requestJson).mock.calls[0][1].body).toEqual({ input: INPUT, fullReport: '보고서 본문' });
  });

  it('입력이 없으면(검증 실패 등) 서버를 호출하지 않고 안내 메시지를 돌려준다', async () => {
    for (const input of [null, undefined]) {
      const res = await analyzeAIRequest({ input, fullReport: '보고서', prompt: '환자 …', session: INTRANET });
      expect(res.ok).toBe(false);
      expect(res.status).toBe(400);
      expect(res.data.error.message).toContain('AI 분석 입력을 만들 수 없습니다');
    }
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('서버 오류는 상태와 메시지를 그대로 돌려준다', async () => {
    vi.mocked(requestJson).mockRejectedValue(Object.assign(new Error('AI 서버 응답 오류'), { status: 502 }));
    const res = await analyzeAIRequest({ input: INPUT, session: INTRANET });
    expect(res).toEqual({ ok: false, status: 502, data: { error: { message: 'AI 서버 응답 오류' } } });
  });
});

describe('analyzeAIRequest — Electron 직접 호출(독립형)', () => {
  const standalone = { mode: 'standalone' };
  const settings = { geminiApiKey: 'gk', claudeApiKey: 'ck' };

  function stubElectron(analyzeAI) {
    vi.stubGlobal('window', { electron: { analyzeAI } });
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(settings) });
  }

  it('구조화 입력과 모델, 모델에 맞는 API 키만 IPC로 넘긴다(프롬프트는 보내지 않는다)', async () => {
    const analyzeAI = vi.fn().mockResolvedValue({ text: '결과' });
    stubElectron(analyzeAI);
    // 옛 호출부처럼 prompt/systemPrompt/fullReport를 넘겨도 봉투에는 실리지 않는다.
    const res = await analyzeAIRequest({ input: INPUT, model: 'gemini-2.5-flash', session: standalone, prompt: '환자 홍길동', systemPrompt: '지침', fullReport: '보고서 전문' });

    expect(analyzeAI).toHaveBeenCalledWith({ input: INPUT, model: 'gemini-2.5-flash', apiKey: 'gk' });
    expect(Object.keys(analyzeAI.mock.calls[0][0]).sort()).toEqual(['apiKey', 'input', 'model']);
    expect(res).toEqual({ ok: true, status: 200, data: { text: '결과' } });
  });

  it('Claude 모델이면 Claude 키를 쓴다', async () => {
    const analyzeAI = vi.fn().mockResolvedValue({ text: 'x' });
    stubElectron(analyzeAI);
    await analyzeAIRequest({ input: INPUT, model: 'claude-haiku-4-5-20251001', session: standalone });
    expect(analyzeAI.mock.calls[0][0].apiKey).toBe('ck');
  });

  it('메인 프로세스가 오류를 돌려주면 실패로 처리한다', async () => {
    stubElectron(vi.fn().mockResolvedValue({ error: { message: 'API 키가 설정되지 않았습니다.' } }));
    const res = await analyzeAIRequest({ input: INPUT, model: 'gemini-2.5-flash', session: standalone });
    expect(res.ok).toBe(false);
    expect(res.data.error.message).toBe('API 키가 설정되지 않았습니다.');
  });

  it('입력이 없으면 IPC를 부르지 않고 사유를 돌려준다', async () => {
    const analyzeAI = vi.fn();
    stubElectron(analyzeAI);
    const res = await analyzeAIRequest({ input: null, inputError: '직력이 30개를 넘어', model: 'gemini-2.5-flash', session: standalone });
    expect(analyzeAI).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, status: 400, data: { error: { message: '직력이 30개를 넘어' } } });
  });
});

describe('analyzeAIRequest — 웹(Vercel)', () => {
  const standalone = { mode: 'standalone' };
  const okResponse = () => ({ ok: true, status: 200, json: async () => ({ text: 'x' }) });
  let fetchMock;

  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('/api/analyze로 구조화 입력과 모델만 POST한다(프롬프트·보고서 전문은 보내지 않는다)', async () => {
    await analyzeAIRequest({ input: INPUT, model: 'gemini-2.5-flash', session: standalone, prompt: '환자 홍길동', systemPrompt: '지침', fullReport: '보고서 전문' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/analyze');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ input: INPUT, model: 'gemini-2.5-flash' });
  });

  it('빌드 시 설정된 클라이언트 토큰을 X-WR-Client 헤더로 보낸다', async () => {
    vi.stubEnv('VITE_WEB_AI_TOKEN', 'bundle-token-123');
    await analyzeAIRequest({ input: INPUT, model: 'gemini-2.5-flash', session: standalone });
    expect(fetchMock.mock.calls[0][1].headers['X-WR-Client']).toBe('bundle-token-123');
  });

  it('토큰이 설정되지 않았으면 헤더를 보내지 않는다', async () => {
    vi.stubEnv('VITE_WEB_AI_TOKEN', '');
    await analyzeAIRequest({ input: INPUT, model: 'gemini-2.5-flash', session: standalone });
    expect(fetchMock.mock.calls[0][1].headers['X-WR-Client']).toBeUndefined();
  });

  it('입력이 없으면 서버를 부르지 않고 사유를 돌려준다', async () => {
    const res = await analyzeAIRequest({ input: undefined, model: 'gemini-2.5-flash', session: standalone });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(res.data.error.message).toContain('AI 분석 입력을 만들 수 없습니다');
  });

  it('서버 오류 본문({ error: { code, message } })을 그대로 돌려준다', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 429, json: async () => ({ error: { code: 'RATE_LIMITED', message: '요청 한도를 초과했습니다.' } }) }));
    const res = await analyzeAIRequest({ input: INPUT, model: 'gemini-2.5-flash', session: standalone });
    expect(res).toEqual({ ok: false, status: 429, data: { error: { code: 'RATE_LIMITED', message: '요청 한도를 초과했습니다.' } } });
  });

  it('다른 서버 주소가 404/405/501이면 같은 출처 /api/analyze로 한 번 더 시도한다(같은 본문)', async () => {
    fetchMock
      .mockImplementationOnce(async () => ({ ok: false, status: 404, json: async () => ({}) }))
      .mockImplementationOnce(async () => okResponse());
    const res = await analyzeAIRequest({ input: INPUT, model: 'm', session: standalone, settings: { apiBaseUrl: 'https://other.example' } });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(['https://other.example/api/analyze', '/api/analyze']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ input: INPUT, model: 'm' });
    expect(res.ok).toBe(true);
  });
});
