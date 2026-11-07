// Central error handler + asyncHandler + request id + logger (REFACTORING_ROADMAP P1-01).
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig(),
}));

import { makeRouterApp } from '../../testing/app';
import { asyncHandler } from '../asyncHandler';
import { AppError } from '../errors';
import { createErrorHandler } from '../errorHandler';
import { requestIdMiddleware } from '../requestId';
import { createLogger, serializeError } from '../../logger';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function capturingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ level: 'trace' }, { write: (line: string) => { lines.push(JSON.parse(line)); } });
  return { logger, lines };
}

function appWith(route: (req: Request, res: Response) => unknown) {
  const { logger, lines } = capturingLogger();
  const app = makeRouterApp((a) => {
    a.use(requestIdMiddleware());
    a.post('/api/thing', asyncHandler(route));
    a.get('/api/thing', asyncHandler(route));
    a.use(createErrorHandler(logger));
  });
  return { app, lines };
}

describe('asyncHandler', () => {
  it('forwards a rejected promise to next(err)', async () => {
    const err = new Error('rejected');
    const next = vi.fn();
    asyncHandler(async () => { throw err; })({} as Request, {} as Response, next as NextFunction);
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledWith(err);
  });

  it('forwards a synchronous throw to next(err)', () => {
    const err = new Error('sync');
    const next = vi.fn();
    asyncHandler(() => { throw err; })({} as Request, {} as Response, next as NextFunction);
    expect(next).toHaveBeenCalledWith(err);
  });

  it('does not call next when the handler resolves (or returns a non-promise)', async () => {
    const next = vi.fn();
    asyncHandler(async () => 'done')({} as Request, {} as Response, next as NextFunction);
    asyncHandler(() => undefined)({} as Request, {} as Response, next as NextFunction);
    await new Promise((r) => setImmediate(r));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('requestIdMiddleware', () => {
  const echo = () => makeRouterApp((a) => {
    a.use(requestIdMiddleware());
    a.get('/id', (req, res) => { res.json({ id: req.requestId }); });
  });

  it('adopts a well-formed incoming X-Request-Id and echoes it', async () => {
    const id = 'abc.DEF_123-xyz';
    const res = await request(echo()).get('/id').set('X-Request-Id', id);
    expect(res.headers['x-request-id']).toBe(id);
    expect(res.body.id).toBe(id);
  });

  it('accepts 64 characters', async () => {
    const id = 'a'.repeat(64);
    expect((await request(echo()).get('/id').set('X-Request-Id', id)).body.id).toBe(id);
  });

  it.each([
    ['missing', undefined],
    ['too long (65)', 'a'.repeat(65)],
    ['disallowed characters', 'abc def'],
    ['log-forging attempt', 'x\\ny'],
    ['empty', ''],
  ])('generates a UUID when the incoming id is %s', async (_name, incoming) => {
    const req = request(echo()).get('/id');
    if (incoming !== undefined) req.set('X-Request-Id', incoming);
    const res = await req;
    expect(res.body.id).toMatch(UUID);
    expect(res.headers['x-request-id']).toBe(res.body.id);
  });
});

describe('createErrorHandler', () => {
  it('answers a rejected handler with the 500 envelope + requestId and logs the error', async () => {
    const { app, lines } = appWith(async () => { throw new Error('db exploded'); });
    const res = await request(app).post('/api/thing?q=secret').send({ password: 'hunter2', note: 'body-value' });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ code: 'INTERNAL_ERROR', error: 'Internal server error', requestId: res.headers['x-request-id'] });
    expect(res.body.requestId).toMatch(UUID);

    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toMatchObject({
      level: 50, requestId: res.body.requestId, method: 'POST', path: '/api/thing', status: 500, code: 'INTERNAL_ERROR',
      err: { type: 'Error', message: 'db exploded' },
    });
    const raw = JSON.stringify(line);
    expect(raw).not.toContain('q=secret'); // path without query string
    expect(raw).not.toContain('hunter2');   // bodies are never logged
    expect(raw).not.toContain('body-value');
  });

  it('logs a pg error with its code but without pg detail values', async () => {
    const pgErr = Object.assign(new Error('deadlock detected'), {
      severity: 'ERROR', code: '40P01', detail: 'Process 1 waits for ShareLock; row value (patient_no)=(P-123)', where: 'SQL statement',
    });
    const { app, lines } = appWith(async () => { throw pgErr; });
    const res = await request(app).get('/api/thing');
    expect(res.status).toBe(500);
    expect(lines[0].err).toMatchObject({ type: 'Error', code: '40P01' });
    expect(JSON.stringify(lines[0])).not.toContain('P-123');
    expect(JSON.stringify(lines[0])).not.toContain('SQL statement');
  });

  it('answers an AppError with its status, code and details, logged as warn', async () => {
    const { app, lines } = appWith(async () => { throw new AppError(409, 'CONFLICT', 'Revision mismatch.', { currentRevision: 3 }); });
    const res = await request(app).get('/api/thing');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'CONFLICT', error: 'Revision mismatch.', currentRevision: 3, requestId: res.headers['x-request-id'] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 40, status: 409, code: 'CONFLICT' });
  });

  it('a ZodError from an internal parse is a 500 whose log keeps issue paths only', async () => {
    const { app, lines } = appWith(async () => { z.object({ a: z.enum(['x']) }).parse({ a: 'PHI-like-value' }); });
    const res = await request(app).get('/api/thing');
    expect(res.status).toBe(500);
    expect(res.body).not.toHaveProperty('issues');
    expect(lines[0]).toMatchObject({ level: 50, issues: [{ path: ['a'], code: 'invalid_enum_value' }] });
    expect(lines[0].err).toMatchObject({ type: 'ZodError', message: '1 validation issue(s)' });
    // The whole line — not just `issues`: ZodError.message/stack repeat the rejected value.
    expect(JSON.stringify(lines[0])).not.toContain('PHI-like-value');
  });

  it('a malformed JSON body (body-parser) never reaches the log, though JSON.parse quotes it', async () => {
    const { app, lines } = appWith(async () => 'unreachable');
    const res = await request(app).post('/api/thing').set('Content-Type', 'application/json').send('{"password":hunter2-secret}');
    expect(res.status).toBe(500); // unchanged: entity.parse.failed stays a 500 in S1
    expect(lines).toHaveLength(1);
    expect(lines[0].err).toMatchObject({ type: 'SyntaxError', message: 'invalid JSON', errorType: 'entity.parse.failed', status: 400 });
    expect(JSON.stringify(lines[0])).not.toContain('hunter2-secret');
  });

  it('a malformed JSON body whose quoted text looks like stack frames still never reaches the log', async () => {
    const { app, lines } = appWith(async () => 'unreachable');
    const res = await request(app).post('/api/thing').set('Content-Type', 'application/json')
      .send('[\n    at hunter2-secret]\n    at (also-secret.js:1:1)');
    expect(res.status).toBe(500);
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain('hunter2-secret');
    expect(raw).not.toContain('also-secret');
    expect(String((lines[0].err as Record<string, unknown>).stack)).toMatch(/^SyntaxError: invalid JSON\n\s+at /);
  });

  it('a PostgreSQL error quoting an input value (22P02) is logged by code only', async () => {
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "PHI-123"'), {
      name: 'error', severity: 'ERROR', code: '22P02', routine: 'string_to_uuid',
    });
    const { app, lines } = appWith(async () => { throw pgErr; });
    const res = await request(app).get('/api/thing');
    expect(res.status).toBe(500);
    expect(lines[0].err).toMatchObject({ type: 'error', message: 'PostgreSQL error 22P02', code: '22P02', routine: 'string_to_uuid' });
    expect(JSON.stringify(lines[0])).not.toContain('PHI-123');
  });

  it('ends the socket instead of writing JSON when headers were already sent', () => {
    const { logger, lines } = capturingLogger();
    const res = { headersSent: true, destroy: vi.fn(), status: vi.fn(), json: vi.fn() };
    const req = { requestId: 'rid-1', method: 'GET', path: '/api/stream' };
    createErrorHandler(logger)(new Error('late'), req as unknown as Request, res as unknown as Response, vi.fn() as unknown as NextFunction);
    expect(res.destroy).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(lines[0]).toMatchObject({ level: 50, requestId: 'rid-1', headersSent: true, err: { message: 'late' } });
  });

  it('covers a response already started by the handler (socket ended, no JSON appended)', async () => {
    const { app, lines } = appWith(async (_req, res) => {
      res.status(200).write('partial');
      throw new Error('after write');
    });
    await expect(request(app).get('/api/thing')).rejects.toThrow();
    expect(lines[0]).toMatchObject({ headersSent: true });
  });
});

