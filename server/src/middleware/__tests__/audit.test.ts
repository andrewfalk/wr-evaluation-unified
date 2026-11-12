import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Request, Response, NextFunction } from 'express';
import { writeAuditLog, auditMiddleware, auditLogin, auditLogout, auditRefreshFail } from '../audit';
import { createFakePool, type FakePool } from '../../testing/fakePool';
import { logger } from '../../logger';

function auditFake(fail = false): FakePool {
  return createFakePool({
    handlers: [{ name: 'audit.insert', match: /INSERT INTO audit_logs/, reply: fail ? new Error('DB down') : { rows: [] } }],
  });
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
    const fake = auditFake();
    await writeAuditLog(fake.pool, {
      actorUserId: 'user-1',
      actorOrgId:  'org-1',
      action:      'patient_view',
      targetType:  'patient',
      targetId:    'pat-1',
      outcome:     'success',
      ip:          '10.0.0.1',
      userAgent:   'Mozilla/5.0',
    });

    expect(fake.calls).toHaveLength(1);
    const { sql, params } = fake.calls[0]!;
    expect(sql).toContain('INSERT INTO audit_logs');
    expect(params[0]).toBe('user-1');   // actor_user_id
    expect(params[2]).toBe('patient_view'); // action
    expect(params[5]).toBe('success');  // outcome
  });

  it('does not throw when DB fails (fire-and-forget)', async () => {
    const fake = auditFake(true);
    const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
    await expect(writeAuditLog(fake.pool, { action: 'test', outcome: 'success' })).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it('serialises extra as JSON string', async () => {
    const fake = auditFake();
    await writeAuditLog(fake.pool, {
      action: 'login_fail',
      outcome: 'failure',
      extra: { code: 'INVALID_CREDENTIALS' },
    });
    const params = fake.calls[0]!.params;
    expect(params[8]).toBe('{"code":"INVALID_CREDENTIALS"}');
  });
});

// ---------------------------------------------------------------------------
// auditMiddleware
// ---------------------------------------------------------------------------
describe('auditMiddleware', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('records success for 2xx responses (via finish event)', async () => {
    const fake = auditFake();
    const req  = makeReq({ sessionInfo: { userId: 'u1', organizationId: 'o1' } } as Partial<Request>);
    const res  = makeRes(200);
    const next = vi.fn() as unknown as NextFunction;

    const mw = auditMiddleware(fake.pool, 'patient_create', 'patient');
    mw(req, res, next);
    expect(next).toHaveBeenCalledOnce();

    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[2]).toBe('patient_create');
    expect(params[5]).toBe('success');
  });

  it('records denied for 401 responses', async () => {
    const fake = auditFake();
    const req  = makeReq();
    const res  = makeRes(401);
    const next = vi.fn() as unknown as NextFunction;

    auditMiddleware(fake.pool, 'patient_view', 'patient')(req, res, next);
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[5]).toBe('denied');
  });

  it('records failure for 4xx (non-auth) responses', async () => {
    const fake = auditFake();
    const req  = makeReq();
    const res  = makeRes(400);
    const next = vi.fn() as unknown as NextFunction;

    auditMiddleware(fake.pool, 'patient_create', 'patient')(req, res, next);
    // Simulate route handler setting error code before sending
    (res as unknown as { locals: Record<string, unknown> }).locals.auditErrorCode = 'INVALID_BODY';
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[5]).toBe('failure');
    expect(params[8]).toContain('INVALID_BODY');
  });

  it('uses getTargetId when provided', async () => {
    const fake = auditFake();
    const req  = makeReq({ params: { id: 'pat-42' } } as Partial<Request>);
    const res  = makeRes(200);
    const next = vi.fn() as unknown as NextFunction;

    auditMiddleware(fake.pool, 'patient_view', 'patient', (r) => r.params.id)(req, res, next);
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[4]).toBe('pat-42'); // target_id
  });

  it('fires on non-json response (res.send equivalent via finish)', async () => {
    const fake = auditFake();
    const req  = makeReq();
    const res  = makeRes(200);
    const next = vi.fn() as unknown as NextFunction;

    auditMiddleware(fake.pool, 'export_csv', 'patient')(req, res, next);
    // Simulate a streaming/file response that never calls res.json()
    res.emit('finish');
    await new Promise((r) => setTimeout(r, 0));

    expect(fake.calls).toHaveLength(1);
    const params = fake.calls[0]!.params;
    expect(params[2]).toBe('export_csv');
    expect(params[5]).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// Explicit audit helpers
// ---------------------------------------------------------------------------
describe('auditLogin', () => {
  it('writes auth_login with outcome', async () => {
    const fake = auditFake();
    auditLogin(fake.pool, makeReq(), 'success', 'u1', 'o1');
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[2]).toBe('auth_login');
    expect(params[5]).toBe('success');
  });

  it('writes failure without userId when credentials wrong', async () => {
    const fake = auditFake();
    auditLogin(fake.pool, makeReq(), 'failure');
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[0]).toBeNull(); // actor_user_id
    expect(params[5]).toBe('failure');
  });
});

describe('auditLogout', () => {
  it('writes auth_logout with the explicitly-passed sessionId', async () => {
    const fake = auditFake();
    const req  = makeReq();
    auditLogout(fake.pool, req, 'u1', 'o1', 'sess-1');
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[0]).toBe('u1');   // actor_user_id
    expect(params[1]).toBe('o1');   // actor_org_id
    expect(params[2]).toBe('auth_logout');
    expect(params[4]).toBe('sess-1'); // target_id = sessionId
    expect(params[5]).toBe('success');
  });

  it('writes nulls when no session was found (idempotent logout with no/invalid refresh cookie)', async () => {
    const fake = auditFake();
    const req  = makeReq();
    auditLogout(fake.pool, req);
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[0]).toBeNull();
    expect(params[4]).toBeNull();
  });
});

describe('auditRefreshFail', () => {
  it('writes auth_refresh_fail with code in extra', async () => {
    const fake = auditFake();
    auditRefreshFail(fake.pool, makeReq(), 'SESSION_INVALID');
    await new Promise((r) => setTimeout(r, 0));

    const params = fake.calls[0]!.params;
    expect(params[2]).toBe('auth_refresh_fail');
    expect(params[5]).toBe('failure');
    expect(params[8]).toContain('SESSION_INVALID');
  });
});
