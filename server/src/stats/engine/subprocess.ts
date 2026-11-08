// Stats engine process: worker slot semaphore, degraded flag, timing log and runEngineProcess.
// Split out of stats/engine/index.ts (S6 P1-34); handler bodies unchanged.
// PR1 — Python subprocess worker spawn wrapper. 계획서(pr1-giggly-treehouse.md) §2 참고.
// 6차례 검토를 거친 프로세스 생명주기 설계를 그대로 구현한다 — 핵심 불변식:
//   1) 완료 판정은 오직 'close' 이벤트에서만 한다(stdout 유실 방지, exit는 쓰지 않음).
//   2) 모든 종료 시도는 requestTermination() 하나로 모은다(kill() 재귀 방지).
//   3) 세마포어 슬롯 반환은 오직 'close'(정상) 또는 최종 안전 타이머(비정상, 미반환)에서만.
//   4) requestSettled(호출자에게 확정 알림)와 processClosed(OS가 실제 종료 확인)를 분리한다.
import { spawn } from 'child_process';
import path from 'path';
import config from '../../config';
import { StatsEngineBusyError, StatsEngineTimeoutError, StatsEngineOutputTooLargeError, StatsEngineProcessError, StatsEngineResultInvalidError, StatsEngineDegradedError, StatsEngineCancelledError } from './errors';

// ---------------------------------------------------------------------------
// 모듈 레벨 상태(가드C 세마포어 + degraded 플래그) — 의도적으로 프로세스 전역이다.
// ---------------------------------------------------------------------------
let inFlightCount = 0;
let engineDegraded = false;

/** 테스트 전용 — 모듈 상태를 초기화한다. */
export function __resetStatsEngineForTests(): void {
  inFlightCount = 0;
  engineDegraded = false;
}

// PR4-B1 — 큐 워커가 claim 전에 확인하는 non-mutating peek. 힌트일 뿐 보장이
// 아니다(peek 이후 실제 runEngineProcess 호출 사이에 다른 요청이 슬롯을 채갈
// 수 있음) — 워커는 그 경합을 StatsEngineBusyError를 잡아 재큐잉하는 것으로
// 처리한다(stats/queue/runsQueue.ts의 requeueOrFinish).
export function isEngineSlotAvailable(): boolean {
  return !engineDegraded && inFlightCount < config.stats.maxConcurrency;
}

// admission이 quota 검사 단계(캐시hit/합류 확인 이후)에서 부르는 별도 게이트.
// degraded는 슬롯이 아니라 엔진 자체의 신뢰 상태이므로 슬롯 peek과 분리해 둔다.
export function isEngineDegraded(): boolean {
  return engineDegraded;
}


interface RecordedOutcome {
  kind: 'spawn_error' | 'stdin_error' | 'timeout' | 'output_too_large' | 'cancelled';
  detail?: string;
}

// P0-13 성능 기준선 — STATS_ENGINE_TIMING=1일 때만(기본 꺼짐, 운영 compose는 이 값을 넘기지 않음)
// analyze.py가 정상 종료 직전 stderr에 쓰는 `STATS_ENGINE_TIMING {...}` 표식을 읽어 Node 쪽
// spawn→close 시간과 합친 한 줄을 로그로 남긴다. 꺼져 있으면 아무것도 읽거나 쓰지 않는다.
// stderr는 원래도 stderrMaxBytes 상한 안에서 모으므로(아래 runEngineProcess) 표식 한 줄은 동작에 영향 없음.
// 켜짐 여부는 config.stats.timingEnabled(STATS_ENGINE_TIMING === '1', P1-10에서 process.env 직접 읽기를 옮김).

