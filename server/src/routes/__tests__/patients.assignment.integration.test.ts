// POST /api/patients/:id/assignment (admin only) against real PostgreSQL (S7-6). Written against the route
// handler before it moved to domain/patients/assignPatient.ts, and kept unchanged across the move: these tests
// replace the order-based mock tests of the assignment in patients.test.ts.
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
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
  createIntegrationOrg, integrationPool, TEST_DATABASE_URL,
  type IntegrationOrg, type IntegrationUser,
} from '../../testing/integrationDb';

const APP = 'wr-itest-patient-assign';
const HOLDER_APP = 'wr-itest-patient-assign-holder';

describe.skipIf(!TEST_DATABASE_URL)('POST /api/patients/:id/assignment (real PostgreSQL, S7-6)', () => {
  let pool: Pool;
  let holderPool: Pool;
  let org: IntegrationOrg;
  let otherOrg: IntegrationOrg;
  let docA: IntegrationUser;
  let docB: IntegrationUser;
  let nurse: IntegrationUser;
  let admin: IntegrationUser;
  let otherDoc: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool(APP);
    holderPool = integrationPool(HOLDER_APP);
    org = await createIntegrationOrg(holderPool, 'patient-assign');
    otherOrg = await createIntegrationOrg(holderPool, 'patient-assign-other');
    docA = await org.makeUser('doctor', 'Doc A');
    docB = await org.makeUser('doctor', 'Doc B');
    nurse = await org.makeUser('nurse', 'Nurse N');
    admin = await org.makeUser('admin', 'Admin C');
    otherDoc = await otherOrg.makeUser('doctor', 'Other Doc');
  });

  afterEach(async () => {
    lockMode.mode = 'off';
    await org.resetData();
  });

  afterAll(async () => {
    if (!pool) return;
    await org?.destroy();
    await otherOrg?.destroy();
    await pool.end();
    await holderPool.end();
  });

  const app = () => makeRouterApp((a) => { a.use('/api/patients', createPatientsRouter(pool)); });

  async function seed(assigned: IntegrationUser | null = docA) {
    const pid = crypto.randomUUID();
    const personId = (await holderPool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1, '배정 환자') RETURNING id`, [org.orgId],
    )).rows[0].id;
    await holderPool.query(
      `INSERT INTO patient_records (id, organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id, name, revision, payload)
       VALUES ($1, $2, $3, $4, $5, '배정 환자', 1, $6)`,
      [pid, org.orgId, docA.id, assigned?.id ?? null, personId,
        JSON.stringify({ id: pid, data: { shared: { name: '배정 환자', doctorName: assigned?.name ?? '' }, modules: {}, activeModules: [] } })],
    );
    return pid;
  }

  function assign(user: IntegrationUser, pid: string, body: unknown, force = false): Promise<request.Response> {
    let req = request(app()).post(`/api/patients/${pid}/assignment`).set(org.headers(user));
    if (force) req = req.query({ force: 'true' });
    return Promise.resolve(req.send(body as object));
  }

  async function record(pid: string) {
    return (await holderPool.query<{ revision: number; assigned: string | null; owner: string; doctor_name: string | null }>(
      `SELECT revision, assigned_doctor_user_id AS assigned, owner_user_id AS owner,
              payload->'data'->'shared'->>'doctorName' AS doctor_name
       FROM patient_records WHERE id = $1`, [pid],
    )).rows[0];
  }
  async function lockRows(pid: string): Promise<number> {
    return (await holderPool.query(`SELECT 1 FROM patient_locks WHERE patient_id = $1`, [pid])).rowCount ?? 0;
  }
  async function auditRows(action: string, targetId: string, atLeast = 1) {
    const deadline = Date.now() + 3000;
    for (;;) {
      const { rows } = await holderPool.query<{ actor: string | null; outcome: string; extra: Record<string, unknown> | null }>(
        `SELECT actor_user_id AS actor, outcome, extra FROM audit_logs
          WHERE action = $1 AND target_id = $2 AND actor_org_id = $3 ORDER BY created_at, id`,
        [action, targetId, org.orgId],
      );
      if (rows.length >= atLeast || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  async function holdLock(user: IntegrationUser, pid: string): Promise<void> {
    const c = await holderPool.connect();
    try {
      await c.query('BEGIN');
      await lockPatientAnchor(c, { patientId: pid, orgId: org.orgId });
      const r = await acquireLock(c, { patientId: pid, orgId: org.orgId, userId: user.id, holderName: user.name, clientInstanceId: crypto.randomUUID() });
      await c.query('COMMIT');
      if (!r.ok) throw new Error('lock not acquired');
    } finally {
      c.release();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Assignment
  // ---------------------------------------------------------------------------------------------

  it('200: assigned doctor changed, payload doctorName synced, revision + 1, owner kept; audited with both doctors', async () => {
    const pid = await seed(docA);
    const res = await assign(admin, pid, { assignedUserId: docB.id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ patientId: pid, assignedUserId: docB.id, revision: 2 });
    expect(await record(pid)).toEqual({ revision: 2, assigned: docB.id, owner: docA.id, doctor_name: 'Doc B' });
    expect(await auditRows('patient_assignment_change', pid)).toEqual([{
      actor: admin.id, outcome: 'success',
      extra: { previousDoctorUserId: docA.id, previousDoctorName: 'Doc A', assignedUserId: docB.id, newDoctorName: 'Doc B', forcedLockHolder: null },
    }]);
  });

  it('null unassigns: doctorName set to \'\'', async () => {
    const pid = await seed(docA);
    const res = await assign(admin, pid, { assignedUserId: null });
    expect(res.body).toEqual({ patientId: pid, assignedUserId: null, revision: 2 });
    expect(await record(pid)).toMatchObject({ assigned: null, doctor_name: '' });
    // The audit keeps null (not the payload's '') for the new doctor.
    expect(await auditRows('patient_assignment_change', pid)).toEqual([{
      actor: admin.id, outcome: 'success',
      extra: { previousDoctorUserId: docA.id, previousDoctorName: 'Doc A', assignedUserId: null, newDoctorName: null, forcedLockHolder: null },
    }]);
  });

  it('after a reassignment a PATCH with the old revision → 409', async () => {
    const pid = await seed(docA);
    await assign(admin, pid, { assignedUserId: docB.id });
    const res = await request(app()).patch(`/api/patients/${pid}`).set(org.headers(admin)).set('If-Match', '1')
      .send({ data: { shared: { name: 'x' }, modules: {}, activeModules: [] } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'CONFLICT', error: 'Revision mismatch. Fetch the latest version before retrying.', currentRevision: 2 });
  });

  it('a target user not in the organization (or missing) → 404 USER_NOT_FOUND; a nurse → 422 TARGET_NOT_A_DOCTOR', async () => {
    const pid = await seed(docA);
    const foreign = await assign(admin, pid, { assignedUserId: otherDoc.id });
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual({ code: 'USER_NOT_FOUND', error: 'User not found in this organization' });
    expect((await assign(admin, pid, { assignedUserId: crypto.randomUUID() })).status).toBe(404);
    const res = await assign(admin, pid, { assignedUserId: nurse.id });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ code: 'TARGET_NOT_A_DOCTOR', error: 'Assigned user must have the doctor role' });
    expect((await record(pid)).revision).toBe(1);
  });

  it('a missing or deleted patient → 404 PATIENT_NOT_FOUND (off and enforce)', async () => {
    const pid = await seed(docA);
    await holderPool.query(`UPDATE patient_records SET deleted_at = now() WHERE id = $1`, [pid]);
    for (const mode of ['off', 'enforce'] as const) {
      lockMode.mode = mode;
      const deleted = await assign(admin, pid, { assignedUserId: docB.id });
      expect(deleted.status).toBe(404);
      expect(deleted.body).toEqual({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      expect((await assign(admin, crypto.randomUUID(), { assignedUserId: docB.id })).status).toBe(404);
    }
  });

  it('a non-admin → 403; an invalid body → 400', async () => {
    const pid = await seed(docA);
    expect((await assign(docA, pid, { assignedUserId: docB.id })).status).toBe(403);
    const bad = await assign(admin, pid, { assignedUserId: 'not-a-uuid' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_BODY');
  });

  // ---------------------------------------------------------------------------------------------
  // Edit lock
  // ---------------------------------------------------------------------------------------------

  it('off: a live lock is not looked at — reassigned, the lock row kept, no lock audit', async () => {
    const pid = await seed(docA);
    await holdLock(docA, pid);
    expect((await assign(admin, pid, { assignedUserId: docB.id })).status).toBe(200);
    expect(await lockRows(pid)).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(await auditRows('patient_lock_observed_block', pid, 0)).toEqual([]);
  });

  it('enforce: a live lock blocks a normal reassignment → 423 with the holder', async () => {
    const pid = await seed(docA);
    await holdLock(docA, pid);
    lockMode.mode = 'enforce';
    const res = await assign(admin, pid, { assignedUserId: docB.id });
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ code: 'LOCK_HELD', error: 'Currently being edited by Doc A', holder: { holderName: 'Doc A' } });
    expect(await record(pid)).toMatchObject({ revision: 1, assigned: docA.id });
    expect(await lockRows(pid)).toBe(1);
  });

  it('enforce + force: the lock is removed and the reassignment goes on, audited as patient_assignment_force', async () => {
    const pid = await seed(docA);
    await holdLock(docA, pid);
    lockMode.mode = 'enforce';
    const res = await assign(admin, pid, { assignedUserId: docB.id }, true);
    expect(res.status).toBe(200);
    expect(await lockRows(pid)).toBe(0);
    expect(await record(pid)).toMatchObject({ revision: 2, assigned: docB.id });
    expect(await auditRows('patient_assignment_force', pid)).toEqual([{
      actor: admin.id, outcome: 'success',
      extra: { previousDoctorUserId: docA.id, previousDoctorName: 'Doc A', assignedUserId: docB.id, newDoctorName: 'Doc B', forcedLockHolder: 'Doc A' },
    }]);
  });

  it('observe: a live lock is recorded (context assignment) and the reassignment goes on — even with force the lock stays', async () => {
    const pid = await seed(docA);
    await holdLock(docA, pid);
    lockMode.mode = 'observe';
    expect((await assign(admin, pid, { assignedUserId: docB.id }, true)).status).toBe(200);
    expect(await auditRows('patient_lock_observed_block', pid)).toEqual([
      { actor: admin.id, outcome: 'success', extra: { holderName: 'Doc A', context: 'assignment' } },
    ]);
    expect(await lockRows(pid)).toBe(1);
    expect(await auditRows('patient_assignment_change', pid)).toHaveLength(1);
  });
});
