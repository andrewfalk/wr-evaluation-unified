// Environment schema (REFACTORING_ROADMAP S2 / P1-09). Every variable the server reads is declared
// here once, with the same parsing rules and start-up error messages as the hand-written parser it
// replaced (frozen by __tests__/config.characterization.test.ts):
//   text(fallback)    env || fallback            (empty string → fallback)
//   requiredText()    non-empty, else "Missing required env var: KEY"
//   flag(fallback)    unset → fallback; otherwise only 'true' and '1' are true
//   positiveInt(n)    unset/empty → n; otherwise an integer ≥ 1, else "KEY must be a positive integer, got '…'"
//   oneOf(values, …)  env || fallback, must be one of values
// Rules that look at two variables (CORS required in production/intranet, the external-AI approval
// gate, LOG_LEVEL's default, TRUST_PROXY's default) run after the fields, in resolveEnv().
// config.ts turns the parsed values into the nested, frozen config object.
import { z } from 'zod';

export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type DeploymentMode = 'intranet' | 'standalone';
export type AiProvider = 'none' | 'internal' | 'external';
export type LockEnforcementMode = 'off' | 'observe' | 'enforce';
export type NodeEnv = 'development' | 'production' | 'test';

const raw = z.string().optional();

function keyOf(ctx: z.RefinementCtx): string {
  return String(ctx.path[ctx.path.length - 1]);
}

function fail(ctx: z.RefinementCtx, message: string): never {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message });
  return z.NEVER as never;
}

const text = (fallback: string) => raw.transform((v) => v || fallback);
const nullableText = () => raw.transform((v) => v || null);
const requiredText = () => raw.transform((v, ctx) => v || fail(ctx, `Missing required env var: ${keyOf(ctx)}`));
const flag = (fallback = false) => raw.transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const positiveInt = (fallback: number) => raw.transform((v, ctx) => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) return fail(ctx, `${keyOf(ctx)} must be a positive integer, got '${v}'`);
  return n;
});

function oneOf<T extends string>(values: readonly T[], fallback: T, message: (got: string) => string) {
  return raw.transform((v, ctx): T => {
    const value = v || fallback;
    return (values as readonly string[]).includes(value) ? (value as T) : fail(ctx, message(value));
  });
}

/** 'default' = not set: resolveEnv() picks 1 in intranet mode, false otherwise. */
const trustProxy = raw.transform((v, ctx): 'default' | boolean | number => {
  if (v === undefined || v === '') return 'default';
  if (v === 'true') return true;
  if (v === 'false') return false;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) return fail(ctx, "TRUST_PROXY must be 'true', 'false', or a non-negative integer");
  return n;
});

const detIntervalSec = raw.transform((v, ctx) => {
  const value = v || '0';
  const sec = Number(value);
  if (!Number.isFinite(sec) || sec < 0 || sec > 1.0) {
    return fail(ctx, `VIDEO_DET_INTERVAL_SEC must be a number in [0, 1.0] (0 disables), got '${value}'`);
  }
  return sec;
});

const corsOrigins = raw.transform((v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean));

