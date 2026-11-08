// P0-13 성능 기준선 ③ — 통계 엔진 기동 vs 계산.
//
// G6 골든 요청 본문(server/src/stats/engine/__tests__/__goldens__/stats-engine-requests.json — 기술통계·층화·이변량 2종·
// OLS 회귀·예측)을 서버와 같은 봉투로 감싸 analyze.py에 넣고, STATS_ENGINE_TIMING=1로 Python이 직접 잰 구간(import·stdin·
// parse·compute·serialize)과 드라이버가 잰 spawn→close 시간을 모은다. 드라이버는 server의 runEngineProcess와
// 같은 방식(스레드 환경변수 1·stdin JSON·stdout 결과)으로 spawn한다.
//
// --container <이름> 이면 그 컨테이너 안에서(운영과 같은 Python·패키지 버전) node 드라이버를 돌린다:
//   node scripts/perf/engine-timing.mjs --container wr-verify-app-1 [--runs 5] [--json out.json]
// 생략하면 이 PC에서 --python(기본 python)·services/stats-engine/analyze.py 로 돈다(패키지 버전이 다를 수 있음).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownTable, median, parseArgs, round } from './lib/perfLib.mjs';

// 컨테이너·로컬 공용 드라이버(CommonJS) — `node -e`로 넘기므로 파일 내용을 문자열로 읽는다.
export const DRIVER_SOURCE = fs.readFileSync(fileURLToPath(new URL('./lib/engineDriver.cjs', import.meta.url)), 'utf8');

/** server/src/stats/engine/subprocess.ts buildEngineTimingLog와 같은 해석(서버 dist에 의존하지 않으려고 복제 — 표식 형식이 바뀌면 둘 다). */
export function parseTiming(driverResult) {
  const m = String(driverResult.stderr ?? '').match(/^STATS_ENGINE_TIMING (\{.*\})\s*$/m);
  const totalMs = driverResult.closeWallMs - driverResult.spawnWallMs;
  if (!m) return { ok: driverResult.code === 0, markerFound: false, totalMs };
  const t = JSON.parse(m[1]);
  return {
    ok: driverResult.code === 0,
    markerFound: true,
    mode: t.mode,
    interpreterStartMs: t.processStartWallMs - driverResult.spawnWallMs,
    importMs: t.importMs, stdinMs: t.stdinMs, parseMs: t.parseMs, computeMs: t.computeMs,
    serializeMs: t.serializeMs, processMs: t.processMs, totalMs,
  };
}

function runDriver({ container, python, script }, body) {
  const input = JSON.stringify(body);
  const cmd = container
    ? spawnSync('docker', ['exec', '-i', container, 'node', '-e', DRIVER_SOURCE, python, script], { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    : spawnSync(process.execPath, ['-e', DRIVER_SOURCE, python, script], { input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (cmd.status !== 0) throw new Error(`driver failed (exit ${cmd.status}): ${cmd.stderr?.slice(0, 500)}`);
  return JSON.parse(cmd.stdout);
}

/** server/src/stats/engine/protocol.ts의 ENGINE_PROTOCOL_VERSION(소스에서 읽어 서버와 어긋나지 않게). */
export function readProtocolVersion(source) {
  const m = String(source).match(/export const ENGINE_PROTOCOL_VERSION = (\d+);/);
  if (!m) throw new Error('ENGINE_PROTOCOL_VERSION not found in server/src/stats/engine/protocol.ts');
  return Number(m[1]);
}

/**
 * G6 골든은 runStatsEngine 류 함수에 넘기는 요청 본문이다. 서버 buildStdinPayload와 같은 봉투로 감싼다:
 * 기술통계 {variables} 그대로 · 이변량 {bivariate} · 회귀 {regression} · 예측 {prediction}.
 */
export function wrapEngineRequest(request, protocolVersion) {
  if (Array.isArray(request?.variables)) return { protocolVersion, variables: request.variables };
  if (typeof request?.method === 'string') return { protocolVersion, bivariate: request };
  if (typeof request?.family === 'string') return { protocolVersion, regression: request };
  if (Array.isArray(request?.outerFolds)) return { protocolVersion, prediction: request };
  throw new Error(`unknown engine request shape: ${Object.keys(request ?? {}).join(',')}`);
}

const FIELDS = ['interpreterStartMs', 'importMs', 'parseMs', 'computeMs', 'serializeMs', 'totalMs'];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = Number(args.runs ?? 5);
  const container = typeof args.container === 'string' ? args.container : null;
  const target = container
    ? { container, python: String(args.python ?? '/opt/stats-venv/bin/python'), script: String(args.script ?? '/app/stats-engine/analyze.py') }
    : { container: null, python: String(args.python ?? 'python'), script: path.resolve(String(args.script ?? 'services/stats-engine/analyze.py')) };
  const goldens = JSON.parse(fs.readFileSync(path.resolve('server/src/stats/engine/__tests__/__goldens__/stats-engine-requests.json'), 'utf8'));
  const protocolVersion = readProtocolVersion(fs.readFileSync(path.resolve('server/src/stats/engine/protocol.ts'), 'utf8'));

  const results = [];
  for (const [name, entry] of Object.entries(goldens)) {
    const list = [];
    for (let i = 0; i < runs; i += 1) list.push(parseTiming(runDriver(target, wrapEngineRequest(entry.request, protocolVersion))));
    const good = list.filter(r => r.ok && r.markerFound);
    const med = Object.fromEntries(FIELDS.map(f => [f, round(median(good.map(r => r[f])))]));
    results.push({ name, mode: good[0]?.mode ?? null, ok: good.length, failed: list.length - good.length, median: med, runs: list });
    process.stderr.write(`  ${name}: ${good.length}/${list.length} 성공\n`);
  }

  console.log(`대상 ${container ? `컨테이너 ${container}` : '이 PC'} · 요청당 ${runs}회 중앙값(ms)`);
  console.log(markdownTable(
    ['요청(G6)', '모드', '성공', '인터프리터 기동', 'import', 'parse', '계산', '직렬화', 'spawn→종료'],
    results.map(r => [r.name, r.mode, `${r.ok}/${r.ok + r.failed}`, ...FIELDS.map(f => r.median[f])]),
  ));
  if (typeof args.json === 'string') fs.writeFileSync(args.json, `${JSON.stringify({ target: container ? 'container' : 'local', runs, results }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
