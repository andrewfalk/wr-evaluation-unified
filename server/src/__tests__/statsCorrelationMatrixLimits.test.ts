// PR3-B 계획서 §8 — 상관행렬 입력 상한은 "값 개수(MAX_TOTAL_VALUES)"와
// "직렬화 바이트(config.stats.maxInputBytes)"가 서로 완전히 독립된 두 상한이고,
// 실수 정밀도가 높은 실제 데이터에서는 값 개수 상한보다 바이트 상한이 먼저
// 걸리는 게 일반적이라는 사실(계획서에서 직접 계산으로 확인)을 세 개의 별도
// 테스트로 고정한다 — 하나로 뭉쳐서 "최대 허용"을 검사하면 이 사실이 가려진다.
//
// assertCorrelationMatrixWithinLimits()는 runEngineProcess() 안에서 spawn()보다
// 먼저 동기 호출된다(statsEngine.ts:501 cfg.assertLimits()) — 상한 초과 시
// C(k,2) 순회나 서브프로세스 스폰 전에 즉시 reject되는지도 함께 확인한다.
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
      maxConcurrency: 4,
      maxConcurrentAnalyzeRequests: 4,
      stdoutMaxBytes: 1024 * 1024,
      stderrMaxBytes: 1024,
      maxInputBytes: 2 * 1024 * 1024, // 운영 기본값(2MiB)과 동일 — §8 바이트 계산의 기준.
      resultTtlHours: 168,
    },
  },
}));

import { spawn } from 'child_process';
import config from '../config';
import {
  runCorrelationMatrixStatsEngine,
  StatsEngineInputTooLargeError,
  __resetStatsEngineForTests,
  type CorrelationMatrixEngineRequest,
} from '../statsEngine';
import { MAX_TOTAL_VALUES, MAX_VALUES_PER_VARIABLE } from '../statsEngineLimits';

class FakeChildProcess extends EventEmitter {
  stdin = Object.assign(new EventEmitter(), { end: vi.fn(), write: vi.fn() });
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn((_signal?: string) => true);
}

function makeVariables(k: number, rows: number, fill: (i: number) => number): CorrelationMatrixEngineRequest['variables'] {
  const values = Array.from({ length: rows }, (_, i) => fill(i));
  return Array.from({ length: k }, (_, vi_) => ({ key: `v${vi_}`, values: [...values] }));
}

function validCorrelationMatrixStdout(variables: CorrelationMatrixEngineRequest['variables']): string {
  const cells: unknown[] = [];
  const rows = variables[0]?.values.length ?? 0;
  for (let i = 0; i < variables.length; i += 1) {
    for (let j = i + 1; j < variables.length; j += 1) {
      cells.push({
        xKey: variables[i].key, yKey: variables[j].key,
        n: rows, r: 0.5, pValue: 0.01, adjustedP: 0.01,
      });
    }
  }
  return JSON.stringify({
    protocolVersion: 3,
    correlationMatrix: { method: 'pearson_correlation', cells },
  });
}

const originalMaxInputBytes = config.stats.maxInputBytes;

function setMaxInputBytes(value: number): void {
  (config.stats as { maxInputBytes: number }).maxInputBytes = value;
}

describe('runCorrelationMatrixStatsEngine — §8 입력 상한 (3종 분리 테스트)', () => {
  let fake: FakeChildProcess;

  beforeEach(() => {
    __resetStatsEngineForTests();
    fake = new FakeChildProcess();
    (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(fake);
  });

  afterEach(() => {
    setMaxInputBytes(originalMaxInputBytes);
  });

  it('값 개수 초과 — 각 변수는 MAX_VALUES_PER_VARIABLE 이내이지만 합이 MAX_TOTAL_VALUES를 넘으면 spawn 전에 거부된다', async () => {
    // 8개 변수 × 50,000(=MAX_VALUES_PER_VARIABLE, 초과 아님) = 400,000 > 350,000(MAX_TOTAL_VALUES).
    // 값 자체는 바이트 상한과 무관하게 만들기 위해 짧은 정수(1)만 사용 — 이 테스트가
    // 순수하게 "총 개수" 분기만 검사하도록 바이트 분기가 걸릴 여지를 없앤다.
    const rows = MAX_VALUES_PER_VARIABLE;
    expect(8 * rows).toBeGreaterThan(MAX_TOTAL_VALUES);
    const variables = makeVariables(8, rows, () => 1);
    const request: CorrelationMatrixEngineRequest = { method: 'pearson_correlation', variables };

    await expect(runCorrelationMatrixStatsEngine(request)).rejects.toBeInstanceOf(StatsEngineInputTooLargeError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('바이트 크기 초과 — 값 개수는 상한 이내여도 직렬화 바이트가 maxInputBytes를 넘으면 spawn 전에 거부된다', async () => {
    // 값 개수는 3개뿐(MAX_TOTAL_VALUES와 전혀 무관)이지만, maxInputBytes를 인위적으로
    // 아주 작게 낮춰 바이트 분기만 독립적으로 걸리게 한다(값개수 분기와 섞지 않음).
    setMaxInputBytes(10);
    const variables = makeVariables(3, 1, (i) => i + 0.5);
    const request: CorrelationMatrixEngineRequest = { method: 'pearson_correlation', variables };

    await expect(runCorrelationMatrixStatsEngine(request)).rejects.toBeInstanceOf(StatsEngineInputTooLargeError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('두 상한을 모두 통과하는 범위 안의 최대급 입력 — 정상 처리되고 합리적인 시간 안에 끝난다', async () => {
    // k=20(변수 선택 상한, StatsAnalysisRecipeSchema.variableKeys.max(20))×rows=7050,
    // 소수점 9자리 실수(계획서 §8이 실제로 계산한 최악 경로 예시와 동일한 자릿수)로
    // 채워 실측: 총 141,000값(<350,000) & 직렬화 바이트 약 2,093,378B(<2,097,152B) —
    // 두 상한 모두 통과하는 조합 중 바이트 상한에 근접한 실사용급 크기.
    const k = 20;
    const rows = 7050;
    const variables = makeVariables(k, rows, (i) => i + 0.123456789);
    const request: CorrelationMatrixEngineRequest = { method: 'pearson_correlation', variables };

    const payloadBytes = Buffer.byteLength(JSON.stringify({ protocolVersion: 3, correlationMatrix: request }), 'utf8');
    expect(k * rows).toBeLessThan(MAX_TOTAL_VALUES);
    expect(payloadBytes).toBeLessThan(config.stats.maxInputBytes);

    const start = performance.now();
    const promise = runCorrelationMatrixStatsEngine(request);
    expect(spawn).toHaveBeenCalledTimes(1); // 상한 통과 → 실제로 spawn까지 진행됨(§8 "순회 시작 전 검사"의 반대 확인)
    fake.stdout.emit('data', Buffer.from(validCorrelationMatrixStdout(variables)));
    fake.emit('close', 0, null);
    const result = await promise;
    const elapsedMs = performance.now() - start;

    expect(result.cells.length).toBe((k * (k - 1)) / 2);
    // 정확한 성능 기준선이 아니라 "C(k,2) 순회가 실수로 다항식 폭발하지 않았는지"를
    // 잡는 관대한 상한선 — Node 측 의미검증(190쌍×7050행 순회)만 측정 대상이다
    // (실제 Python 서브프로세스는 FakeChildProcess로 대체돼 있어 계산 비용은 없음).
    expect(elapsedMs).toBeLessThan(2000);
  });
});