// Field order = the order the hand-written parser checked them, so a single bad variable reports
// the same message. (With several bad variables at once the first reported one may differ.)
export const EnvSchema = z.object({
  DEPLOYMENT_MODE: oneOf(['intranet', 'standalone'] as const, 'standalone',
    (got) => `DEPLOYMENT_MODE must be 'intranet' or 'standalone', got '${got}'`),
  AI_PROVIDER: oneOf(['none', 'internal', 'external'] as const, 'none',
    (got) => `AI_PROVIDER must be 'none', 'internal', or 'external', got '${got}'`),
  AI_EXTERNAL_VENDOR_APPROVED: flag(),
  AI_DEIDENTIFY_REQUIRED: flag(),
  AI_EXTERNAL_ENDPOINT: text(''),
  AI_EXTERNAL_API_KEY: text(''),
  CORS_ORIGINS: corsOrigins,
  NODE_ENV: oneOf(['development', 'production', 'test'] as const, 'development',
    (got) => `NODE_ENV must be 'development', 'production', or 'test', got '${got}'`),
  LOG_LEVEL: raw, // default depends on NODE_ENV — resolveEnv()

  PORT: positiveInt(3001),
  DATABASE_URL: requiredText(),
  JSON_BODY_LIMIT: text('10mb'),
  TRUST_PROXY: trustProxy,
  ACCESS_TOKEN_SECRET: requiredText().transform((v, ctx) => (
    // HS256 key: at least 32 bytes (SEC-A L5). Generate with `openssl rand -hex 32` (64 characters).
    Buffer.byteLength(v, 'utf8') >= 32
      ? v
      : fail(ctx, 'ACCESS_TOKEN_SECRET must be at least 32 bytes (generate with: openssl rand -hex 32)')
  )),
  // REFRESH_TOKEN_SECRET is no longer read (refresh tokens are random values stored hashed, not JWTs);
  // a value left in an existing .env is ignored (SEC-A L5).
  ACCESS_TOKEN_TTL: positiveInt(15 * 60),
  REFRESH_TOKEN_TTL: positiveInt(7 * 24 * 60 * 60),

  AI_INTERNAL_ENDPOINT: text('http://localhost:11434'),
  AI_INTERNAL_MODEL: text('llama3'),
  AI_EXTERNAL_MODEL: text('gpt-4o'),
  AI_TIMEOUT_MS: positiveInt(60000),

  VIDEO_ANALYSIS_ENABLED: flag(),
  STATS_WORKBENCH_ENABLED: flag(),
  LOCK_ENFORCEMENT_MODE: oneOf(['off', 'observe', 'enforce'] as const, 'off',
    (got) => `LOCK_ENFORCEMENT_MODE must be 'off', 'observe', or 'enforce', got '${got}'`),

  VIDEO_ANALYSIS_SCRIPTS_DIR: nullableText(), // default is a path — config.ts
  VIDEO_ANALYSIS_RETENTION: oneOf(['privacy_first', 'review_fidelity'] as const, 'privacy_first',
    (got) => `VIDEO_ANALYSIS_RETENTION must be 'privacy_first' or 'review_fidelity', got '${got}'`),
  VIDEO_ANALYSIS_FIXTURE_MODE: flag(),
  VIDEO_ANALYSIS_FIXTURE_DIR: nullableText(),
  VIDEO_ANALYSIS_PYTHON: nullableText(),
  VIDEO_ANALYSIS_UPLOAD_DIR: nullableText(),
  VIDEO_ANALYSIS_MAX_UPLOAD_BYTES: positiveInt(2 * 1024 * 1024 * 1024),
  VIDEO_ANALYSIS_TARGET_THUMBNAIL: flag(),
  VIDEO_ANALYSIS_OVERLAY_FRAMES: flag(),
  VIDEO_ANALYSIS_CLIP_TTL_HOURS: positiveInt(24),
  VIDEO_ANALYSIS_ALLOW_UNVERIFIED_RECIPE: flag(),
  VIDEO_POSE_TIER: oneOf(['standard', 'auto'] as const, 'standard',
    (got) => `VIDEO_POSE_TIER must be 'standard' or 'auto' ('high' is dev CLI-only), got '${got}'`),
  VIDEO_DET_INTERVAL_SEC: detIntervalSec,
  VIDEO_ANALYSIS_JOB_DEADLINE_MS: positiveInt(600000),
  VIDEO_ANALYSIS_SWEEP_GRACE_MS: positiveInt(30000),
  VIDEO_ANALYSIS_QUEUE_WAIT_MS: positiveInt(600000),

  STATS_ENGINE_SCRIPTS_DIR: nullableText(),
  STATS_ENGINE_PYTHON: nullableText(),
  STATS_ENGINE_TIMEOUT_MS: positiveInt(30000),
  STATS_ENGINE_KILL_GRACE_MS: positiveInt(2000),
  STATS_ENGINE_MAX_CONCURRENCY: positiveInt(1),
  STATS_MAX_CONCURRENT_ANALYZE_REQUESTS: positiveInt(4),
  STATS_ENGINE_STDOUT_MAX_BYTES: positiveInt(10 * 1024 * 1024),
  STATS_ENGINE_STDERR_MAX_BYTES: positiveInt(64 * 1024),
  STATS_ENGINE_MAX_INPUT_BYTES: positiveInt(2 * 1024 * 1024),
  STATS_RUNS_RESULT_TTL_HOURS: positiveInt(24 * 7),
  STATS_ASYNC_SYNC_BUDGET_MS: positiveInt(4000),
  STATS_ASYNC_POLL_TICK_MS: positiveInt(120),
  STATS_ASYNC_SWEEP_INTERVAL_MS: positiveInt(2000),
  STATS_ASYNC_CLAIM_INTERVAL_MS: positiveInt(500),
  STATS_ASYNC_HEARTBEAT_INTERVAL_MS: positiveInt(5000),
  STATS_ASYNC_STALE_SAFETY_MS: positiveInt(5000),
  STATS_ASYNC_QUEUE_WAIT_MS: positiveInt(600000),
  STATS_ASYNC_MAX_JOB_TIMEOUT_MS: positiveInt(10 * 60 * 1000),
  STATS_ASYNC_MAX_HEARTBEAT_FAILURES: positiveInt(5),
  STATS_ASYNC_MAX_REQUEUE_COUNT: positiveInt(20),
  STATS_ASYNC_MAX_FINISH_PERSIST_RETRIES: positiveInt(3),
  STATS_ASYNC_MAX_CONCURRENT_PER_USER: positiveInt(2),
  STATS_ASYNC_MAX_CONCURRENT_PER_ORG: positiveInt(4),
  STATS_ASYNC_MAX_HOURLY_PER_USER: positiveInt(60),
  STATS_ASYNC_MAX_HOURLY_PER_ORG: positiveInt(200),

  // --- read directly from process.env before S2 (P1-10 moves those readers onto config) ---
  // P0-13 perf baseline flag: only '1' turns it on (not 'true').
  STATS_ENGINE_TIMING: raw.transform((v) => v === '1'),
  WR_GIT_COMMIT: text('unknown'),
  // `??`, not `||`: an empty BACKUPS_DIR stays empty, as in routes/opsStatus.ts before S2.
  BACKUPS_DIR: raw.transform((v) => v ?? '/backups'),
  UPDATES_DIR: text('/app/updates'),
  // Raw value (unset, empty or set) — db/auditClient.ts keeps its own unset/empty handling.
  AUDIT_DATABASE_URL: raw,
});

