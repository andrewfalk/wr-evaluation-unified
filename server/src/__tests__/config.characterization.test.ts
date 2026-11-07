// Characterization of createConfig (REFACTORING_ROADMAP S2 / P1-09). Frozen from the hand-written
// parser BEFORE it was replaced by the zod schema (config/schema.ts): for each env below, either the
// whole resulting config or the exact start-up error message. The zod rewrite must leave this file's
// snapshot unchanged. Keys added by S2 (NEW_KEYS) are left out here and pinned in config.test.ts.
//
// Normalised: the repository root becomes <repo>, path separators become '/', and the platform's
// venv interpreter (Scripts/python.exe on Windows, bin/python elsewhere) becomes <venv-python>.
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createConfig } from '../config';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Config keys introduced by S2 — not part of the frozen pre-S2 shape. */
const NEW_KEYS: ReadonlyArray<readonly string[]> = [
  ['gitCommit'], ['backupsDir'], ['updatesDir'], ['stats', 'timingEnabled'],
];

function stripNewKeys(value: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const keyPath of NEW_KEYS) {
    let node: Record<string, unknown> | undefined = copy;
    for (const key of keyPath.slice(0, -1)) node = node?.[key] as Record<string, unknown> | undefined;
    if (node) delete node[keyPath[keyPath.length - 1]];
  }
  return copy;
}

function normalisePaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalisePaths);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalisePaths(v)]));
  }
  if (typeof value === 'string' && value.startsWith(REPO_ROOT)) {
    return ('<repo>' + value.slice(REPO_ROOT.length))
      .split(path.sep).join('/')
      .replace(/\/\.venv\/(Scripts\/python\.exe|bin\/python)$/, '/.venv/<venv-python>');
  }
  return value;
}

