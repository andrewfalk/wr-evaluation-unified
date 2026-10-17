import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { AiAnalysisRequestSchema, AiAnalysisExternalRequestSchema, type AiAnalysisRequest } from '@wr/contracts/aiAnalysis';
import { buildPrompt, buildInternalPrompt, UNIFIED_AI_SYSTEM_PROMPT } from '@wr/contracts/aiPrompt';
import config from '../config';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { auditMiddleware } from '../middleware/audit';
import { analyzeRateLimit } from '../middleware/rateLimit';

// 업스트림 응답 본문 상한. AI 답변은 수 KB~수십 KB라 1MB면 충분하고, 그 이상은 비정상 응답으로 본다.
const MAX_UPSTREAM_RESPONSE_BYTES = 1024 * 1024;

type UpstreamFailure = 'status' | 'shape' | 'timeout' | 'size' | 'network';

// 업스트림 실패 사유. message에 업스트림 내용을 싣지 않는다 — 클라이언트로 나가는 응답과 로그 모두 kind/status만 쓴다.
class UpstreamError extends Error {
  constructor(readonly kind: UpstreamFailure, readonly status?: number) {
    super(`AI upstream failure: ${kind}`);
  }
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

// ---------------------------------------------------------------------------
// POST /api/ai/analyze
// 클라이언트가 보내는 것은 검증을 통과한 구조화 입력(input)뿐이다. 프롬프트와 시스템 프롬프트는 서버가
// @wr/contracts의 빌더로 직접 조립하므로 임의 문자열이 AI 벤더로 전달될 경로가 없다.
//  - internal(병원 내부 LLM): input + (선택) 현행 보고서 전문(fullReport)
//  - external(승인된 외부 벤더): input만. fullReport 필드가 있으면 스키마에서 400
// Returns { text: string } on success.
// ---------------------------------------------------------------------------
async function analyzeHandler(req: Request, res: Response): Promise<void> {
  if (!config.ai.enabled) {
    res.status(403).json({ error: { message: 'AI is not enabled on this server.' } });
    return;
  }

  const isInternal = config.ai.provider === 'internal';
  const parsed = (isInternal ? AiAnalysisRequestSchema : AiAnalysisExternalRequestSchema).safeParse(req.body);
  if (!parsed.success) {
    // 요청 값(received)은 메아리치지 않는다 — 경로와 오류 코드만.
    const details = parsed.error.issues.slice(0, 20).map((issue) => ({ path: issue.path.join('.'), code: issue.code }));
    res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid request body', details } });
    return;
  }

  try {
    // Always use the server-configured model — the client's model name is meaningless to the local
    // Ollama/vLLM instance, and the approved external vendor contract may restrict permitted models.
    const { input } = parsed.data;
    if (isInternal) {
      // 외부용 스키마에는 fullReport 필드 자체가 없다 — 보고서 전문은 이 분기(내부 LLM)로만 들어온다.
      const { fullReport } = parsed.data as AiAnalysisRequest;
      const text = await callInternalLLM({ prompt: buildInternalPrompt(input, fullReport), model: config.ai.internalModel });
      res.status(200).json({ text });
      return;
    }

    // external — approval flags already verified by resolveAiEnabled() at startup.
    const text = await callExternalLLM({ prompt: buildPrompt(input), model: config.ai.externalModel });
    res.status(200).json({ text });
  } catch (err) {
    respondUpstreamError(res, err);
  }
}

function respondUpstreamError(res: Response, err: unknown): void {
  const failure = err instanceof UpstreamError ? err : new UpstreamError('network');
  // 업스트림 메시지·본문은 기록하지 않는다(프롬프트·환자 요약이 섞일 수 있다).
  console.error('[ai] upstream failure', { kind: failure.kind, status: failure.status });
  if (failure.kind === 'timeout') {
    res.status(504).json({ error: { code: 'AI_TIMEOUT', message: 'AI 서버 응답 시간 초과' } });
    return;
  }
  res.status(502).json({ error: { code: 'AI_UPSTREAM_ERROR', message: 'AI 서버 응답 오류' } });
}

// ---------------------------------------------------------------------------
// 업스트림 호출 공통: 타임아웃 + 응답 크기 상한 + JSON 파싱. 실패는 UpstreamError로만 올린다.
// ---------------------------------------------------------------------------
async function readLimitedText(response: globalThis.Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new UpstreamError('size');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
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

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Record<string, unknown>> {
  let response: globalThis.Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.ai.timeoutMs),
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
    const data: unknown = JSON.parse(text);
    if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new UpstreamError('shape');
}

// ---------------------------------------------------------------------------
// Internal LLM (Ollama-compatible: POST /api/generate)
// ---------------------------------------------------------------------------
async function callInternalLLM({ prompt, model }: { prompt: string; model: string }): Promise<string> {
  const url = `${config.ai.internalEndpoint.replace(/\/$/, '')}/api/generate`;
  const data = await postJson(url, {}, { model, prompt, system: UNIFIED_AI_SYSTEM_PROMPT, stream: false });
  // 기대한 모양이 아니면 업스트림 본문을 그대로 돌려주지 않고 실패로 처리한다.
  if (typeof data['response'] !== 'string') throw new UpstreamError('shape');
  return data['response'];
}

// ---------------------------------------------------------------------------
// External vendor (OpenAI-compatible chat completions endpoint)
// ---------------------------------------------------------------------------
async function callExternalLLM({ prompt, model }: { prompt: string; model: string }): Promise<string> {
  const url = `${config.ai.externalEndpoint.replace(/\/$/, '')}/chat/completions`;
  const messages = [
    { role: 'system', content: UNIFIED_AI_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];
  const data = await postJson(url, { Authorization: `Bearer ${config.ai.externalApiKey}` }, { model, messages });
  const choices = Array.isArray(data['choices']) ? data['choices'] : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.['message'] as Record<string, unknown> | undefined;
  if (typeof message?.['content'] !== 'string') throw new UpstreamError('shape');
  return message['content'];
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
export function createAIRouter(pool: Pool): Router {
  const router = Router();
  const requireAuth = createAuthMiddleware(pool);

  router.post(
    '/analyze',
    requireAuth,
    csrfMiddleware,
    analyzeRateLimit(), // 사용자당 분당 20회. 외부 벤더 비용·내부 LLM 부하를 제한한다(keyGenerator가 sessionInfo를 쓰므로 인증 뒤).
    auditMiddleware(pool, 'ai_analyze', 'ai'),
    (req: Request, res: Response) => {
      analyzeHandler(req, res).catch((err: unknown) => {
        console.error('[ai] unexpected error', err instanceof Error ? err.name : typeof err);
        if (!res.headersSent) res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
      });
    }
  );

  return router;
}
