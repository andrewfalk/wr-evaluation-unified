// createApp (src/app.ts) — the real application built from injected pools (REFACTORING_ROADMAP P0-3).
// Pins: importing app.ts creates no database pool; building the app and serving the DB-free
// routes never touches the injected pools; the registration order that matters (updates before
// the SPA catch-all, API paths never falling into the SPA, JSON 413 from the error handler).
import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const poolConstructions = vi.hoisted(() => ({ count: 0 }));
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>();
  class CountingPool extends actual.Pool {
    constructor(...args: ConstructorParameters<typeof actual.Pool>) {
      super(...args);
      poolConstructions.count += 1;
    }
  }
  return { ...actual, default: { ...actual, Pool: CountingPool }, Pool: CountingPool };
});

let Pool: typeof import('pg').Pool;
let createApp: typeof import('../app').createApp;
let API_BODY_LIMITS: typeof import('../app').API_BODY_LIMITS;
beforeAll(async () => {
  ({ Pool } = await import('pg'));
  ({ createApp, API_BODY_LIMITS } = await import('../app.js'));
});

// A pool that is never connected: any use fails the test.
function untouchablePool() {
  const pool = new Pool({ connectionString: 'postgres://nobody:none@127.0.0.1:1/wr_test_unused' });
  const used = vi.fn(() => { throw new Error('the pool must not be used here'); });
  pool.query = used as unknown as typeof pool.query;
  pool.connect = used as unknown as typeof pool.connect;
  return { pool, used };
}

