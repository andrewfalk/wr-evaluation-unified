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

// 웹·Electron 직접 호출 경로는 hf7-3에서 같은 구조화 입력으로 바뀐다 — 그 전까지는 기존 동작을 유지한다.
describe('analyzeAIRequest — 웹·Electron (hf7-3 전까지 기존 동작)', () => {
  it('Electron: IPC로 prompt·systemPrompt·model·apiKey를 넘긴다', async () => {
    const analyzeAI = vi.fn().mockResolvedValue({ text: 'x' });
    vi.stubGlobal('window', { electron: { analyzeAI } });
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ geminiApiKey: 'gk', claudeApiKey: 'ck' }) });
    await analyzeAIRequest({ prompt: 'P', systemPrompt: 'S', model: 'gemini-2.5-flash', session: { mode: 'standalone' } });
    expect(analyzeAI).toHaveBeenCalledWith({ prompt: 'P', systemPrompt: 'S', model: 'gemini-2.5-flash', apiKey: 'gk' });
  });

  it('웹: /api/analyze로 prompt·systemPrompt·model을 POST한다', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ text: 'x' }) });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('window', {});
    vi.stubGlobal('localStorage', { getItem: () => null });
    await analyzeAIRequest({ prompt: 'P', systemPrompt: 'S', model: 'm', session: { mode: 'standalone' } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/analyze');
    expect(JSON.parse(init.body)).toEqual({ prompt: 'P', systemPrompt: 'S', model: 'm' });
  });
});
