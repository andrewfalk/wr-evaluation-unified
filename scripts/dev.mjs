// 공유 패키지 watch 빌드 + 개발 도구 실행기 (REFACTORING_ROADMAP P0-7 W4).
//
// 클라이언트와 루트 테스트는 @wr/contracts·@wr/analytics-core를 별칭 없이 dist로 해석한다(always-dist).
// 그래서 shared/contracts·packages/analytics-core 소스를 고치면 dist가 다시 빌드돼야 Vite·vitest가 바뀐
// 내용을 본다. 이 스크립트는 두 패키지의 tsup --watch와 지정한 도구(vite 또는 vitest)를 함께 띄우고,
// 하나라도 끝나면 나머지도 끈다. 첫 빌드는 npm의 pre 스크립트(predev·pretest:watch)가 한다.
//
//   npm run dev [-- <vite 인자>]          → node scripts/dev.mjs vite …
//   npm run test:watch [-- <vitest 인자>] → node scripts/dev.mjs vitest …
//
// 셸을 거치지 않는다(shell: false) — 각 도구의 bin 스크립트를 현재 node로 직접 실행해, 공백이 든 경로 같은
// 인자의 경계가 Windows에서도 그대로 전달된다.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(repoRoot, 'package.json'));

/** 패키지의 bin 스크립트 절대 경로(package.json "bin"이 문자열이거나 이름별 객체). */
export function binPath(pkgName, binName = pkgName) {
  const pkgJsonPath = require.resolve(`${pkgName}/package.json`);
  const pkg = require(pkgJsonPath);
  const rel = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[binName];
  if (!rel) throw new Error(`${pkgName} has no "${binName}" bin`);
  return resolve(dirname(pkgJsonPath), rel);
}

const TOOLS = { vite: ['vite', 'vite'], vitest: ['vitest', 'vitest'] };

function main() {
  const [tool, ...toolArgs] = process.argv.slice(2);
  if (!TOOLS[tool]) {
    console.error(`usage: node scripts/dev.mjs <${Object.keys(TOOLS).join('|')}> [args…]`);
    process.exit(2);
  }
  const children = [];
  let stopping = false;
  const stopAll = (code = 0) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) {
      if (child.exitCode !== null) continue;
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
    process.exit(code);
  };
  const start = (label, args, cwd) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', shell: false });
    child.on('exit', (code, signal) => {
      if (stopping) return;
      console.error(`[dev] ${label} 종료(${signal ?? code}) — 나머지도 끕니다`);
      stopAll(code ?? 1);
    });
    children.push(child);
  };
  process.on('SIGINT', () => stopAll(0));
  process.on('SIGTERM', () => stopAll(0));

  const tsup = binPath('tsup', 'tsup');
  start('@wr/contracts watch', [tsup, '--watch'], resolve(repoRoot, 'shared'));
  start('@wr/analytics-core watch', [tsup, '--watch'], resolve(repoRoot, 'packages', 'analytics-core'));
  const [pkg, bin] = TOOLS[tool];
  start(tool, [binPath(pkg, bin), ...toolArgs], repoRoot);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
