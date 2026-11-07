// P0-13 성능 기준선 ① — 첫 화면 전송량·요청 수·캐시 재사용·로드 시간(cold / warm).
//
// 실제 배포 경로(시험 스택 8443, Caddy 경유)를 Playwright Chromium으로 연다. CDP Network 이벤트로
// 응답별 실제 전송 바이트(encodedDataLength — 헤더 포함, 압축 후)를 모은다.
//   cold: 새 브라우저 컨텍스트(캐시 없음)에서 첫 방문
//   warm: 같은 컨텍스트에서 같은 주소로 다시 방문(재방문 — 캐시·조건부 요청 효과)
// 각 --runs번(기본 3) 반복해 중앙값. Lighthouse 점수는 도구 세션에서 GUI DevTools를 쓸 수 없어 대신 이 수치를 쓴다.
//
// TLS: 시험 스택의 내부 CA가 Windows에 신뢰 등록돼 있어야 한다(verify-stack.ps1 status 가 알려 줌).
// --ignore-https-errors 로 우회할 수 있지만 Chromium은 인증서 오류가 있는 응답을 캐시에 넣지 않아 warm 수치가
// 무의미해진다 — 그 경우 결과에 표시한다.
//
//   node scripts/perf/page-load.mjs [--url https://wr.hospital.local:8443/] [--runs 3] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { markdownTable, median, parseArgs, round } from './lib/perfLib.mjs';

/**
 * CDP 이벤트 기록 → 집계. 요청 ID별 마지막 응답만 센다.
 * 캐시된 항목을 재검증하면 Chromium은 responseReceived에 캐시와 병합한 상태(200)를 주고, 실제 네트워크
 * 상태(304)는 responseReceivedExtraInfo.statusCode로 따로 준다 — 304는 그 값을 우선해 센다.
 */
export function summarizeNetwork(events) {
  const responses = new Map();
  const finished = new Map();
  const fromCache = new Set();
  const wireStatus = new Map();
  for (const e of events) {
    if (e.method === 'Network.responseReceivedExtraInfo') {
      if (Number.isInteger(e.params.statusCode)) wireStatus.set(e.params.requestId, e.params.statusCode);
    } else if (e.method === 'Network.responseReceived') {
      const r = e.params.response;
      responses.set(e.params.requestId, { url: r.url, status: r.status, fromDiskCache: !!r.fromDiskCache, fromServiceWorker: !!r.fromServiceWorker });
    } else if (e.method === 'Network.loadingFinished') {
      finished.set(e.params.requestId, e.params.encodedDataLength);
    } else if (e.method === 'Network.requestServedFromCache') {
      fromCache.add(e.params.requestId);
    }
  }
  let bytes = 0;
  let notModified = 0;
  let cached = 0;
  for (const [id, r] of responses) {
    if (r.url.startsWith('data:')) continue;
    bytes += finished.get(id) ?? 0;
    if ((wireStatus.get(id) ?? r.status) === 304) notModified += 1;
    if (r.fromDiskCache || fromCache.has(id)) cached += 1;
  }
  const requests = [...responses.values()].filter(r => !r.url.startsWith('data:')).length;
  return { requests, transferBytes: bytes, notModified, servedFromCache: cached };
}

async function visit(page, cdp, url) {
  const events = [];
  const handler = method => params => events.push({ method, params });
  const methods = ['Network.responseReceived', 'Network.responseReceivedExtraInfo', 'Network.loadingFinished', 'Network.requestServedFromCache'];
  const listeners = methods.map(m => [m, handler(m)]);
  for (const [m, h] of listeners) cdp.on(m, h);
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForLoadState('networkidle');
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      return n ? { domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd } : null;
    });
    return { ...summarizeNetwork(events), ...nav };
  } finally {
    for (const [m, h] of listeners) cdp.off(m, h);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = typeof args.url === 'string' ? args.url : 'https://wr.hospital.local:8443/';
  const runs = Number(args.runs ?? 3);
  const ignoreHTTPSErrors = args['ignore-https-errors'] === true;
  const browser = await chromium.launch();
  const cold = [];
  const warm = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      const ctx = await browser.newContext({ ignoreHTTPSErrors });
      const page = await ctx.newPage();
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Network.enable');
      cold.push(await visit(page, cdp, url));
      warm.push(await visit(page, cdp, url));
      await ctx.close();
      process.stderr.write(`\r  ${i + 1}/${runs}`);
    }
  } finally {
    await browser.close();
  }
  process.stderr.write('\n');
  const med = (list, key) => round(median(list.map(r => r[key])));
  const row = (name, list) => [name, med(list, 'requests'), round(med(list, 'transferBytes') / 1024), med(list, 'notModified'), med(list, 'servedFromCache'), med(list, 'domContentLoaded'), med(list, 'load')];
  if (ignoreHTTPSErrors) console.log('주의: --ignore-https-errors — 인증서 오류 응답은 캐시되지 않아 warm 수치가 실제와 다릅니다.');
  console.log(markdownTable(
    ['방문', '요청 수', '전송 KiB', '304', '캐시에서', 'DOMContentLoaded ms', 'load ms'],
    [row('cold(첫 방문)', cold), row('warm(재방문)', warm)],
  ));
  if (typeof args.json === 'string') fs.writeFileSync(args.json, `${JSON.stringify({ url, runs, ignoreHTTPSErrors, cold, warm }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
