// The locking order of correctPatientIdentity is an S7 invariant (plan §3): no-lock probe → the person's
// active cases ORDER BY id FOR UPDATE → re-validate the target → person FOR UPDATE → set re-check → lock checks
// → UPDATEs. Real-database tests cannot tell a missing ORDER BY id apart (both transactions scan in the same
// order — checked in S7-7), so the statement order is pinned here, as the order-based route test did.
import { describe, expect, it } from 'vitest';
import { createFakePool } from '../../testing/fakePool';
import { correctPatientIdentity } from '../patientIdentityCorrection';

const ORG = 'org-1';
const PERSON = 'person-1';
const target = { id: 'case-a', patient_person_id: PERSON, revision: 1, assigned_doctor_user_id: 'u-1' };

function fakeFor(caseIds: string[]) {
  return createFakePool({
    handlers: [
      { name: 'target', match: /SELECT id, patient_person_id, revision, assigned_doctor_user_id\s+FROM patient_records/, reply: { rows: [target] } },
      { name: 'cases', match: /SELECT id FROM patient_records\s+WHERE patient_person_id = \$1/, reply: { rows: caseIds.map((id) => ({ id })) } },
      { name: 'person.lock', match: /SELECT id FROM patient_persons/, reply: { rows: [{ id: PERSON }] } },
      { name: 'locks.target', match: /FROM patient_locks\s+WHERE patient_id = \$1/, reply: { rows: [] } },
      { name: 'locks.others', match: /SELECT holder_name FROM patient_locks/, reply: { rows: [] } },
      { name: 'person.update', match: /UPDATE patient_persons/, reply: { rows: [], rowCount: 1 } },
      { name: 'cases.update', match: /UPDATE patient_records/, reply: { rows: caseIds.map((id) => ({ id })) } },
    ],
  });
}

describe('correctPatientIdentity locking order (S7 invariant)', () => {
  it('active cases are locked ORDER BY id FOR UPDATE before the person; the set re-check is ordered and unlocked', async () => {
    const fake = fakeFor(['case-a', 'case-b']);
    const result = await correctPatientIdentity(fake.pool, {
      targetId: 'case-a', orgId: ORG, expectedRevision: 1, birthDate: '1957-12-13',
      session: { userId: 'u-1', role: 'admin' }, leaseToken: null,
    });
    expect(result).toEqual({ personId: PERSON, affectedPatientIds: ['case-a', 'case-b'], caseCount: 2 });

    const order = fake.calls.map((c) => c.handler);
    expect(order).toEqual(['target', 'cases', 'target', 'person.lock', 'cases', 'locks.target', 'locks.others', 'person.update', 'cases.update']);

    const [lockCases, recheckCases] = fake.callsTo('cases').map((c) => c.sql);
    expect(lockCases).toMatch(/ORDER BY id\s+FOR UPDATE/);
    expect(recheckCases).toMatch(/ORDER BY id/);
    expect(recheckCases).not.toMatch(/FOR UPDATE/);
    expect(fake.callsTo('target')[0].sql).not.toMatch(/FOR UPDATE/); // the probe takes no lock
    expect(fake.callsTo('person.lock')[0].sql).toMatch(/FOR UPDATE/);
  });
});
