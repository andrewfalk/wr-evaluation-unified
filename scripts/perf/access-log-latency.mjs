// P0-13 성능 기준선 ② (선택, 운영 수치) — Caddy JSON access log의 `duration`을 라우트별 p50/p95로 집계한다.
// 운영 서버에서 사용자가 직접 실행하는 용도. **집계만 출력**한다: 원격 IP·쿼리 문자열·헤더·사용자 정보는
// 읽지도 출력하지도 않는다. 경로의 UUID는 :id, 숫자 세그먼트는 :n으로 바꾼다.
//
//   node scripts/perf/access-log-latency.mjs --log <access.log> [--prefix /api/] [--min-count 5] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { markdownTable, normalizeRoute, parseArgs, percentile, round } from './lib/perfLib.mjs';

/** access log 한 줄 → { key, ms, status } 또는 null(해석 불가·다른 로그). IP 등은 꺼내지 않는다. */
export function parseAccessLine(line, prefix = '/api/') {
  let entry;
  try { entry = JSON.parse(line); } catch { return null; }
  const req = entry?.request;
  if (!req || typeof req.uri !== 'string' || typeof req.method !== 'string') return null;
  if (typeof entry.duration !== 'number' || !Number.isFinite(entry.duration)) return null;
  const route = normalizeRoute(req.uri);
  if (prefix && !route.startsWith(prefix)) return null;
  return { key: `${req.method.toUpperCase()} ${route}`, ms: entry.duration * 1000, status: Number(entry.status) || 0 };
}

export function aggregate(records, minCount = 1) {
  const byKey = new Map();
  for (const r of records) {
    if (!byKey.has(r.key)) byKey.set(r.key, { ms: [], errors: 0 });
    const g = byKey.get(r.key);
    g.ms.push(r.ms);
    if (r.status >= 500) g.errors += 1;
  }
  return [...byKey.entries()]
    .filter(([, g]) => g.ms.length >= minCount)
    .map(([key, g]) => ({
      route: key,
      count: g.ms.length,
      p50: round(percentile(g.ms, 50)),
      p95: round(percentile(g.ms, 95)),
      max: round(Math.max(...g.ms)),
      errors5xx: g.errors,
    }))
    .sort((a, b) => b.count - a.count);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.log !== 'string') {
    console.error('usage: node scripts/perf/access-log-latency.mjs --log <access.log> [--prefix /api/] [--min-count 5] [--json out.json]');
    process.exit(2);
  }
  const prefix = typeof args.prefix === 'string' ? args.prefix : '/api/';
  const minCount = Number(args['min-count'] ?? 5);
  const records = [];
  let skipped = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(args.log, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const r = parseAccessLine(line, prefix);
    if (r) records.push(r); else skipped += 1;
  }
  const rows = aggregate(records, minCount);
  console.log(`집계한 요청 ${records.length}건, 제외 ${skipped}줄(다른 경로·해석 불가), 라우트 ${rows.length}개(요청 ${minCount}건 이상)`);
  console.log(markdownTable(['라우트', '건수', 'p50 ms', 'p95 ms', '최대 ms', '5xx'], rows.map(r => [r.route, r.count, r.p50, r.p95, r.max, r.errors5xx])));
  if (typeof args.json === 'string') fs.writeFileSync(args.json, `${JSON.stringify(rows, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
