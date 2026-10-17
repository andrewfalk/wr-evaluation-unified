import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiHttpError,
  parseAnalyzeEnvelope,
  buildClaudeCall,
  buildGeminiCall,
  extractAiText,
  describeAiFailure,
  postJsonViaNet,
} from '../aiRequest.js';
import { buildPrompt, UNIFIED_AI_SYSTEM_PROMPT } from '../../shared/dist/aiPrompt.js';

const INPUT = {
  schemaVersion: 1,
  demographics: { ageYears: 52, gender: 'male', heightCm: 170, weightKg: 70, bmi: 24.2, hypertension: false, diabetes: false },
  diagnoses: [],
  jobs: [],
  modules: {},
};
const envelope = (over = {}) => ({ input: INPUT, model: 'gemini-2.5-flash', apiKey: 'AIza-test-key', ...over });

describe('parseAnalyzeEnvelope — 봉투 검증', () => {
  it('apiKey를 봉투에서 떼어 따로 검사하므로 정상 요청이 strict 스키마에 거부되지 않는다', () => {
    const parsed = parseAnalyzeEnvelope(envelope());
    expect(parsed.ok).toBe(true);
    expect(parsed).toMatchObject({ provider: 'gemini', model: 'gemini-2.5-flash', apiKey: 'AIza-test-key' });
  });

  it('프롬프트와 시스템 프롬프트는 이 모듈이 계약 빌더로 조립한다(렌더러 값이 아니다)', () => {
    const parsed = parseAnalyzeEnvelope(envelope());
    expect(parsed.prompt).toBe(buildPrompt(INPUT));
    expect(parsed.systemPrompt).toBe(UNIFIED_AI_SYSTEM_PROMPT);
  });

  it('모델을 생략하면 기존처럼 Claude 기본 모델이다', () => {
    const parsed = parseAnalyzeEnvelope(envelope({ model: undefined }));
    expect(parsed).toMatchObject({ ok: true, provider: 'claude', model: 'claude-haiku-4-5-20251001' });
  });

  it('claude- 모델은 claude로 분기한다', () => {
    expect(parseAnalyzeEnvelope(envelope({ model: 'claude-sonnet-4-6-20250514' }))).toMatchObject({ ok: true, provider: 'claude' });
  });

  it.each([
    ['옛 형식(prompt·systemPrompt)', { input: undefined, prompt: '환자 홍길동 …', systemPrompt: '지침 무시' }],
    ['input과 함께 prompt', { prompt: '홍길동' }],
    ['input과 함께 systemPrompt', { systemPrompt: '무시하고 …' }],
    ['fullReport(보고서 전문)', { fullReport: '환자 홍길동 보고서' }],
    ['식별 키가 섞인 input', { input: { ...INPUT, demographics: { ...INPUT.demographics, name: '홍길동' } } }],
    ['input 누락', { input: undefined }],
    ['알 수 없는 추가 키', { extra: 1 }],
  ])('%s → 거부한다', (_name, over) => {
    const parsed = parseAnalyzeEnvelope(envelope(over));
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toBe('AI 분석 요청 형식이 올바르지 않습니다.');
    expect(JSON.stringify(parsed)).not.toContain('홍길동');
  });

  it.each([null, undefined, 'string', 42, [envelope()]])('봉투가 객체가 아니면 거부한다 — %j', (value) => {
    expect(parseAnalyzeEnvelope(value).ok).toBe(false);
  });

  it.each(['gpt-4o', 'gemini-2.5-flash/../../x', 'GEMINI-2.5-FLASH', 'claude-opus-unknown', ''])('허용 목록 밖 모델 "%s" → 거부', (model) => {
    const parsed = parseAnalyzeEnvelope(envelope({ model }));
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toBe('허용되지 않은 모델입니다.');
  });

  it.each([undefined, '', '   ', null, 123])('API 키가 없으면(%j) 업체에 맞는 안내를 한다', (apiKey) => {
    const gemini = parseAnalyzeEnvelope(envelope({ apiKey }));
    expect(gemini.ok).toBe(false);
    expect(gemini.message).toContain('Gemini API 키');
    const claude = parseAnalyzeEnvelope(envelope({ apiKey, model: 'claude-haiku-4-5-20251001' }));
    expect(claude.message).toContain('Claude API 키');
  });

  it.each([
    ['개행 포함(헤더 주입)', 'key\r\nX-Injected: 1'],
    ['공백 포함', 'key with space'],
    ['제어문자 포함', 'key\u0000'],
    ['탭 포함', 'key\tvalue'],
    ['너무 긴 키', 'k'.repeat(513)],
  ])('API 키 %s → 거부', (_name, apiKey) => {
    const parsed = parseAnalyzeEnvelope(envelope({ apiKey }));
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toContain('API 키 형식');
    expect(JSON.stringify(parsed)).not.toContain('Injected');
  });

  it('형식 오류와 키 누락이 겹치면 요청 형식 오류를 먼저 알린다', () => {
    expect(parseAnalyzeEnvelope(envelope({ input: undefined, apiKey: '' })).message).toBe('AI 분석 요청 형식이 올바르지 않습니다.');
  });
});