export interface EngineTimingLog {
  mode: string | null;
  /** spawn 직전(Node 벽시계) → Python 프로세스 첫 줄(Python 벽시계). 같은 호스트 시계라 비교 가능. */
  interpreterStartMs: number | null;
  importMs: number | null;
  stdinMs: number | null;
  parseMs: number | null;
  computeMs: number | null;
  serializeMs: number | null;
  /** Python 첫 줄 → 결과 직렬화 완료(단조 시계). */
  processMs: number | null;
  /** spawn 직전 → 'close'(Node 벽시계). */
  totalMs: number;
  /** 표식을 못 찾거나 해석하지 못하면 false(나머지 Python 구간은 null). */
  markerFound: boolean;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function buildEngineTimingLog(stderrText: string, spawnWallMs: number, closeWallMs: number): EngineTimingLog {
  const totalMs = closeWallMs - spawnWallMs;
  const empty: EngineTimingLog = {
    mode: null, interpreterStartMs: null, importMs: null, stdinMs: null, parseMs: null,
    computeMs: null, serializeMs: null, processMs: null, totalMs, markerFound: false,
  };
  const match = stderrText.match(/^STATS_ENGINE_TIMING (\{.*\})\s*$/m);
  if (!match) return empty;
  let marker: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(match[1]!);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;
    marker = parsed as Record<string, unknown>;
  } catch {
    return empty;
  }
  const startWall = finiteOrNull(marker.processStartWallMs);
  return {
    mode: typeof marker.mode === 'string' ? marker.mode : null,
    interpreterStartMs: startWall === null ? null : Math.round((startWall - spawnWallMs) * 1000) / 1000,
    importMs: finiteOrNull(marker.importMs),
    stdinMs: finiteOrNull(marker.stdinMs),
    parseMs: finiteOrNull(marker.parseMs),
    computeMs: finiteOrNull(marker.computeMs),
    serializeMs: finiteOrNull(marker.serializeMs),
    processMs: finiteOrNull(marker.processMs),
    totalMs,
    markerFound: true,
  };
}

// PR3-A — descriptive/bivariate 두 경로가 spawn·타이머·세마포어·listener 생명주기를
// 전부 동일하게 공유한다(6차례 검토를 거친 로직, 변경 없음). 달라지는 3가지(입력상한
// 검사·stdin payload·stdout 성공 파싱)만 파라미터로 뺀다 — 로직을 복제하면 한쪽만
// 고치는 버그가 생기기 쉽다.
interface EngineRunConfig<T> {
  assertLimits: () => void;
  buildStdinPayload: () => unknown;
  /** zod shape + 의미검증까지 끝내고 최종 반환값을 만든다. 실패 시 throw
   * (StatsEngineResultInvalidError 권장 — 그대로 reject된다). */
  parseSuccess: (parsed: unknown) => T;
  /** PR4-B1 — 생략 시 기존 config.stats.timeoutMs(30초, sync 호출부 전부).
   * 큐 워커가 행별 engine_timeout_ms를 넘길 때만 오버라이드한다. 실행
   * 타이머·안전 타이머 둘 다 이 값을 쓴다(한쪽만 바꾸면 행별 timeout이
   * 반쪽만 적용됨). */
  timeoutMs?: number;
  /** PR4-B1 — abort되면 이미 spawn됐으면 requestTermination('SIGTERM'), 아직
   * spawn 전이면 spawn 자체를 건너뛰고 즉시 StatsEngineCancelledError로 reject. */
  signal?: AbortSignal;
  /** PR4-B1 — spawn 직후 실제 PID를 알려준다(취소 registry가 소유권을 기록). */
  onSpawn?: (pid: number | undefined) => void;
}

