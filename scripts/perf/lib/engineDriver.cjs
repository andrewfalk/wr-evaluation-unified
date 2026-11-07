// engine-timing.mjs의 드라이버 — 컨테이너 안(`docker exec -i <app> node -e <이 파일 내용>`)과 이 PC에서 같은 코드로
// analyze.py를 spawn한다(server runEngineProcess와 같은 스레드 환경변수 1·stdin JSON). argv: python, script.
// stdin: 엔진 요청 JSON. stdout: {code, spawnWallMs, closeWallMs, stdoutBytes, stderr} 한 줄.
/* eslint-disable */
const { spawn } = require('child_process');
const [python, script] = process.argv.slice(1);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  const env = { ...process.env, STATS_ENGINE_TIMING: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1',
    MKL_NUM_THREADS: '1', NUMEXPR_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' };
  const spawnWallMs = Date.now();
  const child = spawn(python, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdoutBytes = 0; let stderr = '';
  child.stdout.on('data', c => { stdoutBytes += c.length; });
  child.stderr.on('data', c => { stderr += c; });
  child.on('close', code => {
    process.stdout.write(JSON.stringify({ code, spawnWallMs, closeWallMs: Date.now(), stdoutBytes, stderr: stderr.slice(0, 4000) }));
  });
  child.stdin.end(input);
});
