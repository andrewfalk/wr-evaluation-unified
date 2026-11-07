// P0-13 측정 도구의 순수 함수 — 수치 해석이 바뀌면 트랙 P 전/후 비교가 어긋나므로 고정한다.
import { describe, it, expect } from 'vitest';
import { percentile, median, round, normalizeRoute, markdownTable, parseArgs } from './lib/perfLib.mjs';
import { initialAssetsFromHtml, measureFile } from './bundle-size.mjs';
import { parseAccessLine, aggregate } from './access-log-latency.mjs';
import { summarizeNetwork } from './page-load.mjs';
import { readCookie, summarizeSamples, patientRevision, findWorkspaceId } from './api-latency.mjs';
import { parseTiming, wrapEngineRequest, readProtocolVersion } from './engine-timing.mjs';

describe('perfLib', () => {
  it('percentile uses linear interpolation and ignores input order', () => {
    expect(percentile([3, 1, 2, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
    expect(() => percentile([1], 101)).toThrow();
    expect(median([5, 1, 3])).toBe(3);
  });

  it('round keeps null for missing values', () => {
    expect(round(1.26, 1)).toBe(1.3);
    expect(round(null)).toBeNull();
    expect(round(Number.NaN)).toBeNull();
  });

  it('normalizeRoute drops the query and replaces ids', () => {
    expect(normalizeRoute('/api/patients/0f8fad5b-d9cb-469f-a165-70867728950e?x=1')).toBe('/api/patients/:id');
    expect(normalizeRoute('/api/stats/runs/12/cancel#h')).toBe('/api/stats/runs/:n/cancel');
    expect(normalizeRoute(undefined)).toBe('/');
  });

  it('markdownTable renders null as a dash', () => {
    expect(markdownTable(['a', 'b'], [[1, null]])).toBe('| a | b |\n| --- | --- |\n| 1 | — |');
  });

  it('parseArgs reads values and bare flags', () => {
    expect(parseArgs(['--runs', '3', '--json', 'x.json', '--ignore-https-errors'])).toEqual({ runs: '3', json: 'x.json', 'ignore-https-errors': true });
  });
});

describe('bundle-size', () => {
  it('collects local script/link references from index.html', () => {
    const html = `<script type="module" crossorigin src="./assets/index-a.js"></script>
      <link rel="modulepreload" crossorigin href="./assets/vendor-b.js">
      <link rel="stylesheet" href="./assets/index-c.css">
      <link rel="icon" href="data:,">
      <script src="https://cdn.example/x.js"></script>`;
    expect([...initialAssetsFromHtml(html)].sort()).toEqual(['assets/index-a.js', 'assets/index-c.css', 'assets/vendor-b.js']);
  });

  it('measures raw, gzip and brotli sizes', () => {
    const r = measureFile(Buffer.from('a'.repeat(1000)));
    expect(r.raw).toBe(1000);
    expect(r.gzip).toBeLessThan(100);
    expect(r.brotli).toBeLessThan(100);
  });
});

describe('access-log-latency', () => {
  const line = (uri, duration, extra = {}) => JSON.stringify({ request: { method: 'get', uri, remote_ip: '10.0.0.1', headers: { Cookie: ['x'] } }, duration, status: 200, ...extra });

  it('keeps only method, normalized route, duration and status — never the client address', () => {
    const r = parseAccessLine(line('/api/patients/0f8fad5b-d9cb-469f-a165-70867728950e?name=x', 0.0123));
    expect(r).toEqual({ key: 'GET /api/patients/:id', ms: 12.3, status: 200 });
    expect(JSON.stringify(r)).not.toContain('10.0.0.1');
  });

  it('skips other paths, broken lines and lines without duration', () => {
    expect(parseAccessLine(line('/assets/x.js', 0.001))).toBeNull();
    expect(parseAccessLine('not json')).toBeNull();
    expect(parseAccessLine(JSON.stringify({ request: { method: 'GET', uri: '/api/x' } }))).toBeNull();
  });

  it('aggregates p50/p95 per route and counts 5xx', () => {
    const records = [10, 20, 30, 40].map((ms, i) => ({ key: 'GET /api/x', ms, status: i === 3 ? 502 : 200 }));
    records.push({ key: 'GET /api/rare', ms: 1, status: 200 });
    expect(aggregate(records, 2)).toEqual([{ route: 'GET /api/x', count: 4, p50: 25, p95: 38.5, max: 40, errors5xx: 1 }]);
  });

  it('handles a route with hundreds of thousands of samples (no spread into Math.max)', () => {
    const many = Array.from({ length: 300_000 }, (_, i) => ({ key: 'GET /api/big', ms: i % 1000, status: 200 }));
    const [row] = aggregate(many, 1);
    expect(row.count).toBe(300_000);
    expect(row.max).toBe(999);
  });
});

describe('page-load summarizeNetwork', () => {
  it('sums encoded bytes and counts 304 and cache hits, ignoring data: URLs', () => {
    const events = [
      { method: 'Network.responseReceived', params: { requestId: '1', response: { url: 'https://h/', status: 200 } } },
      { method: 'Network.loadingFinished', params: { requestId: '1', encodedDataLength: 1000 } },
      { method: 'Network.responseReceived', params: { requestId: '2', response: { url: 'https://h/a.js', status: 304 } } },
      { method: 'Network.loadingFinished', params: { requestId: '2', encodedDataLength: 200 } },
      { method: 'Network.requestServedFromCache', params: { requestId: '3' } },
      { method: 'Network.responseReceived', params: { requestId: '3', response: { url: 'https://h/b.css', status: 200, fromDiskCache: true } } },
      { method: 'Network.loadingFinished', params: { requestId: '3', encodedDataLength: 0 } },
      { method: 'Network.responseReceived', params: { requestId: '4', response: { url: 'data:image/png;base64,x', status: 200 } } },
    ];
    expect(summarizeNetwork(events)).toEqual({ requests: 3, transferBytes: 1200, notModified: 1, servedFromCache: 1 });
  });

  it('counts a revalidated response as 304 from responseReceivedExtraInfo even when responseReceived says 200', () => {
    const events = [
      { method: 'Network.responseReceivedExtraInfo', params: { requestId: 'doc', statusCode: 304 } },
      { method: 'Network.responseReceived', params: { requestId: 'doc', response: { url: 'https://h/', status: 200 } } },
      { method: 'Network.loadingFinished', params: { requestId: 'doc', encodedDataLength: 31 } },
      { method: 'Network.responseReceived', params: { requestId: 'api', response: { url: 'https://h/api/x', status: 200 } } },
      { method: 'Network.responseReceivedExtraInfo', params: { requestId: 'api', statusCode: 200 } },
      { method: 'Network.loadingFinished', params: { requestId: 'api', encodedDataLength: 400 } },
    ];
    expect(summarizeNetwork(events)).toMatchObject({ requests: 2, notModified: 1, transferBytes: 431 });
  });
});

describe('api-latency', () => {
  it('reads one cookie out of several Set-Cookie headers', () => {
    expect(readCookie(['wr_refresh=abc; HttpOnly; Path=/', 'wr_csrf=t%20k; Path=/; SameSite=Strict'], 'wr_csrf')).toBe('t k');
    expect(readCookie([], 'wr_csrf')).toBeNull();
    expect(readCookie(undefined, 'wr_csrf')).toBeNull();
  });

  it('reads the patient revision from sync.revision', () => {
    expect(patientRevision({ sync: { revision: 3 } })).toBe(3);
    expect(patientRevision({ revision: 2 })).toBe(2);
    expect(patientRevision({ sync: {} })).toBeNull();
    expect(patientRevision(null)).toBeNull();
  });

  it('finds the saved workspace id by name in the refreshed list', () => {
    const res = { items: [{ id: 'a', name: 'other' }, { id: 'b', name: 'perf-baseline-1' }] };
    expect(findWorkspaceId(res, 'perf-baseline-1')).toBe('b');
    expect(findWorkspaceId(res, 'missing')).toBeNull();
    expect(findWorkspaceId({}, 'x')).toBeNull();
  });

  it('summarizes successful samples only and counts errors', () => {
    expect(summarizeSamples({ s: [{ ms: 10, ok: true }, { ms: 30, ok: true }, { ms: 999, ok: false }] }))
      .toEqual([{ step: 's', count: 3, errors: 1, p50: 20, p95: 29, max: 30 }]);
  });
});

describe('engine-timing', () => {
  it('wraps golden request bodies the way the server does', () => {
    expect(wrapEngineRequest({ variables: [] }, 6)).toEqual({ protocolVersion: 6, variables: [] });
    expect(wrapEngineRequest({ method: 'welch_t', groups: [] }, 6)).toEqual({ protocolVersion: 6, bivariate: { method: 'welch_t', groups: [] } });
    expect(wrapEngineRequest({ family: 'ols', y: [] }, 6)).toMatchObject({ regression: { family: 'ols' } });
    expect(wrapEngineRequest({ outerFolds: [] }, 6)).toMatchObject({ prediction: { outerFolds: [] } });
    expect(() => wrapEngineRequest({ x: 1 }, 6)).toThrow(/unknown engine request shape/);
  });

  it('reads the protocol version from the server source', () => {
    expect(readProtocolVersion('foo\nexport const ENGINE_PROTOCOL_VERSION = 6;\n')).toBe(6);
    expect(() => readProtocolVersion('nothing')).toThrow();
  });

  it('parses the timing marker relative to the driver spawn time', () => {
    const marker = { mode: 'descriptive', processStartWallMs: 1050, importMs: 800, stdinMs: 1, parseMs: 2, computeMs: 3, serializeMs: 0.1, processMs: 810 };
    expect(parseTiming({ code: 0, spawnWallMs: 1000, closeWallMs: 1900, stderr: `STATS_ENGINE_TIMING ${JSON.stringify(marker)}\n` }))
      .toMatchObject({ ok: true, markerFound: true, interpreterStartMs: 50, importMs: 800, computeMs: 3, totalMs: 900 });
    expect(parseTiming({ code: 1, spawnWallMs: 0, closeWallMs: 5, stderr: 'STATS_ENGINE_ERROR {}' }))
      .toEqual({ ok: false, markerFound: false, totalMs: 5 });
  });
});
