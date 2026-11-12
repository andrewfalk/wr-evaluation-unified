// POST /api/patients against real PostgreSQL (S7-3). Written against the route handler before it moved to
// domain/patients/createPatient.ts, and kept unchanged across the move: these tests replace the
// order-based mock tests of the create in patients.test.ts. The validation-only 400s (no DB work) stay in
// the unit tests.
import crypto from 'crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import request from 'supertest';
import { createPatientsRouter } from '../patients';
import { makeRouterApp } from '../../testing/app';
import {
  createIntegrationOrg, integrationPool, waitForLockWait, TEST_DATABASE_URL,
  type IntegrationOrg, type IntegrationUser,
} from '../../testing/integrationDb';

const APP = 'wr-itest-patient-create';
const HOLDER_APP = 'wr-itest-patient-create-holder';

describe.skipIf(!TEST_DATABASE_URL)('POST /api/patients (real PostgreSQL, S7-3)', () => {
  let pool: Pool;
  let holderPool: Pool;
  let org: IntegrationOrg;
  let docA: IntegrationUser;
  let nurseB: IntegrationUser;

  beforeAll(async () => {
    pool = integrationPool(APP);
    holderPool = integrationPool(HOLDER_APP);
    org = await createIntegrationOrg(holderPool, 'patient-create');
    docA = await org.makeUser('doctor', 'Doc A');
    nurseB = await org.makeUser('nurse', 'Nurse B');
  });

  afterEach(async () => {
    await holderPool.query(
      `DELETE FROM idempotency_keys WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)`, [org.orgId],
    );
    await org.resetData();
  });

  afterAll(async () => {
    if (!pool) return;
    await org?.destroy();
    await pool.end();
    await holderPool.end();
  });

  const app = () => makeRouterApp((a) => { a.use('/api/patients', createPatientsRouter(pool)); });

  interface CreateOpts { id?: string; name?: string; patientNo?: string; birthDate?: string; doctorName?: string; top?: Record<string, unknown>; data?: Record<string, unknown>; shared?: Record<string, unknown> }
  function body(o: CreateOpts = {}) {
    return {
      ...(o.id ? { id: o.id } : {}),
      phase: 'intake',
      ...o.top,
      data: {
        shared: {
          name: o.name ?? '생성 환자',
          ...(o.patientNo !== undefined ? { patientNo: o.patientNo } : {}),
          ...(o.birthDate !== undefined ? { birthDate: o.birthDate } : {}),
          ...(o.doctorName !== undefined ? { doctorName: o.doctorName } : {}),
          ...o.shared,
        },
        modules: {}, activeModules: [],
        ...o.data,
      },
    };
  }

  function create(user: IntegrationUser, key: string, b: unknown): Promise<request.Response> {
    return Promise.resolve(request(app()).post('/api/patients').set(org.headers(user)).set('Idempotency-Key', key).send(b as object));
  }

  async function record(id: string) {
    const { rows } = await holderPool.query<{
      revision: number; owner: string | null; assigned: string | null; person: string; patient_no: string | null;
      birth_date: string | null; payload: Record<string, unknown>; status: string; observed_at: string | null;
      source: string | null; build: string | null; verified_at: string | null; engine: string | null;
    }>(
      `SELECT revision, owner_user_id AS owner, assigned_doctor_user_id AS assigned, patient_person_id AS person,
              patient_no, birth_date::text AS birth_date, payload, completion_status AS status,
              server_observed_modules_complete_at::text AS observed_at, completion_source AS source,
              completion_client_build_version AS build,
              server_verified_modules_complete_at::text AS verified_at, completion_verification_engine_version AS engine
       FROM patient_records WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async function slot(key: string, user: IntegrationUser) {
    const { rows } = await holderPool.query<{ status: number; body: unknown }>(
      `SELECT status, body FROM idempotency_keys WHERE key = $1 AND user_id = $2`, [key, user.id],
    );
    return rows[0];
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

  const key = () => `itest-${crypto.randomUUID()}`;

  // ---------------------------------------------------------------------------------------------
  // Creation and the idempotency slot
  // ---------------------------------------------------------------------------------------------

  it('201: revision 1, owner and assigned doctor = the doctor, stored payload; the slot keeps the response', async () => {
    const id = crypto.randomUUID();
    const k = key();
    const res = await create(docA, k, body({ id }));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id, assignedDoctorUserId: docA.id, sync: { serverId: id, revision: 1, syncStatus: 'synced' } });
    // No doctorName in the request: the server fills in the resolved doctor's name.
    expect(res.body.data.shared.doctorName).toBe('Doc A');

    const r = await record(id);
    expect(r).toMatchObject({ revision: 1, owner: docA.id, assigned: docA.id });
    expect(r.payload).toMatchObject({ id, phase: 'intake', data: { shared: { name: '생성 환자', doctorName: 'Doc A' } } });
    expect(await slot(k, docA)).toEqual({ status: 201, body: res.body });
  });

  it('a nurse\'s new patient has no assigned doctor (no doctorName)', async () => {
    const id = crypto.randomUUID();
    const res = await create(nurseB, key(), body({ id }));
    expect(res.status).toBe(201);
    expect(res.body.assignedDoctorUserId).toBeNull();
    expect((await record(id)).assigned).toBeNull();
  });

  it('a replay with the same key returns the stored status and body without creating anything', async () => {
    const k = key();
    const first = await create(docA, k, body({ id: crypto.randomUUID() }));
    const replay = await create(docA, k, body({ id: crypto.randomUUID(), name: 'different' }));
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const n = await holderPool.query(`SELECT 1 FROM patient_records WHERE organization_id = $1`, [org.orgId]);
    expect(n.rowCount).toBe(1);
  });

  it('the same key while another request holds the slot: committed as in-progress → 409 IDEMPOTENCY_IN_PROGRESS', async () => {
    const k = key();
    const id = crypto.randomUUID();
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(
        `INSERT INTO idempotency_keys (key, user_id, org_id, status, body) VALUES ($1, $2, $3, 0, 'null'::jsonb)`,
        [k, docA.id, org.orgId],
      );
      const pending = create(docA, k, body({ id }));
      await waitForLockWait(holderPool, APP); // the slot INSERT waits on the uncommitted key
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: 'IDEMPOTENCY_IN_PROGRESS', error: 'A request with this Idempotency-Key is already in progress. Please retry shortly.' });
    });
    expect(await record(id)).toBeUndefined();
  });

  it('the same key while another request holds the slot: rolled back → this request takes the slot and creates', async () => {
    const k = key();
    const id = crypto.randomUUID();
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(
        `INSERT INTO idempotency_keys (key, user_id, org_id, status, body) VALUES ($1, $2, $3, 0, 'null'::jsonb)`,
        [k, docA.id, org.orgId],
      );
      const pending = create(docA, k, body({ id }));
      await waitForLockWait(holderPool, APP);
      await t1.query('ROLLBACK');
      expect((await pending).status).toBe(201);
    });
    expect((await slot(k, docA)).status).toBe(201);
  });

  it('an expired slot is pruned: the key can be used again', async () => {
    const k = key();
    await holderPool.query(
      `INSERT INTO idempotency_keys (key, user_id, org_id, status, body, expires_at) VALUES ($1, $2, $3, 0, 'null'::jsonb, now() - interval '1 minute')`,
      [k, docA.id, org.orgId],
    );
    expect((await create(docA, k, body({ id: crypto.randomUUID() }))).status).toBe(201);
  });

  // ---------------------------------------------------------------------------------------------
  // Patient identity (person)
  // ---------------------------------------------------------------------------------------------

  it('the same patient number for another injury/evaluation record links to the same person', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    expect((await create(docA, key(), body({ id: a, patientNo: no, birthDate: '1980-01-01' }))).status).toBe(201);
    const second = await create(docA, key(), body({ id: b, patientNo: no, birthDate: '1980-01-01' }));
    expect(second.status).toBe(201);
    expect(second.body.sync.warnings).toBeUndefined();
    expect((await record(b)).person).toBe((await record(a)).person);
  });

  it('the same number and birth date with a different name → 201 with a name warning', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    await create(docA, key(), body({ id: crypto.randomUUID(), patientNo: no, birthDate: '1980-01-01', name: '김철수' }));
    const res = await create(docA, key(), body({ id: crypto.randomUUID(), patientNo: no, birthDate: '1980-01-01', name: '김영희' }));
    expect(res.status).toBe(201);
    expect(res.body.sync.warnings).toEqual([expect.objectContaining({ code: expect.any(String) })]);
  });

  it('the same number with a different birth date → 409 PATIENT_IDENTITY_CONFLICT; the slot is rolled back so the key works again', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    await create(docA, key(), body({ id: crypto.randomUUID(), patientNo: no, birthDate: '1980-01-01' }));
    const k = key();
    const id = crypto.randomUUID();
    const res = await create(docA, k, body({ id, patientNo: no, birthDate: '1990-05-05' }));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'PATIENT_IDENTITY_CONFLICT', error: 'This patient number belongs to an existing patient with a different birth date' });
    expect(await record(id)).toBeUndefined();
    expect(await slot(k, docA)).toBeUndefined();

    expect((await create(docA, k, body({ id, patientNo: no, birthDate: '1980-01-01' }))).status).toBe(201);
  });

  it('the same id created concurrently → 409 CONFLICT; the slot is rolled back', async () => {
    const id = crypto.randomUUID();
    const k = key();
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      const person = await t1.query<{ id: string }>(
        `INSERT INTO patient_persons (organization_id, name) VALUES ($1, 'other') RETURNING id`, [org.orgId],
      );
      await t1.query(
        `INSERT INTO patient_records (id, organization_id, owner_user_id, patient_person_id, name, revision, payload)
         VALUES ($1, $2, $3, $4, 'other', 1, '{}')`,
        [id, org.orgId, docA.id, person.rows[0].id],
      );
      const pending = create(docA, k, body({ id }));
      await waitForLockWait(holderPool, APP);
      await t1.query('COMMIT');
      const res = await pending;
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: 'CONFLICT', error: 'A patient with this ID already exists' });
    });
    expect(await slot(k, docA)).toBeUndefined();
  });

  // Records the current behavior (S7 plan R2 — reproduced here): two requests creating the same NEW patient
  // number at the same time. The second one's person INSERT fails on the unique number, and
  // resolvePatientPersonId re-reads the person in the same (now aborted) transaction → 500.
  it('R2 record: the same new patient number created concurrently by another transaction', async () => {
    const no = `NO-${crypto.randomUUID()}`;
    const id = crypto.randomUUID();
    let res!: request.Response;
    await withHolder(async (t1) => {
      await t1.query('BEGIN');
      await t1.query(
        `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date) VALUES ($1, $2, 'first', '1980-01-01')`,
        [org.orgId, no],
      );
      const pending = create(docA, key(), body({ id, patientNo: no, birthDate: '1980-01-01' }));
      await waitForLockWait(holderPool, APP); // the person INSERT waits on the uncommitted number
      await t1.query('COMMIT');
      res = await pending;
    });
    expect({ status: res.status, body: res.body }).toEqual(R2_OBSERVED);
  });

  // ---------------------------------------------------------------------------------------------
  // Completion columns and dates
  // ---------------------------------------------------------------------------------------------

  const KNEE_COMPLETE = {
    data: { modules: { knee: {} }, activeModules: ['knee'] },
    shared: { diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }] },
  };

  it('modulesCompleteObserved: true stamps the client-reported completion at creation, not the server verification', async () => {
    const id = crypto.randomUUID();
    const res = await create(docA, key(), body({
      id, top: { modulesCompleteObserved: true, completionClientBuildVersion: 'build-1', completionClientSchemaVersion: 1 },
    }));
    expect(res.status).toBe(201);
    // The client report alone does not make the server verification: this case is not verifiable.
    expect(await record(id)).toMatchObject({ status: 'modules_complete', source: 'client_reported', build: 'build-1', verified_at: null, engine: null });
    expect((await record(id)).observed_at).not.toBeNull();
    expect(res.body.completionStatus).toBe('modules_complete');
    expect(res.body.serverObservedModulesCompleteAt).toEqual(expect.any(String));
  });

  it('without a report (false or missing) the completion columns are empty', async () => {
    for (const top of [{ modulesCompleteObserved: false }, {}]) {
      const id = crypto.randomUUID();
      expect((await create(docA, key(), body({ id, top }))).status).toBe(201);
      expect(await record(id)).toMatchObject({ status: 'draft', observed_at: null, source: null, build: null, verified_at: null, engine: null });
    }
  });

  it('server verification does not depend on the client report: a verifiable case without a report gets only the server columns', async () => {
    const id = crypto.randomUUID();
    const res = await create(docA, key(), body({ id, ...KNEE_COMPLETE }));
    expect(res.status).toBe(201);
    const r = await record(id);
    expect(r).toMatchObject({ status: 'draft', observed_at: null, source: null });
    expect(r.verified_at).not.toBeNull();
    expect(r.engine).not.toBeNull();
    expect(res.body.serverVerifiedModulesCompleteAt).toEqual(expect.any(String));
  });

  it('a replay reproduces the stored response including the completion fields', async () => {
    const k = key();
    const first = await create(docA, k, body({
      id: crypto.randomUUID(), ...KNEE_COMPLETE,
      top: { modulesCompleteObserved: true, completionClientBuildVersion: 'b', completionClientSchemaVersion: 1 },
    }));
    const replay = await create(docA, k, body());
    expect(replay.body).toEqual(first.body);
    expect(replay.body.serverVerifiedModulesCompleteAt).toEqual(expect.any(String));
  });

  it('a slash birth date is stored canonical in the column and the payload; an empty birth date is allowed', async () => {
    const id = crypto.randomUUID();
    expect((await create(docA, key(), body({ id, birthDate: '2020/01/02' }))).status).toBe(201);
    const r = await record(id);
    expect(r.birth_date).toBe('2020-01-02');
    expect((r.payload as { data: { shared: { birthDate: string } } }).data.shared.birthDate).toBe('2020-01-02');

    const blank = crypto.randomUUID();
    expect((await create(docA, key(), body({ id: blank, birthDate: '' }))).status).toBe(201);
    expect((await record(blank)).birth_date).toBeNull();
  });
});

// Observed on the unchanged handler (2026-11-12): 500. The person INSERT fails with 23505, and
// resolvePatientPersonId's re-read runs in the aborted transaction. S7-R2 fixes this (after S7-4) and
// changes this expectation to the fixed response.
const R2_OBSERVED = { status: 500, body: { code: 'INTERNAL_ERROR', error: 'Internal server error' } };
