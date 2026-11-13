/**
 * Central config loaded once at startup from process.env.
 * All other modules import the default export.
 * Tests can call createConfig({ ... }) directly without module reloading.
 *
 * Parsing and start-up validation live in config/schema.ts (zod, REFACTORING_ROADMAP S2 / P1-09);
 * this file only shapes the parsed values into the nested, frozen object the server uses.
 * Behaviour is frozen by __tests__/config.characterization.test.ts.
 */
import path from 'path';
import { resolveEnv } from './config/schema';

export {
  LOG_LEVELS,
  type LogLevel,
  type DeploymentMode,
  type AiProvider,
  type LockEnforcementMode,
} from './config/schema';

// Repository root, from this file's location — server/src/config.ts and server/dist/config.js are
// both two levels below it — so the dev-tool defaults below no longer depend on the working
// directory (before S2 they assumed the server was started from server/). Production and
// containers set these paths through env (VIDEO_ANALYSIS_*, STATS_ENGINE_*).
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function poseInferenceRoot(): string {
  return path.join(REPO_ROOT, 'services', 'pose-inference');
}

// PR1: stats-engine dev 도구 기본 경로 — pose venv와 완전히 독립된 경로(계획서 §7.3).
function statsEngineRoot(): string {
  return path.join(REPO_ROOT, 'services', 'stats-engine');
}

function venvPython(scriptsDir: string): string {
  // venv 경로는 OS별로 다르다(Windows=Scripts/python.exe, POSIX=bin/python).
  const rel = process.platform === 'win32' ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
  return path.join(scriptsDir, '.venv', rel);
}

