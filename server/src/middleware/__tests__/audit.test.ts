import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Request, Response, NextFunction } from 'express';
import type { Pool } from 'pg';
import { writeAuditLog, auditMiddleware, auditLogin, auditLogout, auditRefreshFail } from '../audit';

function makePool(fail = false): Pool {
  const query = fail
    ? vi.fn().mockRejectedValue(new Error('DB down'))
    : vi.fn().mockResolvedValue({ rows: [] });
  return { query } as unknown as Pool;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    ip: '127.0.0.1',
    headers: { 'user-agent': 'test-agent' },
    params: {},
    sessionInfo: undefined,
    ...overrides,
  } as unknown as Request;
}

// EventEmitter-based mock so res.on('finish') works correctly.
function makeRes(status = 200): Response {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    statusCode: status,
    locals:     {} as Record<string, unknown>,
  }) as unknown as Response;
}

// ---------------------------------------------------------------------------
// writeAuditLog
// ---------------------------------------------------------------------------
describe('writeAuditLog', () => {
  it('inserts a row with correct parameters', async () => {
    const pool = makePool();
    await writeAuditLog(pool, {
      actorUserId: 'user-1',
      actorOrgId:  'org-1',
      action:      'patient_view',
      targetType:  'patient',
      targetId:    'pat-1',
      outcome:     'success',
      ip:          '10.0.0.1',
      userAgent:   'Mozilla/5.0',
    });

    expect(pool.query).toHaveBeenCalledOnce();
    const [sql, params] = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO audit_logs');
    expect(params[0]).toBe('user-1');   // actor_user_id
    expect(params[2]).toBe('patient_view'); // action
    expect(params[5]).toBe('success');  // outcome
  });

  it('does not throw when DB fails (fire-and-forget)', async () => {
    const pool = makePool(true);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(writeAuditLog(pool, { action: 'test', outcome: 'success' })).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('serialises extra as JSON string', async () => {
    const pool = makePool();
    await writeAuditLog(pool, {
      action: 'login_fail',
      outcome: 'failure',
      extra: { code: 'INVALID_CREDENTIALS' },
    });
    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[8]).toBe('{"code":"INVALID_CREDENTIALS"}');
  });
});

// ---------------------------------------------------------------------------
// auditMiddleware
// ---------------------------------------------------------------------------
describe('auditMiddleware', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('records success for 2xx responses (via finish event)', async () => {
    const pool = makePool();
    const req  = makeReq({ sessionInfo: { userId: 'u1', organizationId: 'o1' } } as Partial<Request>);
    const res  = makeRes(200);
    const next = vi.fn() as unknown as NextFunction;

    const mw = auditMiddleware(pool, 'patient_create', 'patient');
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('patient_create');
    expect(params[5]).toBe('success');
  });

  it('records denied for 401 responses', async () => {
    const pool = makePool();
    const req  = makeReq();
    const res  = makeRes(401);
    const next = vi.fn() as unknown as NextFunction;

    auditMiddleware(pool, 'patient_view', 'patient')(req, res, next);
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[5]).toBe('denied');
  });

  it('records failure for 4xx (non-auth) responses', async () => {
    const pool = makePool();
    const req  = makeReq();
    const res  = makeRes(400);
    const next = vi.fn() as unknown as NextFunction;

    auditMiddleware(pool, 'patient_create', 'patient')(req, res, next);
    // Simulate route handler setting error code before sending
    (res as unknown as { locals: Record<string, unknown> }).locals.auditErrorCode = 'INVALID_BODY';
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[5]).toBe('failure');
    expect(params[8]).toContain('INVALID_BODY');
  });

  it('uses getTargetId when provided', async () => {
    const pool = makePool();
    const req  = makeReq({ params: { id: 'pat-42' } } as Partial<Request>);
    const res  = makeRes(200);
    const next = vi.fn() as unknown as NextFunction;

    auditMiddleware(pool, 'patient_view', 'patient', (r) => r.params.id)(req, res, next);
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[4]).toBe('pat-42'); // target_id
  });

  it('fires on non-json response (res.send equivalent via finish)', async () => {
    const pool = makePool();
    const req  = makeReq();
    const res  = makeRes(200);
    const next = vi.fn() as unknown as NextFunction;

    auditMiddleware(pool, 'export_csv', 'patient')(req, res, next);
    // Simulate a streaming/file response that never calls res.json()
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    expect(pool.query).toHaveBeenCalledOnce();
    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('export_csv');
    expect(params[5]).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Explicit audit helpers
// ---------------------------------------------------------------------------
describe('auditLogin', () => {
  it('writes auth_login with outcome', async () => {
    const pool = makePool();
    auditLogin(pool, makeReq(), 'success', 'u1', 'o1');
    await new Promise((r) => setTimeout(r, 0));

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('auth_login');
    expect(params[5]).toBe('success');
  });

  it('writes failure without userId when credentials wrong', async () => {
    const pool = makePool();
    auditLogin(pool, makeReq(), 'failure');
    await new Promise((r) => setTimeout(r, 0));

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[0]).toBeNull(); // actor_user_id
    expect(params[5]).toBe('failure');
  });
});

describe('auditLogout', () => {
  it('writes auth_logout with sessionId', async () => {
    const pool = makePool();
    const req  = makeReq({
      sessionInfo: { userId: 'u1', organizationId: 'o1', sessionId: 'sess-1' },
    } as Partial<Request>);
    auditLogout(pool, req);
    await new Promise((r) => setTimeout(r, 0));

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('auth_logout');
    expect(params[4]).toBe('sess-1'); // target_id = sessionId
    expect(params[5]).toBe('success');
  });
});

describe('auditRefreshFail', () => {
  it('writes auth_refresh_fail with code in extra', async () => {
    const pool = makePool();
    auditRefreshFail(pool, makeReq(), 'SESSION_INVALID');
    await new Promise((r) => setTimeout(r, 0));

    const params = (pool.query as ReturnType<typeof vi.fn>).mock.calls[0][1] as unknown[];
    expect(params[2]).toBe('auth_refresh_fail');
    expect(params[5]).toBe('failure');
    expect(params[8]).toContain('SESSION_INVALID');
  });
});
