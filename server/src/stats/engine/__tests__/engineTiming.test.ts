// P0-13 성능 기준선 — STATS_ENGINE_TIMING 계측. 꺼져 있으면(기본) 로그를 남기지 않고, 켜면 정상 종료 때
// analyze.py의 stderr 표식을 읽어 한 줄 로그. 결과(resolve 값)는 켜든 끄든 같다.
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../../config', async () => ({
  default: (await import('../../../testing/configMock.js')).testConfig({
    stats: {
      python: 'python',
      scriptsDir: '/fake/scripts',
      timeoutMs: 5000,
      killGraceMs: 1000,
      maxConcurrency: 1,
      maxConcurrentAnalyzeRequests: 4,
      stdoutMaxBytes: 4096,
      stderrMaxBytes: 4096,
      maxInputBytes: 1024 * 1024,
      resultTtlHours: 168,
      // Mutable on this mock: tests switch timing on/off (config.stats.timingEnabled, P1-10).
      timingEnabled: false,
    },
  }),
}));

import { spawn } from 'child_process';
import config from '../../../config';
import { logger } from '../../../logger';
import {
  runStatsEngine,
  buildEngineTimingLog,
  __resetStatsEngineForTests,
  type StatsEngineRequest,
} from '..';

class FakeChildProcess extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal?: string) => true);
}

const req: StatsEngineRequest = { variables: [{ key: 'v1', kind: 'continuous', values: [1, 2, 3] }] };

function validStdoutPayload() {
  return JSON.stringify({
    protocolVersion: 6,
    continuous: [{
      variableKey: 'v1', n: 3, mean: 2, sd: 1, median: 2, q1: 1.5, q3: 2.5, iqr: 1,
      skewness: null, kurtosis: null, min: 1, max: 3, nullReasons: {}, histogram: null, boxplot: null,
    }],
    discrete: [],
  });
}

const MARKER = {
  mode: 'descriptive', processStartWallMs: 1_000_120, importMs: 400.5, stdinMs: 1, parseMs: 2,
  computeMs: 30, serializeMs: 0.5, processMs: 434,
};

// "only STATS_ENGINE_TIMING=1 turns it on" is the config rule — config.test.ts ('stats.timingEnabled').

describe('buildEngineTimingLog', () => {
  it('combines the Python marker with the Node spawn→close time', () => {
    const log = buildEngineTimingLog(`STATS_ENGINE_TIMING ${JSON.stringify(MARKER)}\n`, 1_000_000, 1_000_600);
    expect(log).toEqual({
      mode: 'descriptive', interpreterStartMs: 120, importMs: 400.5, stdinMs: 1, parseMs: 2,
      computeMs: 30, serializeMs: 0.5, processMs: 434, totalMs: 600, markerFound: true,
    });
  });

  it('finds the marker among other stderr lines', () => {
    const log = buildEngineTimingLog(`warning: something\nSTATS_ENGINE_TIMING ${JSON.stringify(MARKER)}\n`, 1_000_000, 1_000_600);
    expect(log.markerFound).toBe(true);
  });

  it('reports markerFound=false with only totalMs when the marker is missing or broken', () => {
    for (const stderr of ['', 'STATS_ENGINE_TIMING {not json}', 'STATS_ENGINE_TIMING [1,2]']) {
      const log = buildEngineTimingLog(stderr, 10, 25);
      expect(log.markerFound).toBe(false);
      expect(log.totalMs).toBe(15);
      expect(log.computeMs).toBeNull();
    }
  });

  it('nulls non-numeric fields instead of passing them through', () => {
    const log = buildEngineTimingLog(`STATS_ENGINE_TIMING ${JSON.stringify({ ...MARKER, computeMs: 'x', processStartWallMs: null })}`, 0, 1);
    expect(log.computeMs).toBeNull();
    expect(log.interpreterStartMs).toBeNull();
    expect(log.importMs).toBe(400.5);
  });
});

function spyInfo() {
  return vi.spyOn(logger, 'info').mockImplementation(() => undefined);
}

