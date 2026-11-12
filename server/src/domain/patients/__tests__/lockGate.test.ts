// runLockGate (S7-0): the edit-lock write gate without the request — the former evaluateLockGate body.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mode = vi.hoisted(() => ({ value: 'off' as 'off' | 'observe' | 'enforce' }));
vi.mock('../../../config', async () => {
  const cfg = (await import('../../../testing/configMock.js')).testConfig();
  Object.defineProperty(cfg, 'lockEnforcementMode', { get: () => mode.value, enumerable: true });
  return { default: cfg };
});
const audit = vi.hoisted(() => ({ writeAuditLog: vi.fn() }));
vi.mock('../../../middleware/audit', () => audit);

import { hashToken } from '../../../auth/tokenHash';
import { createFakePool } from '../../../testing/fakePool';
import { runLockGate } from '../lockGate';
import type { PatientWriteContext } from '../context';

const PATIENT = '11111111-1111-1111-1111-111111111111';
const ctx: PatientWriteContext = {
  actor: { userId: 'u-1', role: 'doctor', name: 'Dr. Kim' },
  orgId: 'org-1',
  leaseToken: 'ignored-here',
  audit: { ip: '10.0.0.1', userAgent: 'vitest' },
};
const lockRow = {
  patient_id: PATIENT, client_instance_id: 'c-1', user_id: 'u-2', holder_name: 'Dr. Lee',
  acquired_at: new Date('2026-01-01T00:00:00Z'), expires_at: new Date('2026-01-01T00:10:00Z'),
  lease_token_hash: hashToken('their-token'),
};

function poolWithLock(rows: unknown[]) {
  return createFakePool({ handlers: [{ name: 'locks', match: /FROM patient_locks/, reply: { rows } }] });
}

beforeEach(() => {
  audit.writeAuditLog.mockReset();
});

describe('runLockGate', () => {
  it('off: passes without reading patient_locks', async () => {
    mode.value = 'off';
    const fake = poolWithLock([lockRow]);
    expect(await runLockGate(fake.pool, fake.pool, ctx, { patientId: PATIENT, leaseToken: null })).toEqual({ blocked: null });
    expect(fake.calls).toEqual([]);
  });

  it('enforce: a lock held by someone else blocks; no audit row', async () => {
    mode.value = 'enforce';
    const fake = poolWithLock([lockRow]);
    const { blocked } = await runLockGate(fake.pool, fake.pool, ctx, { patientId: PATIENT, leaseToken: null });
    expect(blocked).toMatchObject({ patientId: PATIENT, holderName: 'Dr. Lee' });
    expect(fake.callsTo('locks')[0].params).toEqual([PATIENT, 'org-1']);
    expect(audit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('enforce: the holder\'s own lease token, or no lock, passes', async () => {
    mode.value = 'enforce';
    const own = await runLockGate(poolWithLock([lockRow]).pool, createFakePool().pool, ctx, { patientId: PATIENT, leaseToken: 'their-token' });
    expect(own.blocked).toBeNull();
    const none = await runLockGate(poolWithLock([]).pool, createFakePool().pool, ctx, { patientId: PATIENT, leaseToken: null });
    expect(none.blocked).toBeNull();
  });

  it('observe: passes and writes the audit row through the pool (extra = { holderName })', async () => {
    mode.value = 'observe';
    const tx = poolWithLock([lockRow]);
    const pool = createFakePool();
    expect(await runLockGate(tx.pool, pool.pool, ctx, { patientId: PATIENT, leaseToken: null })).toEqual({ blocked: null });
    expect(audit.writeAuditLog).toHaveBeenCalledTimes(1);
    expect(audit.writeAuditLog).toHaveBeenCalledWith(pool.pool, {
      actorUserId: 'u-1', actorOrgId: 'org-1', action: 'patient_lock_observed_block',
      targetType: 'patient', targetId: PATIENT, outcome: 'success',
      ip: '10.0.0.1', userAgent: 'vitest',
      extra: { holderName: 'Dr. Lee' },
    });
  });

  it('observe: auditContext adds `context` after holderName (the assignment / video apply rows)', async () => {
    mode.value = 'observe';
    const fake = poolWithLock([lockRow]);
    await runLockGate(fake.pool, fake.pool, ctx, { patientId: PATIENT, leaseToken: null, auditContext: 'assignment' });
    const extra = audit.writeAuditLog.mock.calls[0][1].extra;
    expect(extra).toEqual({ holderName: 'Dr. Lee', context: 'assignment' });
    expect(Object.keys(extra)).toEqual(['holderName', 'context']);
  });
});
