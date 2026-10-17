// 통합 평가 시스템 - AI 분석 API Route (웹/Vercel)
// Claude / Gemini API 프록시 (API 키를 서버에서 안전하게 관리)
//
// 이 엔드포인트는 인증된 사용자 없이 공개로 호출된다. 따라서 모든 단계가 "열어 두지 않는" 방향이다:
//  1) Origin 허용 목록(브라우저 남용 차단) → 2) 클라이언트 토큰(봇·스캐너 필터; 번들에 들어가므로 비밀이 아님)
//  → 3) Upstash 속도 제한(IP 분·일 + 전역 일일 예산) → 4) 구조화 입력 스키마 → 5) 모델 허용 목록
//  → 6) 서버가 프롬프트를 직접 조립 → 7) 제한 시간·크기 상한이 있는 업스트림 호출 → { text }만 응답.
// 필요한 설정(토큰·Upstash)이 없으면 열어 두지 않고 503으로 닫는다(fail-closed).
// 클라이언트가 보낸 임의 prompt/systemPrompt는 받지 않는다(스키마가 거부) — 외부 벤더에는 비식별 구조화 값으로
// 서버가 만든 프롬프트만 전달된다. 운영 설정은 docs/VERCEL_AI_PROXY_HARDENING.md 참고.

import { timingSafeEqual } from 'node:crypto';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
// 계약은 반드시 CJS 빌드(.cjs)로 가져온다. 루트 package.json에 "type"이 없어 Vercel이 이 파일을 CommonJS로
// 변환하는데, 그러면 import가 require()가 되고 shared/package.json이 "type":"module"이라 ESM인 dist/*.js를
// require()하게 된다. require(esm)을 지원하지 않는 Node(20.19·22.12 미만)에서는 ERR_REQUIRE_ESM으로 함수 로드가
// 실패한다(FUNCTION_INVOCATION_FAILED). 회귀 테스트: scripts/__tests__/vercelAnalyzeCjsLoad.test.mjs.
import {
    isAllowedModel,
    DEFAULT_CLAUDE_MODEL,
    CLAUDE_MAX_TOKENS,
    GEMINI_MAX_OUTPUT_TOKENS,
} from '../shared/dist/aiModels.cjs';
import { AiAnalysisExternalRequestSchema } from '../shared/dist/aiAnalysis.cjs';
import { buildPrompt, UNIFIED_AI_SYSTEM_PROMPT } from '../shared/dist/aiPrompt.cjs';

const UPSTREAM_TIMEOUT_MS = 60_000;
const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_DAILY_BUDGET = 2000;

class UpstreamError extends Error {
    constructor(kind, status) {
        super(`AI upstream failure: ${kind}`);
        this.kind = kind; // 'status' | 'shape' | 'timeout' | 'size' | 'network'
        this.status = status;
    }
}

const isTimeout = (err) => err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');

function allowedOrigins(env) {
    const origins = [];
    // 로컬 개발 주소는 production 배포에서는 허용하지 않는다.
    if (env.VERCEL_ENV !== 'production') origins.push('http://localhost:3000', 'http://127.0.0.1:3000');
    if (env.APP_ORIGIN) origins.push(env.APP_ORIGIN.replace(/\/$/, ''));
    // Vercel이 주는 배포 도메인(커스텀 도메인은 APP_ORIGIN으로 추가한다).
    for (const host of [env.VERCEL_URL, env.VERCEL_BRANCH_URL, env.VERCEL_PROJECT_PRODUCTION_URL]) {
        if (host) origins.push(`https://${host}`);
    }
    return origins;
}

function tokenMatches(provided, expected) {
    const a = Buffer.from(String(provided || ''));
    const b = Buffer.from(String(expected));
    return a.length === b.length && timingSafeEqual(a, b);
}

function clientIp(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    return String(req.headers['x-real-ip'] || forwarded || req.socket?.remoteAddress || 'unknown');
}

function send(res, status, error, extraHeaders = {}) {
    for (const [key, value] of Object.entries(extraHeaders)) res.setHeader(key, value);
    return res.status(status).json({ error });
}

// ---------------------------------------------------------------------------
// 속도 제한 (Upstash Redis). 분당 IP 10 · 일당 IP 100 · 전역 일일 예산(WEB_AI_DAILY_BUDGET).
// Redis에 닿지 못해도 열어 두지 않는다(호출 비용 남용을 막는 것이 목적이므로 fail-closed).
// ---------------------------------------------------------------------------

// 한 번의 제한 확인을 기다리는 최대 시간. Redis가 응답하지 않으면 첫 확인에서 바로 503으로 닫는다.
// (라이브러리 기본값 5초 × 세 번 = 15초를 기다린 뒤 통과하던 것을 2초로 줄인다.)
const LIMITER_TIMEOUT_MS = 2000;

