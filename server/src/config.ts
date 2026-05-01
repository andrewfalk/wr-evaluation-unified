/**
 * Central config loaded once at startup from process.env.
 * All other modules import the default export.
 * Tests can call createConfig({ ... }) directly without module reloading.
 */

function required(env: NodeJS.ProcessEnv, key: string): string {
  const val = env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optional(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  return env[key] || fallback;
}

function bool(env: NodeJS.ProcessEnv, key: string, fallback = false): boolean {
  const val = env[key];
  if (val === undefined) return fallback;
  return val === 'true' || val === '1';
}

function positiveInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${key} must be a positive integer, got '${raw}'`);
  }
  return n;
}

export type DeploymentMode = 'intranet' | 'standalone';
export type AiProvider     = 'none' | 'internal' | 'external';

export function createConfig(env: NodeJS.ProcessEnv = process.env) {
  // ---------------------------------------------------------------------------
  // Deployment mode
  // ---------------------------------------------------------------------------
  const rawMode = optional(env, 'DEPLOYMENT_MODE', 'standalone');
  if (rawMode !== 'intranet' && rawMode !== 'standalone') {
    throw new Error(
      `DEPLOYMENT_MODE must be 'intranet' or 'standalone', got '${rawMode}'`
    );
  }
  const deploymentMode = rawMode as DeploymentMode;

  // ---------------------------------------------------------------------------
  // AI provider gate
  //
  // AI_PROVIDER=none       → disabled
  // AI_PROVIDER=internal   → internal LLM (Ollama/vLLM); no deidentification gate
  // AI_PROVIDER=external   → external vendor; requires both approval flags
  // ---------------------------------------------------------------------------
  const rawAiProvider = optional(env, 'AI_PROVIDER', 'none');
  if (!['none', 'internal', 'external'].includes(rawAiProvider)) {
    throw new Error(
      `AI_PROVIDER must be 'none', 'internal', or 'external', got '${rawAiProvider}'`
    );
  }
  const aiProvider               = rawAiProvider as AiProvider;
  const aiExternalVendorApproved = bool(env, 'AI_EXTERNAL_VENDOR_APPROVED');
  const aiDeidentifyRequired     = bool(env, 'AI_DEIDENTIFY_REQUIRED');
  const aiExternalEndpoint       = optional(env, 'AI_EXTERNAL_ENDPOINT', '');
  const aiExternalApiKey         = optional(env, 'AI_EXTERNAL_API_KEY', '');

  function resolveAiEnabled(): boolean {
    if (aiProvider === 'none')     return false;
    if (aiProvider === 'internal') return true;
    // external: both approval flags AND endpoint+key must be present
    if (!aiExternalVendorApproved || !aiDeidentifyRequired) return false;
    if (!aiExternalEndpoint) {
      throw new Error('AI_EXTERNAL_ENDPOINT is required when AI_PROVIDER=external and approval flags are set');
    }
    if (!aiExternalApiKey) {
      throw new Error('AI_EXTERNAL_API_KEY is required when AI_PROVIDER=external and approval flags are set');
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // CORS origins (comma-separated)
  // ---------------------------------------------------------------------------
  const corsOrigins = (env['CORS_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // ---------------------------------------------------------------------------
  // NODE_ENV
  // ---------------------------------------------------------------------------
  const rawNodeEnv = optional(env, 'NODE_ENV', 'development');
  if (!['development', 'production', 'test'].includes(rawNodeEnv)) {
    throw new Error(`NODE_ENV must be 'development', 'production', or 'test', got '${rawNodeEnv}'`);
  }
  const nodeEnv = rawNodeEnv as 'development' | 'production' | 'test';

  // CORS_ORIGINS is mandatory in production / intranet deployments.
  // An empty allowlist in production would silently block all credentialed
  // browser requests that include an Origin header (login, CSRF, etc.).
  if (corsOrigins.length === 0 && (nodeEnv === 'production' || deploymentMode === 'intranet')) {
    throw new Error(
      'CORS_ORIGINS must be set (e.g. https://wr.hospital.local) in production or intranet mode'
    );
  }

  return Object.freeze({
    env:         nodeEnv,
    port:        positiveInt(env, 'PORT', 3001),
    databaseUrl: required(env, 'DATABASE_URL'),

    deploymentMode,
    // intranet mode never falls back to local storage on server errors
    localFallbackAllowed: deploymentMode !== 'intranet',

    auth: Object.freeze({
      accessTokenSecret:  required(env, 'ACCESS_TOKEN_SECRET'),
      refreshTokenSecret: required(env, 'REFRESH_TOKEN_SECRET'),
      // access token TTL in seconds (default 15 min)
      accessTokenTtl:  positiveInt(env, 'ACCESS_TOKEN_TTL',  15 * 60),
      // refresh token TTL in seconds (default 7 days)
      refreshTokenTtl: positiveInt(env, 'REFRESH_TOKEN_TTL', 7 * 24 * 60 * 60),
    }),

    ai: Object.freeze({
      provider:               aiProvider,
      enabled:                resolveAiEnabled(),
      internalEndpoint:       optional(env, 'AI_INTERNAL_ENDPOINT', 'http://localhost:11434'),
      // Model name sent to the internal LLM backend (e.g. 'llama3', 'mistral').
      // Overrides any model name the client sends — the client has no visibility
      // into what models are loaded in the hospital's Ollama/vLLM instance.
      internalModel:          optional(env, 'AI_INTERNAL_MODEL', 'llama3'),
      externalEndpoint:       aiExternalEndpoint,
      externalApiKey:         aiExternalApiKey,
      externalVendorApproved: aiExternalVendorApproved,
      deidentifyRequired:     aiDeidentifyRequired,
    }),

    cors: Object.freeze({ origins: corsOrigins }),
  });
}

const config = createConfig();
export default config;
