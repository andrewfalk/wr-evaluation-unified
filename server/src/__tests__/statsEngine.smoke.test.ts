// PR1 계획서 §9-item3 — 실제 Python(mock 없이)으로 stdin 전송·UTF-8(한글 ordinal 값)·
// stdout 파싱·정상 종료까지 실측한다. statsEngine.test.ts는 child_process를 mock해서
// Node 쪽 프로세스 생명주기 로직만 검증하므로, Node↔Python 경계 자체(실제 인코딩·실제
// 프로세스 spawn·실제 numpy/scipy 계산)는 이 테스트에서만 증명된다.
//
// 실행 조건: services/stats-engine에 numpy/scipy/jsonschema가 설치된 Python이 있어야
// 한다(로컬 venv 또는 시스템 Python). STATS_ENGINE_PYTHON_FOR_TEST로 인터프리터 경로를
// 지정할 수 있고, 미지정 시 'python'을 PATH에서 찾는다 — 그것도 없거나 numpy/scipy가
// 없으면 이 파일 전체를 skip한다(statsSnapshot.integration.test.ts와 동일한 "환경 없으면
// skip" 컨벤션).
//
//   STATS_ENGINE_PYTHON_FOR_TEST="C:\Python314\python.exe" \
//     npx vitest run --config vitest.config.ts src/__tests__/statsEngine.smoke.test.ts
//
// 이 테스트가 skip 없이 실행되는 것을 최소 하나의 경로에서는 강제해야 한다(계획서
// §9-item3/gap표 항목6) — 배포 체크리스트(§7.4/§8.3)에 "Docker 이미지 빌드 후 이
// 테스트를 STATS_ENGINE_PYTHON_FOR_TEST=/opt/stats-venv/bin/python로 최소 1회 skip
// 없이 실행"을 명시적 단계로 추가할 것. 로컬 dev에서도 Python venv를 셋업했다면 항상
// 실행되므로, "환경이 없어서 계속 skip된다"는 상태 자체를 만들지 않는 것이 원칙이다.
import { describe, expect, it, beforeAll } from 'vitest';
import { execFileSync } from 'child_process';
import path from 'path';

const PYTHON = process.env.STATS_ENGINE_PYTHON_FOR_TEST || 'python';
const SCRIPTS_DIR = path.resolve(__dirname, '../../../services/stats-engine');

