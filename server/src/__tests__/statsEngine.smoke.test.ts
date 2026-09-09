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
      protocolVersion: 1,
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
      protocolVersion: 1,
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
});
