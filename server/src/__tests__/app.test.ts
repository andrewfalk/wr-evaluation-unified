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
beforeAll(async () => {
  ({ Pool } = await import('pg'));
  ({ createApp } = await import('../app'));
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
  });
  afterAll(() => fs.rmSync(webDir, { recursive: true, force: true }));

  it('importing app.ts does not create a database pool', () => {
    expect(poolConstructions.count).toBe(0);
  });

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
    const big = JSON.stringify({ blob: 'x'.repeat(11 * 1024 * 1024) }); // default JSON_BODY_LIMIT is 10mb
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(big);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ code: 'PAYLOAD_TOO_LARGE', error: 'Request body is too large' });
  });
});