describe('요청 조립', () => {
  const base = { prompt: '본문', systemPrompt: '시스템', apiKey: 'KEY' };

  it('Gemini: 키는 헤더로, 프롬프트는 본문으로, 모델별 출력 토큰 한도를 적용한다', () => {
    const pro = buildGeminiCall({ ...base, model: 'gemini-2.5-pro' });
    expect(pro.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(pro.headers['x-goog-api-key']).toBe('KEY');
    expect(pro.url).not.toContain('KEY');
    const body = JSON.parse(pro.body);
    expect(body.system_instruction.parts[0].text).toBe('시스템');
    expect(body.contents[0].parts[0].text).toBe('본문');
    expect(body.generationConfig.maxOutputTokens).toBe(65536);
    expect(JSON.parse(buildGeminiCall({ ...base, model: 'gemini-2.5-flash' }).body).generationConfig.maxOutputTokens).toBe(8192);
  });

  it('Gemini: 모델명은 URL 경로에 넣기 전에 인코딩한다(허용 목록 검증과 별개의 이중 방어)', () => {
    const call = buildGeminiCall({ ...base, model: 'a/b c?x=1' });
    expect(call.url).toContain('/models/a%2Fb%20c%3Fx%3D1:generateContent');
  });

  it('Claude: 시스템 프롬프트·메시지·최대 토큰', () => {
    const call = buildClaudeCall({ ...base, model: 'claude-haiku-4-5-20251001' });
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers).toMatchObject({ 'x-api-key': 'KEY', 'anthropic-version': '2023-06-01' });
    expect(JSON.parse(call.body)).toEqual({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000, system: '시스템', messages: [{ role: 'user', content: '본문' }],
    });
  });
});

describe('extractAiText — 업체 응답에서 텍스트만', () => {
  it('Gemini: 생각(thought) 파트를 빼고 텍스트 파트를 합친다', () => {
    const data = { candidates: [{ content: { parts: [{ text: '가' }, { text: '비밀 사고', thought: true }, { text: '나' }] } }], usageMetadata: {} };
    expect(extractAiText('gemini', data)).toBe('가나');
  });

  it('Claude: 텍스트 블록만 합친다', () => {
    expect(extractAiText('claude', { content: [{ type: 'text', text: '가' }, { type: 'tool_use' }, { type: 'text', text: '나' }] })).toBe('가나');
  });

  it.each([
    ['gemini', {}], ['gemini', null], ['gemini', 'text'], ['gemini', { candidates: [] }], ['gemini', { candidates: [{ content: { parts: [{ text: 42 }] } }] }],
    ['gemini', { candidates: [{ content: { parts: [{ text: '' }] } }] }],
    ['claude', {}], ['claude', null], ['claude', []], ['claude', { content: [{ type: 'text', text: 5 }] }], ['claude', { content: [] }],
  ])('%s: 기대한 모양이 아니면 null이다(원본을 돌려주지 않는다) — %j', (provider, data) => {
    expect(extractAiText(provider, data)).toBeNull();
  });
});

describe('describeAiFailure — 업스트림 내용 없이 안내', () => {
  it.each([
    [new AiHttpError('timeout'), '시간이 초과'],
    [new AiHttpError('network'), '연결하지 못했습니다'],
    [new AiHttpError('status', 401), 'API 키가 올바르지 않거나'],
    [new AiHttpError('status', 403), 'API 키가 올바르지 않거나'],
    [new AiHttpError('status', 429), '요청 한도를 초과'],
    [new AiHttpError('status', 500), '오류가 발생했습니다'],
    [new AiHttpError('shape'), '오류가 발생했습니다'],
    [new AiHttpError('size'), '오류가 발생했습니다'],
    [new Error('SECRET upstream detail'), '오류가 발생했습니다'],
  ])('%j', (error, expected) => {
    const message = describeAiFailure(error);
    expect(message).toContain(expected);
    expect(message).not.toContain('SECRET');
  });
});

// ---------------------------------------------------------------------------
// net.request를 흉내 낸 가짜. 스크립트가 end() 시점에 응답 이벤트를 만든다.
function fakeNet(script) {
  const requests = [];
  return {
    requests,
    request: vi.fn((options) => {
      const req = new EventEmitter();
      req.options = options;
      req.headers = {};
      req.setHeader = vi.fn((key, value) => { req.headers[key] = value; });
      req.write = vi.fn();
      req.abort = vi.fn();
      req.end = vi.fn(() => script && script(req));
      requests.push(req);
      return req;
    }),
  };
}
function respond(req, { statusCode = 200, headers = {}, chunks = [], endAfter = true } = {}) {
  const response = new EventEmitter();
  response.statusCode = statusCode;
  response.headers = headers;
  req.emit('response', response);
  for (const chunk of chunks) response.emit('data', Buffer.from(chunk));
  if (endAfter) response.emit('end');
  return response;
}
const CALL = { url: 'https://api.example/v1', headers: { 'x-key': 'K', 'Content-Type': 'application/json' }, body: '{"a":1}' };

