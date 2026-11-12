// PATCH /api/patients/:id against real PostgreSQL (S7-4). Written against the route handler before it moved
// to domain/patients/patchPatient.ts, and kept unchanged across the move: these tests replace the
// order-based mock tests of the PATCH in patients.test.ts. The contention scenarios are the S7 plan §5 merge
// conditions — each makes the interleaving deterministic by holding a row in the test's own transaction and
// waiting (pg_stat_activity) until the request is blocked behind it.
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

const APP = 'wr-itest-patient-patch';
const HOLDER_APP = 'wr-itest-patient-patch-holder';

describe.skipIf(!TEST_DATABASE_URL)('PATCH /api/patients/:id (real PostgreSQL, S7-4)', () => {
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
    org = await createIntegrationOrg(holderPool, 'patient-patch');
    otherOrg = await createIntegrationOrg(holderPool, 'patient-patch-other');
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

  interface SeedOpts { assigned?: IntegrationUser | null; patientNo?: string | null; birthDate?: string | null; name?: string; payload?: Record<string, unknown>; inOrg?: IntegrationOrg }
  /** A patient at revision 1 (person + case inserted directly). */
  async function seed(o: SeedOpts = {}): Promise<{ pid: string; personId: string }> {
    const target = o.inOrg ?? org;
    const pid = crypto.randomUUID();
    const name = o.name ?? '수정 환자';
    const personId = (await holderPool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date) VALUES ($1, $2, $3, $4) RETURNING id`,
      [target.orgId, o.patientNo ?? null, name, o.birthDate ?? null],
    )).rows[0].id;
    const payload = o.payload ?? {
      id: pid, phase: 'intake', marker: 'seed',
      data: { shared: { name, patientNo: o.patientNo ?? '', birthDate: o.birthDate ?? '' }, modules: {}, activeModules: [] },
    };
    await holderPool.query(
      `INSERT INTO patient_records (id, organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id,
                                    name, patient_no, birth_date, revision, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, $9)`,
      [pid, target.orgId, docA.id, o.assigned === undefined ? docA.id : o.assigned?.id ?? null, personId,
        name, o.patientNo ?? null, o.birthDate ?? null, JSON.stringify(payload)],
    );
    return { pid, personId };
  }

  function data(shared: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
    return { shared: { name: '수정 환자', ...shared }, modules: {}, activeModules: [], ...extra };
  }

  function patch(user: IntegrationUser, pid: string, ifMatch: number | null, body: unknown, headers: Record<string, string> = {}): Promise<request.Response> {
    let req = request(app()).patch(`/api/patients/${pid}`).set(org.headers(user)).set(headers);
    if (ifMatch !== null) req = req.set('If-Match', String(ifMatch));
    return Promise.resolve(req.send(body as object));
  }

  async function record(pid: string) {
    const { rows } = await holderPool.query<{
      revision: number; person: string; patient_no: string | null; birth_date: string | null; name: string;
      payload: Record<string, unknown>; status: string; observed_at: string | null; source: string | null;
      build: string | null; verified_at: string | null; engine: string | null; deleted: boolean;
    }>(
      `SELECT revision, patient_person_id AS person, patient_no, birth_date::text AS birth_date, name, payload,
              completion_status AS status, server_observed_modules_complete_at::text AS observed_at,
              completion_source AS source, completion_client_build_version AS build,
              server_verified_modules_complete_at::text AS verified_at, completion_verification_engine_version AS engine,
              deleted_at IS NOT NULL AS deleted
       FROM patient_records WHERE id = $1`,
      [pid],
    );
    return rows[0];
  }

  async function personDeleted(personId: string): Promise<boolean> {
    return (await holderPool.query<{ d: boolean }>(`SELECT deleted_at IS NOT NULL AS d FROM patient_persons WHERE id = $1`, [personId])).rows[0].d;
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

  const REVISION_MISMATCH = (currentRevision: number) => ({
    code: 'CONFLICT', error: 'Revision mismatch. Fetch the latest version before retrying.', currentRevision,
  });
  const FORBIDDEN = { code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' };

  // ---------------------------------------------------------------------------------------------
  // §5 contention scenarios (S7-4 merge conditions)
  // ---------------------------------------------------------------------------------------------

  it('§5-1 enforce: a lock taken by someone else while the PATCH waits for the anchor → 423', async () => {
    const { pid } = await seed();
    lockMode.mode = 'enforce';
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await lockPatientAnchor(t1, { patientId: pid, orgId: org.orgId });
      const lock = await acquireLock(t1, { patientId: pid, orgId: org.orgId, userId: docB.id, holderName: 'Doc B', clientInstanceId: crypto.randomUUID() });
      expect(lock.ok).toBe(true);
      const pending = patch(docA, pid, 1, { data: data({ name: 'A-edit' }) });
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(423);
      expect(res.body).toMatchObject({ code: 'LOCK_HELD', error: 'Currently being edited by Doc B', holder: { holderName: 'Doc B' } });
    });
    expect((await record(pid)).revision).toBe(1);
  });

  it('§5-2 reassigned while the PATCH waits for the anchor (it passed the access middleware) → 403', async () => {
    const { pid } = await seed({ assigned: docA });
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [pid]);
      await t1.query(`UPDATE patient_records SET assigned_doctor_user_id = $2 WHERE id = $1`, [pid, docB.id]);
      const pending = patch(docA, pid, 1, { data: data({ name: 'A-edit' }) });
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(403);
      expect(res.body).toEqual(FORBIDDEN);
    });
    expect((await record(pid)).name).toBe('수정 환자');
  });

  it('§5-3 two PATCHes with the same revision: one 200, the other 409 revision mismatch (full body)', async () => {
    const { pid } = await seed();
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [pid]);
      const a = patch(docA, pid, 1, { data: data({ name: 'first' }) });
      const b = patch(docA, pid, 1, { data: data({ name: 'second' }) });
      await waitForLockWait(holderPool, APP, { count: 2 });
      await t1.query('ROLLBACK');
      const results = await Promise.all([a, b]);
      const ok = results.filter((r) => r.status === 200);
      const conflict = results.filter((r) => r.status === 409);
      expect(ok).toHaveLength(1);
      expect(conflict).toHaveLength(1);
      expect(conflict[0].body).toEqual(REVISION_MISMATCH(2));
    });
    expect((await record(pid)).revision).toBe(2);
  });

  it('§5-4 a deadlock on the persons is retried: the PATCH PostgreSQL aborts runs again → 200', async () => {
    const takenNo = `NO-${crypto.randomUUID()}`;
    const { personId: personX } = await seed({ patientNo: takenNo });
    const { pid, personId: oldPerson } = await seed({ patientNo: `NO-${crypto.randomUUID()}` });
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`SET LOCAL deadlock_timeout = '30s'`); // the PATCH, not this transaction, is the victim
      await t1.query(`SELECT 1 FROM patient_persons WHERE id = $1 FOR UPDATE`, [personX]);
      // The PATCH holds its case anchor and waits for person X (the number it moves to).
      const pending = patch(docA, pid, 1, { data: data({ patientNo: takenNo }) });
      await waitForLockWait(holderPool, APP);
      await t1.query(`SELECT 1 FROM patient_records WHERE id = $1 FOR UPDATE`, [pid]); // closes the cycle
      await t1.query('ROLLBACK');
      const res = await pending;
      expect(res.status).toBe(200);
      expect(res.body.sync.revision).toBe(2);
    });
    expect((await record(pid)).person).toBe(personX);
    expect(await personDeleted(oldPerson)).toBe(true);
  });

  it('§5-5 soft-deleted while the PATCH waits for the anchor → 404', async () => {
    const { pid } = await seed();
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(`UPDATE patient_records SET deleted_at = now() WHERE id = $1`, [pid]);
      const pending = patch(docA, pid, 1, { data: data({ name: 'after-delete' }) });
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    });
  });

  it('§5-6 observe: another user\'s lock does not block; a patient_lock_observed_block row records the holder', async () => {
    const { pid } = await seed();
    await holdLock(docB, pid);
    lockMode.mode = 'observe';
    const res = await patch(docA, pid, 1, { data: data({ name: 'observed' }) });
    expect(res.status).toBe(200);
    expect(await auditRows('patient_lock_observed_block', pid)).toEqual([
      { actor: docA.id, outcome: 'success', extra: { holderName: 'Doc B' } },
    ]);
  });

  it('§5-7 a new patient number moves the case to a new person and soft-deletes the orphaned old one', async () => {
    const { pid, personId } = await seed({ patientNo: `NO-${crypto.randomUUID()}` });
    const res = await patch(docA, pid, 1, { data: data({ patientNo: `NO-${crypto.randomUUID()}` }) });
    expect(res.status).toBe(200);
    expect((await record(pid)).person).not.toBe(personId);
    expect(await personDeleted(personId)).toBe(true);
  });

  // ---------------------------------------------------------------------------------------------
  // Success, revision, payload
  // ---------------------------------------------------------------------------------------------

  it('200: meta columns and payload updated, revision + 1, response = the stored row', async () => {
    const { pid } = await seed();
    const res = await patch(docA, pid, 1, { phase: 'evaluation', data: data({ name: '새 이름', injuryDate: '2024-01-01' }, { activeModules: ['knee'] }) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: pid, phase: 'evaluation', marker: 'seed', sync: { serverId: pid, revision: 2, syncStatus: 'synced' } });
    expect(await record(pid)).toMatchObject({ revision: 2, name: '새 이름' });
    expect((await record(pid)).payload).toMatchObject({ phase: 'evaluation', marker: 'seed', data: { shared: { name: '새 이름' }, activeModules: ['knee'] } });
  });

  it('only phase: the stored data is kept', async () => {
    const { pid } = await seed();
    const res = await patch(docA, pid, 1, { phase: 'evaluation' });
    expect(res.status).toBe(200);
    expect((await record(pid)).payload).toMatchObject({ phase: 'evaluation', marker: 'seed', data: { shared: { name: '수정 환자' } } });
  });

  it('a stale If-Match → 409 with the current revision; nothing written (a completion report with it too)', async () => {
    const { pid } = await seed();
    await holderPool.query(`UPDATE patient_records SET revision = 3 WHERE id = $1`, [pid]);
    const res = await patch(docA, pid, 1, {
      data: data({ name: 'stale' }), modulesCompleteObserved: true, completionClientBuildVersion: 'b', completionClientSchemaVersion: 1,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(REVISION_MISMATCH(3));
    expect(await record(pid)).toMatchObject({ revision: 3, name: '수정 환자', status: 'draft', observed_at: null });
  });

  it('no If-Match → 400; a non-integer If-Match → 400', async () => {
    const { pid } = await seed();
    expect((await patch(docA, pid, null, { data: data() })).status).toBe(400);
    const res = await patch(docA, pid, null, { data: data() }, { 'If-Match': 'abc' });
    expect(res.status).toBe(400);
    expect((await record(pid)).revision).toBe(1);
  });

  it('an invalid birth date → 400 INVALID_BIRTH_DATE without the value; an empty name → 400 NAME_REQUIRED', async () => {
    const { pid } = await seed();
    const bad = await patch(docA, pid, 1, { data: data({ birthDate: '4110-02-12' }) });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_BIRTH_DATE');
    expect(JSON.stringify(bad.body)).not.toContain('4110-02-12');
    const noName = await patch(docA, pid, 1, { data: data({ name: '  ' }) });
    expect(noName.status).toBe(400);
    expect(noName.body).toEqual({ code: 'NAME_REQUIRED', error: 'Patient name (data.shared.name) is required' });
    expect((await record(pid)).revision).toBe(1);
  });

  it('a slash birth date is stored canonical in the column and the payload', async () => {
    const { pid } = await seed();
    expect((await patch(docA, pid, 1, { data: data({ birthDate: '2020/01/02' }) })).status).toBe(200);
    const r = await record(pid);
    expect(r.birth_date).toBe('2020-01-02');
    expect((r.payload as { data: { shared: { birthDate: string } } }).data.shared.birthDate).toBe('2020-01-02');
  });

  // ---------------------------------------------------------------------------------------------
  // Identity (person)
  // ---------------------------------------------------------------------------------------------

  it('a number whose person has a different birth date → 409 PATIENT_IDENTITY_CONFLICT, nothing written', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    await seed({ patientNo: no, birthDate: '1980-01-01' });
    const { pid, personId } = await seed();
    const res = await patch(docA, pid, 1, { data: data({ patientNo: no, birthDate: '1990-05-05' }) });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'PATIENT_IDENTITY_CONFLICT', error: 'This patient number belongs to an existing patient with a different birth date' });
    expect(await record(pid)).toMatchObject({ revision: 1, person: personId });
  });

  it('a number with the same birth date and a different name → 200 with a name warning', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    await seed({ patientNo: no, birthDate: '1980-01-01', name: '김철수' });
    const { pid } = await seed();
    const res = await patch(docA, pid, 1, { data: data({ name: '김영희', patientNo: no, birthDate: '1980-01-01' }) });
    expect(res.status).toBe(200);
    expect(res.body.sync.warnings).toEqual([expect.objectContaining({ code: expect.any(String) })]);
  });

  it('a blank number moves the case to an anonymous person and releases the old one', async () => {
    const { pid, personId } = await seed({ patientNo: `NO-${crypto.randomUUID()}` });
    expect((await patch(docA, pid, 1, { data: data({ patientNo: '' }) })).status).toBe(200);
    const r = await record(pid);
    expect(r.person).not.toBe(personId);
    expect(r.patient_no).toBeNull();
    expect(await personDeleted(personId)).toBe(true);
  });

  it('R2: a new patient number committed by another transaction meanwhile → 200, linked to that person; the old one released', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    const { pid, personId: oldPerson } = await seed({ patientNo: `NO-${crypto.randomUUID()}` });
    let otherPerson!: string;
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      otherPerson = (await t1.query<{ id: string }>(
        `INSERT INTO patient_persons (organization_id, patient_no, name) VALUES ($1, $2, '수정 환자') RETURNING id`,
        [org.orgId, no],
      )).rows[0].id;
      const pending = patch(docA, pid, 1, { data: data({ patientNo: no }) });
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      expect((await pending).status).toBe(200);
    });
    expect((await record(pid)).person).toBe(otherPerson);
    expect(await personDeleted(oldPerson)).toBe(true);
  });

  it('the same number keeps the person (not released)', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    const { pid, personId } = await seed({ patientNo: no });
    expect((await patch(docA, pid, 1, { data: data({ patientNo: no, name: '이름만 변경' }) })).status).toBe(200);
    expect((await record(pid)).person).toBe(personId);
    expect(await personDeleted(personId)).toBe(false);
  });

  // ---------------------------------------------------------------------------------------------
  // Access
  // ---------------------------------------------------------------------------------------------

  it('the assigned doctor → 200; another doctor → 403; an admin → 200 regardless of assignment', async () => {
    const { pid } = await seed({ assigned: docA });
    expect((await patch(docB, pid, 1, { data: data({ name: 'B' }) })).body).toEqual(FORBIDDEN);
    expect((await patch(docA, pid, 1, { data: data({ name: 'A' }) })).status).toBe(200);
    expect((await patch(adminC, pid, 2, { data: data({ name: 'C' }) })).status).toBe(200);
  });

  it('an unassigned patient: a doctor → 403, an admin → 200', async () => {
    const { pid } = await seed({ assigned: null });
    const res = await patch(docA, pid, 1, { data: data({ name: 'A' }) });
    expect(res.status).toBe(403);
    expect((await patch(adminC, pid, 1, { data: data({ name: 'C' }) })).status).toBe(200);
  });

  it('a missing patient → 404; another organization\'s patient → 404 even for an admin', async () => {
    const missing = await patch(docA, crypto.randomUUID(), 1, { data: data() });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    const { pid } = await seed({ inOrg: otherOrg, assigned: null });
    expect((await patch(adminC, pid, 1, { data: data() })).status).toBe(404);
  });

  it('enforce: another user\'s lock → 423 without writing; the holder\'s own token (X-Lock-Token) → 200', async () => {
    const { pid } = await seed();
    const token = await holdLock(docA, pid);
    lockMode.mode = 'enforce';
    const blocked = await patch(adminC, pid, 1, { data: data({ name: 'C' }) });
    expect(blocked.status).toBe(423);
    expect(Object.keys(blocked.body.holder)).toEqual(['holderName', 'acquiredAt', 'expiresAt']);
    expect((await record(pid)).revision).toBe(1);
    expect((await patch(docA, pid, 1, { data: data({ name: 'A' }) }, { 'X-Lock-Token': token })).status).toBe(200);
  });

  it('423 comes after the revision check: another user\'s lock with a stale If-Match → 409', async () => {
    const { pid } = await seed();
    await holdLock(docB, pid);
    lockMode.mode = 'enforce';
    const res = await patch(docA, pid, 7, { data: data() });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(REVISION_MISMATCH(1));
  });

  // ---------------------------------------------------------------------------------------------
  // Completion columns
  // ---------------------------------------------------------------------------------------------

  const KNEE_COMPLETE = {
    shared: { diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }] },
    extra: { modules: { knee: {} }, activeModules: ['knee'] },
  };
  const report = (observed: boolean, build = 'build-1') =>
    ({ modulesCompleteObserved: observed, completionClientBuildVersion: build, completionClientSchemaVersion: 1 });

  it('completion: first true stamps time/source/versions; a later true keeps them; absent → untouched (complete or draft); false → draft with them kept', async () => {
    const { pid } = await seed();
    expect((await patch(docA, pid, 1, { data: data(), ...report(true, 'build-1') })).status).toBe(200);
    const first = await record(pid);
    expect(first).toMatchObject({ status: 'modules_complete', source: 'client_reported', build: 'build-1' });
    expect(first.observed_at).not.toBeNull();

    await patch(docA, pid, 2, { data: data(), ...report(true, 'build-2') });
    expect(await record(pid)).toMatchObject({ status: 'modules_complete', observed_at: first.observed_at, build: 'build-1' });

    await patch(docA, pid, 3, { data: data() }); // an old client: no report at all — the status stays
    expect(await record(pid)).toMatchObject({ status: 'modules_complete', observed_at: first.observed_at, source: 'client_reported', build: 'build-1' });

    await patch(docA, pid, 4, { data: data(), ...report(false) });
    expect(await record(pid)).toMatchObject({ status: 'draft', observed_at: first.observed_at, source: 'client_reported', build: 'build-1' });

    await patch(docA, pid, 5, { data: data() });
    expect(await record(pid)).toMatchObject({ status: 'draft', observed_at: first.observed_at, build: 'build-1' });
  });

  it('a stored provenance with microseconds (set by SQL now()) is kept to the microsecond by a later PATCH', async () => {
    const { pid } = await seed();
    await holderPool.query(
      `UPDATE patient_records SET completion_status = 'modules_complete', server_observed_modules_complete_at = now(),
              completion_source = 'client_reported', completion_client_build_version = 'b0', completion_client_schema_version = 1
       WHERE id = $1`, [pid],
    );
    const before = (await record(pid)).observed_at;
    expect(await patch(docA, pid, 1, { data: data(), ...report(true, 'build-9') }).then((r) => r.status)).toBe(200);
    expect(await record(pid)).toMatchObject({ observed_at: before, build: 'b0', status: 'modules_complete' });
  });

  it('server verification does not depend on the client report; an unverifiable case keeps it empty', async () => {
    const { pid } = await seed();
    expect((await patch(docA, pid, 1, { data: data(KNEE_COMPLETE.shared, KNEE_COMPLETE.extra) })).status).toBe(200);
    const r = await record(pid);
    expect(r).toMatchObject({ status: 'draft', observed_at: null });
    expect(r.verified_at).not.toBeNull();
    expect(r.engine).not.toBeNull();

    const { pid: other } = await seed();
    await patch(docA, other, 1, { data: data({ diagnoses: [{ code: 'M54.5' }] }), ...report(true) });
    expect(await record(other)).toMatchObject({ status: 'modules_complete', verified_at: null, engine: null });
  });

  it('modulesCompleteObserved: true without the version fields → 400', async () => {
    const { pid } = await seed();
    const res = await patch(docA, pid, 1, { data: data(), modulesCompleteObserved: true });
    expect(res.status).toBe(400);
    expect((await record(pid)).revision).toBe(1);
  });
});
