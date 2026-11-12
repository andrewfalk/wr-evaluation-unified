// Workspace save → patient_records upsert, against real PostgreSQL (S7-1). Written against the route
// handler before the upsert moved to domain/patients/upsertFromWorkspace.ts, and kept unchanged across
// the move: these tests replace the order-based mock tests of the upsert in workspaces.test.ts.
// The HF1 basics (assignment, revision, enforce lock, first-save race) are in
// workspaces.integration.test.ts.
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

import { createWorkspacesRouter } from '../workspaces';
import { makeRouterApp } from '../../testing/app';
import { acquireLock, lockPatientAnchor } from '../../db/patientLocks';
import {
  createIntegrationOrg, integrationPool, waitForLockWait, TEST_DATABASE_URL,
  type IntegrationOrg, type IntegrationUser,
} from '../../testing/integrationDb';

const APP = 'wr-itest-ws-upsert';
const HOLDER_APP = 'wr-itest-ws-upsert-holder';

describe.skipIf(!TEST_DATABASE_URL)('workspace save → patient_records upsert (real PostgreSQL, S7-1)', () => {
  let pool: Pool;        // the app's pool — its sessions are the ones waitForLockWait looks for
  let holderPool: Pool;  // the test's own transactions
  let org: IntegrationOrg;
  let docA: IntegrationUser;
  let nurseB: IntegrationUser;
  let adminC: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool(APP);
    holderPool = integrationPool(HOLDER_APP);
    org = await createIntegrationOrg(holderPool, 'ws-upsert');
    docA = await org.makeUser('doctor', 'Doc A');
    nurseB = await org.makeUser('nurse', 'Nurse B');
    adminC = await org.makeUser('admin', 'Admin C');
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

  const app = () => makeRouterApp((a) => { a.use('/api/workspaces', createWorkspacesRouter(pool)); });

  function save(user: IntegrationUser, patients: unknown[], extra: Record<string, unknown> = {}): Promise<request.Response> {
    return Promise.resolve(request(app()).post('/api/workspaces').set(org.headers(user)).send({ name: 'ws', patients, ...extra }));
  }

  interface PatientOpts {
    doctorName?: string;
    revision?: number;
    patientNo?: string;
    birthDate?: string;
    serverId?: string;
    top?: Record<string, unknown>;
    data?: Record<string, unknown>;
    shared?: Record<string, unknown>;
  }
  function patient(id: string, marker: string, opts: PatientOpts = {}) {
    const sync: Record<string, unknown> = {};
    if (opts.revision !== undefined) Object.assign(sync, { revision: opts.revision, syncStatus: 'synced' });
    if (opts.serverId) sync.serverId = opts.serverId;
    return {
      id,
      phase: 'intake',
      marker,
      ...(Object.keys(sync).length > 0 ? { sync } : {}),
      ...opts.top,
      data: {
        shared: {
          name: `환자-${marker}`, doctorName: opts.doctorName ?? '',
          ...(opts.patientNo !== undefined ? { patientNo: opts.patientNo } : {}),
          ...(opts.birthDate !== undefined ? { birthDate: opts.birthDate } : {}),
          ...opts.shared,
        },
        modules: {}, activeModules: [],
        ...opts.data,
      },
    };
  }

  async function row(id: string) {
    const { rows } = await holderPool.query<{
      revision: number; marker: string | null; owner: string | null; assigned: string | null; name: string;
      person: string | null; birth_date: string | null; payload_birth: string | null; deleted: boolean;
    }>(
      `SELECT revision, payload->>'marker' AS marker, owner_user_id AS owner, assigned_doctor_user_id AS assigned, name,
              patient_person_id AS person, birth_date::text AS birth_date,
              payload->'data'->'shared'->>'birthDate' AS payload_birth, deleted_at IS NOT NULL AS deleted
       FROM patient_records WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function provenance(id: string) {
    const { rows } = await holderPool.query<Record<string, string | null>>(
      `SELECT completion_status, server_observed_modules_complete_at::text AS observed_at, completion_source,
              completion_client_build_version AS build, completion_client_schema_version::text AS schema,
              server_verified_modules_complete_at::text AS verified_at, completion_verification_engine_version AS engine
       FROM patient_records WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function personDeleted(personId: string): Promise<boolean> {
    const { rows } = await holderPool.query<{ deleted: boolean }>(
      `SELECT deleted_at IS NOT NULL AS deleted FROM patient_persons WHERE id = $1`, [personId],
    );
    return rows[0].deleted;
  }

  /** Audit rows for one target, polling: writeAuditLog is not awaited by the route. */
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

  async function holdLock(user: IntegrationUser, pid: string): Promise<string> {
    const c = await holderPool.connect();
    try {
      await c.query('BEGIN');
      await lockPatientAnchor(c, { patientId: pid, orgId: org.orgId });
      const r = await acquireLock(c, {
        patientId: pid, orgId: org.orgId, userId: user.id, holderName: user.name, clientInstanceId: crypto.randomUUID(),
      });
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

  // ---------------------------------------------------------------------------------------------
  // New-patient INSERT
  // ---------------------------------------------------------------------------------------------

  it('a doctor\'s new patient is INSERTed with the saver as owner and assigned doctor (no doctorName)', async () => {
    const pid = crypto.randomUUID();
    const res = await save(docA, [patient(pid, 'new')]);
    expect(res.status).toBe(201);
    expect(await row(pid)).toMatchObject({ revision: 1, owner: docA.id, assigned: docA.id, name: '환자-new', deleted: false });
    expect(res.body.saved).toEqual([{ id: pid, revision: 1, assignedDoctorUserId: docA.id }]);
  });

  it('a slash date is stored canonical in the column, the payload and the snapshot', async () => {
    const pid = crypto.randomUUID();
    const res = await save(docA, [patient(pid, 'dated', { birthDate: '2020/01/02' })]);
    expect(res.status).toBe(201);
    expect(await row(pid)).toMatchObject({ birth_date: '2020-01-02', payload_birth: '2020-01-02' });
    expect(res.body.items[0].patients[0].data.shared.birthDate).toBe('2020-01-02');
  });

  it('sync.serverId, not the local id, is the patient_records id and the snapshot patient id', async () => {
    const localId = crypto.randomUUID();
    const serverId = crypto.randomUUID();
    const res = await save(docA, [patient(localId, 'server-id', { serverId })]);
    expect(res.body.saved).toEqual([{ id: serverId, revision: 1, assignedDoctorUserId: docA.id }]);
    expect(await row(serverId)).toMatchObject({ marker: 'server-id' });
    expect(await row(localId)).toBeUndefined();
    const ws = await holderPool.query<{ patient_ids: string[] }>(`SELECT patient_ids FROM workspaces WHERE id = $1`, [res.body.items[0].id]);
    expect(ws.rows[0].patient_ids).toEqual([serverId]);
  });

  it('a concurrent INSERT of the same id by another path (no advisory lock) makes this one skipped(error); the workspace is still saved', async () => {
    const pid = crypto.randomUUID();
    await withHolder(async (t1) => {
      // Another path (e.g. POST /api/patients) inserting the same id, not yet committed.
      await t1.query('BEGIN');
      const person = await t1.query<{ id: string }>(
        `INSERT INTO patient_persons (organization_id, name) VALUES ($1, 'other-path') RETURNING id`, [org.orgId],
      );
      await t1.query(
        `INSERT INTO patient_records (id, organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id, name, revision, payload)
         VALUES ($1, $2, $3, $3, $4, 'other-path', 1, $5)`,
        [pid, org.orgId, docA.id, person.rows[0].id, JSON.stringify({ marker: 'other-path' })],
      );

      const pending = save(docA, [patient(pid, 'workspace')]);
      await waitForLockWait(holderPool, APP); // the INSERT waits on the uncommitted key
      await t1.query('COMMIT');
      const res = await pending;

      expect(res.status).toBe(201);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.skipped).toEqual([{ id: pid, reason: 'error' }]);
      expect(res.body.saved).toEqual([]);
      expect(await row(pid)).toMatchObject({ marker: 'other-path', revision: 1 });
      expect(await auditRows('workspace_patient_write_rejected', pid)).toEqual([
        { actor: docA.id, outcome: 'failure', extra: { kind: 'skipped', reason: 'error' } },
      ]);
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Existing-patient UPDATE
  // ---------------------------------------------------------------------------------------------

  it('re-saving keeps the completion provenance (first observed/verified time, source, versions) and updates the status', async () => {
    const pid = crypto.randomUUID();
    // A knee case the server can verify complete on its own (M17.0 with side, confirmation and assessment).
    const complete = (marker: string, build: string, revision?: number) => patient(pid, marker, {
      revision,
      top: { modulesCompleteObserved: true, completionClientBuildVersion: build, completionClientSchemaVersion: 1 },
      data: { modules: { knee: {} }, activeModules: ['knee'] },
      shared: { diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }] },
    });

    await save(docA, [complete('first', 'build-1')]);
    const first = await provenance(pid);
    expect(first).toMatchObject({ completion_status: 'modules_complete', completion_source: 'client_reported', build: 'build-1', schema: '1' });
    expect(first.observed_at).not.toBeNull();
    expect(first.verified_at).not.toBeNull();
    expect(first.engine).not.toBeNull();

    const res = await save(docA, [complete('second', 'build-2', 1)]);
    expect(res.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
    expect(await provenance(pid)).toEqual(first); // every provenance column byte-identical (µs timestamps)

    // Reported incomplete again: the status goes back to draft, the provenance stays.
    await save(docA, [patient(pid, 'third', { revision: 2, top: { modulesCompleteObserved: false } })]);
    expect(await provenance(pid)).toEqual({ ...first, completion_status: 'draft' });
  });

  it('a case the server cannot verify complete gets the client report but no server verification', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'spine', {
      top: { modulesCompleteObserved: true, completionClientBuildVersion: 'b', completionClientSchemaVersion: 1 },
      shared: { diagnoses: [{ code: 'M54.5' }] },
    })]);
    expect(await provenance(pid)).toMatchObject({ completion_status: 'modules_complete', completion_source: 'client_reported', verified_at: null, engine: null });
  });

  it('a blank patient number reuses the patient\'s anonymous person (no new person row)', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'anon-1')]);
    const before = await row(pid);
    await save(docA, [patient(pid, 'anon-2', { revision: 1 })]);
    expect((await row(pid)).person).toBe(before.person);
    const persons = await holderPool.query(`SELECT 1 FROM patient_persons WHERE organization_id = $1`, [org.orgId]);
    expect(persons.rowCount).toBe(1);
  });

  it('changing the patient number moves the case to the new person and soft-deletes the orphaned old one', async () => {
    const pid = crypto.randomUUID();
    const oldNo = `NO-${crypto.randomUUID()}`;
    await save(docA, [patient(pid, 'old-no', { patientNo: oldNo })]);
    const oldPerson = (await row(pid)).person!;

    const res = await save(docA, [patient(pid, 'new-no', { patientNo: `NO-${crypto.randomUUID()}`, revision: 1 })]);
    expect(res.body.saved).toHaveLength(1);
    expect((await row(pid)).person).not.toBe(oldPerson);
    expect(await personDeleted(oldPerson)).toBe(true);
    // The old number is free again: another patient can take it as a new person.
    const other = crypto.randomUUID();
    expect((await save(docA, [patient(other, 'reuse', { patientNo: oldNo })])).body.saved).toHaveLength(1);
    expect((await row(other)).person).not.toBe(oldPerson);
  });

  it('a deadlock on the patient-number persons is retried: the save that PostgreSQL aborts runs again and saves', async () => {
    const pid = crypto.randomUUID();
    const other = crypto.randomUUID();
    const takenNo = `NO-${crypto.randomUUID()}`;
    await save(docA, [patient(pid, 'p', { patientNo: `NO-${crypto.randomUUID()}` })]);
    await save(docA, [patient(other, 'q', { patientNo: takenNo })]);
    const personX = (await row(other)).person!;
    const oldPerson = (await row(pid)).person!;

    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      // Make the save, not this transaction, the one PostgreSQL's deadlock check aborts.
      await t1.query(`SET LOCAL deadlock_timeout = '30s'`);
      await t1.query(`SELECT 1 FROM patient_persons WHERE id = $1 FOR UPDATE`, [personX]);

      // The save locks its case row, then waits for person X (the number it moves to).
      const pending = save(docA, [patient(pid, 'p-moved', { patientNo: takenNo, revision: 1 })]);
      await waitForLockWait(holderPool, APP);
      // Closing the cycle: wait for the case row the save holds. The save's check (1s) finds the deadlock.
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [pid]);
      await t1.query('ROLLBACK');

      const res = await pending;
      expect(res.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
      expect(res.body.skipped).toEqual([]);
    });
    expect(await row(pid)).toMatchObject({ marker: 'p-moved', person: personX });
    expect(await personDeleted(oldPerson)).toBe(true);
  });

  it('a patient deleted after the snapshot transaction, before its upsert, is skipped(deleted) without an audit row', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'to-delete')]);
    await withHolder(async (t1) => {
      // Hold the patient's advisory lock: the snapshot transaction passes, the upsert waits behind it.
      await t1.query('BEGIN');
      await t1.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pid]);
      const pending = save(docA, [patient(pid, 'after-delete', { revision: 1 })]);
      await waitForLockWait(holderPool, APP);
      await t1.query(`UPDATE patient_records SET deleted_at = now() WHERE id = $1`, [pid]);
      await t1.query('COMMIT');

      const res = await pending;
      expect(res.body.skipped).toEqual([{ id: pid, reason: 'deleted' }]);
      expect(res.body.saved).toEqual([]);
    });
    expect(await row(pid)).toMatchObject({ marker: 'to-delete', deleted: true, revision: 1 });
    await new Promise((r) => setTimeout(r, 200));
    expect(await auditRows('workspace_patient_write_rejected', pid, 0)).toEqual([]);
  });

  it('a patient without an assigned doctor can be written only by an admin', async () => {
    const pid = crypto.randomUUID();
    await save(nurseB, [patient(pid, 'unassigned')]); // a nurse's new patient has no assigned doctor
    expect((await row(pid)).assigned).toBeNull();

    const nurse = await save(nurseB, [patient(pid, 'nurse-again', { revision: 1 })]);
    expect(nurse.body.skipped).toEqual([{ id: pid, reason: 'not_assigned' }]);
    const admin = await save(adminC, [patient(pid, 'admin', { revision: 1 })]);
    expect(admin.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: null }]);
  });

  it('rejections are audited: not_assigned → denied, revision conflict → failure with the server revision', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'a', { doctorName: 'Doc A' })]);
    await save(nurseB, [patient(pid, 'b', { doctorName: 'Doc A', revision: 1 })]);
    await holderPool.query(`UPDATE patient_records SET revision = 3 WHERE id = $1`, [pid]);
    await save(docA, [patient(pid, 'stale', { doctorName: 'Doc A', revision: 1 })]);

    expect(await auditRows('workspace_patient_write_rejected', pid, 2)).toEqual([
      { actor: nurseB.id, outcome: 'denied', extra: { kind: 'skipped', reason: 'not_assigned' } },
      { actor: docA.id, outcome: 'failure', extra: { kind: 'conflict', serverRevision: 3 } },
    ]);
  });

  // ---------------------------------------------------------------------------------------------
  // Edit-lock gate
  // ---------------------------------------------------------------------------------------------

  it('enforce: another user\'s lock → lockedByOther with the holder (no token), audited denied with holderName only', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'locked', { doctorName: 'Doc A' })]);
    await holdLock(docA, pid);
    lockMode.mode = 'enforce';

    const res = await save(adminC, [patient(pid, 'blocked', { doctorName: 'Doc A', revision: 1 })]);
    expect(res.body.lockedByOther).toEqual([{
      id: pid, holder: { holderName: 'Doc A', acquiredAt: expect.any(String), expiresAt: expect.any(String) },
    }]);
    expect(Object.keys(res.body.lockedByOther[0].holder)).toEqual(['holderName', 'acquiredAt', 'expiresAt']);
    expect(await auditRows('workspace_patient_write_rejected', pid)).toEqual([
      { actor: adminC.id, outcome: 'denied', extra: { kind: 'locked', holderName: 'Doc A' } },
    ]);
  });

  it('enforce: each patient is checked against its own token from lockTokens', async () => {
    const p1 = crypto.randomUUID();
    const p2 = crypto.randomUUID();
    await save(docA, [patient(p1, 'p1'), patient(p2, 'p2')]);
    const t1 = await holdLock(docA, p1);
    const t2 = await holdLock(docA, p2);
    lockMode.mode = 'enforce';

    const swapped = await save(docA, [patient(p1, 'x1', { revision: 1 }), patient(p2, 'x2', { revision: 1 })], { lockTokens: { [p1]: t2, [p2]: t1 } });
    expect(swapped.body.lockedByOther.map((l: { id: string }) => l.id).sort()).toEqual([p1, p2].sort());
    expect(swapped.body.saved).toEqual([]);

    const matched = await save(docA, [patient(p1, 'y1', { revision: 1 }), patient(p2, 'y2', { revision: 1 })], { lockTokens: { [p1]: t1, [p2]: t2 } });
    expect(matched.body.saved.map((s: { id: string }) => s.id).sort()).toEqual([p1, p2].sort());
    expect((await row(p1)).marker).toBe('y1');
    expect((await row(p2)).marker).toBe('y2');
  });

  it('observe: another user\'s lock does not block; a patient_lock_observed_block row records the holder', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'observed', { doctorName: 'Doc A' })]);
    await holdLock(docA, pid);
    lockMode.mode = 'observe';

    const res = await save(adminC, [patient(pid, 'written', { doctorName: 'Doc A', revision: 1 })]);
    expect(res.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
    expect(await auditRows('patient_lock_observed_block', pid)).toEqual([
      { actor: adminC.id, outcome: 'success', extra: { holderName: 'Doc A' } },
    ]);
    expect(await auditRows('workspace_patient_write_rejected', pid, 0)).toEqual([]);
  });

  it('off: a lock does not block and is not looked at', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'off', { doctorName: 'Doc A' })]);
    await holdLock(docA, pid);

    const res = await save(adminC, [patient(pid, 'written', { doctorName: 'Doc A', revision: 1 })]);
    expect(res.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
    await new Promise((r) => setTimeout(r, 200));
    expect(await auditRows('patient_lock_observed_block', pid, 0)).toEqual([]);
  });
});
