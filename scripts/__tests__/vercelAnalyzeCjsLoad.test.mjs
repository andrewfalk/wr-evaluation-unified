import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Vercel 함수(api/analyze.js)가 "배포 환경에서만" 깨지는 부류를 막는 테스트다. 다른 테스트는 vitest(네이티브 ESM)에서
// 함수를 불러서, Vercel이 이 파일을 CommonJS로 변환할 때 생기는 문제(import → require)를 보지 못한다.
// 실제로 shared/dist/*.js(ESM)를 import했다가 Node 20.18·22.11에서 ERR_REQUIRE_ESM으로 FUNCTION_INVOCATION_FAILED가 났다.
// 여기서는 require(esm)을 끈 Node에서, 함수 파일만 CJS로 변환해 로드하고 핸들러를 한 번 호출한다.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const LOADER = path.join(HERE, 'vercelFunctionCjsLoader.cjs');
const FUNCTION_FILE = path.join(ROOT, 'api', 'analyze.js');

function nodeRun(args) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
}

// require(esm)을 끌 수 있는 Node(20.19+, 22.12+ 등)면 플래그로 끄고, 그보다 옛 Node는 원래 지원하지 않으므로 그대로 쓴다.
const NO_REQUIRE_ESM = nodeRun(['--no-experimental-require-module', '-e', '0']).status === 0
  ? ['--no-experimental-require-module']
  : [];

const lastJson = (stdout) => JSON.parse(stdout.trim().split('\n').filter(Boolean).pop());

describe('Vercel 함수는 CommonJS로 변환돼도 로드되고 동작한다', () => {
  it('전제: 이 환경에서 shared/dist/*.js(ESM)는 require할 수 없다 — 아래 테스트가 의미를 갖는 조건', () => {
    const esmContract = path.join(ROOT, 'shared', 'dist', 'aiModels.js');
    const result = nodeRun([...NO_REQUIRE_ESM, '-e', `try { require(${JSON.stringify(esmContract)}); console.log('LOADED'); } catch (e) { console.log(e.code); }`]);
    expect(result.stdout.trim()).toBe('ERR_REQUIRE_ESM');
  });

  it('api/analyze.js를 CJS로 변환해 로드하고(require(esm) 없이) 핸들러를 호출하면 서버가 조립한 프롬프트로 업스트림을 부른다', () => {
    const result = nodeRun([...NO_REQUIRE_ESM, LOADER, FUNCTION_FILE]);
    const out = lastJson(result.stdout);
    // 실패 시 단계(load/handler/invoke)와 오류 코드가 그대로 드러나도록 객체 전체를 비교한다.
    expect(out).toEqual({ stage: 'ok', status: 200, text: '가짜 분석', upstreamCalls: 1, promptSent: true });
    expect(result.status).toBe(0);
  });
});