class RateLimitUnavailableError extends Error {
    constructor(reason) {
        super(`rate limit unavailable: ${reason}`);
        this.reason = reason;
    }
}

async function checkRateLimit(env, ip) {
    const url = env.UPSTASH_REDIS_REST_URL;
    const token = env.UPSTASH_REDIS_REST_TOKEN;
    if (!url || !token) return { configured: false };

    const redis = new Redis({ url, token });
    const budget = Number.parseInt(env.WEB_AI_DAILY_BUDGET, 10) || DEFAULT_DAILY_BUDGET;
    const make = (limiter, prefix) => new Ratelimit({ redis, limiter, prefix, timeout: LIMITER_TIMEOUT_MS });
    const checks = [
        [make(Ratelimit.slidingWindow(10, '1 m'), 'wr-ai:ip-min'), ip],
        [make(Ratelimit.slidingWindow(100, '1 d'), 'wr-ai:ip-day'), ip],
        [make(Ratelimit.fixedWindow(budget, '1 d'), 'wr-ai:budget'), 'global'],
    ];
    // 순서대로 확인해 앞 단계에서 거절된 요청이 전역 예산을 소모하지 않게 한다.
    for (const [limiter, key] of checks) {
        const result = await limiter.limit(key);
        // Upstash는 Redis가 시간 안에 응답하지 않으면 예외를 던지지 않고 { success: true, reason: 'timeout' }을 돌려준다.
        // success만 보면 한도를 확인하지 못한 채 통과(fail-open)하므로, 시간 초과와 예상 밖의 응답 형태는 장애로 취급한다.
        if (!result || result.reason === 'timeout' || typeof result.success !== 'boolean') {
            throw new RateLimitUnavailableError(result?.reason ?? 'malformed');
        }
        if (!result.success) {
            return { configured: true, allowed: false, retryAfterSec: Math.max(1, Math.ceil((result.reset - Date.now()) / 1000)) };
        }
    }
    return { configured: true, allowed: true };
}

// ---------------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------------
export default async function handler(req, res) {
    const env = process.env;
    const origins = allowedOrigins(env);
    const origin = String(req.headers.origin || '');
    const originAllowed = origins.includes(origin);

    res.setHeader('Cache-Control', 'no-store');
    if (originAllowed) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-WR-User-Id, X-WR-Org-Id, X-WR-Auth-Mode, X-WR-Client');
    }

    if (req.method === 'OPTIONS') {
        // 허용된 Origin의 사전 요청만 통과시킨다.
        return originAllowed ? res.status(204).end() : res.status(403).end();
    }

    if (req.method !== 'POST') {
        return send(res, 405, { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed. Use POST.' }, { Allow: 'POST, OPTIONS' });
    }

    // 1) Origin — 브라우저 발신 요청은 항상 Origin을 보낸다(같은 출처 POST 포함). 없거나 허용 목록 밖이면 거부.
    if (!originAllowed) {
        return send(res, 403, { code: 'ORIGIN_NOT_ALLOWED', message: '허용되지 않은 출처의 요청입니다.' });
    }

    // 2) 클라이언트 토큰 — 번들에 포함되므로 비밀이 아니다. 봇·스캐너를 걸러 내는 필터일 뿐이다.
    const clientToken = env.WEB_AI_CLIENT_TOKEN;
    if (!clientToken) {
        return send(res, 503, { code: 'AI_PROXY_NOT_CONFIGURED', message: 'AI 분석이 설정되지 않았습니다. 관리자에게 문의하세요.' });
    }
    if (!tokenMatches(req.headers['x-wr-client'], clientToken)) {
        return send(res, 403, { code: 'CLIENT_NOT_ALLOWED', message: '허용되지 않은 클라이언트입니다.' });
    }

    // 3) 속도 제한
    let limit;
    try {
        limit = await checkRateLimit(env, clientIp(req));
    } catch (err) {
        console.error('[ai] rate limit backend failure', err instanceof RateLimitUnavailableError ? err.reason : err instanceof Error ? err.name : typeof err);
        return send(res, 503, { code: 'RATE_LIMIT_UNAVAILABLE', message: 'AI 분석을 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.' });
    }
    if (!limit.configured) {
        return send(res, 503, { code: 'RATE_LIMIT_UNAVAILABLE', message: 'AI 분석이 설정되지 않았습니다. 관리자에게 문의하세요.' });
    }
    if (!limit.allowed) {
        return send(res, 429, { code: 'RATE_LIMITED', message: '요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.' }, { 'Retry-After': String(limit.retryAfterSec) });
    }

    // 4) 요청 본문 — fullReport·prompt 같은 키는 스키마가 거부한다. 입력 값은 응답에 메아리치지 않는다.
    const parsed = AiAnalysisExternalRequestSchema.safeParse(req.body);
    if (!parsed.success) {
        const details = parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
        return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: '요청 형식이 올바르지 않습니다.', details } });
    }

    // 5) 모델 허용 목록 — 임의 모델명은 고가 모델 호출(비용)과 업스트림 URL 경로 조작에 쓰일 수 있다.
    const { input, model } = parsed.data;
    if (model !== undefined && !isAllowedModel(model)) {
        return send(res, 400, { code: 'MODEL_NOT_ALLOWED', message: '허용되지 않은 모델입니다.' });
    }
    const resolvedModel = model ?? DEFAULT_CLAUDE_MODEL;
    const provider = resolvedModel.startsWith('gemini') ? 'gemini' : 'claude';
    const apiKey = provider === 'gemini' ? env.GEMINI_API_KEY : env.CLAUDE_API_KEY;
    if (!apiKey) {
        return send(res, 503, { code: 'AI_NOT_CONFIGURED', message: 'AI 분석이 설정되지 않았습니다. 관리자에게 문의하세요.' });
    }

    // 6~7) 서버가 조립한 프롬프트로 업스트림 호출
    try {
        const prompt = buildPrompt(input);
        const text = provider === 'gemini'
            ? await callGemini({ model: resolvedModel, prompt, apiKey })
            : await callClaude({ model: resolvedModel, prompt, apiKey });
        return res.status(200).json({ text });
    } catch (err) {
        return respondUpstreamError(res, provider, err);
    }
}