describe('createApp', () => {
  let webDir: string;
  beforeAll(() => {
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-app-test-'));
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><title>SPA</title>');
    fs.mkdirSync(path.join(webDir, 'assets'));
    fs.writeFileSync(path.join(webDir, 'assets', 'index-AbC123.js'), 'console.log(1);');
    fs.mkdirSync(path.join(webDir, 'images'));
    fs.writeFileSync(path.join(webDir, 'images', 'G1.png'), 'png');
    fs.writeFileSync(path.join(webDir, 'job-presets.json'), '{"presets":[]}');
  });

  it('importing app.ts does not create a database pool', () => {
    expect(poolConstructions.count).toBe(0);
  });

  // P-1(REFACTORING_ROADMAP Phase 2 P2-21) — 정적 자산 캐시 헤더.
  it.each([
    ['hashed bundle /assets/*', '/assets/index-AbC123.js', 'public, max-age=31536000, immutable'],
    ['index.html (direct)', '/index.html', 'no-cache'],
    ['index.html (root)', '/', 'no-cache'],
    ['SPA fallback', '/patients/123', 'no-cache'],
    ['unhashed public file', '/job-presets.json', 'no-cache'],
    ['unhashed public image', '/images/G1.png', 'no-cache'],
  ])('static caching: %s', async (_label, url, expected) => {
    const { pool } = untouchablePool();
    const app = createApp({ pool, auditPool: pool, webDir });
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(expected);
  });

  it('static caching: /api keeps no-store, an unknown /assets file is not served as the SPA', async () => {
    const { pool } = untouchablePool();
    const app = createApp({ pool, auditPool: pool, webDir });
    const api = await request(app).get('/api/config/public');
    expect(api.headers['cache-control']).toBe('no-store');
    const missing = await request(app).get('/assets/gone-123.js');
    // 옛 청크(배포 뒤 사라진 해시 파일)는 SPA fallback(index.html)로 응답된다 — 캐시는 no-cache(immutable 아님).
    expect(missing.headers['cache-control']).toBe('no-cache');
  });
  afterAll(() => fs.rmSync(webDir, { recursive: true, force: true }));

  it('builds the whole app from injected pools without touching them', async () => {
    const main = untouchablePool();
    const audit = untouchablePool();
    const app = createApp({ pool: main.pool, auditPool: audit.pool, webDir });

    const health = await request(app).get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, service: 'wr-app-server' });

    const publicConfig = await request(app).get('/api/config/public');
    expect(publicConfig.status).toBe(200);
    expect(publicConfig.headers['cache-control']).toMatch(/no-store/); // /api no-store middleware

    expect(main.used).not.toHaveBeenCalled();
    expect(audit.used).not.toHaveBeenCalled();
  });

  it('serves the SPA for app routes but never for /api or /updates paths', async () => {
    const { pool } = untouchablePool();
    const app = createApp({ pool, auditPool: pool, webDir });

    const page = await request(app).get('/some/client/route');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<title>SPA</title>');

    const unknownApi = await request(app).get('/api/does-not-exist');
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.text).not.toContain('<title>SPA</title>');

    // /updates is registered before the catch-all: a missing feed file is the updates router's
    // JSON 404, not index.html with 200.
    const feed = await request(app).get('/updates/does-not-exist.yml');
    expect(feed.status).toBe(404);
    expect(feed.text).not.toContain('<title>SPA</title>');
  });

  it('accepts a relative webDir (normalised to an absolute path for sendFile)', async () => {
    const { pool } = untouchablePool();
    const app = createApp({ pool, auditPool: pool, webDir: path.relative(process.cwd(), webDir) });
    const page = await request(app).get('/another/route');
    expect(page.status).toBe(200);
    expect(page.text).toContain('<title>SPA</title>');
  });

  it('answers an oversized JSON body with the JSON 413 from the error handler', async () => {
    const { pool } = untouchablePool();
    const app = createApp({ pool, auditPool: pool, webDir });
    const big = JSON.stringify({ blob: 'x'.repeat(11 * 1024 * 1024) }); // above every limit (largest: JSON_BODY_LIMIT 10mb)
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(413);
    // P1-01: the central error handler adds the request id to every error envelope.
    expect(res.body).toEqual({ code: 'PAYLOAD_TOO_LARGE', error: 'Request body is too large', requestId: res.headers['x-request-id'] });
  });

  it('keeps answering malformed JSON with the 500 envelope (unchanged by P1-01)', async () => {
    const { pool } = untouchablePool();
    const app = createApp({ pool, auditPool: pool, webDir });
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"loginId":');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error', requestId: res.headers['x-request-id'] });
  });

  // P1-01 — unknown /api paths answer JSON (was Express's HTML "Cannot GET"), with or without the SPA.
  it.each([
    ['with the SPA', true],
    ['API-only (no web directory)', false],
  ])('answers an unknown /api path with a JSON 404 (%s)', async (_name, withSpa) => {
    const { pool, used } = untouchablePool();
    const app = createApp({ pool, auditPool: pool, webDir: withSpa ? webDir : path.join(webDir, 'missing') });
    for (const [method, url] of [['get', '/api/does-not-exist'], ['post', '/api/admin-typo/x'], ['get', '/api']] as const) {
      const res = await request(app)[method](url);
      expect(res.status, `${method} ${url}`).toBe(404);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body).toEqual({ code: 'NOT_FOUND', error: 'Not found', requestId: res.headers['x-request-id'] });
    }
    expect(used).not.toHaveBeenCalled();
  });

  it('keeps /health unchanged apart from the X-Request-Id header', async () => {
    const { pool } = untouchablePool();
    const app = createApp({ pool, auditPool: pool, webDir });
    const res = await request(app).get('/health').set('X-Request-Id', 'probe-1');
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['ok', 'service', 'time']);
    expect(res.headers['x-request-id']).toBe('probe-1');
  });

  // SEC-A L2 — every API mount has its own JSON parser with its own limit.
  describe('per-mount JSON body limits', () => {
    const toBytes = (limit: string): number => {
      const m = /^(\d+)(kb|mb)$/.exec(limit);
      if (!m) throw new Error(`unexpected limit ${limit}`);
      return Number(m[1]) * (m[2] === 'kb' ? 1024 : 1024 * 1024);
    };
    const bodyOf = (bytes: number) => {
      const overhead = JSON.stringify({ blob: '' }).length;
      return JSON.stringify({ blob: 'x'.repeat(bytes - overhead) });
    };

    it('the large limit is only on the routes that carry whole patients', () => {
      expect(API_BODY_LIMITS).toEqual({
        '/api/auth': '256kb', '/api/config': '256kb', '/api/devices': '256kb', '/api/admin/ops': '256kb',
        '/api/admin': '256kb', '/api/audit': '256kb', '/api/workspaces': '10mb', '/api/patients': '10mb',
        '/api/autosave': '10mb', '/api/ai': '2mb', '/api/presets': '256kb', '/api/capabilities': '256kb',
        '/api/video-analysis': '10mb', '/api/stats': '1mb',
      });
    });

    it.each(Object.keys({
      '/api/auth': 1, '/api/config': 1, '/api/devices': 1, '/api/admin/ops': 1, '/api/admin': 1, '/api/audit': 1,
      '/api/workspaces': 1, '/api/patients': 1, '/api/autosave': 1, '/api/ai': 1, '/api/presets': 1,
      '/api/capabilities': 1, '/api/video-analysis': 1, '/api/stats': 1,
    }))('%s: 413 just over its limit, parsed (not 413) just under it — without touching the pool', async (prefix) => {
      const { pool, used } = untouchablePool();
      const app = createApp({ pool, auditPool: pool, webDir });
      const limit = toBytes(API_BODY_LIMITS[prefix as keyof typeof API_BODY_LIMITS]);
      const over = await request(app).post(`${prefix}/__limit_probe`).set('Content-Type', 'application/json').send(bodyOf(limit + 1));
      expect(over.status).toBe(413);
      expect(over.body).toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      const under = await request(app).post(`${prefix}/__limit_probe`).set('Content-Type', 'application/json').send(bodyOf(limit - 64));
      expect(under.status).not.toBe(413);
      expect(used).not.toHaveBeenCalled();
    });
  });
});
