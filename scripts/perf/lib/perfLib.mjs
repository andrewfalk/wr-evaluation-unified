// scripts/perf 공용 도우미 (P0-13 성능 기준선). 순수 함수는 perfLib.test.mjs가 고정한다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

/** 정렬된 표본의 백분위(선형 보간, numpy 기본 'linear'와 같음). 빈 배열이면 null. */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (p < 0 || p > 100) throw new Error(`percentile: p must be in [0, 100] (got ${p})`);
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

export function median(values) {
  return percentile(values, 50);
}

export function round(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** 요청 경로를 집계 키로: 쿼리 제거, UUID → :id, 순수 숫자 세그먼트 → :n. IP·쿼리 값은 남기지 않는다. */
export function normalizeRoute(uri) {
  const pathOnly = String(uri ?? '').split('?')[0].split('#')[0] || '/';
  return pathOnly
    .split('/')
    .map(seg => {
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (/^\d+$/.test(seg)) return ':n';
      return seg;
    })
    .join('/');
}

/** 마크다운 표. rows는 배열의 배열. */
export function markdownTable(headers, rows) {
  const line = cells => `| ${cells.map(c => (c === null || c === undefined ? '—' : String(c))).join(' | ')} |`;
  return [line(headers), line(headers.map(() => '---')), ...rows.map(line)].join('\n');
}

/** `--key value`·`--flag` 인자 해석(값 없는 플래그는 true). */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/**
 * 측정 전용 정적 서버(127.0.0.1만). 압축·캐시 헤더 없음 — 렌더링 시간 측정용이지 전송량 측정용이 아니다
 * (전송량은 실제 배포 스택에서 page-load.mjs로 잰다). 없는 경로는 index.html(SPA).
 */
export function startStaticServer(rootDir, port = 0) {
  const root = path.resolve(rootDir);
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = path.resolve(root, `.${urlPath}`);
    if (!file.startsWith(root)) { res.writeHead(403); res.end(); return; }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({ url: `http://127.0.0.1:${actual}`, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

/** 측정 환경 한 줄(문서용). 호스트 이름·IP는 적지 않는다. */
export async function describeEnvironment() {
  const os = await import('node:os');
  const cpus = os.cpus();
  return {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpu: cpus[0]?.model?.trim() ?? 'unknown',
    cores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3),
  };
}
