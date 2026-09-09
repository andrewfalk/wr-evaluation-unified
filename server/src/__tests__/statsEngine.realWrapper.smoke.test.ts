// PR1 계획서 §9-item3 — 9차 검토 §2 필수 수정. statsEngine.smoke.test.ts는 analyze.py를
// execFileSync로 직접 호출해 Python 스크립트 자체는 검증하지만, 운영 코드가 실제로 쓰는
// server/src/statsEngine.ts의 runStatsEngine()(세마포어·close 기반 생명주기·zod
// 재검증·§2.2 의미검증)은 전혀 거치지 않는다 — Node↔Python "wrapper" 경로 자체가
// 실제로 동작하는지는 이 파일에서만 증명한다(다른 statsEngine.test.ts는 child_process를
// mock하므로 이 경계를 넘지 않는다).
//
// 실행 조건은 statsEngine.smoke.test.ts와 동일(STATS_ENGINE_PYTHON_FOR_TEST로 numpy/scipy가
// 설치된 인터프리터 지정, 미지정 시 PATH의 'python'). 환경이 없으면 이 파일 전체가
// skip되는데, 그 상태가 "계속 조용히 skip되는" 것을 막기 위해 STATS_ENGINE_REQUIRE_PYTHON=1을
// 설정하면 환경이 없을 때 skip 대신 **테스트 파일 자체가 실패**한다 — Docker 이미지
// 검증·향후 CI에서는 이 플래그를 켜서 "환경이 없어서 검증을 못 했다"가 조용히 넘어가지
// 않게 한다(계획서 §9-item3/gap표 항목6, 8차 검토가 지적한 "필수 실행 경로 미보장" 수정).
//
//   STATS_ENGINE_PYTHON_FOR_TEST="C:\Python314\python.exe" STATS_ENGINE_REQUIRE_PYTHON=1 \
//     npx vitest run --config vitest.config.ts src/__tests__/statsEngine.realWrapper.smoke.test.ts
import { execFileSync } from 'child_process';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

const PYTHON = process.env.STATS_ENGINE_PYTHON_FOR_TEST || 'python';
const SCRIPTS_DIR = path.resolve(__dirname, '../../../services/stats-engine');
const REQUIRE_PYTHON = process.env.STATS_ENGINE_REQUIRE_PYTHON === '1';

function pythonAvailable(): boolean {
  try {
    execFileSync(PYTHON, ['-c', 'import numpy, scipy, jsonschema'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE = pythonAvailable();

if (REQUIRE_PYTHON && !AVAILABLE) {
  // 모듈 최상위에서 던진다 — describe.skipIf처럼 조용히 건너뛰지 않고 이 파일 전체를
  // 실패로 만든다. Docker 이미지 검증·CI에서 이 플래그를 켜두면 "환경이 없어서 계속
  // skip됐다"는 상태 자체가 성립할 수 없다.
  throw new Error(
    `STATS_ENGINE_REQUIRE_PYTHON=1인데 ${PYTHON}에 numpy/scipy/jsonschema가 없음 — ` +
    'Node<->Python wrapper 실제 연동 검증을 건너뛸 수 없는 환경입니다. venv를 확인할 것.',
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

describe.skipIf(!AVAILABLE)('runStatsEngine — 실제 Python + 실제 운영 wrapper(mock 없음)', () => {
  it('세마포어·close 기반 생명주기·zod 재검증·§2.2 의미검증을 전부 거쳐 실제 프로세스로부터 정상 결과를 받는다', async () => {
    const { runStatsEngine, __resetStatsEngineForTests } = await import('../statsEngine');
    __resetStatsEngineForTests();

    const result = await runStatsEngine({
      variables: [
        { key: 'v1', kind: 'continuous', values: [10, 20, 30, 40, 50] },
        { key: 'grade', kind: 'discrete', values: ['중등도', '경도', '고도', '중등도'] },
      ],
    });

    expect(result.continuous[0].variableKey).toBe('v1');
    expect(result.continuous[0].n).toBe(5);
    expect(result.continuous[0].mean).toBe(30);
    expect(result.discrete[0].variableKey).toBe('grade');
    expect(result.discrete[0].n).toBe(4);
  });

  it('연속으로 두 번 호출해도(세마포어 순차 반환) 둘 다 정상 완료된다', async () => {
    const { runStatsEngine, __resetStatsEngineForTests } = await import('../statsEngine');
    __resetStatsEngineForTests();

    const r1 = await runStatsEngine({ variables: [{ key: 'a', kind: 'continuous', values: [1, 2, 3] }] });
    const r2 = await runStatsEngine({ variables: [{ key: 'b', kind: 'continuous', values: [4, 5, 6] }] });
    expect(r1.continuous[0].mean).toBe(2);
    expect(r2.continuous[0].mean).toBe(5);
  });
});