describe('runStatsEngine with STATS_ENGINE_TIMING', () => {
  let fake: FakeChildProcess;
  let info: ReturnType<typeof spyInfo>;
  const setTiming = (on: boolean) => { (config.stats as { timingEnabled: boolean }).timingEnabled = on; };

  beforeEach(() => {
    __resetStatsEngineForTests();
    fake = new FakeChildProcess();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fake);
    info = spyInfo();
  });

  afterEach(() => {
    info.mockRestore();
    setTiming(false);
  });

  it('off (default): no timing log, same result', async () => {
    setTiming(false);
    const promise = runStatsEngine(req);
    fake.stdout.emit('data', Buffer.from(validStdoutPayload()));
    fake.stderr.emit('data', Buffer.from(`STATS_ENGINE_TIMING ${JSON.stringify(MARKER)}\n`));
    fake.emit('close', 0, null);
    const result = await promise;
    expect(result.continuous[0]!.variableKey).toBe('v1');
    expect(info).not.toHaveBeenCalled();
  });

  it('on: one timing log line on success, result unchanged', async () => {
    setTiming(true);
    const promise = runStatsEngine(req);
    fake.stdout.emit('data', Buffer.from(validStdoutPayload()));
    fake.stderr.emit('data', Buffer.from(`STATS_ENGINE_TIMING ${JSON.stringify(MARKER)}\n`));
    fake.emit('close', 0, null);
    const result = await promise;
    expect(result.continuous[0]!.variableKey).toBe('v1');
    expect(info).toHaveBeenCalledTimes(1);
    const [fields, msg] = info.mock.calls[0] as unknown as [{ timing: Record<string, unknown> }, string];
    expect(msg).toBe('[stats-engine] timing');
    const logged = fields.timing;
    expect(logged).toMatchObject({ mode: 'descriptive', computeMs: 30, markerFound: true });
    expect(typeof logged.totalMs).toBe('number');
  });

  it('on: a failed run logs no timing line', async () => {
    setTiming(true);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const promise = runStatsEngine(req);
    fake.stderr.emit('data', Buffer.from('STATS_ENGINE_ERROR {"code":"COMPUTE_ERROR","detail":"x"}\n'));
    fake.emit('close', 1, null);
    await expect(promise).rejects.toThrow();
    expect(info).not.toHaveBeenCalled();
    error.mockRestore();
  });
});

// SEC-A L10 (P1-22): the stats child gets the filtered environment — no DATABASE_URL or secrets — with the thread
// knobs, and STATS_ENGINE_TIMING only when timing is on (analyze.py reads it itself).
describe('runStatsEngine child environment (SEC-A L10)', () => {
  let fake: FakeChildProcess;
  const setTiming = (on: boolean) => { (config.stats as { timingEnabled: boolean }).timingEnabled = on; };
  const saved = { db: process.env.DATABASE_URL, secret: process.env.ACCESS_TOKEN_SECRET };

  beforeEach(() => {
    __resetStatsEngineForTests();
    fake = new FakeChildProcess();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fake);
    process.env.DATABASE_URL = 'postgres://wr_app:secret@postgres:5432/wr_evaluation';
    process.env.ACCESS_TOKEN_SECRET = 'x'.repeat(64);
  });

  afterEach(() => {
    setTiming(false);
    if (saved.db === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = saved.db;
    if (saved.secret === undefined) delete process.env.ACCESS_TOKEN_SECRET; else process.env.ACCESS_TOKEN_SECRET = saved.secret;
  });

  async function spawnEnv(): Promise<NodeJS.ProcessEnv> {
    const promise = runStatsEngine(req);
    fake.stdout.emit('data', Buffer.from(validStdoutPayload()));
    fake.emit('close', 0, null);
    await promise;
    const call = (spawn as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!;
    return (call[2] as { env: NodeJS.ProcessEnv }).env;
  }

  it('no secrets; thread knobs set; STATS_ENGINE_TIMING only when on', async () => {
    setTiming(false);
    const off = await spawnEnv();
    expect(off).not.toHaveProperty('DATABASE_URL');
    expect(off).not.toHaveProperty('ACCESS_TOKEN_SECRET');
    expect(off).not.toHaveProperty('STATS_ENGINE_TIMING');
    expect(off).toMatchObject({ OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', MKL_NUM_THREADS: '1' });
    __resetStatsEngineForTests();
    fake = new FakeChildProcess();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fake);
    setTiming(true);
    const on = await spawnEnv();
    expect(on.STATS_ENGINE_TIMING).toBe('1');
    expect(on).not.toHaveProperty('DATABASE_URL');
  });
});
