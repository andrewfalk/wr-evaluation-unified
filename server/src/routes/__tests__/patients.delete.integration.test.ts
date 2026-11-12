// DELETE /api/patients/:id against real PostgreSQL (S7-5). Written against the route handler before it moved to
// domain/patients/softDeletePatient.ts, and kept unchanged across the move: these tests replace the
// order-based mock tests of the DELETE in patients.test.ts. The autosave cleanup is covered in
// patientDeleteAutosave.integration.test.ts.
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

const APP = 'wr-itest-patient-delete';
const HOLDER_APP = 'wr-itest-patient-delete-holder';

describe.skipIf(!TEST_DATABASE_URL)('DELETE /api/patients/:id (real PostgreSQL, S7-5)', () => {
  let pool: Pool;
  let holderPool: Pool;
  let org: IntegrationOrg;
  let otherOrg: IntegrationOrg;
  let docA: IntegrationUser;
  let docB: IntegrationUser;
  let adminC: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool(APP);
    holderPool = integrationPool(HOLDER_APP);
    org = await createIntegrationOrg(holderPool, 'patient-delete');
    otherOrg = await createIntegrationOrg(holderPool, 'patient-delete-other');
    docA = await org.makeUser('doctor', 'Doc A');
    docB = await org.makeUser('doctor', 'Doc B');
    adminC = await org.makeUser('admin', 'Admin C');
  });

  afterEach(async () => {
    lockMode.mode = 'off';
    await org.resetData();
    await otherOrg.resetData();
  });

  afterAll(async () => {
    if (!pool) return;
    await org?.destroy();
    await otherOrg?.destroy();
    await pool.end();
    await holderPool.end();
  });

  const app = () => makeRouterApp((a) => { a.use('/api/patients', createPatientsRouter(pool)); });

  async function seed(o: { assigned?: IntegrationUser | null; patientNo?: string | null; personId?: string; inOrg?: IntegrationOrg; revision?: number } = {}) {
    const target = o.inOrg ?? org;
    const pid = crypto.randomUUID();
    const personId = o.personId ?? (await holderPool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, patient_no, name) VALUES ($1, $2, '삭제 환자') RETURNING id`,
      [target.orgId, o.patientNo ?? null],
    )).rows[0].id;
    await holderPool.query(
      `INSERT INTO patient_records (id, organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id, name, patient_no, revision, payload)
       VALUES ($1, $2, $3, $4, $5, '삭제 환자', $6, $7, $8)`,
      [pid, target.orgId, docA.id, o.assigned === undefined ? docA.id : o.assigned?.id ?? null, personId, o.patientNo ?? null,
        o.revision ?? 1, JSON.stringify({ id: pid, data: { shared: { name: '삭제 환자' } } })],
    );
    return { pid, personId };
  }

  function del(user: IntegrationUser, pid: string, revision: string | number | null): Promise<request.Response> {
    let req = request(app()).delete(`/api/patients/${pid}`).set(org.headers(user));
    if (revision !== null) req = req.query({ revision });
    return Promise.resolve(req);
  }

  async function record(pid: string) {
    return (await holderPool.query<{ revision: number; deleted: boolean }>(
      `SELECT revision, deleted_at IS NOT NULL AS deleted FROM patient_records WHERE id = $1`, [pid],
    )).rows[0];
  }
  async function personDeleted(personId: string): Promise<boolean> {
    return (await holderPool.query<{ d: boolean }>(`SELECT deleted_at IS NOT NULL AS d FROM patient_persons WHERE id = $1`, [personId])).rows[0].d;
  }
  async function lockRows(pid: string): Promise<number> {
    return (await holderPool.query(`SELECT 1 FROM patient_locks WHERE patient_id = $1`, [pid])).rowCount ?? 0;
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

  const NOT_FOUND = { code: 'PATIENT_NOT_FOUND', error: 'Patient not found' };
  const FORBIDDEN = { code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' };

  // ---------------------------------------------------------------------------------------------
  // Soft delete
  // ---------------------------------------------------------------------------------------------

  it('204: soft-deleted without a revision bump; the last case\'s person is released; the number is free again', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    const { pid, personId } = await seed({ patientNo: no, revision: 3 });
    const res = await del(docA, pid, 3);
    expect(res.status).toBe(204);
    expect(await record(pid)).toEqual({ revision: 3, deleted: true });
    expect(await personDeleted(personId)).toBe(true);
    // The number can be used by a new person.
    await holderPool.query(`INSERT INTO patient_persons (organization_id, patient_no, name) VALUES ($1, $2, 'reuse')`, [org.orgId, no]);
  });

  it('a person with another live case is not released; the delete still succeeds', async () => {
    const { pid, personId } = await seed({ patientNo: `NO-${crypto.randomUUID()}` });
    await seed({ personId, patientNo: null });
    expect((await del(docA, pid, 1)).status).toBe(204);
    expect(await personDeleted(personId)).toBe(false);
  });

  it('the deleted patient is redacted in workspace snapshots (by id or sync.serverId), other entries kept', async () => {
    const { pid } = await seed();
    const ws = (await holderPool.query<{ id: string }>(
      `INSERT INTO workspaces (organization_id, owner_user_id, name, patient_ids, snapshot_payload)
       VALUES ($1, $2, 'ws', $3, $4) RETURNING id`,
      [org.orgId, docA.id, [pid], JSON.stringify([
        { id: pid, data: { shared: { name: '삭제 환자' } } },
        { id: 'local-1', sync: { serverId: pid }, data: { shared: { name: '사본' } } },
        { id: 'keep', data: { shared: { name: '남는 환자' } } },
      ])],
    )).rows[0].id;
    expect((await del(docA, pid, 1)).status).toBe(204);
    const { rows } = await holderPool.query<{ snapshot_payload: unknown[] }>(`SELECT snapshot_payload FROM workspaces WHERE id = $1`, [ws]);
    expect(rows[0].snapshot_payload).toEqual([
      { id: pid, redacted: true },
      { id: pid, redacted: true },
      { id: 'keep', data: { shared: { name: '남는 환자' } } },
    ]);
  });

  it('the patient\'s edit lock row is removed with it', async () => {
    const { pid } = await seed();
    await holdLock(docA, pid);
    expect(await lockRows(pid)).toBe(1);
    expect((await del(docA, pid, 1)).status).toBe(204);
    expect(await lockRows(pid)).toBe(0);
  });

  // ---------------------------------------------------------------------------------------------
  // Revision and validation
  // ---------------------------------------------------------------------------------------------

  it('a stale revision → 409 with the current revision; nothing changed', async () => {
    const { pid } = await seed({ revision: 2 });
    const res = await del(docA, pid, 1);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'CONFLICT', error: 'Revision mismatch.', currentRevision: 2 });
    expect(await record(pid)).toEqual({ revision: 2, deleted: false });
  });

  it('no revision → 400 REVISION_REQUIRED; a non-integer → 400 INVALID_REVISION', async () => {
    const { pid } = await seed();
    expect((await del(docA, pid, null)).body).toEqual({ code: 'REVISION_REQUIRED', error: 'revision query parameter is required' });
    expect((await del(docA, pid, 'x')).body).toEqual({ code: 'INVALID_REVISION', error: 'revision must be a positive integer' });
    expect((await record(pid)).deleted).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // Access and contention
  // ---------------------------------------------------------------------------------------------

  it('the assigned doctor → 204; another doctor → 403; an admin → 204 regardless of assignment', async () => {
    const a = await seed({ assigned: docA });
    expect((await del(docB, a.pid, 1)).body).toEqual(FORBIDDEN);
    expect((await del(docA, a.pid, 1)).status).toBe(204);
    const b = await seed({ assigned: docB });
    expect((await del(adminC, b.pid, 1)).status).toBe(204);
  });

  it('an unassigned patient: a doctor → 403; a missing patient → 404; another organization\'s → 404 even for an admin', async () => {
    const { pid } = await seed({ assigned: null });
    expect((await del(docA, pid, 1)).status).toBe(403);
    expect((await del(docA, crypto.randomUUID(), 1)).body).toEqual(NOT_FOUND);
    const other = await seed({ inOrg: otherOrg, assigned: null });
    expect((await del(adminC, other.pid, 1)).body).toEqual(NOT_FOUND);
  });

  it('an already deleted patient → 404', async () => {
    const { pid } = await seed();
    await holderPool.query(`UPDATE patient_records SET deleted_at = now() WHERE id = $1`, [pid]);
    expect((await del(adminC, pid, 1)).body).toEqual(NOT_FOUND);
  });

  it('reassigned while the delete waits for the anchor (it passed the access middleware) → 403, not deleted', async () => {
    const { pid } = await seed({ assigned: docA });
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [pid]);
      await t1.query(`UPDATE patient_records SET assigned_doctor_user_id = $2 WHERE id = $1`, [pid, docB.id]);
      const pending = del(docA, pid, 1);
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN);
    });
    expect((await record(pid)).deleted).toBe(false);
  });

  it('enforce: another user\'s lock → 423, not deleted', async () => {
    const { pid } = await seed();
    await holdLock(docB, pid);
    lockMode.mode = 'enforce';
    const res = await del(docA, pid, 1);
    expect(res.status).toBe(423);
    expect(res.body).toMatchObject({ code: 'LOCK_HELD', error: 'Currently being edited by Doc B', holder: { holderName: 'Doc B' } });
    expect((await record(pid)).deleted).toBe(false);
  });

  it('enforce: a lock taken while the delete waits for the anchor → 423', async () => {
    const { pid } = await seed();
    lockMode.mode = 'enforce';
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await lockPatientAnchor(t1, { patientId: pid, orgId: org.orgId });
      await acquireLock(t1, { patientId: pid, orgId: org.orgId, userId: docB.id, holderName: 'Doc B', clientInstanceId: crypto.randomUUID() });
      const pending = del(docA, pid, 1);
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      expect((await pending).status).toBe(423);
    });
    expect((await record(pid)).deleted).toBe(false);
  });

  it('a lock request waiting behind the delete finds the patient gone → 404', async () => {
    const { pid } = await seed();
    await withHolder(async (t1) => {
      // Hold the anchor so the delete and the lock request queue up behind it in order.
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [pid]);
      const deleting = del(docA, pid, 1);
      await waitForLockWait(holderPool, APP);
      const locking = Promise.resolve(request(app()).post(`/api/patients/${pid}/lock`).set(org.headers(docA)).send({ clientInstanceId: crypto.randomUUID() }));
      await waitForLockWait(holderPool, APP, { count: 2 });
      await t1.query('ROLLBACK');
      expect((await deleting).status).toBe(204);
      expect((await locking).status).toBe(404);
    });
    expect(await lockRows(pid)).toBe(0);
  });
});
