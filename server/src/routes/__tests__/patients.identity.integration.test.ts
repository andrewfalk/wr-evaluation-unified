// POST /api/patients/:id/identity-correction against real PostgreSQL (S7-7). Written against the route handler
// before its transaction loop moved to domain/patients/correctIdentity.ts, and kept unchanged across the move:
// these tests replace the order-based mock tests of the correction in patients.test.ts. The locking order of
// correctPatientIdentity (no-lock probe → active cases ORDER BY id FOR UPDATE → re-validate → person) is an
// invariant of S7: the concurrent scenarios below check that it does not deadlock with itself or with a PATCH.
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';

const lockMode = vi.hoisted(() => ({ mode: 'off' as 'off' | 'observe' | 'enforce' }));
vi.mock('../../config', async (importOriginal) => {
  const actualModule = await importOriginal<typeof import('../../config')>();
  const cfg = { ...actualModule.default };
  Object.defineProperty(cfg, 'lockEnforcementMode', { get: () => lockMode.mode, enumerable: true });
  return { ...actualModule, default: cfg };
});

import { createPatientsRouter } from '../patients';
import { makeRouterApp } from '../../testing/app';
import { acquireLock, lockPatientAnchor } from '../../db/patientLocks';
import {
  createIntegrationOrg, integrationPool, waitForLockWait, TEST_DATABASE_URL,
  type IntegrationOrg, type IntegrationUser,
} from '../../testing/integrationDb';

const APP = 'wr-itest-patient-identity';
const HOLDER_APP = 'wr-itest-patient-identity-holder';
const CORRECTED = '1957-12-13';

