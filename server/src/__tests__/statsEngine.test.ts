// PR1 계획서 §2/§9-item2 — spawn wrapper 프로세스 생명주기 실측 검증. child_process를
// mock한 FakeChildProcess로 'close' 기준 확정·kill() 재귀 방지·busy/degraded·§2.2 의미
// 검증을 검증한다.
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
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
      maxInputBytes: 1024 * 1024,
      resultTtlHours: 168,
    },
  },
}));

import { spawn } from 'child_process';
import {
  runStatsEngine,
  StatsEngineBusyError,
  StatsEngineDegradedError,
  StatsEngineOutputTooLargeError,
  StatsEngineProcessError,
  StatsEngineResultInvalidError,
  StatsEngineTimeoutError,
  __resetStatsEngineForTests,
  type StatsEngineRequest,
} from '../statsEngine';

class FakeChildProcess extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal?: string) => true);
}

const req: StatsEngineRequest = {
  variables: [{ key: 'v1', kind: 'continuous', values: [1, 2, 3] }],
};

function validStdoutPayload() {
  return JSON.stringify({
    protocolVersion: 2,
    continuous: [{
      variableKey: 'v1', n: 3, mean: 2, sd: 1, median: 2, q1: 1.5, q3: 2.5, iqr: 1,
      skewness: null, kurtosis: null, min: 1, max: 3, nullReasons: {},
    }],
    discrete: [],
  });
}