export type ParsedEnv = z.infer<typeof EnvSchema>;

export interface ResolvedEnv extends Omit<ParsedEnv, 'LOG_LEVEL' | 'TRUST_PROXY'> {
  LOG_LEVEL: LogLevel;
  TRUST_PROXY: boolean | number;
  aiEnabled: boolean;
}

/**
 * Parse and cross-check the environment. Throws `Error(message)` with the first problem — the
 * same messages the server has always printed when it refused to start.
 */
export function resolveEnv(env: NodeJS.ProcessEnv): ResolvedEnv {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) throw new Error(parsed.error.issues[0].message);
  const e = parsed.data;

  const logLevel = e.LOG_LEVEL || (e.NODE_ENV === 'test' ? 'silent' : 'info');
  if (!LOG_LEVELS.includes(logLevel as LogLevel)) {
    throw new Error(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got '${logLevel}'`);
  }

  // An empty allowlist in production would silently block every credentialed browser request
  // that carries an Origin header (login, CSRF, …).
  if (e.CORS_ORIGINS.length === 0 && (e.NODE_ENV === 'production' || e.DEPLOYMENT_MODE === 'intranet')) {
    throw new Error('CORS_ORIGINS must be set (e.g. https://wr.hospital.local:8443) in production or intranet mode');
  }

  // Caddy terminates TLS in intranet mode: trust exactly one proxy hop by default so req.ip and
  // rate-limit buckets see the real client.
  const trustProxyValue = e.TRUST_PROXY === 'default' ? (e.DEPLOYMENT_MODE === 'intranet' ? 1 : false) : e.TRUST_PROXY;

  return { ...e, LOG_LEVEL: logLevel as LogLevel, TRUST_PROXY: trustProxyValue, aiEnabled: resolveAiEnabled(e) };
}

// AI_PROVIDER=none → off · internal → on (hospital LLM, no de-identification gate) ·
// external → on only with both approval flags, and then the endpoint and key are required.
function resolveAiEnabled(e: ParsedEnv): boolean {
  if (e.AI_PROVIDER === 'none') return false;
  if (e.AI_PROVIDER === 'internal') return true;
  if (!e.AI_EXTERNAL_VENDOR_APPROVED || !e.AI_DEIDENTIFY_REQUIRED) return false;
  if (!e.AI_EXTERNAL_ENDPOINT) {
    throw new Error('AI_EXTERNAL_ENDPOINT is required when AI_PROVIDER=external and approval flags are set');
  }
  if (!e.AI_EXTERNAL_API_KEY) {
    throw new Error('AI_EXTERNAL_API_KEY is required when AI_PROVIDER=external and approval flags are set');
  }
  return true;
}