describe.skipIf(!TEST_DATABASE_URL)('POST /api/patients/:id/identity-correction (real PostgreSQL, S7-7)', () => {
  let pool: Pool;
  let holderPool: Pool;
  let org: IntegrationOrg;
  let docA: IntegrationUser;
  let docB: IntegrationUser;
  let admin: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool(APP);
    holderPool = integrationPool(HOLDER_APP);
    org = await createIntegrationOrg(holderPool, 'patient-identity');
    docA = await org.makeUser('doctor', 'Doc A');
    docB = await org.makeUser('doctor', 'Doc B');
    admin = await org.makeUser('admin', 'Admin C');
  });

  afterEach(async () => {
    lockMode.mode = 'off';
    await org.resetData();
  });

  afterAll(async () => {
    if (!pool) return;
    await org?.destroy();
    await pool.end();
    await holderPool.end();
  });

  const app = () => makeRouterApp((a) => { a.use('/api/patients', createPatientsRouter(pool)); });

  /** A person (number + birth date) with `cases` active cases, all assigned to `assigned`; ids sorted. */
  async function seedPerson(cases: number, assigned: IntegrationUser | null = docA, birthDate = '1957-12-31') {
    const no = `NO-${crypto.randomUUID()}`;
    const personId = (await holderPool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date) VALUES ($1, $2, '정정 환자', $3) RETURNING id`,
      [org.orgId, no, birthDate],
    )).rows[0].id;
    const ids: string[] = [];
    for (let i = 0; i < cases; i += 1) ids.push(await addCase(holderPool, personId, no, assigned, birthDate));
    return { personId, no, ids: ids.sort() };
  }

  async function addCase(db: Pool | PoolClient, personId: string, no: string, assigned: IntegrationUser | null, birthDate = '1957-12-31') {
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO patient_records (id, organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id,
                                    name, patient_no, birth_date, revision, payload)
       VALUES ($1, $2, $3, $4, $5, '정정 환자', $6, $7, 1, $8)`,
      [id, org.orgId, docA.id, assigned?.id ?? null, personId, no, birthDate,
        JSON.stringify({ id, data: { shared: { name: '정정 환자', patientNo: no, birthDate }, modules: {}, activeModules: [] } })],
    );
    return id;
  }

  function correct(user: IntegrationUser, pid: string, body: unknown, ifMatch: string | null = '1', headers: Record<string, string> = {}): Promise<request.Response> {
    let req = request(app()).post(`/api/patients/${pid}/identity-correction`).set(org.headers(user)).set(headers);
    if (ifMatch !== null) req = req.set('If-Match', ifMatch);
    return Promise.resolve(req.send(body as object));
  }
  const body = (birthDate = CORRECTED, reasonCode = 'batch_import_typo') => ({ birthDate, reasonCode });

  async function caseRow(id: string) {
    return (await holderPool.query<{ revision: number; birth_date: string; payload_birth: string }>(
      `SELECT revision, birth_date::text AS birth_date, payload->'data'->'shared'->>'birthDate' AS payload_birth
       FROM patient_records WHERE id = $1`, [id],
    )).rows[0];
  }
  async function personBirth(personId: string): Promise<string> {
    return (await holderPool.query<{ b: string }>(`SELECT birth_date::text AS b FROM patient_persons WHERE id = $1`, [personId])).rows[0].b;
  }
  async function auditRows(action: string, targetId: string, atLeast = 1) {
    const deadline = Date.now() + 3000;
    for (;;) {
      const { rows } = await holderPool.query<{ actor: string | null; outcome: string; target_type: string; extra: Record<string, unknown> | null }>(
        `SELECT actor_user_id AS actor, outcome, target_type, extra FROM audit_logs
          WHERE action = $1 AND target_id = $2 AND actor_org_id = $3 ORDER BY created_at, id`,
        [action, targetId, org.orgId],
      );
      if (rows.length >= atLeast || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  async function holdLock(user: IntegrationUser, pid: string): Promise<string> {
    const c = await holderPool.connect();
    try {
      await c.query('BEGIN');
      await lockPatientAnchor(c, { patientId: pid, orgId: org.orgId });
      const r = await acquireLock(c, { patientId: pid, orgId: org.orgId, userId: user.id, holderName: user.name, clientInstanceId: crypto.randomUUID() });
      await c.query('COMMIT');
      if (!r.ok) throw new Error('lock not acquired');
      return r.leaseToken;
    } finally {
      c.release();
    }
  }
  async function withHolder<T>(fn: (t1: PoolClient) => Promise<T>): Promise<T> {
    const t1 = await holderPool.connect();
    try {
      return await fn(t1);
    } finally {
      await t1.query('ROLLBACK').catch(() => {});
      t1.release();
    }
  }

  const FORBIDDEN = { code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' };

  // ---------------------------------------------------------------------------------------------
  // Correction
  // ---------------------------------------------------------------------------------------------

  it('one active case: the assigned doctor corrects person and case (column + payload, revision + 1); audited in the transaction', async () => {
    const { personId, ids: [pid] } = await seedPerson(1);
    const res = await correct(docA, pid, body());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: pid, sync: { revision: 2 }, affectedPatientIds: [pid] });
    expect(await personBirth(personId)).toBe(CORRECTED);
    expect(await caseRow(pid)).toEqual({ revision: 2, birth_date: CORRECTED, payload_birth: CORRECTED });
    expect(await auditRows('patient_identity_correct', personId)).toEqual([
      { actor: docA.id, outcome: 'success', target_type: 'patient_person', extra: { reasonCode: 'batch_import_typo', affectedCaseCount: 1 } },
    ]);
  });

  it('several active cases: a doctor → 403 IDENTITY_CORRECTION_REQUIRES_ADMIN; an admin corrects them all', async () => {
    const { personId, ids } = await seedPerson(3);
    const denied = await correct(docA, ids[0], body());
    expect(denied.status).toBe(403);
    expect(denied.body).toEqual({ code: 'IDENTITY_CORRECTION_REQUIRES_ADMIN', error: 'This patient number has multiple active cases; only an administrator can correct it' });
    expect(await personBirth(personId)).toBe('1957-12-31');

    const ok = await correct(admin, ids[0], body());
    expect(ok.status).toBe(200);
    expect([...ok.body.affectedPatientIds].sort()).toEqual(ids);
    for (const id of ids) expect(await caseRow(id)).toMatchObject({ revision: 2, birth_date: CORRECTED });
  });

  it('a stale If-Match → 409 with the current revision; no If-Match → 400', async () => {
    const { ids: [pid] } = await seedPerson(1);
    const stale = await correct(docA, pid, body(), '5');
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ code: 'CONFLICT', error: 'Revision mismatch.', currentRevision: 1 });
    expect((await correct(docA, pid, body(), null)).status).toBe(400);
  });

  it('an empty, invalid or future birth date and an unknown reason code → 400; nothing written', async () => {
    const { personId, ids: [pid] } = await seedPerson(1);
    expect((await correct(docA, pid, body(''))).status).toBe(400);
    const invalid = await correct(docA, pid, body('1957-02-30'));
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_BIRTH_DATE');
    expect((await correct(docA, pid, body('4110-02-12'))).status).toBe(400);
    expect((await correct(docA, pid, body(CORRECTED, 'because'))).status).toBe(400);
    expect(await personBirth(personId)).toBe('1957-12-31');
  });

  it('neither the assigned doctor nor an admin → 403; a missing patient → 404', async () => {
    const { ids: [pid] } = await seedPerson(1, docA);
    const res = await correct(docB, pid, body());
    expect(res.status).toBe(403);
    expect(res.body).toEqual(FORBIDDEN);
    const missing = await correct(admin, crypto.randomUUID(), body());
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
  });

  it('reassigned while the correction waits for the case locks → 403', async () => {
    const { ids: [pid] } = await seedPerson(1, docA);
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [pid]);
      await t1.query(`UPDATE patient_records SET assigned_doctor_user_id = $2 WHERE id = $1`, [pid, docB.id]);
      const pending = correct(docA, pid, body());
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Edit locks
  // ---------------------------------------------------------------------------------------------

  it('a lock on a sibling case → 423 (in any lock mode)', async () => {
    const { personId, ids } = await seedPerson(2);
    await holdLock(docB, ids[1]);
    const res = await correct(admin, ids[0], body());
    expect(res.status).toBe(423);
    expect(res.body).toEqual({ code: 'LOCK_HELD', error: 'A related case is being edited by Doc B' });
    expect(await personBirth(personId)).toBe('1957-12-31');
  });

  it('the caller\'s own lock on the target case does not block the correction', async () => {
    const { ids: [pid] } = await seedPerson(1);
    const token = await holdLock(docA, pid);
    lockMode.mode = 'enforce'; // the early gate is on too: the caller's token passes it as well
    expect((await correct(docA, pid, body(), '1', { 'X-Lock-Token': token })).status).toBe(200);
  });

  it('enforce: another user\'s lock on the target → 423 from the early gate (lock holder body)', async () => {
    const { ids: [pid] } = await seedPerson(1);
    await holdLock(docB, pid);
    lockMode.mode = 'enforce';
    const res = await correct(docA, pid, body());
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ code: 'LOCK_HELD', error: 'Currently being edited by Doc B', holder: { holderName: 'Doc B' } });
  });

  it('a lock taken on the target after the early gate (TOCTOU) is caught after the cases are locked → 423', async () => {
    const { personId, ids: [pid] } = await seedPerson(1);
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await lockPatientAnchor(t1, { patientId: pid, orgId: org.orgId });
      await acquireLock(t1, { patientId: pid, orgId: org.orgId, userId: docB.id, holderName: 'Doc B', clientInstanceId: crypto.randomUUID() });
      const pending = correct(docA, pid, body()); // the early gate does not see the uncommitted lock
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(423);
      expect(res.body).toEqual({ code: 'LOCK_HELD', error: 'A related case is being edited by Doc B' });
    });
    expect(await personBirth(personId)).toBe('1957-12-31');
  });

  // ---------------------------------------------------------------------------------------------
  // Concurrency (the locking order invariant)
  // ---------------------------------------------------------------------------------------------

  it('cases A and B of one person corrected at the same time: no deadlock — one 200, the other 409 (B\'s revision moved)', async () => {
    const { ids } = await seedPerson(2);
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [ids[0]]);
      const a = correct(admin, ids[0], body('1957-12-13'));
      const b = correct(admin, ids[1], body('1957-12-14'));
      await waitForLockWait(holderPool, APP, { count: 2 });
      await t1.query('ROLLBACK');
      const results = await Promise.all([a, b]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const conflict = results.find((r) => r.status === 409)!;
      expect(conflict.body).toEqual({ code: 'CONFLICT', error: 'Revision mismatch.', currentRevision: 2 });
    });
  });

  it('a correction and a PATCH of a sibling case at the same time: no deadlock, both succeed', async () => {
    const { personId, no, ids } = await seedPerson(2, null);
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_persons WHERE id = $1 FOR UPDATE`, [personId]);
      // The PATCH of case B holds B and waits for the person; the correction of A locks A, then waits for B.
      const patching = Promise.resolve(request(app()).patch(`/api/patients/${ids[1]}`).set(org.headers(admin)).set('If-Match', '1')
        .send({ data: { shared: { name: '형제 수정', patientNo: no, birthDate: '1957-12-31' }, modules: {}, activeModules: [] } }));
      await waitForLockWait(holderPool, APP);
      const correcting = correct(admin, ids[0], body());
      await waitForLockWait(holderPool, APP, { count: 2 });
      await t1.query('ROLLBACK');
      const [p, c] = await Promise.all([patching, correcting]);
      expect(p.status).toBe(200);
      expect(c.status).toBe(200);
    });
    expect(await personBirth(personId)).toBe(CORRECTED);
  });

  it('a case added to the person while the correction waits → retried with the new set (200, all cases)', async () => {
    const { personId, no, ids } = await seedPerson(1, null);
    let added!: string;
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_persons WHERE id = $1 FOR UPDATE`, [personId]);
      added = await addCase(t1, personId, no, null);
      const pending = correct(admin, ids[0], body()); // locks [A], waits for the person
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT'); // the case set is now [A, added] → set changed → retry
      const res = await pending;
      expect(res.status).toBe(200);
      expect([...res.body.affectedPatientIds].sort()).toEqual([ids[0], added].sort());
    });
    expect(await caseRow(added)).toMatchObject({ birth_date: CORRECTED });
  });
});
