import { describe, expect, it } from 'vitest';
import { isUuid, summarizePc, type PcRow } from '../pcIdentity';
import { clientExtraWithoutReserved, createBurstTracker, createEventThrottle, fallbackActor, sessionMatchesPc } from '../emrAuditRecord';
import { createPacedLimiter } from '../../middleware/rateLimit';

const r = (id: string, at: string, overrides: Partial<PcRow> = {}): PcRow => ({
  id, user_id: `u-${id}`, organization_id: 'org-1', status: 'active', registered_at: at, ...overrides,
});

describe('summarizePc', () => {
  it('status: any revoked row → revoked; else any active → active; else pending', () => {
    expect(summarizePc('fp', [r('a', '2026-01-01', { status: 'active' }), r('b', '2026-01-02', { status: 'revoked' })]).status).toBe('revoked');
    expect(summarizePc('fp', [r('a', '2026-01-01', { status: 'pending' }), r('b', '2026-01-02', { status: 'active' })]).status).toBe('active');
    expect(summarizePc('fp', [r('a', '2026-01-01', { status: 'pending' })]).status).toBe('pending');
  });

  it('anchor = first registered row whatever its status, ties by id; registrant = first active row', () => {
    const pc = summarizePc('fp', [
      r('c', '2026-01-02T00:00:00Z', { status: 'active' }),
      r('b', '2026-01-01T00:00:00Z', { status: 'pending' }),
      r('a', '2026-01-01T00:00:00Z', { status: 'revoked' }),
    ]);
    expect(pc.anchorId).toBe('a');
    expect(pc.registrantUserId).toBe('u-c');
  });

  it('organisation: one value (null counts) is resolved; several are not', () => {
    expect(summarizePc('fp', [r('a', '2026-01-01'), r('b', '2026-01-02')])).toMatchObject({ orgResolved: true, orgId: 'org-1' });
    expect(summarizePc('fp', [r('a', '2026-01-01', { organization_id: null })])).toMatchObject({ orgResolved: true, orgId: null });
    expect(summarizePc('fp', [r('a', '2026-01-01'), r('b', '2026-01-02', { organization_id: null })]))
      .toMatchObject({ orgResolved: false, orgId: null, orgIds: ['org-1', null] });
  });

  it('isUuid', () => {
    expect(isUuid('6f1c1d3e-8f7a-4c55-9b1e-2a3b4c5d6e7f')).toBe(true);
    expect(isUuid('dev-1')).toBe(false);
    expect(isUuid("6f1c1d3e-8f7a-4c55-9b1e-2a3b4c5d6e7f' OR 1=1")).toBe(false);
  });
});

describe('emr audit record helpers', () => {
  it('reserved keys are removed and the client source is kept as client_source', () => {
    expect(clientExtraWithoutReserved({ source: 'auto', deviceId: 'x', burst: true, other: 1 })).toEqual({ client_source: 'auto', other: 1 });
    expect(clientExtraWithoutReserved(null)).toEqual({});
  });

  it('session/PC organisation match', () => {
    const pc = summarizePc('fp', [r('a', '2026-01-01')]);
    expect(sessionMatchesPc({ userId: 'u', organizationId: 'org-1' }, pc)).toBe(true);
    expect(sessionMatchesPc({ userId: 'u', organizationId: 'org-2' }, pc)).toBe(false);
    expect(sessionMatchesPc({ userId: 'u', organizationId: null }, pc)).toBe(true);
  });

  it('fallback actor is always flagged uncertain', () => {
    const pc = summarizePc('fp', [r('a', '2026-01-01')]);
    expect(fallbackActor(pc, { userId: 's', organizationId: 'org-1' })).toEqual({
      actorUserId: 's', actorOrgId: 'org-1', flags: { actor_uncertain: true, actor_source: 'session_fallback' },
    });
    expect(fallbackActor(pc, null)).toEqual({
      actorUserId: 'u-a', actorOrgId: 'org-1',
      flags: { actor_uncertain: true, session_missing: true, actor_from_queue: true, actor_source: 'device_registrant' },
    });
  });

  it('burst tracker and event throttle', () => {
    let t = 0;
    const burst = createBurstTracker({ gapMs: 1000, now: () => t });
    expect(burst.isBurst('pc')).toBe(false);
    burst.accepted('pc');
    t = 999;
    expect(burst.isBurst('pc')).toBe(true);
    t = 2000;
    expect(burst.isBurst('pc')).toBe(false);

    const throttle = createEventThrottle({ windowMs: 100, now: () => t });
    expect(throttle.take('pc')).toEqual({ suppressed: 0 });
    expect(throttle.take('pc')).toBeNull();
    expect(throttle.take('pc')).toBeNull();
    t += 100;
    expect(throttle.take('pc')).toEqual({ suppressed: 2 });
  });
});

describe('createPacedLimiter', () => {
  it('burst at once, then waits at the rate; refuses beyond maxWaiting real waiters; refund gives the slot back', () => {
    let t = 0;
    const lim = createPacedLimiter({ burst: 2, ratePerSec: 10, maxWaiting: 2, now: () => t });
    const a = lim.acquire('k');
    const b = lim.acquire('k');
    expect([a.allowed && a.delayMs, b.allowed && b.delayMs]).toEqual([0, 0]);
    const c = lim.acquire('k');
    const d = lim.acquire('k');
    expect(c.allowed && c.delayMs).toBe(100);
    expect(d.allowed && d.delayMs).toBe(200);
    const e = lim.acquire('k');
    expect(e.allowed).toBe(false);
    if (!e.allowed) expect(e.retryAfterSec).toBeGreaterThanOrEqual(1);
    // A refund returns a token but the two waiters are still waiting: no third waiter.
    if (a.allowed) a.refund();
    expect(lim.acquire('k').allowed).toBe(false);
    if (c.allowed) c.doneWaiting();
    const f = lim.acquire('k');
    expect(f.allowed && f.delayMs).toBe(200);
    t = 10_000; // refilled
    const g = lim.acquire('k');
    expect(g.allowed && g.delayMs).toBe(0);
    expect(lim.acquire('other').allowed).toBe(true);
  });

  it('throughput over a period is bounded by burst + rate × time', () => {
    let t = 0;
    const lim = createPacedLimiter({ burst: 5, ratePerSec: 2, maxWaiting: 0, now: () => t });
    let accepted = 0;
    for (let ms = 0; ms <= 10_000; ms += 10) {
      t = ms;
      for (let i = 0; i < 3; i += 1) if (lim.acquire('k').allowed) accepted += 1;
    }
    expect(accepted).toBeLessThanOrEqual(5 + 2 * 10 + 1);
    expect(accepted).toBeGreaterThanOrEqual(5 + 2 * 10 - 1);
  });
});