export function createConfig(env: NodeJS.ProcessEnv = process.env) {
  const e = resolveEnv(env);
  const videoScriptsDir = e.VIDEO_ANALYSIS_SCRIPTS_DIR ?? poseInferenceRoot();
  const statsScriptsDir = e.STATS_ENGINE_SCRIPTS_DIR ?? statsEngineRoot();

  return Object.freeze({
    env:         e.NODE_ENV,
    port:        e.PORT,
    databaseUrl: e.DATABASE_URL,
    jsonBodyLimit: e.JSON_BODY_LIMIT,
    log: Object.freeze({ level: e.LOG_LEVEL }),

    deploymentMode: e.DEPLOYMENT_MODE,
    // intranet mode never falls back to local storage on server errors
    localFallbackAllowed: e.DEPLOYMENT_MODE !== 'intranet',
    trustProxy: e.TRUST_PROXY,

    auth: Object.freeze({
      accessTokenSecret:  e.ACCESS_TOKEN_SECRET,
      // access token TTL in seconds (default 15 min)
      accessTokenTtl:  e.ACCESS_TOKEN_TTL,
      // refresh session idle TTL in seconds (default 24 hours; 7 days before 7.2.0)
      refreshTokenTtl: e.REFRESH_TOKEN_TTL,
      // absolute session lifetime in seconds from login (default 12 hours, SEC-B M3)
      sessionAbsoluteTtl: e.SESSION_ABSOLUTE_TTL,
    }),

    ai: Object.freeze({
      provider:               e.AI_PROVIDER,
      enabled:                e.aiEnabled,
      internalEndpoint:       e.AI_INTERNAL_ENDPOINT,
      // Model name sent to the internal LLM backend (e.g. 'llama3', 'mistral'). Overrides any model
      // the client sends — the client cannot see which models the hospital's Ollama/vLLM has loaded.
      internalModel:          e.AI_INTERNAL_MODEL,
      // Model name sent to the external vendor endpoint (e.g. 'gpt-4o'). Overrides the client-sent
      // model — the approved vendor contract may restrict which models are permitted.
      externalModel:          e.AI_EXTERNAL_MODEL,
      externalEndpoint:       e.AI_EXTERNAL_ENDPOINT,
      externalApiKey:         e.AI_EXTERNAL_API_KEY,
      externalVendorApproved: e.AI_EXTERNAL_VENDOR_APPROVED,
      deidentifyRequired:     e.AI_DEIDENTIFY_REQUIRED,
      // AI 업스트림(내부 LLM·외부 벤더) 호출 한 건의 제한 시간(ms). 초과하면 504로 끊는다.
      timeoutMs:              e.AI_TIMEOUT_MS,
    }),

    cors: Object.freeze({ origins: e.CORS_ORIGINS }),

    // 작업 영상 인간공학 분석(v6.0.0). 검증(6.0-B2) 통과 전까지 운영 기본 비활성.
    videoAnalysisEnabled: e.VIDEO_ANALYSIS_ENABLED,

    // 통계분석 워크벤치(PR0-A). 최종 활성화 여부는 stats/policy/workbenchRuntimeState.ts가 이 값과
    // deploymentMode를 함께 본다(§7.6).
    statsWorkbenchEnabled: e.STATS_WORKBENCH_ENABLED,

    // 환자 단위 TTL lease lock 롤아웃 플래그(3단계). off: 락 API는 존재하되 쓰기 엔드포인트가
    // 락을 확인 안 함(기본, 구버전 클라이언트와 100% 호환) → observe: 락 체크는 평가·로그만
    // 남기고 막지 않음 → enforce: 실제 게이팅.
    lockEnforcementMode: e.LOCK_ENFORCEMENT_MODE,

    // S8: this instance's queue namespace. Statistics runs and video analysis clips/jobs record it, and the
    // queue scans (claim, sweeps, cleanup, cache, quota) only see their own namespace — servers sharing one
    // database stay apart. 'default' in production; development servers get their own (scripts).
    queueNamespace: e.QUEUE_NAMESPACE,

    video: Object.freeze({
      // dev-only fixture 추론 워커 활성(운영 기본 off). enabled와 함께여야 워커가 돈다.
      fixtureMode: e.VIDEO_ANALYSIS_FIXTURE_MODE,
      // fixture 영상 allowlist 디렉터리. 이 안의 파일만 분석 입력으로 허용(path traversal 차단).
      fixtureDir: e.VIDEO_ANALYSIS_FIXTURE_DIR ?? path.join(videoScriptsDir, 'samples'),
      scriptsDir: videoScriptsDir,
      // Python 실행기. 운영/컨테이너는 env 명시 권장(기본값은 dev venv).
      python: e.VIDEO_ANALYSIS_PYTHON ?? venvPython(videoScriptsDir),
      // M3-7a 실 업로드: Node·추론 공유 볼륨. 미설정이면 업로드 라우트 비활성(UPLOAD_DISABLED).
      uploadDir: e.VIDEO_ANALYSIS_UPLOAD_DIR,
      // 업로드 최대 크기(바이트). 기본 2GB.
      maxUploadBytes: e.VIDEO_ANALYSIS_MAX_UPLOAD_BYTES,
      // 허용 확장자/MIME(매직바이트 sniffing과 함께 검증).
      allowedExtensions: Object.freeze(['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv']),
      allowedMimeTypes: Object.freeze(['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm', 'video/x-msvideo', 'video/x-matroska']),
      // 보존 정책: privacy_first(원본 추론 후 삭제·skeleton만) | review_fidelity(원본 TTL 보존).
      retentionPolicy: e.VIDEO_ANALYSIS_RETENTION,
      // 대상자 선택 시 대표 프레임 썸네일 노출(privacy 정책 예외, 기본 off). 동의+인트라넷 전제에서만 opt-in.
      targetThumbnail: e.VIDEO_ANALYSIS_TARGET_THUMBNAIL,
      // 골격 검수 overlay에 실 프레임 표시(privacy 정책 예외, 기본 off).
      overlayFrames: e.VIDEO_ANALYSIS_OVERLAY_FRAMES,
      // 미확정 임시 영상 보존 시간(시간). TTL 경과 시 cleanup이 회수.
      clipTtlHours: e.VIDEO_ANALYSIS_CLIP_TTL_HOURS,
      // recipe 미확정(status='unverified')인데도 apply를 허용할지(fail-closed 기본 false). dev/test/fixture 전용.
      allowUnverifiedRecipe: e.VIDEO_ANALYSIS_ALLOW_UNVERIFIED_RECIPE,
      // pose 모델 티어(6.0-14): standard(기본) | auto. 'high'는 dev CLI 디버그 전용 → 기동 실패(fail-fast).
      poseTier: e.VIDEO_POSE_TIER,
      // det 실행 간격 초(6.0-15). 0(기본)=매 샘플 프레임 det. 상한 1.0(mapTargetTrack ±500ms 창).
      detIntervalSec: e.VIDEO_DET_INTERVAL_SEC,
      // 전체 job 처리 deadline(ms, 6.0-12) — sweepStale·클라이언트 폴링 상한의 단일 진실원천.
      jobDeadlineMs: e.VIDEO_ANALYSIS_JOB_DEADLINE_MS,
      // sweepStale 임계 = jobDeadlineMs + sweepGraceMs(정상 job 조기 종료 방지 여유).
      sweepGraceMs: e.VIDEO_ANALYSIS_SWEEP_GRACE_MS,
      // 클라이언트가 job을 queued 상태로 기다리는 상한(ms, 직렬 큐 대기 예산).
      queueWaitMs: e.VIDEO_ANALYSIS_QUEUE_WAIT_MS,
    }),

    // PR1 — Python subprocess 통계 엔진. maxValuesPerVariable/maxTotalValues/maxStringLength는
    // 여기 없다 — stats/engine/engineLimits.ts의 하드코딩 상수(Python jsonschema와 일치해야 함, 계획서 §7.3).
    stats: Object.freeze({
      scriptsDir: statsScriptsDir,
      python: e.STATS_ENGINE_PYTHON ?? venvPython(statsScriptsDir),
      // Python 프로세스 계산 타임아웃(ms). 안전 타이머 = timeoutMs + killGraceMs + 5000ms(§7.4).
      timeoutMs: e.STATS_ENGINE_TIMEOUT_MS,
      // SIGTERM 이후 SIGKILL까지 유예(ms).
      killGraceMs: e.STATS_ENGINE_KILL_GRACE_MS,
      // Python worker 동시 실행 상한(가드C, runStatsEngine 내부 세마포어).
      maxConcurrency: e.STATS_ENGINE_MAX_CONCURRENCY,
      // POST /analyze 핸들러 전체의 동시 처리 상한(가드A) — Node 측 전처리 비용 통제용.
      maxConcurrentAnalyzeRequests: e.STATS_MAX_CONCURRENT_ANALYZE_REQUESTS,
      stdoutMaxBytes: e.STATS_ENGINE_STDOUT_MAX_BYTES,
      stderrMaxBytes: e.STATS_ENGINE_STDERR_MAX_BYTES,
      // stdin JSON 바이트 상한 — 값 개수 상한과 별개의 이중 검사(§7.4).
      maxInputBytes: e.STATS_ENGINE_MAX_INPUT_BYTES,
      // 성공한 stats_runs 결과의 TTL(시간) — idempotency 캐시 유효기간.
      resultTtlHours: e.STATS_RUNS_RESULT_TTL_HOURS,
      // P0-13 성능 기준선 — STATS_ENGINE_TIMING=1일 때만(운영 compose는 넘기지 않음).
      timingEnabled: e.STATS_ENGINE_TIMING,

      // PR4-B1 — 비동기 job 인프라(admission→attempt→finish).
      async: Object.freeze({
        // admission 이후 동기 응답을 시도하는 예산(ms) — 넘으면 202.
        syncBudgetMs: e.STATS_ASYNC_SYNC_BUDGET_MS,
        // §B 폴링 루프의 재조회 간격(ms).
        pollTickMs: e.STATS_ASYNC_POLL_TICK_MS,
        // sweepLoop 주기(ms) — claimLoop와 독립(orphan·queued 취소·대기초과 확정).
        sweepIntervalMs: e.STATS_ASYNC_SWEEP_INTERVAL_MS,
        // claimLoop 주기(ms).
        claimIntervalMs: e.STATS_ASYNC_CLAIM_INTERVAL_MS,
        // heartbeat 갱신 주기(ms) — staleThresholdMs의 1/3 이하 권장.
        heartbeatIntervalMs: e.STATS_ASYNC_HEARTBEAT_INTERVAL_MS,
        // staleThresholdMs = engine_timeout_ms + killGraceMs + safetyMs.
        staleSafetyMs: e.STATS_ASYNC_STALE_SAFETY_MS,
        // claim 전 queued 대기 상한(ms, 실행 타임아웃과 별개 예산).
        queueWaitMs: e.STATS_ASYNC_QUEUE_WAIT_MS,
        // 행별 engine_timeout_ms 상한.
        maxJobTimeoutMs: e.STATS_ASYNC_MAX_JOB_TIMEOUT_MS,
        // heartbeat 쓰기 연속 실패 허용 횟수 — 넘으면 heartbeat만 멈추고 계산은 계속.
        maxConsecutiveHeartbeatFailures: e.STATS_ASYNC_MAX_HEARTBEAT_FAILURES,
        // BUSY 재큐잉 상한 — 넘으면 PROCESS_ERROR로 확정 실패.
        maxRequeueCount: e.STATS_ASYNC_MAX_REQUEUE_COUNT,
        // finishRun/requeueOrFinish 저장 실패 재시도 한도.
        maxFinishPersistRetries: e.STATS_ASYNC_MAX_FINISH_PERSIST_RETRIES,
        // admission quota — 동시실행(queued+running)·시간당(상태 무관 생성).
        maxConcurrentPerUser: e.STATS_ASYNC_MAX_CONCURRENT_PER_USER,
        maxConcurrentPerOrg: e.STATS_ASYNC_MAX_CONCURRENT_PER_ORG,
        maxHourlyPerUser: e.STATS_ASYNC_MAX_HOURLY_PER_USER,
        maxHourlyPerOrg: e.STATS_ASYNC_MAX_HOURLY_PER_ORG,
      }),
    }),

    // Values P1-10 moves off direct process.env reads (behaviour unchanged).
    // Build provenance recorded in video analysis recipes (workers/videoAnalysisWorker.ts).
    gitCommit: e.WR_GIT_COMMIT,
    // Backup monitor output read by GET /api/admin/ops/backup-status (routes/opsStatus.ts).
    backupsDir: e.BACKUPS_DIR,
    // electron-updater feed directory served under /updates (routes/updates.ts).
    updatesDir: e.UPDATES_DIR,
    // Read-only audit pool (wr_audit_reader) — db/auditClient.ts. Raw env value.
    auditDatabaseUrl: e.AUDIT_DATABASE_URL,
    // M9: apply migrations on start-up (true) or only check them (false, role-separated) — config/schema.ts.
    autoMigrate: e.AUTO_MIGRATE,
  });
}

const config = createConfig();
export default config;
