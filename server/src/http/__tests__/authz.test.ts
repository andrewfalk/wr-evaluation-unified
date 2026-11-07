// http/authz.ts (REFACTORING_ROADMAP S4 / P1-15).
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Request } from 'express';

vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig(),
}));

import { makeRouterApp } from '../../testing/app';
import { createFakePool, authSessionHandler } from '../../testing/fakePool';
import { makeAccessToken, authHeaders } from '../../testing/tokens';
import { AppError } from '../errors';
import { requireAdmin, requireAuth, requireCsrf, requireFeature, requireOrg, sessionOf } from '../authz';
import { createAuthMiddleware } from '../../middleware/auth';
import { adminOnly } from '../../middleware/adminOnly';
import { csrfMiddleware } from '../../middleware/csrf';

describe('re-exports keep the existing middleware', () => {
  it('requireAuth / requireAdmin / requireCsrf are the middleware/* implementations', () => {
    expect(requireAuth).toBe(createAuthMiddleware);
    expect(requireAdmin).toBe(adminOnly);
    expect(requireCsrf).toBe(csrfMiddleware);
  });
});

describe('sessionOf', () => {
  it('returns the session set by the auth middleware', () => {
    const session = { sessionId: 's', userId: 'u', csrfTokenHash: 'h', organizationId: null, role: 'doctor', name: 'n', mustChangePassword: false };
    expect(sessionOf({ sessionInfo: session } as unknown as Request)).toBe(session);
  });

  it('throws 401 UNAUTHORIZED when a route forgot requireAuth', () => {
    let caught: unknown;
    try { sessionOf({} as Request); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });
});

function orgApp() {
  const fake = createFakePool({ handlers: [authSessionHandler()] });
  const app = makeRouterApp((a) => {
    a.get('/x', requireAuth(fake.pool), requireOrg(), (req, res) => { res.json({ orgId: req.orgId }); });
  });
  return { app, fake };
}

describe('requireOrg', () => {
  it('sets req.orgId for a session with an organization', async () => {
    const { app } = orgApp();
    const res = await request(app).get('/x').set(authHeaders(makeAccessToken({ orgId: 'org-9' })));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orgId: 'org-9' });
  });

  it('403 FORBIDDEN "Organization context required" without one (the existing response)', async () => {
    const { app } = orgApp();
    const res = await request(app).get('/x').set(authHeaders(makeAccessToken({ orgId: null })));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ code: 'FORBIDDEN', error: 'Organization context required' });
  });
});

describe('requireAdmin behind requireAuth (router.use form)', () => {
  function adminApp() {
    const fake = createFakePool({ handlers: [authSessionHandler()] });
    const app = makeRouterApp((a) => {
      a.use('/admin', requireAuth(fake.pool), requireAdmin());
      a.get('/admin/thing', (_req, res) => { res.json({ ok: true }); });
    });
    return { app, fake };
  }

  it('401 without a token, before any DB query', async () => {
    const { app, fake } = adminApp();
    expect((await request(app).get('/admin/thing')).status).toBe(401);
    expect(fake.calls).toHaveLength(0);
  });

  it('403 for a non-admin, 200 for an admin', async () => {
    const { app } = adminApp();
    expect((await request(app).get('/admin/thing').set(authHeaders(makeAccessToken({ role: 'doctor' })))).body)
      .toEqual({ code: 'FORBIDDEN', error: 'Admin access required' });
    expect((await request(app).get('/admin/thing').set(authHeaders(makeAccessToken({ role: 'admin' })))).status).toBe(200);
  });
});

describe('requireFeature', () => {
  function featureApp(open: { value: boolean }) {
    const fake = createFakePool({ handlers: [authSessionHandler()] });
    const app = makeRouterApp((a) => {
      a.use('/f', requireFeature(() => open.value), requireAuth(fake.pool));
      a.get('/f/x', (_req, res) => { res.json({ ok: true }); });
    });
    return { app, fake };
  }

  it('closed: 404 NOT_FOUND for every route, before authentication (existence not revealed)', async () => {
    const { app, fake } = featureApp({ value: false });
    const res = await request(app).get('/f/x');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'NOT_FOUND', error: 'Not found' });
    expect(fake.calls).toHaveLength(0);
  });

  it('is read on every request (runtime availability can change)', async () => {
    const open = { value: false };
    const { app } = featureApp(open);
    expect((await request(app).get('/f/x')).status).toBe(404);
    open.value = true;
    expect((await request(app).get('/f/x').set(authHeaders(makeAccessToken()))).status).toBe(200);
  });

  it('only a boolean true opens it, and passing the availability object does not compile', () => {
    const availability = () => ({ available: false, reason: null, checkedAt: null });
    // @ts-expect-error — requireFeature needs () => boolean; the availability object is always truthy.
    const misused = requireFeature(availability);
    const res = { status: vi.fn().mockReturnValue({ json: vi.fn() }) };
    const next = vi.fn();
    misused({} as Request, res as never, next);
    expect(next).not.toHaveBeenCalled(); // even if it slips through, a non-true value keeps it closed
    expect(res.status).toHaveBeenCalledWith(404);
  });
});
