// PR4-B2 — statsRegressionEngine.realWrapper.smoke.test.ts와 같은 이유: mock 없이
// runPredictionStatsEngine()이 실제 Python 서브프로세스(prediction.py)와 왕복하는지
// 거치는 테스트가 필요하다. buildPredictionEngineRequest가 만든 요청이 실제 필드명
// (X 대문자, groups/outerFolds shape 등)까지 Python 쪽과 맞는지는 이 경계를 실제로
// 넘어야만 검증된다. prediction.py는 numpy만 있으면 되므로(statsmodels 불필요)
// STATS_ENGINE_PYTHON_FOR_TEST 없이도 로컬 인터프리터로 실행 가능하다.
import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import { PREDICTION_POLICY } from '../statsPolicy';
import { assignPredictionOuterFolds } from '../statsPredictionCohort';

const PYTHON = process.env.STATS_ENGINE_PYTHON_FOR_TEST || 'python';
const SCRIPTS_DIR = path.resolve(__dirname, '../../../services/stats-engine');
const REQUIRE_PYTHON = process.env.STATS_ENGINE_REQUIRE_PYTHON === '1';

function pythonAvailable(): boolean {
  try {
    execFileSync(PYTHON, ['-c', 'import numpy, jsonschema'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE = pythonAvailable();

if (REQUIRE_PYTHON && !AVAILABLE) {
  throw new Error(
    `STATS_ENGINE_REQUIRE_PYTHON=1인데 ${PYTHON}에 numpy/jsonschema가 없음 — ` +
    'Node<->Python 예측 wrapper 실제 연동 검증을 건너뛸 수 없는 환경입니다.',
  );
}

vi.mock('../config', () => ({
  default: {
    stats: {
      python: PYTHON,
      scriptsDir: SCRIPTS_DIR,
      timeoutMs: 60000,
      killGraceMs: 2000,
      maxConcurrency: 1,
      maxConcurrentAnalyzeRequests: 4,
      stdoutMaxBytes: 10 * 1024 * 1024,
      stderrMaxBytes: 64 * 1024,
      maxInputBytes: 2 * 1024 * 1024,
      resultTtlHours: 168,
    },
  },
}));

function makeSyntheticRequest(n: number, p: number, seed: number) {
  // 결정적 합성 자료 — outcome은 첫 predictor에 강하게 의존(추정 가능한 신호).
  const y: number[] = [];
  const X: number[][] = [];
  const groups: string[] = [];
  let state = seed;
  const rand = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  for (let i = 0; i < n; i++) {
    const row = Array.from({ length: p }, () => rand() * 2 - 1);
    X.push(row);
    const eta = -0.1 + 1.8 * row[0] - 0.5 * row[1];
    const prob = 1 / (1 + Math.exp(-eta));
    y.push(rand() < prob ? 1 : 0);
    groups.push(`person-${i}`);
  }
  return { y, X, groups };
}

describe.skipIf(!AVAILABLE)('runPredictionStatsEngine — 실제 Python + 실제 운영 wrapper(mock 없음)', () => {
  it('정상 요청이 실제 프로세스를 왕복해 estimation:ok 결과를 받는다', async () => {
    const { runPredictionStatsEngine, buildPredictionEngineRequest, __resetStatsEngineForTests } = await import('../statsEngine');
    __resetStatsEngineForTests();

    const n = 150;
    const p = 3;
    const { y, X, groups } = makeSyntheticRequest(n, p, 42);

    const strata = new Map<string, 0 | 1>();
    groups.forEach((g, i) => strata.set(g, y[i] === 1 ? 1 : 0));
    const outerFoldAssignment = assignPredictionOuterFolds(strata, 3, 4, 'smoke-test-digest');

    const request = buildPredictionEngineRequest({
      y, x: X, columnNames: ['x1', 'x2', 'x3'], groups, outerFoldAssignment, outerFoldCount: 4,
    });
    // 실측 시간 절약을 위해 스모크 테스트는 정책 기본값보다 훨씬 작은 bootstrap/격자를 쓴다.
    request.config.lambdaGrid = [0.001, 0.01, 0.1, 1.0];
    request.config.bootstrapReplicates = 10;
    request.config.aucCiReplicates = 10;

    const result = await runPredictionStatsEngine(request);
    expect(result.estimation).toBe('ok');
    expect(result.lambdaSelected).not.toBeNull();
    expect(result.coefficients).toHaveLength(p);
    expect(result.oofRepresentative).toHaveLength(n);
    const rocAuc = result.metrics.roc_auc!;
    expect(rocAuc.apparent).not.toBeNull();
    expect(Number.isFinite(rocAuc.apparent as number)).toBe(true);
  }, 60000);

  it('buildPredictionEngineRequest가 만든 config를 그대로 써도(정책 기본값) 왕복한다', async () => {
    const { runPredictionStatsEngine, buildPredictionEngineRequest, __resetStatsEngineForTests } = await import('../statsEngine');
    __resetStatsEngineForTests();

    const n = 80;
    const p = 2;
    const { y, X, groups } = makeSyntheticRequest(n, p, 7);
    const strata = new Map<string, 0 | 1>();
    groups.forEach((g, i) => strata.set(g, y[i] === 1 ? 1 : 0));
    const outerFoldAssignment = assignPredictionOuterFolds(strata, PREDICTION_POLICY.repeats, PREDICTION_POLICY.outerFolds, 'smoke-2');

    const request = buildPredictionEngineRequest({
      y, x: X, columnNames: ['x1', 'x2'], groups, outerFoldAssignment, outerFoldCount: PREDICTION_POLICY.outerFolds,
    });
    expect(request.outerFolds).toHaveLength(PREDICTION_POLICY.repeats);
    expect(request.config.lambdaGrid).toHaveLength(PREDICTION_POLICY.lambdaGridSize);

    const result = await runPredictionStatsEngine(request, { timeoutMs: 60000 });
    expect(['ok', 'non_estimable']).toContain(result.estimation);
  }, 90000);
});
