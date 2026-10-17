// 독립형(Electron) AI 호출의 순수 부분 — IPC 봉투 검증, 업체별 요청 조립, 응답 해석, 오류 문구.
// main.js의 'analyze-ai' 핸들러는 이 모듈만 거쳐 외부 벤더(Gemini/Claude)를 부른다.
//
// 렌더러가 보내는 것은 { input, model?, apiKey } 뿐이다. 프롬프트와 시스템 프롬프트는 여기서 @wr/contracts의
// 빌더로 직접 조립하므로 임의 문자열이 벤더로 전달될 경로가 없고, 모델명은 허용 목록으로 검증한 뒤 URL에 넣는다.
// 업스트림 오류 메시지·본문은 렌더러로 돌려주지 않는다(상태 코드로만 안내).
//
// 계약(shared/dist/*.cjs)은 처음 쓸 때 불러온다 — 인트라넷 셸은 이 핸들러를 등록하지 않으므로 계약 파일 없이도 시작해야 한다.

const MAX_API_KEY_LENGTH = 512;
const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;

let cachedContracts = null;
function contracts() {
  if (!cachedContracts) {
    cachedContracts = {
      models: require('../shared/dist/aiModels.cjs'),
      analysis: require('../shared/dist/aiAnalysis.cjs'),
      prompt: require('../shared/dist/aiPrompt.cjs'),
    };
  }
  return cachedContracts;
}

/** 업스트림 호출 실패. message에 업스트림 내용을 싣지 않는다 — kind/status만 있다. */
class AiHttpError extends Error {
  constructor(kind, status) {
    super(`AI upstream failure: ${kind}`);
    this.kind = kind; // 'status' | 'shape' | 'timeout' | 'size' | 'network'
    this.status = status;
  }
}

const providerLabel = (provider) => (provider === 'gemini' ? 'Gemini' : 'Claude');
const fail = (message) => ({ ok: false, message });

/**
 * IPC 봉투 { apiKey, input, model? } → 검증된 호출 정보.
 * apiKey는 봉투에서 먼저 떼어 따로 검사한다 — 봉투째 strict 스키마에 넣으면 정상 요청도 거부된다.
 */
function parseAnalyzeEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return fail('AI 분석 요청 형식이 올바르지 않습니다.');
  const { apiKey, ...request } = envelope;
  const { models, analysis, prompt } = contracts();

  // 옛 형식({ prompt, systemPrompt })과 fullReport는 strict 스키마가 거부한다.
  const parsed = analysis.AiAnalysisExternalRequestSchema.safeParse(request);
  if (!parsed.success) return fail('AI 분석 요청 형식이 올바르지 않습니다.');

  const model = parsed.data.model ?? models.DEFAULT_CLAUDE_MODEL;
  if (!models.isAllowedModel(model)) return fail('허용되지 않은 모델입니다.');
  const provider = model.startsWith('gemini') ? 'gemini' : 'claude';

  if (typeof apiKey !== 'string' || apiKey.trim() === '') {
    return fail(`API 키가 설정되지 않았습니다. 설정에서 ${providerLabel(provider)} API 키를 입력하세요.`);
  }
  // 헤더로 들어가는 값이다 — 길이 상한과 공백·제어문자(헤더 주입)를 막는다.
  const hasUnsafeChar = [...apiKey].some((ch) => ch <= ' ' || ch === '\u007f'); // 공백·제어문자
  if (apiKey.length > MAX_API_KEY_LENGTH || hasUnsafeChar) {
    return fail('API 키 형식이 올바르지 않습니다. 설정에서 다시 입력하세요.');
  }

  return {
    ok: true,
    provider,
    model,
    apiKey,
    prompt: prompt.buildPrompt(parsed.data.input),
    systemPrompt: prompt.UNIFIED_AI_SYSTEM_PROMPT,
  };
}

function buildClaudeCall({ model, prompt, systemPrompt, apiKey }) {
  return {
    url: 'https://api.anthropic.com/v1/messages',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model,
      max_tokens: contracts().models.CLAUDE_MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    }),
  };
}

function buildGeminiCall({ model, prompt, systemPrompt, apiKey }) {
  const { GEMINI_MAX_OUTPUT_TOKENS } = contracts().models;
  return {
    // 모델명은 허용 목록을 통과한 값이지만 URL 경로에 들어가므로 한 번 더 인코딩한다.
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: model.includes('pro') ? GEMINI_MAX_OUTPUT_TOKENS.pro : GEMINI_MAX_OUTPUT_TOKENS.flash },
    }),
  };
}

/** 업체 응답에서 텍스트만 꺼낸다. 기대한 모양이 아니면 null(원본을 돌려주지 않는다). */
function extractAiText(provider, data) {
  if (!data || typeof data !== 'object') return null;
  if (provider === 'gemini') {
    const parts = Array.isArray(data.candidates?.[0]?.content?.parts) ? data.candidates[0].content.parts : [];
    return parts.filter((p) => p && typeof p.text === 'string' && p.thought !== true).map((p) => p.text).join('') || null;
  }
  const blocks = Array.isArray(data.content) ? data.content : [];
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') || null;
}

/** 렌더러에 보여 줄 문구. 업스트림 메시지는 쓰지 않고 실패 종류·상태 코드로만 안내한다. */
function describeAiFailure(error) {
  if (error instanceof AiHttpError) {
    if (error.kind === 'timeout') return 'AI 서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.';
    if (error.kind === 'network') return 'AI 서버에 연결하지 못했습니다. 네트워크 연결을 확인하세요.';
    if (error.kind === 'status') {
      if (error.status === 401 || error.status === 403) return 'API 키가 올바르지 않거나 권한이 없습니다. 설정에서 API 키를 확인하세요.';
      if (error.status === 429) return '요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.';
    }
  }
  return 'AI 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.';
}

/**
 * Electron net 모듈(Chromium 네트워크 스택 — 시스템 인증서 저장소를 신뢰하므로 회사 프록시의 SSL Inspection 인증서도
 * 통과)로 JSON을 POST한다. 제한 시간·응답 크기 상한이 있고, 실패는 AiHttpError로만 올린다. net은 주입받는다(테스트용).
 */
function postJsonViaNet(net, { url, headers, body }, { timeoutMs = UPSTREAM_TIMEOUT_MS, maxBytes = MAX_UPSTREAM_RESPONSE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const request = net.request({ url, method: 'POST' });
    const abort = () => { try { request.abort(); } catch { /* 이미 종료됨 */ } };
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const failWith = (kind, status) => { finish(reject, new AiHttpError(kind, status)); abort(); };

    timer = setTimeout(() => failWith('timeout'), timeoutMs);
    for (const [key, value] of Object.entries(headers || {})) request.setHeader(key, value);

    request.on('response', (response) => {
      if (response.statusCode >= 400) { failWith('status', response.statusCode); return; } // 본문은 읽지 않는다
      const declared = Number(response.headers?.['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) { failWith('size'); return; }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) { failWith('size'); return; }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        try {
          finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch {
          finish(reject, new AiHttpError('shape'));
        }
      });
      response.on('error', () => failWith('network'));
    });
    request.on('error', () => failWith('network'));
    request.write(body);
    request.end();
  });
}

module.exports = {
  AiHttpError,
  parseAnalyzeEnvelope,
  buildClaudeCall,
  buildGeminiCall,
  extractAiText,
  describeAiFailure,
  postJsonViaNet,
};