describe('logger', () => {
  it('redacts authorization/cookie headers, passwords and refresh tokens', () => {
    const { logger, lines } = capturingLogger();
    logger.info({
      req: { headers: { authorization: 'Bearer tok', cookie: 'wr_refresh=abc', 'user-agent': 'ua' } },
      body: { password: 'pw', refreshToken: 'rt', loginId: 'kept' },
    }, 'x');
    const raw = JSON.stringify(lines[0]);
    for (const secret of ['Bearer tok', 'wr_refresh=abc', '"pw"', '"rt"']) expect(raw).not.toContain(secret);
    expect(raw).toContain('kept');
    expect(raw).toContain('ua');
  });

  it('redacts top-level password and refreshToken too', () => {
    const { logger, lines } = capturingLogger();
    logger.info({ password: 'top-pw', refreshToken: 'top-rt', loginId: 'kept' }, 'x');
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain('top-pw');
    expect(raw).not.toContain('top-rt');
    expect(raw).toContain('kept');
  });

  it('serializeError keeps type/message/stack/code/constraint and drops everything else', () => {
    const err = Object.assign(new Error('dup'), { code: '23505', constraint: 'c1', detail: 'Key (x)=(v)', parameters: ['v'] });
    const out = serializeError(err);
    expect(out).toMatchObject({ type: 'Error', message: 'dup', code: '23505', constraint: 'c1' });
    expect(out).toHaveProperty('stack');
    expect(out).not.toHaveProperty('detail');
    expect(out).not.toHaveProperty('parameters');
    expect(serializeError('str')).toEqual({ type: 'string' });
    // body-parser's own `type` does not replace the class name
    const tooLarge = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 });
    expect(serializeError(tooLarge)).toMatchObject({ type: 'Error', errorType: 'entity.too.large', status: 413 });
  });
});