function outcome(env: NodeJS.ProcessEnv): unknown {
  try {
    return { config: normalisePaths(stripNewKeys(createConfig(env) as unknown as Record<string, unknown>)) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

const BASE = {
  DATABASE_URL: 'postgresql://test',
  ACCESS_TOKEN_SECRET: 'access-secret',
  REFRESH_TOKEN_SECRET: 'refresh-secret',
} satisfies NodeJS.ProcessEnv;

const INTRANET = { ...BASE, DEPLOYMENT_MODE: 'intranet', CORS_ORIGINS: 'https://wr.hospital.local:8443' };

// Every variable createConfig reads, set to a valid non-default value.
const ALL_OVERRIDDEN: NodeJS.ProcessEnv = {
  ...INTRANET,
  NODE_ENV: 'production',
  LOG_LEVEL: 'debug',
  PORT: '4001',
  JSON_BODY_LIMIT: '2mb',
  TRUST_PROXY: '2',
  CORS_ORIGINS: ' https://a.example , https://b.example ,, ',
  ACCESS_TOKEN_TTL: '600',
  REFRESH_TOKEN_TTL: '86400',
  AI_PROVIDER: 'external',
  AI_EXTERNAL_VENDOR_APPROVED: 'true',
  AI_DEIDENTIFY_REQUIRED: '1',
  AI_EXTERNAL_ENDPOINT: 'https://llm.example/v1',
  AI_EXTERNAL_API_KEY: 'key-1',
  AI_INTERNAL_ENDPOINT: 'http://llm.internal:11434',
  AI_INTERNAL_MODEL: 'mistral',
  AI_EXTERNAL_MODEL: 'gpt-x',
  AI_TIMEOUT_MS: '30000',
  VIDEO_ANALYSIS_ENABLED: 'true',
  STATS_WORKBENCH_ENABLED: '1',
  LOCK_ENFORCEMENT_MODE: 'enforce',
  VIDEO_ANALYSIS_SCRIPTS_DIR: '/opt/pose',
  VIDEO_ANALYSIS_RETENTION: 'review_fidelity',
  VIDEO_ANALYSIS_FIXTURE_MODE: 'true',
  VIDEO_ANALYSIS_FIXTURE_DIR: '/opt/pose/fixtures',
  VIDEO_ANALYSIS_PYTHON: '/opt/pose/venv/bin/python',
  VIDEO_ANALYSIS_UPLOAD_DIR: '/data/uploads',
  VIDEO_ANALYSIS_MAX_UPLOAD_BYTES: '1048576',
  VIDEO_ANALYSIS_TARGET_THUMBNAIL: 'true',
  VIDEO_ANALYSIS_OVERLAY_FRAMES: '1',
  VIDEO_ANALYSIS_CLIP_TTL_HOURS: '12',
  VIDEO_ANALYSIS_ALLOW_UNVERIFIED_RECIPE: 'true',
  VIDEO_POSE_TIER: 'auto',
  VIDEO_DET_INTERVAL_SEC: '0.5',
  VIDEO_ANALYSIS_JOB_DEADLINE_MS: '300000',
  VIDEO_ANALYSIS_SWEEP_GRACE_MS: '10000',
  VIDEO_ANALYSIS_QUEUE_WAIT_MS: '120000',
  STATS_ENGINE_SCRIPTS_DIR: '/opt/stats',
  STATS_ENGINE_PYTHON: '/opt/stats-venv/bin/python',
  STATS_ENGINE_TIMEOUT_MS: '20000',
  STATS_ENGINE_KILL_GRACE_MS: '1000',
  STATS_ENGINE_MAX_CONCURRENCY: '2',
  STATS_MAX_CONCURRENT_ANALYZE_REQUESTS: '8',
  STATS_ENGINE_STDOUT_MAX_BYTES: '1000',
  STATS_ENGINE_STDERR_MAX_BYTES: '2000',
  STATS_ENGINE_MAX_INPUT_BYTES: '3000',
  STATS_RUNS_RESULT_TTL_HOURS: '48',
  STATS_ASYNC_SYNC_BUDGET_MS: '1000',
  STATS_ASYNC_POLL_TICK_MS: '50',
  STATS_ASYNC_SWEEP_INTERVAL_MS: '1500',
  STATS_ASYNC_CLAIM_INTERVAL_MS: '250',
  STATS_ASYNC_HEARTBEAT_INTERVAL_MS: '3000',
  STATS_ASYNC_STALE_SAFETY_MS: '4000',
  STATS_ASYNC_QUEUE_WAIT_MS: '90000',
  STATS_ASYNC_MAX_JOB_TIMEOUT_MS: '120000',
  STATS_ASYNC_MAX_HEARTBEAT_FAILURES: '7',
  STATS_ASYNC_MAX_REQUEUE_COUNT: '9',
  STATS_ASYNC_MAX_FINISH_PERSIST_RETRIES: '4',
  STATS_ASYNC_MAX_CONCURRENT_PER_USER: '3',
  STATS_ASYNC_MAX_CONCURRENT_PER_ORG: '5',
  STATS_ASYNC_MAX_HOURLY_PER_USER: '30',
  STATS_ASYNC_MAX_HOURLY_PER_ORG: '100',
};

const CASES: Array<[string, NodeJS.ProcessEnv]> = [
  ['defaults (minimal env)', BASE],
  ['intranet defaults', INTRANET],
  ['every variable overridden', ALL_OVERRIDDEN],
  ['empty strings fall back to defaults', {
    ...BASE, DEPLOYMENT_MODE: '', NODE_ENV: '', LOG_LEVEL: '', PORT: '', JSON_BODY_LIMIT: '', TRUST_PROXY: '',
    AI_PROVIDER: '', LOCK_ENFORCEMENT_MODE: '', VIDEO_ANALYSIS_RETENTION: '', VIDEO_POSE_TIER: '', VIDEO_DET_INTERVAL_SEC: '',
    VIDEO_ANALYSIS_SCRIPTS_DIR: '', VIDEO_ANALYSIS_UPLOAD_DIR: '', STATS_ENGINE_SCRIPTS_DIR: '', AI_TIMEOUT_MS: '',
  }],
  ['booleans: only "true" and "1" are true', {
    ...BASE, VIDEO_ANALYSIS_ENABLED: 'yes', STATS_WORKBENCH_ENABLED: 'TRUE', VIDEO_ANALYSIS_FIXTURE_MODE: '0',
    VIDEO_ANALYSIS_TARGET_THUMBNAIL: '', VIDEO_ANALYSIS_OVERLAY_FRAMES: 'false', VIDEO_ANALYSIS_ALLOW_UNVERIFIED_RECIPE: '1',
  }],
  ['TRUST_PROXY true', { ...BASE, TRUST_PROXY: 'true' }],
  ['TRUST_PROXY false in intranet', { ...INTRANET, TRUST_PROXY: 'false' }],
  ['TRUST_PROXY 0', { ...BASE, TRUST_PROXY: '0' }],
  ['AI internal', { ...BASE, AI_PROVIDER: 'internal' }],
  ['AI external without approval flags (disabled)', { ...BASE, AI_PROVIDER: 'external', AI_EXTERNAL_VENDOR_APPROVED: 'true' }],
  ['VIDEO_DET_INTERVAL_SEC upper bound', { ...BASE, VIDEO_DET_INTERVAL_SEC: '1.0' }],
  ['NODE_ENV test', { ...BASE, NODE_ENV: 'test' }],
  // --- start-up errors ---
  ['missing DATABASE_URL', { ACCESS_TOKEN_SECRET: 'a', REFRESH_TOKEN_SECRET: 'r' }],
  ['empty DATABASE_URL', { ...BASE, DATABASE_URL: '' }],
  ['missing ACCESS_TOKEN_SECRET', { DATABASE_URL: 'postgresql://test', REFRESH_TOKEN_SECRET: 'r' }],
  ['missing REFRESH_TOKEN_SECRET', { DATABASE_URL: 'postgresql://test', ACCESS_TOKEN_SECRET: 'a' }],
  ['bad DEPLOYMENT_MODE', { ...BASE, DEPLOYMENT_MODE: 'cloud' }],
  ['bad AI_PROVIDER', { ...BASE, AI_PROVIDER: 'openai' }],
  ['bad NODE_ENV', { ...BASE, NODE_ENV: 'staging' }],
  ['bad LOG_LEVEL', { ...BASE, LOG_LEVEL: 'verbose' }],
  ['CORS_ORIGINS missing in production', { ...BASE, NODE_ENV: 'production' }],
  ['CORS_ORIGINS only commas in intranet', { ...BASE, DEPLOYMENT_MODE: 'intranet', CORS_ORIGINS: ' , ' }],
  ['PORT 0', { ...BASE, PORT: '0' }],
  ['PORT not a number', { ...BASE, PORT: 'abc' }],
  ['PORT fractional', { ...BASE, PORT: '1.5' }],
  ['negative STATS_ASYNC_POLL_TICK_MS', { ...BASE, STATS_ASYNC_POLL_TICK_MS: '-5' }],
  ['bad TRUST_PROXY', { ...BASE, TRUST_PROXY: 'yes' }],
  ['negative TRUST_PROXY', { ...BASE, TRUST_PROXY: '-1' }],
  ['bad LOCK_ENFORCEMENT_MODE', { ...BASE, LOCK_ENFORCEMENT_MODE: 'strict' }],
  ['bad VIDEO_ANALYSIS_RETENTION', { ...BASE, VIDEO_ANALYSIS_RETENTION: 'forever' }],
  ['VIDEO_POSE_TIER high (dev CLI only)', { ...BASE, VIDEO_POSE_TIER: 'high' }],
  ['VIDEO_DET_INTERVAL_SEC above 1', { ...BASE, VIDEO_DET_INTERVAL_SEC: '1.5' }],
  ['VIDEO_DET_INTERVAL_SEC negative', { ...BASE, VIDEO_DET_INTERVAL_SEC: '-0.1' }],
  ['VIDEO_DET_INTERVAL_SEC not a number', { ...BASE, VIDEO_DET_INTERVAL_SEC: 'soon' }],
  ['AI external approved without endpoint', { ...BASE, AI_PROVIDER: 'external', AI_EXTERNAL_VENDOR_APPROVED: 'true', AI_DEIDENTIFY_REQUIRED: 'true' }],
  ['AI external approved without key', {
    ...BASE, AI_PROVIDER: 'external', AI_EXTERNAL_VENDOR_APPROVED: 'true', AI_DEIDENTIFY_REQUIRED: 'true', AI_EXTERNAL_ENDPOINT: 'https://x',
  }],
];

describe('createConfig characterization (S2 / P1-09)', () => {
  it('produces the frozen config or start-up error for every case', async () => {
    const results = Object.fromEntries(CASES.map(([name, env]) => [name, outcome(env)]));
    await expect(JSON.stringify(results, null, 2) + '\n').toMatchFileSnapshot('./__goldens__/config-characterization.json');
  });
});
