import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const availabilityState = { available: true };
vi.mock('../../statsWorkbenchRuntimeState', () => ({
  getStatsWorkbenchAvailability: () => ({ available: availabilityState.available, reason: null, checkedAt: null }),
}));

const writeAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../audit', () => ({ writeAuditLog: (...args: unknown[]) => writeAuditLog(...args) }));

import { requireCapability } from '../requireCapability';
import { createFakePool, type FakePool } from '../../testing/fakePool';

type SessionInfo = { userId: string; organizationId: string | null; role: string };

function capabilityFake(reply: unknown[] | Error): FakePool {
  return createFakePool({
    handlers: [{ name: 'capability', match: () => true, reply: reply instanceof Error ? reply : { rows: reply } }],
  });
}

function makeReq(session: SessionInfo | undefined): Request {
  return {
    sessionInfo: session,
    ip: '10.0.0.1',
    headers: { 'user-agent': 'test-agent' },
  } as unknown as Request;
}

function makeRes() {
  const json   = vi.fn();
  const status = vi.fn().mockReturnValue({ json });
  return { res: { status, json } as unknown as Response, status, json };
}

describe('requireCapability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    availabilityState.available = true;
  });

  it('decides the capability only — runtime availability is decided by the router requireFeature (S4 / P1-15)', async () => {
    availabilityState.available = false; // ignored here: the stats router answers 404 before this runs
    const fake = capabilityFake([{ has_default: true, has_grant: false }]);
    const middleware = requireCapability(fake.pool, 'stats.view');
    const req  = makeReq({ userId: 'u1', organizationId: 'org-1', role: 'doctor' });
    const next = vi.fn() as unknown as NextFunction;
    const { res, status } = makeRes();
    await middleware(req, res, next);
    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
    expect(fake.calls).toHaveLength(1);
  });

  it('returns 403 when organizationId is null', async () => {
    const { pool } = capabilityFake([]);
    const middleware = requireCapability(pool, 'stats.view');
    const req  = makeReq({ userId: 'u1', organizationId: null, role: 'doctor' });
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, json } = makeRes();
    await middleware(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('calls next when the capability defaults to all roles', async () => {
    const { pool } = capabilityFake([{ has_default: true, has_grant: false }]);
    const middleware = requireCapability(pool, 'stats.view');
    const req  = makeReq({ userId: 'u1', organizationId: 'org-1', role: 'doctor' });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next when an active grant exists', async () => {
    const { pool } = capabilityFake([{ has_default: false, has_grant: true }]);
    const middleware = requireCapability(pool, 'stats.export_limited_rows');
    const req  = makeReq({ userId: 'u1', organizationId: 'org-1', role: 'doctor' });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('returns 403 and audits denial when neither default nor grant applies', async () => {
    const { pool } = capabilityFake([{ has_default: false, has_grant: false }]);
    const middleware = requireCapability(pool, 'stats.export_phi');
    const req  = makeReq({ userId: 'u1', organizationId: 'org-1', role: 'doctor' });
    const next = vi.fn() as unknown as NextFunction;
    const { res, status, json } = makeRes();
    await middleware(req, res, next);
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'FORBIDDEN', capability: 'stats.export_phi' }));
    expect(next).not.toHaveBeenCalled();
    expect(writeAuditLog).toHaveBeenCalledWith(pool, expect.objectContaining({
      action: 'stats_access_denied', outcome: 'denied', actorUserId: 'u1',
    }));
  });

  it('calls next(err) when the DB query throws', async () => {
    const { pool } = capabilityFake(new Error('DB down'));
    const middleware = requireCapability(pool, 'stats.view');
    const req  = makeReq({ userId: 'u1', organizationId: 'org-1', role: 'doctor' });
    const next = vi.fn() as unknown as NextFunction;
    const { res } = makeRes();
    await middleware(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
