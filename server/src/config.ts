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

  function resolveAiEnabled(): boolean {
    if (aiProvider === 'none')     return false;
    if (aiProvider === 'internal') return true;
    return aiExternalVendorApproved && aiDeidentifyRequired;
  }

  // ---------------------------------------------------------------------------
  // CORS origins (comma-separated)
  // ---------------------------------------------------------------------------
  const corsOrigins = (env['CORS_ORIGINS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return Object.freeze({
    env:            optional(env, 'NODE_ENV', 'development') as 'development' | 'production' | 'test',
    port:           Number(optional(env, 'PORT', '3001')),
    databaseUrl:    required(env, 'DATABASE_URL'),

    deploymentMode,
    // intranet mode never falls back to local storage on server errors
    localFallbackAllowed: deploymentMode !== 'intranet',

    auth: Object.freeze({
      accessTokenSecret:  required(env, 'ACCESS_TOKEN_SECRET'),
      refreshTokenSecret: required(env, 'REFRESH_TOKEN_SECRET'),
      // access token TTL in seconds (default 15 min)
      accessTokenTtl:  Number(optional(env, 'ACCESS_TOKEN_TTL',  String(15 * 60))),
      // refresh token TTL in seconds (default 7 days)
      refreshTokenTtl: Number(optional(env, 'REFRESH_TOKEN_TTL', String(7 * 24 * 60 * 60))),
    }),

    ai: Object.freeze({
      provider:               aiProvider,
      enabled:                resolveAiEnabled(),
      internalEndpoint:       optional(env, 'AI_INTERNAL_ENDPOINT', 'http://localhost:11434'),
      externalEndpoint:       optional(env, 'AI_EXTERNAL_ENDPOINT', ''),
      externalApiKey:         optional(env, 'AI_EXTERNAL_API_KEY', ''),
      externalVendorApproved: aiExternalVendorApproved,
      deidentifyRequired:     aiDeidentifyRequired,
    }),

    cors: Object.freeze({ origins: corsOrigins }),
  });
}

const config = createConfig();
export default config;
