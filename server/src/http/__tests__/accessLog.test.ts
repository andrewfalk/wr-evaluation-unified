// S9 / P1-d: the access log through the real app (createApp) — one line per finished request with method, path
// (no query), status, duration and the request id the response carried; nothing else from the request (no
// headers, cookies or query); /health not logged; level by status.
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createApp } from '../../app';
import { createLogger } from '../../logger';

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ level: 'trace' }, { write: (line: string) => { lines.push(JSON.parse(line)); } });
  // Never connected: these requests do not reach the database.
  const pool = new Pool({ connectionString: 'postgres://nobody:none@127.0.0.1:1/wr_test_unused' });
  const app = createApp({ pool, auditPool: pool, logger, webDir: '/nonexistent-web-dir' });
  const accessLines = () => lines.filter((l) => l.msg === 'request completed');
  return { app, lines, accessLines };
}

describe('access log', () => {
  it('logs method, path without the query, status, duration and the request id — and nothing from headers or query', async () => {
    const { app, accessLines } = capture();
    const res = await request(app)
      .get('/api/no-such-route?patientName=SECRET_QUERY')
      .set('Authorization', 'Bearer SECRET_TOKEN')
      .set('Cookie', 'wr_refresh=SECRET_COOKIE');

    expect(res.status).toBe(404);
    const lines = accessLines();
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatchObject({
      level: 40, // warn for 4xx
      msg: 'request completed',
      req: { id: res.headers['x-request-id'], method: 'GET', path: '/api/no-such-route' },
      res: { statusCode: 404 },
    });
    expect(typeof line.responseTime).toBe('number');
    expect(Object.keys(line.req as object).sort()).toEqual(['id', 'method', 'path']);
    expect(JSON.stringify(line)).not.toMatch(/SECRET_(QUERY|TOKEN|COOKIE)/);
  });

  it('an incoming X-Request-Id (from the reverse proxy) is the logged id', async () => {
    const { app, accessLines } = capture();
    await request(app).get('/api/no-such-route').set('X-Request-Id', 'proxy-abc-123');
    expect(accessLines()[0]).toMatchObject({ req: { id: 'proxy-abc-123' } });
  });

  it('/health is not logged; a 2xx is logged at info', async () => {
    const { app, accessLines } = capture();
    expect((await request(app).get('/health')).status).toBe(200);
    expect(accessLines()).toHaveLength(0);

    expect((await request(app).get('/api/config/public')).status).toBe(200);
    expect(accessLines()).toEqual([expect.objectContaining({ level: 30, res: { statusCode: 200 } })]);
  });

  it('a 5xx is logged at error, without the error object (the error handler logs that)', async () => {
    const { app, accessLines, lines } = capture();
    // A 5xx: the login route's pool cannot connect.
    const res = await request(app).post('/api/auth/login').send({ loginId: 'x', password: 'y' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const [line] = accessLines();
    expect(line).toMatchObject({ level: 50, res: { statusCode: res.status } });
    expect(line.err).toBeUndefined();
    // the error itself is the error handler's own line
    expect(lines.some((l) => l.msg === 'request failed' && l.level === 50 && l.err)).toBe(true);
  });
});