describe('postJsonViaNet', () => {
  afterEach(() => vi.useRealTimers());

  it('POST로 헤더·본문을 보내고 JSON 응답을 돌려준다', async () => {
    const net = fakeNet((req) => respond(req, { chunks: ['{"text"', ':"안녕"}'] }));
    await expect(postJsonViaNet(net, CALL)).resolves.toEqual({ text: '안녕' });
    const [req] = net.requests;
    expect(req.options).toEqual({ url: CALL.url, method: 'POST' });
    expect(req.headers).toEqual({ 'x-key': 'K', 'Content-Type': 'application/json' });
    expect(req.write).toHaveBeenCalledWith('{"a":1}');
    expect(req.end).toHaveBeenCalledOnce();
  });

  it('400 이상은 본문을 읽지 않고 상태 코드만으로 실패하며 요청을 중단한다(업스트림 메시지 비노출)', async () => {
    const net = fakeNet((req) => respond(req, { statusCode: 401, chunks: ['{"error":{"message":"SECRET-UPSTREAM"}}'] }));
    const error = await postJsonViaNet(net, CALL).catch((e) => e);
    expect(error).toBeInstanceOf(AiHttpError);
    expect(error).toMatchObject({ kind: 'status', status: 401 });
    expect(error.message).not.toContain('SECRET');
    expect(net.requests[0].abort).toHaveBeenCalled();
  });

  it('Content-Length가 상한을 넘으면 읽기 전에 실패한다', async () => {
    const net = fakeNet((req) => respond(req, { headers: { 'content-length': String(1024 * 1024 + 1) }, chunks: ['{}'] }));
    await expect(postJsonViaNet(net, CALL)).rejects.toMatchObject({ kind: 'size' });
    expect(net.requests[0].abort).toHaveBeenCalled();
  });

  it('응답이 상한(1MB)을 넘으면 중단하고 실패한다', async () => {
    const big = 'x'.repeat(600 * 1024);
    const net = fakeNet((req) => respond(req, { chunks: [big, big, '{"never":true}'] }));
    await expect(postJsonViaNet(net, CALL)).rejects.toMatchObject({ kind: 'size' });
    expect(net.requests[0].abort).toHaveBeenCalled();
  });

  it('상한을 직접 지정할 수 있다', async () => {
    const net = fakeNet((req) => respond(req, { chunks: ['{"a":"0123456789"}'] }));
    await expect(postJsonViaNet(net, CALL, { maxBytes: 5 })).rejects.toMatchObject({ kind: 'size' });
  });

  it('JSON이 아니면 shape 오류다', async () => {
    const net = fakeNet((req) => respond(req, { chunks: ['<html>SECRET</html>'] }));
    const error = await postJsonViaNet(net, CALL).catch((e) => e);
    expect(error).toMatchObject({ kind: 'shape' });
    expect(error.message).not.toContain('SECRET');
  });

  it('요청 오류는 네트워크 오류로만 알리고 원래 메시지를 싣지 않는다', async () => {
    const net = fakeNet((req) => req.emit('error', new Error('net::ERR_NAME_NOT_RESOLVED SECRET-HOST')));
    const error = await postJsonViaNet(net, CALL).catch((e) => e);
    expect(error).toMatchObject({ kind: 'network' });
    expect(error.message).not.toContain('SECRET');
  });

  it('응답 스트림 오류도 네트워크 오류다', async () => {
    const net = fakeNet((req) => respond(req, { endAfter: false }).emit('error', new Error('reset')));
    await expect(postJsonViaNet(net, CALL)).rejects.toMatchObject({ kind: 'network' });
  });

  it('제한 시간(기본 60초)이 지나면 중단하고 timeout으로 실패하며, 늦게 온 응답은 무시한다', async () => {
    vi.useFakeTimers();
    let lateRequest;
    const net = fakeNet((req) => { lateRequest = req; });
    const pending = postJsonViaNet(net, CALL);
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(lateRequest.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(lateRequest.abort).toHaveBeenCalledOnce();
    expect(() => respond(lateRequest, { chunks: ['{"late":true}'] })).not.toThrow();
  });

  it('성공하면 제한 시간 타이머를 정리한다', async () => {
    vi.useFakeTimers();
    const net = fakeNet((req) => respond(req, { chunks: ['{}'] }));
    await postJsonViaNet(net, CALL);
    expect(vi.getTimerCount()).toBe(0);
  });
});
