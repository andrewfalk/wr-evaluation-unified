/**
 * Central config loaded once at startup from process.env.
 * All other modules import the default export.
 * Tests can call createConfig({ ... }) directly without module reloading.
 */
import path from 'path';

// 영상 분석 dev 도구 기본 경로: 서버는 server/에서 실행되므로 repo 루트는 cwd 상위로 가정.
// 운영/컨테이너는 env로 명시(아래 VIDEO_ANALYSIS_* 참고) — 기본값 의존 금지.
function poseInferenceRoot(): string {
  return path.resolve(process.cwd(), '..', 'services', 'pose-inference');
}
function defaultPython(scriptsDir: string): string {
  // venv 경로는 OS별로 다르다(Windows=Scripts/python.exe, POSIX=bin/python).
  const rel = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  return path.join(scriptsDir, '.venv', rel);
}

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

function trustProxy(env: NodeJS.ProcessEnv, deploymentMode: DeploymentMode): false | true | number {
  const raw = env['TRUST_PROXY'];
  if (raw === undefined || raw === '') {
    return deploymentMode === 'intranet' ? 1 : false;
  }

  if (raw === 'true') return true;
  if (raw === 'false') return false;

  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error("TRUST_PROXY must be 'true', 'false', or a non-negative integer");
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
      'CORS_ORIGINS must be set (e.g. https://wr.hospital.local:8443) in production or intranet mode'
    );
  }

  return Object.freeze({
    env:         nodeEnv,
    port:        positiveInt(env, 'PORT', 3001),
    databaseUrl: required(env, 'DATABASE_URL'),
    jsonBodyLimit: optional(env, 'JSON_BODY_LIMIT', '10mb'),

    deploymentMode,
    // intranet mode never falls back to local storage on server errors
    localFallbackAllowed: deploymentMode !== 'intranet',
    // Caddy terminates TLS and forwards requests to the app container in
    // intranet mode. Trust exactly one proxy hop by default so req.ip and
    // rate-limit buckets reflect the real client address.
    trustProxy: trustProxy(env, deploymentMode),

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
      // Model name sent to the external vendor endpoint (e.g. 'gpt-4o').
      // Overrides the client-sent model — the approved vendor contract may
      // restrict which models are permitted under the hospital agreement.
      externalModel:          optional(env, 'AI_EXTERNAL_MODEL', 'gpt-4o'),
      externalEndpoint:       aiExternalEndpoint,
      externalApiKey:         aiExternalApiKey,
      externalVendorApproved: aiExternalVendorApproved,
      deidentifyRequired:     aiDeidentifyRequired,
    }),

    cors: Object.freeze({ origins: corsOrigins }),

    // 작업 영상 인간공학 분석(v6.0.0). 검증(6.0-B2) 통과 전까지 운영 기본 비활성.
    videoAnalysisEnabled: bool(env, 'VIDEO_ANALYSIS_ENABLED', false),

    video: Object.freeze((() => {
      const scriptsDir = optional(env, 'VIDEO_ANALYSIS_SCRIPTS_DIR', poseInferenceRoot());
      const retention = optional(env, 'VIDEO_ANALYSIS_RETENTION', 'privacy_first');
      if (retention !== 'privacy_first' && retention !== 'review_fidelity') {
        throw new Error(`VIDEO_ANALYSIS_RETENTION must be 'privacy_first' or 'review_fidelity', got '${retention}'`);
      }
      return {
        // dev-only fixture 추론 워커 활성(운영 기본 off). enabled와 함께여야 워커가 돈다.
        fixtureMode: bool(env, 'VIDEO_ANALYSIS_FIXTURE_MODE', false),
        // fixture 영상 allowlist 디렉터리. 이 안의 파일만 분석 입력으로 허용(path traversal 차단).
        fixtureDir: optional(env, 'VIDEO_ANALYSIS_FIXTURE_DIR', path.join(scriptsDir, 'samples')),
        scriptsDir,
        // Python 실행기. 운영/컨테이너는 env 명시 권장(기본값은 dev venv).
        python: optional(env, 'VIDEO_ANALYSIS_PYTHON', defaultPython(scriptsDir)),
        // M3-7a 실 업로드: Node·추론 공유 볼륨. 미설정이면 업로드 라우트 비활성(UPLOAD_DISABLED).
        uploadDir: env['VIDEO_ANALYSIS_UPLOAD_DIR'] || null,
        // 업로드 최대 크기(바이트). 기본 2GB.
        maxUploadBytes: positiveInt(env, 'VIDEO_ANALYSIS_MAX_UPLOAD_BYTES', 2 * 1024 * 1024 * 1024),
        // 허용 확장자/MIME(매직바이트 sniffing과 함께 검증).
        allowedExtensions: Object.freeze(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']),
        allowedMimeTypes: Object.freeze(['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm', 'video/x-msvideo', 'video/x-matroska']),
        // 보존 정책: privacy_first(원본 추론 후 삭제·skeleton만) | review_fidelity(원본 TTL 보존).
        retentionPolicy: retention as 'privacy_first' | 'review_fidelity',
        // 대상자 선택 시 대표 프레임 썸네일 노출(privacy 정책 예외, 기본 off). 동의+인트라넷 전제에서만 opt-in.
        targetThumbnail: bool(env, 'VIDEO_ANALYSIS_TARGET_THUMBNAIL', false),
        // 골격 검수 overlay에 실 프레임 표시(privacy 정책 예외, 기본 off). on일 때만 추론이 샘플 프레임을
        // 다운스케일 JPEG로 추출·보관하고 서빙 허용. 검증 초기 한시 예외(동의+인트라넷 전제).
        overlayFrames: bool(env, 'VIDEO_ANALYSIS_OVERLAY_FRAMES', false),
        // 미확정 임시 영상 보존 시간(시간). TTL 경과 시 cleanup이 회수.
        clipTtlHours: positiveInt(env, 'VIDEO_ANALYSIS_CLIP_TTL_HOURS', 24),
        // recipe 미확정(가중치 sha 없음 → status='unverified')인데도 apply를 허용할지(fail-closed 기본 false).
        // dev/test/fixture 전용 단일 노브(6.0-9). 운영(에어갭 baked 이미지)에선 절대 켜지 않는다.
        allowUnverifiedRecipe: bool(env, 'VIDEO_ANALYSIS_ALLOW_UNVERIFIED_RECIPE', false),
        // 전체 job 처리 deadline(ms, 6.0-12). 추론(infer_clip+feature_calc) subprocess의 합이 이를 넘지 않도록
        // 엄격 분배하고, sweepStale·클라이언트 폴링 상한이 모두 이 값에서 파생된다(단일 진실원천).
        // 손목(wholebody)은 CPU에서 1~2분 클립도 오래 걸려 기본 600000(10분). GPU면 더 줄여도 됨(§Range).
        jobDeadlineMs: positiveInt(env, 'VIDEO_ANALYSIS_JOB_DEADLINE_MS', 600000),
        // sweepStale이 정체 job을 error로 정리하는 여유(ms). sweep 임계 = jobDeadlineMs + sweepGraceMs라
        // claim·IO·persist 오버헤드로 정상 job이 조기에 죽지 않게 한다.
        sweepGraceMs: positiveInt(env, 'VIDEO_ANALYSIS_SWEEP_GRACE_MS', 30000),
        // 클라이언트가 job을 queued 상태로 기다리는 상한(ms). 직렬 큐(동시 1건)라 앞선 job 때문에 대기할 수
        // 있어 별도 예산으로 둔다. 서버 queued stale(1시간)보다 짧게(기본 10분) — UI가 과도하게 매달리지 않게.
        queueWaitMs: positiveInt(env, 'VIDEO_ANALYSIS_QUEUE_WAIT_MS', 600000),
      };
    })()),
  });
}

const config = createConfig();
export default config;
