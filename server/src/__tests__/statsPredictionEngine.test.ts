// 코드리뷰(2026-09-25) — validatePredictionSemantics의 oofRepresentative 방어
// 검증(중복/범위초과 row 인덱스, [0,1] 밖 확률값)이 실제로 걸리는지 mock
// child_process로 확인한다. zod shape는 길이만 맞으면 통과하므로(row/p 자체의
// 의미 제약은 shape에 없음), 이 검증이 없으면 이후 y[point.row]/groups[point.row]
// 매핑과 곡선 공개통제의 "row는 0..N-1의 정확한 순열" 전제가 조용히 깨진다.
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../config', () => ({
  default: {
    stats: {
      python: 'python',
      scriptsDir: '/fake/scripts',
      timeoutMs: 5000,
      killGraceMs: 1000,
      maxConcurrency: 1,
      maxConcurrentAnalyzeRequests: 4,
      stdoutMaxBytes: 1024 * 1024,
      stderrMaxBytes: 1024,
      maxInputBytes: 1024 * 1024,
      resultTtlHours: 168,
    },
  },
}));

import { spawn } from 'child_process';
import {
  runPredictionStatsEngine,
  buildPredictionEngineRequest,
  StatsEngineResultInvalidError,
  __resetStatsEngineForTests,
} from '../statsEngine';

class FakeChildProcess extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal?: string) => true);
}

const request = buildPredictionEngineRequest({
  y: [1, 0, 1, 0],
  x: [[1], [2], [3], [4]],
  columnNames: ['x1'],
  groups: ['p1', 'p2', 'p3', 'p4'],
  outerFoldAssignment: new Map([[1, new Map([['p1', 0], ['p2', 1], ['p3', 0], ['p4', 1]])]]),
  outerFoldCount: 2,
});

function baseMetric(value: number) {
  return {
    apparent: value, representativeRepeat: value,
    cv: { status: 'ok', validRepeats: 1, totalRepeats: 1, mean: value, min: value, max: value },
    bootstrap: { status: 'ok', validReplicates: 1, totalReplicates: 1, optimism: 0, corrected: value },
  };
}

function validPayload(oofRepresentative: Array<{ row: number; p: number }>) {
  return JSON.stringify({
    protocolVersion: 6,
    prediction: {
      estimation: 'ok',
      nonEstimableReason: null,
      lambdaSelected: 0.1,
      metrics: {
        roc_auc: baseMetric(0.8), average_precision: baseMetric(0.7), brier: baseMetric(0.2),
        calibration_intercept: baseMetric(0.0), calibration_slope: baseMetric(1.0),
      },
      aucCi: null,
      oofRepresentative,
      intercept: -0.5,
      coefficients: [1.2],
      droppedColumnFoldCount: 0,
      flags: [],
    },
  });
}

describe('runPredictionStatsEngine — oofRepresentative 방어 검증', () => {
  let fake: FakeChildProcess;

  beforeEach(() => {
    __resetStatsEngineForTests();
    fake = new FakeChildProcess();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fake);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('row가 0..N-1의 정확한 순열이고 p가 [0,1] 안이면 통과한다', async () => {
    const promise = runPredictionStatsEngine(request);
    fake.stdout.emit('data', Buffer.from(validPayload([
      { row: 0, p: 0.1 }, { row: 1, p: 0.2 }, { row: 2, p: 0.8 }, { row: 3, p: 0.9 },
    ])));
    fake.emit('close', 0, null);
    await expect(promise).resolves.toBeDefined();
  });

  it('row 인덱스가 중복되면 거부된다', async () => {
    const promise = runPredictionStatsEngine(request);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    fake.stdout.emit('data', Buffer.from(validPayload([
      { row: 0, p: 0.1 }, { row: 0, p: 0.2 }, { row: 2, p: 0.8 }, { row: 3, p: 0.9 },
    ])));
    fake.emit('close', 0, null);
    await assertion;
  });

  it('row 인덱스가 범위를 벗어나면 거부된다', async () => {
    const promise = runPredictionStatsEngine(request);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    fake.stdout.emit('data', Buffer.from(validPayload([
      { row: 0, p: 0.1 }, { row: 1, p: 0.2 }, { row: 2, p: 0.8 }, { row: 4, p: 0.9 },
    ])));
    fake.emit('close', 0, null);
    await assertion;
  });

  it('확률값이 1을 넘으면 거부된다', async () => {
    const promise = runPredictionStatsEngine(request);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    fake.stdout.emit('data', Buffer.from(validPayload([
      { row: 0, p: 0.1 }, { row: 1, p: 0.2 }, { row: 2, p: 0.8 }, { row: 3, p: 1.5 },
    ])));
    fake.emit('close', 0, null);
    await assertion;
  });

  it('확률값이 음수면 거부된다', async () => {
    const promise = runPredictionStatsEngine(request);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    fake.stdout.emit('data', Buffer.from(validPayload([
      { row: 0, p: -0.1 }, { row: 1, p: 0.2 }, { row: 2, p: 0.8 }, { row: 3, p: 0.9 },
    ])));
    fake.emit('close', 0, null);
    await assertion;
  });
});