describe('runStatsEngine', () => {
  let fake: FakeChildProcess;

  beforeEach(() => {
    __resetStatsEngineForTests();
    fake = new FakeChildProcess();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fake);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('정상 종료(close, code 0) 이후에만 결과가 resolve된다', async () => {
    const promise = runStatsEngine(req);
    fake.stdout.emit('data', Buffer.from(validStdoutPayload()));
    fake.emit('close', 0, null);
    const result = await promise;
    expect(result.continuous[0].variableKey).toBe('v1');
  });

  it('타임아웃 — SIGTERM 전송 후 close가 와야 슬롯이 반환되고 TimeoutError로 reject된다', async () => {
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineTimeoutError);

    await vi.advanceTimersByTimeAsync(5000); // timeoutMs 경과
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');
    expect(fake.kill).toHaveBeenCalledTimes(1); // grace 타이머는 아직 안 지남 — SIGKILL 미호출

    fake.emit('close', null, 'SIGTERM'); // 프로세스가 SIGTERM에 실제로 반응해 종료
    await assertion;

    // 슬롯이 정상 반환됐는지 — 다음 호출이 즉시 busy가 아니어야 한다.
    const fake2 = new FakeChildProcess();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fake2);
    const p2 = runStatsEngine(req);
    fake2.stdout.emit('data', Buffer.from(validStdoutPayload()));
    fake2.emit('close', 0, null);
    await expect(p2).resolves.toBeDefined();
  });

  it('grace 유예 안에 close가 안 오면 SIGKILL까지 escalation한다', async () => {
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineTimeoutError);

    await vi.advanceTimersByTimeAsync(5000); // timeout
    await vi.advanceTimersByTimeAsync(1000); // killGraceMs 경과 — SIGKILL
    expect(fake.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');

    fake.emit('close', null, 'SIGKILL');
    await assertion;
  });

  it('출력 초과 — stdout 상한을 넘으면 누적을 멈추고 종료를 시도한다', async () => {
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineOutputTooLargeError);

    fake.stdout.emit('data', Buffer.alloc(2000, 'a')); // stdoutMaxBytes(1024) 초과
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');

    fake.emit('close', null, 'SIGTERM');
    await assertion;
  });

  it('kill() 자체가 동기적으로 throw해도 요청 처리가 죽지 않는다', async () => {
    fake.kill = vi.fn((): boolean => { throw new Error('permission denied'); });
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineTimeoutError);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.kill).toHaveBeenCalledTimes(1); // grace 타이머의 SIGKILL 호출도 나가지만 잡아냄
    fake.emit('close', null, 'SIGTERM');
    await assertion;
  });

  it("kill() 호출이 동기적으로 'error'를 재발생시켜도 무한 재귀하지 않는다(4차 검토 §1)", async () => {
    let killCallCount = 0;
    fake.kill = vi.fn(() => {
      killCallCount += 1;
      if (killCallCount === 1) {
        // 실제 결함 재현 — kill() 호출의 부작용으로 'error'가 동기적으로 다시 발생.
        fake.emit('error', new Error('kill triggered synchronous error'));
      }
      return true;
    });

    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineProcessError);

    // 'error' 이벤트 자체가 requestTermination()을 부르므로 즉시 kill()이 1회 트리거된다.
    fake.emit('error', new Error('spawn failed'));

    expect(killCallCount).toBe(1); // terminationRequested 가드 덕에 재귀 없이 정확히 1회
    fake.emit('close', null, null);
    await assertion;
  });

  it('§2.2 의미검증 — 요청하지 않은 kind로 결과가 오면 거부한다', async () => {
    const promise = runStatsEngine({ variables: [{ key: 'v1', kind: 'discrete', values: ['a', 'b'] }] });
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    fake.stdout.emit('data', Buffer.from(validStdoutPayload())); // continuous로 옴 — kind 불일치
    fake.emit('close', 0, null);
    await assertion;
  });

  it('§2.2 의미검증 — n이 입력 길이와 다르면 거부한다', async () => {
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    const badPayload = JSON.stringify({
      protocolVersion: 2,
      continuous: [{ variableKey: 'v1', n: 999, mean: 2, sd: 1, median: 2, q1: 1.5, q3: 2.5, iqr: 1, skewness: null, kurtosis: null, min: 1, max: 3, nullReasons: {} }],
      discrete: [],
    });
    fake.stdout.emit('data', Buffer.from(badPayload));
    fake.emit('close', 0, null);
    await assertion;
  });

  it('§2.2 의미검증 — discrete level count 합이 n과 다르면 거부한다', async () => {
    const discreteReq: StatsEngineRequest = { variables: [{ key: 'd1', kind: 'discrete', values: ['a', 'b', 'a'] }] };
    const promise = runStatsEngine(discreteReq);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    const badPayload = JSON.stringify({
      protocolVersion: 2,
      continuous: [],
      discrete: [{ variableKey: 'd1', n: 3, levels: [{ level: 'a', count: 2 }, { level: 'b', count: 5 }] }], // 합 7 != n 3
    });
    fake.stdout.emit('data', Buffer.from(badPayload));
    fake.emit('close', 0, null);
    await assertion;
  });

  it('세마포어 초과 — maxConcurrency(1) 초과 요청은 즉시 StatsEngineBusyError', async () => {
    const p1 = runStatsEngine(req); // 첫 요청 진행 중(close 미발생)
    const fake2 = new FakeChildProcess();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fake2);
    await expect(runStatsEngine(req)).rejects.toBeInstanceOf(StatsEngineBusyError);

    fake.stdout.emit('data', Buffer.from(validStdoutPayload()));
    fake.emit('close', 0, null);
    await p1;
  });

  it('안전 타이머 발동 후 늦게 close가 와도 재확정하지 않고 engineDegraded가 유지된다', async () => {
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineProcessError);

    // 안전 타이머 = timeoutMs + killGraceMs + 5000 = 11000ms
    await vi.advanceTimersByTimeAsync(11000);
    await assertion;

    // 이후 요청은 engineDegraded로 즉시 거부된다(슬롯 반환 안 됐으므로).
    await expect(runStatsEngine(req)).rejects.toBeInstanceOf(StatsEngineDegradedError);

    // 뒤늦게 도착하는 close — 재확정하지 않는지(예외 없이 조용히 처리)만 확인.
    expect(() => fake.emit('close', null, 'SIGKILL')).not.toThrow();
  });

  it('spawn() 자체가 동기적으로 throw해도 슬롯이 누수되지 않는다(8차 검토 §2 핵심)', async () => {
    (spawn as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('EAGAIN: resource temporarily unavailable');
    });
    await expect(runStatsEngine(req)).rejects.toBeInstanceOf(StatsEngineProcessError);

    // 슬롯이 정상 반환됐는지 — 다음 요청은 정상적으로 spawn을 시도할 수 있어야 한다
    // (busy로 영구 거부되면 안 됨).
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(fake);
    const p2 = runStatsEngine(req);
    fake.stdout.emit('data', Buffer.from(validStdoutPayload()));
    fake.emit('close', 0, null);
    await expect(p2).resolves.toBeDefined();
  });

  it('§2.2 의미검증 — 같은 변수의 결과가 중복으로 오면 거부한다(8차 검토 §3 핵심)', async () => {
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    const dup = JSON.parse(validStdoutPayload());
    dup.continuous.push({ ...dup.continuous[0] }); // 같은 variableKey 결과를 2번
    fake.stdout.emit('data', Buffer.from(JSON.stringify(dup)));
    fake.emit('close', 0, null);
    await assertion;
  });

  it('비유한 통계량(Infinity)은 schema에서 거부된다(8차 검토 §4 핵심)', async () => {
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineResultInvalidError);
    // JSON.parse('1e400')는 유효한 JSON 숫자 토큰이 double 표현범위를 넘어 Infinity로
    // 파싱된다 — z.number().finite()가 없으면 이 값이 그대로 통과했었다.
    const raw = validStdoutPayload().replace('"mean":2', '"mean":1e400');
    fake.stdout.emit('data', Buffer.from(raw));
    fake.emit('close', 0, null);
    await assertion;
  });

  it('stderr 상한 초과 — 종료를 시도하고 output_too_large로 거부된다(8차 검토 §6 핵심)', async () => {
    const promise = runStatsEngine(req);
    const assertion = expect(promise).rejects.toBeInstanceOf(StatsEngineOutputTooLargeError);

    fake.stderr.emit('data', Buffer.alloc(2000, 'e')); // stderrMaxBytes(1024) 초과
    expect(fake.kill).toHaveBeenCalledWith('SIGTERM');

    fake.emit('close', null, 'SIGTERM');
    await assertion;
  });
});