function pythonAvailable(): boolean {
  try {
    execFileSync(PYTHON, ['-c', 'import numpy, scipy, jsonschema'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const AVAILABLE = pythonAvailable();
const REQUIRE_PYTHON = process.env.STATS_ENGINE_REQUIRE_PYTHON === '1';

// 9차 검토 §2 필수 수정 — STATS_ENGINE_REQUIRE_PYTHON=1이면 skip 대신 이 파일 자체가
// 실패한다(모듈 최상위에서 throw). Docker 이미지 검증·향후 CI에서 이 플래그를 켜서
// "환경이 없어서 계속 조용히 skip된다"는 상태가 성립할 수 없게 한다.
if (REQUIRE_PYTHON && !AVAILABLE) {
  throw new Error(
    `STATS_ENGINE_REQUIRE_PYTHON=1인데 ${PYTHON}에 numpy/scipy/jsonschema가 없음 — ` +
    'Python 자체 검증을 건너뛸 수 없는 환경입니다. venv를 확인할 것.',
  );
}

describe.skipIf(!AVAILABLE)('statsEngine <-> analyze.py 실제 프로세스 (smoke)', () => {
  beforeAll(() => {
    if (!AVAILABLE) {
      console.warn(
        `[statsEngine.smoke.test] skipped — ${PYTHON}에 numpy/scipy/jsonschema가 없음. ` +
        'STATS_ENGINE_PYTHON_FOR_TEST로 numpy/scipy가 설치된 인터프리터를 지정할 것.',
      );
    }
  });

  function runReal(stdin: string): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(PYTHON, [path.join(SCRIPTS_DIR, 'analyze.py')], {
        input: stdin, encoding: 'utf8', timeout: 30000,
      });
      return { code: 0, stdout, stderr: '' };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  it('실제 stdin JSON을 받아 실제 stdout JSON을 반환한다(mock 없음)', () => {
    const request = {
      protocolVersion: 3,
      variables: [
        { key: 'v1', kind: 'continuous', values: [10, 20, 30, 40, 50] },
        { key: 'v2', kind: 'discrete', values: ['a', 'b', 'a'] },
      ],
    };
    const { code, stdout, stderr } = runReal(JSON.stringify(request));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.continuous[0].n).toBe(5);
    expect(parsed.continuous[0].mean).toBe(30);
    expect(parsed.discrete[0].n).toBe(3);
  });

  it('한글 ordinal 값이 UTF-8로 손상 없이 왕복한다(§9-item3 요구)', () => {
    const request = {
      protocolVersion: 3,
      variables: [{ key: 'grade', kind: 'discrete', values: ['중등도', '경도', '고도', '중등도'] }],
    };
    const { code, stdout } = runReal(JSON.stringify(request));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    const levels = Object.fromEntries(parsed.discrete[0].levels.map((l: { level: string; count: number }) => [l.level, l.count]));
    expect(levels).toEqual({ '중등도': 2, '경도': 1, '고도': 1 });
  });

  it('잘못된 입력은 exit 1 + STATS_ENGINE_ERROR 마커를 stderr에 낸다', () => {
    const { code, stdout, stderr } = runReal('not valid json');
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^STATS_ENGINE_ERROR /);
    const marker = JSON.parse(stderr.replace(/^STATS_ENGINE_ERROR /, '').trim());
    expect(marker.code).toBe('INVALID_INPUT');
  });

  it('--selfcheck는 exit 0으로 끝난다', () => {
    expect(() => execFileSync(PYTHON, [path.join(SCRIPTS_DIR, 'analyze.py'), '--selfcheck'], { stdio: 'pipe' })).not.toThrow();
  });

  // PR3-B — protocolVersion 3(histogram/boxplot/correlationMatrix)이 실제 Python
  // 프로세스와 왕복하는지(mock 없음).
  it('연속형 결과에 histogram/boxplot이 실제로 배선된다', () => {
    const request = {
      protocolVersion: 3,
      variables: [{ key: 'v1', kind: 'continuous', values: [1, 2, 3, 4, 5, 100] }],
    };
    const { code, stdout, stderr } = runReal(JSON.stringify(request));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.continuous[0].histogram.bins.length).toBeGreaterThan(0);
    expect(parsed.continuous[0].boxplot.outlierCount).toBe(1);
  });

  it('상관행렬 요청이 실제 Python 프로세스를 왕복해 모든 쌍을 반환한다', () => {
    const request = {
      protocolVersion: 3,
      correlationMatrix: {
        method: 'pearson_correlation',
        variables: [
          { key: 'a', values: [1, 2, 3, 4, 5] },
          { key: 'b', values: [2, 4, 6, 8, 10] },
          { key: 'c', values: [5, 3, 1, 2, 4] },
        ],
      },
    };
    const { code, stdout, stderr } = runReal(JSON.stringify(request));
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.correlationMatrix.cells).toHaveLength(3);
  });

  // §8 성능 실측(코드리뷰 지적 — 지금까지 statsCorrelationMatrixLimits.test.ts의
  // 성능 테스트는 FakeChildProcess로 Node 측 검증 로직 비용만 쟀지, 실제 Python
  // numpy/scipy 계산 비용은 한 번도 실측하지 않았다). 여기서는 이 파일의 다른
  // 테스트와 동일하게 mock 없이 진짜 analyze.py 프로세스를 스폰한다.
  //
  // heap(피크 메모리) 측정은 여기서 하지 않는다 — execFileSync는 동기 호출이라
  // 자식 프로세스를 실행 중에 옆에서 폴링할 수 없고, Node에 자식 프로세스의
  // OS 레벨 RSS를 크로스플랫폼으로 얻는 표준 수단이 없다(PR1이 이 문제를 이미
  // 겪었고, 그때도 단위테스트가 아니라 Docker+`docker stats`라는 별도 운영 검증
  // 절차로 풀었다 — project_pr1_progress.md 참고). 즉 heap 실측은 자동화된
  // 테스트의 몫이 아니라 Docker 기반 운영 검증 절차의 몫이라는 게 PR1 때부터의
  // 결론이고, 여기서도 같은 결론을 따른다(거짓 숫자를 만들어 넣지 않음).
  function runCorrelationMatrixPerf(label: string, variables: Array<{ key: string; values: number[] }>) {
    const k = variables.length;
    const rows = variables[0].values.length;
    const request = { protocolVersion: 3, correlationMatrix: { method: 'spearman_correlation', variables } };
    const stdin = JSON.stringify(request);
    const byteLength = Buffer.byteLength(stdin, 'utf8');
    expect(k * rows).toBeLessThanOrEqual(350_000); // MAX_TOTAL_VALUES
    expect(byteLength).toBeLessThanOrEqual(2 * 1024 * 1024); // config.stats.maxInputBytes 기본값

    const start = Date.now();
    const { code, stdout, stderr } = runReal(stdin);
    const elapsedMs = Date.now() - start;

    expect(stderr).toBe('');
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.correlationMatrix.cells).toHaveLength((k * (k - 1)) / 2);

    console.log(`[§8 실측: ${label}] k=${k} rows=${rows} totalValues=${k * rows} bytes=${byteLength} → 실제 Python 왕복 ${elapsedMs}ms`);
    return elapsedMs;
  }

  // 코드리뷰 지적(2026-09-12) — 처음엔 "소수점 9자리 실수 k=20/rows=7,062"만
  // "이 스키마로 만들 수 있는 가장 비싼 정상 요청"이라고 잘못 단정했다. 리뷰가
  // 정수 입력으로 실측: k=20×rows=17,500(정확히 MAX_TOTAL_VALUES=350,000, 값
  // 개수 상한 자체에 닿음)도 1,878,379바이트로 바이트 상한(2,097,152)을 통과한다
  // — 즉 값 자체의 자릿수(정밀도)에 따라 "바이트 상한이 먼저 걸리는 지점"이
  // 달라지고, 정수처럼 자릿수가 짧으면 값개수 상한(350,000, rows=7,062의 2.48배)
  // 까지 그대로 채울 수 있어 실제 계산량(변수쌍 190개×벡터 길이 17,500)이 훨씬
  // 크다. 두 케이스를 각각 별도로 실측해 어느 쪽이 "이 스키마의 진짜 최댓값"인지
  // 숫자로 직접 비교한다 — 하나만 보고 "이게 최댓값"이라고 다시 단정하지 않는다.
  it('§8 — 고정밀 소수값 k=20/rows=7,062(바이트 상한이 먼저 걸리는 지점)의 실제 Python 왕복 시간', () => {
    const variables = Array.from({ length: 20 }, (_, vi) => ({
      key: `v${vi}`,
      values: Array.from({ length: 7062 }, (_, i) => i + 0.123456789),
    }));
    const elapsedMs = runCorrelationMatrixPerf('고정밀 소수(바이트 상한 경계)', variables);
    // 정밀 벤치마크가 아니라 회귀 감시용 관대한 상한선 — statsEngine.ts의
    // timeoutMs 기본값(30s)보다 훨씬 널널하게 잡는다.
    expect(elapsedMs).toBeLessThan(10_000);
  });

  it('§8 — 정수값 k=20/rows=17,500(MAX_TOTAL_VALUES=350,000 자체에 닿는 진짜 최댓값)의 실제 Python 왕복 시간', () => {
    const variables = Array.from({ length: 20 }, (_, vi) => ({
      key: `v${vi}`,
      values: Array.from({ length: 17_500 }, (_, i) => i),
    }));
    const elapsedMs = runCorrelationMatrixPerf('정수(값개수 상한 자체)', variables);
    expect(elapsedMs).toBeLessThan(10_000);
  });
});