function respondUpstreamError(res, provider, err) {
    const failure = err instanceof UpstreamError ? err : new UpstreamError('network');
    // 업스트림 메시지·본문은 기록하지도, 돌려주지도 않는다(요청 요약이 섞일 수 있다).
    console.error('[ai] upstream failure', { provider, kind: failure.kind, status: failure.status });
    if (failure.kind === 'timeout') {
        return send(res, 504, { code: 'AI_TIMEOUT', message: 'AI 서버 응답 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.' });
    }
    if (failure.kind === 'status' && failure.status === 429) {
        return send(res, 429, { code: 'AI_UPSTREAM_RATE_LIMITED', message: '요청 한도를 초과했습니다. 잠시 후 다시 시도해주세요.' });
    }
    return send(res, 502, { code: 'AI_UPSTREAM_ERROR', message: 'AI 분석 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' });
}

// ---------------------------------------------------------------------------
// 업스트림 호출 공통: 제한 시간 + 응답 크기 상한 + JSON 파싱. 실패는 UpstreamError로만 올린다.
// ---------------------------------------------------------------------------
async function readLimitedText(response) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamError('size');
    }
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > MAX_UPSTREAM_RESPONSE_BYTES) {
                await reader.cancel().catch(() => undefined);
                throw new UpstreamError('size');
            }
            chunks.push(value);
        }
    } catch (err) {
        if (err instanceof UpstreamError) throw err;
        throw new UpstreamError(isTimeout(err) ? 'timeout' : 'network');
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function postJson(url, headers, body) {
    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
    } catch (err) {
        throw new UpstreamError(isTimeout(err) ? 'timeout' : 'network');
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new UpstreamError('status', response.status);
    }
    const text = await readLimitedText(response);
    try {
        const data = JSON.parse(text);
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
    } catch {
        // fall through
    }
    throw new UpstreamError('shape');
}

async function callClaude({ model, prompt, apiKey }) {
    const data = await postJson(
        'https://api.anthropic.com/v1/messages',
        { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        {
            model,
            max_tokens: CLAUDE_MAX_TOKENS,
            system: UNIFIED_AI_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: prompt }],
        },
    );
    const blocks = Array.isArray(data.content) ? data.content : [];
    const text = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
    if (!text) throw new UpstreamError('shape');
    return text;
}

async function callGemini({ model, prompt, apiKey }) {
    const isPro = model.includes('pro');
    const data = await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { 'x-goog-api-key': apiKey },
        {
            system_instruction: { parts: [{ text: UNIFIED_AI_SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { maxOutputTokens: isPro ? GEMINI_MAX_OUTPUT_TOKENS.pro : GEMINI_MAX_OUTPUT_TOKENS.flash },
        },
    );
    const parts = Array.isArray(data.candidates?.[0]?.content?.parts) ? data.candidates[0].content.parts : [];
    const text = parts.filter((p) => p && typeof p.text === 'string' && p.thought !== true).map((p) => p.text).join('');
    if (!text) throw new UpstreamError('shape');
    return text;
}
