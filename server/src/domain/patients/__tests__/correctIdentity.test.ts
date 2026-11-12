// correctIdentity's retry loop (S7-7). The successful retry after one changed case set runs against real
// PostgreSQL (patients.identity.integration.test.ts); giving up after IDENTITY_CORRECTION_MAX_ATTEMPTS needs the
// set to change on every attempt, which has no deterministic interleaving on a real database — pinned here.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config', async () => ({
  default: (await import('../../../testing/configMock.js')).testConfig({ lockEnforcementMode: 'off' }),
}));
const correction = vi.hoisted(() => ({ correctPatientIdentity: vi.fn() }));
vi.mock('../../../db/patientIdentityCorrection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db/patientIdentityCorrection')>()),
  correctPatientIdentity: correction.correctPatientIdentity,
}));

import { IdentitySetChangedError } from '../../../db/patientIdentityCorrection';
import { createFakePool } from '../../../testing/fakePool';
import { correctIdentity, IDENTITY_CORRECTION_MAX_ATTEMPTS } from '../correctIdentity';
import type { PatientWriteContext } from '../context';

const ctx: PatientWriteContext = {
  actor: { userId: 'u-1', role: 'admin', name: 'Admin' },
  orgId: 'org-1',
  leaseToken: null,
  audit: { ip: null, userAgent: null },
};
const params = { id: 'p-1', expectedRevision: 1, birthDate: '1957-12-13', reasonCode: 'other' };

beforeEach(() => { correction.correctPatientIdentity.mockReset(); });

describe('correctIdentity retry loop', () => {
  it('a case set that changes on every attempt: each attempt rolled back, then set_changed', async () => {
    correction.correctPatientIdentity.mockImplementation(async () => { throw new IdentitySetChangedError(); });
    const fake = createFakePool();
    expect(await correctIdentity(fake.pool, ctx, params)).toEqual({ kind: 'set_changed' });
    expect(IDENTITY_CORRECTION_MAX_ATTEMPTS).toBe(3);
    expect(correction.correctPatientIdentity).toHaveBeenCalledTimes(3);
    expect(fake.transactions.map((t) => t.outcome)).toEqual(['rollback', 'rollback', 'rollback']);
    fake.assertAllReleased();
  });

  it('an error other than a changed set is not retried', async () => {
    const boom = new Error('boom');
    correction.correctPatientIdentity.mockImplementation(async () => { throw boom; });
    const fake = createFakePool();
    await expect(correctIdentity(fake.pool, ctx, params)).rejects.toBe(boom);
    expect(correction.correctPatientIdentity).toHaveBeenCalledTimes(1);
    fake.assertAllReleased();
  });
});
