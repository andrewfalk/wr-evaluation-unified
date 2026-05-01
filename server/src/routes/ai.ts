import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import config from '../config';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { auditMiddleware } from '../middleware/audit';

const AnalyzeBody = z.object({
  prompt:       z.string().min(1),
  systemPrompt: z.string().optional(),
  model:        z.string().optional(),
});

// ---------------------------------------------------------------------------
// POST /api/ai/analyze
// Proxies to the configured AI backend (internal LLM or approved external vendor).
// Returns { text: string } on success.
// ---------------------------------------------------------------------------
async function analyzeHandler(req: Request, res: Response): Promise<void> {
  if (!config.ai.enabled) {
    res.status(403).json({ error: { message: 'AI is not enabled on this server.' } });
    return;
  }

  const parsed = AnalyzeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request body', details: parsed.error.errors } });
    return;
  }

  const { prompt, systemPrompt, model } = parsed.data;

  try {
    if (config.ai.provider === 'internal') {
      // Always use the server-configured model — the client's model name
      // (e.g. 'gemini-2.5-flash') is meaningless to the local Ollama/vLLM instance.
      const text = await callInternalLLM({ prompt, systemPrompt, model: config.ai.internalModel });
      res.status(200).json({ text });
      return;
    }

    // external — approval flags already verified by resolveAiEnabled() at startup.
    // Use server-configured model to enforce the approved vendor contract.
    const text = await callExternalLLM({ prompt, systemPrompt, model: config.ai.externalModel });
    res.status(200).json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI backend error';
    res.status(502).json({ error: { message } });
  }
}

// ---------------------------------------------------------------------------
// Internal LLM (Ollama-compatible: POST /api/generate)
// ---------------------------------------------------------------------------
async function callInternalLLM({
  prompt,
  systemPrompt,
  model,
}: {
  prompt: string;
  systemPrompt?: string;
  model: string;
}): Promise<string> {
  const url = `${config.ai.internalEndpoint.replace(/\/$/, '')}/api/generate`;
  const body: Record<string, unknown> = { model, prompt, stream: false };
  if (systemPrompt) body['system'] = systemPrompt;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Internal LLM returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const text = typeof data['response'] === 'string' ? data['response'] : JSON.stringify(data);
  return text;
}

// ---------------------------------------------------------------------------
// External vendor (OpenAI-compatible chat completions endpoint)
// ---------------------------------------------------------------------------
async function callExternalLLM({
  prompt,
  systemPrompt,
  model,
}: {
  prompt: string;
  systemPrompt?: string;
  model: string;
}): Promise<string> {
  const url = `${config.ai.externalEndpoint.replace(/\/$/, '')}/chat/completions`;
  const messages: { role: string; content: string }[] = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.ai.externalApiKey}`,
    },
    body: JSON.stringify({ model, messages }),
  });

  if (!response.ok) {
    throw new Error(`External LLM returned ${response.status}`);
  }

  const data = (await response.json()) as Record<string, unknown>;
  const choices = Array.isArray(data['choices']) ? data['choices'] : [];
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.['message'] as Record<string, unknown> | undefined;
  const text = typeof message?.['content'] === 'string' ? message['content'] : JSON.stringify(data);
  return text;
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
    auditMiddleware(pool, 'ai_analyze', 'ai'),
    (req: Request, res: Response) => {
      analyzeHandler(req, res).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : 'Unexpected error';
        res.status(500).json({ error: { message } });
      });
    }
  );

  return router;
}