export async function runEngineProcess<T>(cfg: EngineRunConfig<T>): Promise<T> {
  cfg.assertLimits();
  if (cfg.signal?.aborted) {
    throw new StatsEngineCancelledError();
  }
  if (engineDegraded) {
    throw new StatsEngineDegradedError();
  }
  if (inFlightCount >= config.stats.maxConcurrency) {
    throw new StatsEngineBusyError();
  }
  inFlightCount += 1;
  const resolvedTimeoutMs = cfg.timeoutMs ?? config.stats.timeoutMs;

  let slotReleased = false;
  const releaseSlot = () => {
    if (slotReleased) return;
    slotReleased = true;
    inFlightCount = Math.max(0, inFlightCount - 1);
  };

  return new Promise<T>((resolve, reject) => {
    const scriptPath = path.join(config.stats.scriptsDir, 'analyze.py');
    const env = {
      // eslint-disable-next-line no-restricted-syntax -- 자식 env 최소화는 L10(SEC-A P1-22)에서 buildChildEnv()로.
      ...process.env,
      OMP_NUM_THREADS: '1',
      OPENBLAS_NUM_THREADS: '1',
      MKL_NUM_THREADS: '1',
      NUMEXPR_NUM_THREADS: '1',
      VECLIB_MAXIMUM_THREADS: '1',
    };

    // 7차 검토 필수 수정 — spawn() 자체가 동기적으로 throw할 수 있다(예: 잘못된 옵션,
    // 플랫폼별 ENOENT가 비동기 'error' 대신 동기 예외로 오는 경우). 이 시점엔 아직 아무
    // 리스너도 등록 전이라 'close'가 절대 오지 않으므로, 여기서 못 잡으면 슬롯이 영구
    // 누수되고 이후 모든 요청이 StatsEngineBusyError로 막힌다(실제 재현됨).
    const timingEnabled = config.stats.timingEnabled;
    const spawnWallMs = timingEnabled ? Date.now() : 0;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(config.stats.python, [scriptPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      releaseSlot();
      reject(new StatsEngineProcessError('PROCESS_ERROR', err instanceof Error ? err.message : 'spawn 실패'));
      return;
    }
    cfg.onSpawn?.(child.pid);

    let recordedOutcome: RecordedOutcome | null = null;
    let requestSettled = false;
    let processClosed = false;
    let terminationRequested = false;
    let graceTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;

    let stdoutChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let onAbort: (() => void) | null = null;

    const clearAllTimers = () => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
      if (safetyTimer) { clearTimeout(safetyTimer); safetyTimer = null; }
    };

    const removeAllListeners = () => {
      child.removeAllListeners();
      child.stdin?.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      if (onAbort) cfg.signal?.removeEventListener('abort', onAbort);
    };

    // §2.1 — 모든 종료 시도의 단일 진입점. terminationRequested를 kill() 호출 '전에'
    // 세워 재귀(kill 실패로 인한 동기 'error' 재발생 포함)를 끊는다.
    function requestTermination(signal: 'SIGTERM' | 'SIGKILL') {
      if (terminationRequested) return;
      terminationRequested = true;
      try { child.kill(signal); } catch { /* 동기 throw 무시 — 별도 기록 불필요 */ }
      graceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* 무시 */ }
      }, config.stats.killGraceMs);
    }

    // PR4-B1 — spawn 이후에 abort되면 여기서 종료를 요청한다(spawn 이전 abort는
    // 함수 시작부의 cfg.signal?.aborted 체크가 이미 걸러 spawn 자체를 안 한다).
    if (cfg.signal) {
      onAbort = () => {
        recordedOutcome ??= { kind: 'cancelled' };
        requestTermination('SIGTERM');
      };
      cfg.signal.addEventListener('abort', onAbort);
    }

    // 정상 확정(오직 'close'에서만 호출) — recordedOutcome/exitCode로 분기.
    function finish(exitCode: number | null) {
      requestSettled = true;
      clearAllTimers();
      releaseSlot();
      removeAllListeners();

      if (recordedOutcome) {
        switch (recordedOutcome.kind) {
          case 'timeout':
            reject(new StatsEngineTimeoutError());
            return;
          case 'output_too_large':
            reject(new StatsEngineOutputTooLargeError());
            return;
          case 'cancelled':
            reject(new StatsEngineCancelledError());
            return;
          case 'spawn_error':
          case 'stdin_error':
            reject(new StatsEngineProcessError('PROCESS_ERROR', recordedOutcome.detail ?? recordedOutcome.kind));
            return;
        }
      }

      if (exitCode === 0) {
        if (timingEnabled) {
          const timing = buildEngineTimingLog(Buffer.concat(stderrChunks).toString('utf8'), spawnWallMs, Date.now());
          console.info(`[stats-engine] timing ${JSON.stringify(timing)}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'));
        } catch {
          reject(new StatsEngineProcessError('INVALID_OUTPUT', 'stdout이 유효한 JSON이 아님'));
          return;
        }
        try {
          resolve(cfg.parseSuccess(parsed));
        } catch (err) {
          reject(err instanceof Error ? err : new StatsEngineResultInvalidError(String(err)));
        }
        return;
      }

      // 비정상 종료 — stderr의 STATS_ENGINE_ERROR 마커를 파싱(진단용 detail은 서버
      // 로그로만 남기고 이 에러 객체를 통해 호출자에게 원문을 노출하지 않는다).
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      const markerMatch = stderrText.match(/STATS_ENGINE_ERROR (\{.*\})/);
      if (markerMatch) {
        console.error('[stats-engine] process error marker:', markerMatch[1]);
      } else if (stderrText) {
        console.error('[stats-engine] process exited non-zero with stderr:', stderrText.slice(0, 2000));
      }
      reject(new StatsEngineProcessError('PROCESS_ERROR', `stats-engine 프로세스가 code ${exitCode}로 종료됨`));
    }

    child.on('error', (err) => {
      recordedOutcome ??= { kind: 'spawn_error', detail: err.message };
      requestTermination('SIGTERM');
    });

    child.stdin?.on('error', (err) => {
      recordedOutcome ??= { kind: 'stdin_error', detail: err.message };
      requestTermination('SIGTERM');
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (recordedOutcome?.kind === 'output_too_large') return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > config.stats.stdoutMaxBytes) {
        recordedOutcome ??= { kind: 'output_too_large' };
        stdoutChunks = [];
        requestTermination('SIGTERM');
        return;
      }
      stdoutChunks.push(chunk);
    });

    // 7차 검토 필수 수정 — 이전 판은 상한 초과 시 조용히 버리기만 하고 종료를 시도하지
    // 않아, stderr를 계속 흘려보내는 프로세스가 stdout만 정상이면 그대로 성공 처리됐다
    // (kill 없이 성공하는 게 실제 재현됨). stdout과 동일하게 kill+output_too_large로
    // 승격한다. 또한 문턱을 넘기는 그 chunk 자체를 통째로 저장하지 않는다 — 이전 판은
    // "누적 전 체크"라 문턱을 막 넘긴 큰 chunk가 그대로 들어가 실제 보관량이 상한을
    // 크게 초과할 수 있었다.
    child.stderr?.on('data', (chunk: Buffer) => {
      if (recordedOutcome?.kind === 'output_too_large') return;
      stderrBytes += chunk.length;
      if (stderrBytes > config.stats.stderrMaxBytes) {
        recordedOutcome ??= { kind: 'output_too_large' };
        stderrChunks = [];
        requestTermination('SIGTERM');
        return;
      }
      stderrChunks.push(chunk);
    });

    timeoutTimer = setTimeout(() => {
      recordedOutcome ??= { kind: 'timeout' };
      requestTermination('SIGTERM');
    }, resolvedTimeoutMs);

    // §2.1 최종 안전 타이머 — 'close'가 끝내 안 오면 요청을 실패로 1회 확정하되 슬롯은
    // 반환하지 않는다(프로세스가 실제로 끝났는지 모르므로) — 대신 엔진 전체를 격리한다.
    safetyTimer = setTimeout(() => {
      if (processClosed) return;
      requestSettled = true;
      clearAllTimers();
      engineDegraded = true;
      // 슬롯은 의도적으로 반환하지 않는다 — releaseSlot() 호출 없음.
      reject(new StatsEngineProcessError('PROCESS_ERROR', '프로세스 종료를 확인하지 못함(안전 타이머 발동)'));
      // 리스너는 해제하지 않는다 — 늦게 오는 'close'를 계속 듣고 아래에서 정리한다.
    }, resolvedTimeoutMs + config.stats.killGraceMs + 5000);

    child.once('close', (code) => {
      processClosed = true;
      if (requestSettled) {
        // 안전 타이머가 이미 확정한 뒤 늦게 온 close — Promise·슬롯·DB 저장은 다시
        // 만들지 않되 정리 작업(타이머·리스너)은 반드시 수행한다.
        clearAllTimers();
        console.warn('[stats-engine] degraded 유발 프로세스가 뒤늦게 실제로 종료됨(late close), engineDegraded는 유지됨');
        removeAllListeners();
        return;
      }
      finish(code);
    });

    try {
      const payload = JSON.stringify(cfg.buildStdinPayload());
      child.stdin?.end(payload, 'utf8');
    } catch (err) {
      recordedOutcome ??= { kind: 'stdin_error', detail: err instanceof Error ? err.message : String(err) };
      requestTermination('SIGTERM');
    }
  });
}

// PR4-B1 — stats/queue/runsQueue.ts의 attempt()가 행별 timeoutMs·취소 signal·onSpawn을
// 전달할 때 쓴다. sync 호출부(기존 전부)는 opts를 생략 — 동작 무변경.
export interface EngineRunOpts {
  timeoutMs?: number;
  signal?: AbortSignal;
  onSpawn?: (pid: number | undefined) => void;
}
