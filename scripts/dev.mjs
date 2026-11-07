// `npm run dev` — 공유 패키지 watch 빌드 + Vite 개발 서버 (REFACTORING_ROADMAP P0-7 W4).
//
// 클라이언트는 @wr/contracts·@wr/analytics-core를 별칭 없이 dist로 해석한다(always-dist). 그래서 개발 중
// shared/contracts·packages/analytics-core 소스를 고치면 dist가 다시 빌드돼야 Vite가 바뀐 내용을 본다.
// predev가 한 번 빌드한 뒤, 여기서 두 패키지의 tsup --watch와 vite를 함께 띄운다. 하나라도 끝나면 나머지도 끈다.
//
//   npm run dev            (= node scripts/dev.mjs, 추가 인자는 vite로 전달)
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';

const children = [];

function start(label, command, args) {
  const child = spawn(command, args, { cwd: repoRoot, stdio: 'inherit', shell: isWin });
  child.on('exit', (code, signal) => {
    if (stopping) return;
    console.error(`[dev] ${label} 종료(${signal ?? code}) — 나머지도 끕니다`);
    stopAll(code ?? 1);
  });
  children.push(child);
  return child;
}

let stopping = false;
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode !== null) continue;
    if (isWin) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

// tsup --watch는 첫 빌드를 다시 하므로 predev 직후 한 번 더 빌드되지만, 시작 순서를 맞출 필요가 없어 단순하다.
start('@wr/contracts watch', 'npm', ['run', 'build', '--workspace', '@wr/contracts', '--', '--watch']);
start('@wr/analytics-core watch', 'npm', ['run', 'build', '--workspace', '@wr/analytics-core', '--', '--watch']);
start('vite', 'npx', ['vite', ...process.argv.slice(2)]);
