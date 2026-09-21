// PR4-A1 리뷰 — statsEngine.realWrapper.smoke.test.ts와 같은 이유로, 회귀 경로도
// runRegressionStatsEngine()이 실제 Python 서브프로세스와 왕복하는지 거치는 테스트가
// 하나도 없었다. statsRegressionSuppression.test.ts는 runRegressionStatsEngine 자체를
// mock하므로 Node→Python 요청 페이로드의 실제 필드명(x vs X)까지는 검증하지 못한다 —
// 리뷰로 재현된 "statsEngine.ts가 소문자 x로 보내 Python이 INVALID_INPUT으로 거부"
// 버그가 바로 이 경계를 넘지 않아 기존 테스트에 걸리지 않았다. 이 파일은 mock 없이
// 실제 프로세스를 스폰해 그 경계를 실제로 넘는다.
//
// 실행 조건은 statsEngine.realWrapper.smoke.test.ts와 동일(STATS_ENGINE_PYTHON_FOR_TEST로
// numpy/scipy/statsmodels가 설치된 인터프리터 지정, 미지정 시 PATH의 'python').
// STATS_ENGINE_REQUIRE_PYTHON=1이면 환경이 없을 때 skip 대신 파일 자체가 실패한다.
import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const PYTHON = process.env.STATS_ENGINE_PYTHON_FOR_TEST || 'python';
const SCRIPTS_DIR = path.resolve(__dirname, '../../../services/stats-engine');
const REQUIRE_PYTHON = process.env.STATS_ENGINE_REQUIRE_PYTHON === '1';

function pythonAvailable(): boolean {
  try {
    execFileSync(PYTHON, ['-c', 'import numpy, scipy, jsonschema, statsmodels'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE = pythonAvailable();

if (REQUIRE_PYTHON && !AVAILABLE) {
  throw new Error(
    `STATS_ENGINE_REQUIRE_PYTHON=1인데 ${PYTHON}에 numpy/scipy/jsonschema/statsmodels가 없음 — ` +
    'Node<->Python 회귀 wrapper 실제 연동 검증을 건너뛸 수 없는 환경입니다. venv를 확인할 것.',
  );
}

vi.mock('../config', () => ({
  default: {
    stats: {
      python: PYTHON,
      scriptsDir: SCRIPTS_DIR,
      timeoutMs: 30000,
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

describe.skipIf(!AVAILABLE)('runRegressionStatsEngine — 실제 Python + 실제 운영 wrapper(mock 없음)', () => {
  it('OLS(HC3) 요청이 실제 프로세스를 왕복해 정상 추정 결과를 받는다', async () => {
    const { runRegressionStatsEngine, __resetStatsEngineForTests } = await import('../statsEngine');
    __resetStatsEngineForTests();
    const n = 40;
    const y = Array.from({ length: n }, (_, i) => 2 + 1.5 * i + (i % 3 === 0 ? 0.7 : -0.4));
    const X = Array.from({ length: n }, (_, i) => [1, i]);
    const result = await runRegressionStatsEngine({
      family: 'gaussian',
      y,
      X,
      columnNames: ['intercept', 'x1'],
      covariance: { type: 'hc3' },
    });
    expect(result.estimation).toBe('ok');
    expect(result.terms).toHaveLength(2);
    for (const term of result.terms) {
      expect(Number.isFinite(term.estimate)).toBe(true);
      expect(term.se).not.toBeNull();
      expect(Number.isFinite(term.se as number)).toBe(true);
    }
  }, 30000);

  it('binomial(로지스틱) HC3 요청도 실제 프로세스를 왕복해 정상 추정 결과를 받는다', async () => {
    const { runRegressionStatsEngine, __resetStatsEngineForTests } = await import('../statsEngine');
    __resetStatsEngineForTests();
    const n = 40;
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const x1 = i - n / 2;
      X.push([1, x1]);
      y.push(x1 + (i % 5 === 0 ? -3 : 3) > 0 ? 1 : 0);
    }
    const result = await runRegressionStatsEngine({
      family: 'binomial',
      y,
      X,
      columnNames: ['intercept', 'x1'],
      covariance: { type: 'hc3' },
    });
    expect(['ok', 'inference_withheld']).toContain(result.estimation);
    expect(result.terms).toHaveLength(2);
  }, 30000);
});
