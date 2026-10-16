// HF1(H1) — 워크스페이스 저장이 patient_records를 쓰는 경로의 인가·revision·락·동시성 검증.
// mock QueryRunner로는 "두 요청이 동시에 '없음'을 본 뒤" 같은 타이밍을 증명할 수 없어 실제
// Postgres로만 검증한다(결정론: 한쪽 트랜잭션이 락을 쥔 채 대기 — 자연 경합에 기대지 않음).
//
// 실행 조건: TEST_DATABASE_URL이 격리된 테스트 DB(마이그레이션 적용됨)를 가리켜야 한다.
// 개발 서버가 같은 DB를 보면 워커가 간섭하므로 wr_evaluation이 아닌 별도 DB를 쓸 것.
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_test_hf1 \
//     npx vitest run --config vitest.config.ts src/routes/__tests__/workspaces.integration.test.ts
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// 락 enforcement 모드를 테스트마다 바꾼다. 실제 config는 Object.freeze라 복사본에 getter를 둔다
// (statsDescriptiveHttp.integration.test.ts와 같은 방식).
const lockMode = vi.hoisted(() => ({ mode: 'off' as 'off' | 'observe' | 'enforce' }));
vi.mock('../../config', async (importOriginal) => {
  const actualModule = await importOriginal<typeof import('../../config')>();
  const cfg = { ...actualModule.default };
  Object.defineProperty(cfg, 'lockEnforcementMode', { get: () => lockMode.mode, enumerable: true });
  return { ...actualModule, default: cfg };
});

import { createWorkspacesRouter } from '../workspaces';
import { createPatientsRouter } from '../patients';
import { generateAccessToken } from '../../auth/tokens';
import { hashToken, generateToken } from '../../auth/tokenHash';
import { acquireLock, lockPatientAnchor } from '../../db/patientLocks';
import type { QueryRunner } from '../../db/patientPersons';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-workspaces-csrf';

interface TestUser { id: string; name: string; token: string }

describe.skipIf(!TEST_DB_URL)('POST /api/workspaces — patient_records 쓰기 인가 (실제 Postgres)', () => {
  let pool: Pool;
  let orgId: string;
  let docA: TestUser;
  let nurseB: TestUser;
  let adminC: TestUser;

  async function makeUser(role: 'doctor' | 'nurse' | 'admin', name: string): Promise<TestUser> {
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [`__test_ws_${role}_${crypto.randomUUID()}__`, 'x', name, role, orgId],
    );
    const id = user.rows[0].id;
    const sessionId = crypto.randomUUID();
    const csrfHash = hashToken(CSRF_TOKEN);
    await pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, csrf_token_hash, expires_at, family_id)
       VALUES ($1,$2,$3,$4, now() + interval '1 day', $5)`,
      [sessionId, id, hashToken(generateToken()), csrfHash, crypto.randomUUID()],
    );
    const token = generateAccessToken({
      sub: id, sessionId, orgId, role, name, mustChangePassword: false, csrfHash,
    }).token;
    return { id, name, token };
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_workspaces_org__'],
    );
    orgId = org.rows[0].id;
    docA = await makeUser('doctor', 'Doc A');
    nurseB = await makeUser('nurse', 'Nurse B');
    adminC = await makeUser('admin', 'Admin C');
  });

  async function cleanOrgData() {
    await pool.query(`DELETE FROM patient_locks WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM workspaces WHERE organization_id = $1`, [orgId]);
  }

  afterEach(async () => {
    lockMode.mode = 'off';
    await cleanOrgData();
  });

  afterAll(async () => {
    await cleanOrgData();
    await pool.query(`DELETE FROM sessions WHERE user_id = ANY($1::uuid[])`, [[docA.id, nurseB.id, adminC.id]]);
    await pool.query(`DELETE FROM users WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  // 테스트가 "이 지점에서 다른 일이 끼어든다"를 결정적으로 만들 수 있게, 스냅샷 보정 UPDATE 직전에 훅을 한 번 실행한다.
  interface Hooks { beforeStamp?: () => Promise<void> }
  function app(hooks: Hooks = {}) {
    const hookedPool = new Proxy(pool, {
      get(target, prop) {
        if (prop === 'query') {
          return async (sql: unknown, params?: unknown[]) => {
            if (typeof sql === 'string' && sql.includes('UPDATE workspaces')) { // 첫 트랜잭션의 UPDATE/INSERT는 pool이 아니라 client로 나가므로, pool.query의 UPDATE workspaces는 보정뿐이다
              const hook = hooks.beforeStamp;
              hooks.beforeStamp = undefined; // 한 번만
              if (hook) await hook();
            }
            return (target.query as unknown as (...a: unknown[]) => Promise<unknown>).call(target, sql, params);
          };
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as Pool;
    const a = express();
    a.use(express.json());
    a.use(cookieParser());
    a.use('/api/workspaces', createWorkspacesRouter(hookedPool));
    a.use('/api/patients', createPatientsRouter(pool));
    return a;
  }

  function save(user: TestUser, patients: unknown[], extra: Record<string, unknown> = {}, hooks: Hooks = {}): request.Test {
    return request(app(hooks))
      .post('/api/workspaces')
      .set('Authorization', `Bearer ${user.token}`)
      .set('X-CSRF-Token', CSRF_TOKEN)
      .send({ name: 'ws', patients, ...extra });
  }

  function patient(id: string, marker: string, opts: { doctorName?: string; revision?: number } = {}) {
    return {
      id,
      phase: 'intake',
      marker, // payload에 그대로 저장되는 최상위 키 — 덮어쓰기 여부를 이 값으로 판별한다
      ...(opts.revision !== undefined ? { sync: { revision: opts.revision, syncStatus: 'synced' } } : {}),
      data: { shared: { name: `환자-${marker}`, doctorName: opts.doctorName ?? '' }, modules: {}, activeModules: [] },
    };
  }

  async function row(id: string) {
    const { rows } = await pool.query<{ revision: number; marker: string | null; assigned: string | null }>(
      `SELECT revision, payload->>'marker' AS marker, assigned_doctor_user_id AS assigned
       FROM patient_records WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  it('담당의가 새 환자를 저장하면 INSERT되고 응답에 saved[].revision이 담긴다', async () => {
    const pid = crypto.randomUUID();
    const res = await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
    expect(res.status).toBe(201);
    expect(await row(pid)).toMatchObject({ revision: 1, marker: 'A-1', assigned: docA.id });
    expect(res.body.saved).toEqual([{ id: pid, revision: 1, assignedDoctorUserId: docA.id }]);
    expect(res.body.skipped).toEqual([]);
    expect(res.body.conflicts).toEqual([]);
  });

  it('담당의 본인이 올바른 revision으로 다시 저장하면 revision이 1 오르고 saved로 보고된다', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
    const res = await save(docA, [patient(pid, 'A-2', { doctorName: 'Doc A', revision: 1 })]);
    expect(await row(pid)).toMatchObject({ revision: 2, marker: 'A-2' });
    expect(res.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
  });

  it('H1: 담당의가 아닌 간호 계정의 저장은 담당의 환자 payload를 덮어쓰지 못하고 skipped로 보고된다', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'A-original', { doctorName: 'Doc A' })]);

    const res = await save(nurseB, [patient(pid, 'B-overwrite', { doctorName: 'Doc A', revision: 1 })]);

    // 가장 먼저 확인: 데이터가 바뀌지 않았는가(수정 전 코드는 여기서 실패한다)
    expect(await row(pid)).toMatchObject({ revision: 1, marker: 'A-original', assigned: docA.id });
    expect(res.body.skipped).toEqual([{ id: pid, reason: 'not_assigned' }]);
    expect(res.body.saved).toEqual([]);
  });

  it('admin은 담당의가 아니어도 저장할 수 있다(PATCH와 같은 규칙)', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'A-original', { doctorName: 'Doc A' })]);
    const res = await save(adminC, [patient(pid, 'C-admin', { doctorName: 'Doc A', revision: 1 })]);
    expect(await row(pid)).toMatchObject({ revision: 2, marker: 'C-admin' });
    expect(res.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
  });

  it('서버에 더 새로운 revision이 있으면 덮어쓰지 않고 conflicts로 보고한다', async () => {
    const pid = crypto.randomUUID();
    await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
    // 다른 기기/PATCH가 revision 2로 올렸다고 가정
    await pool.query(
      `UPDATE patient_records SET revision = 2, payload = jsonb_set(payload, '{marker}', '"newer-from-other-device"') WHERE id = $1`,
      [pid],
    );

    const res = await save(docA, [patient(pid, 'A-stale', { doctorName: 'Doc A', revision: 1 })]);

    expect(await row(pid)).toMatchObject({ revision: 2, marker: 'newer-from-other-device' });
    expect(res.body.conflicts).toEqual([{ id: pid, serverRevision: 2 }]);
    expect(res.body.saved).toEqual([]);
  });

  it('한 환자가 제외돼도 같은 저장의 다른 환자는 정상 저장된다(부분 성공)', async () => {
    const owned = crypto.randomUUID();
    const foreign = crypto.randomUUID();
    await save(docA, [patient(foreign, 'A-foreign', { doctorName: 'Doc A' })]);

    const res = await save(nurseB, [
      patient(foreign, 'B-overwrite', { doctorName: 'Doc A', revision: 1 }),
      patient(owned, 'B-new'), // 담당의 미지정 신규 환자 — INSERT는 허용(현행 동작)
    ]);

    expect(res.status).toBe(201);
    expect((await row(foreign)).marker).toBe('A-foreign');
    expect((await row(owned)).marker).toBe('B-new');
    expect(res.body.skipped).toEqual([{ id: foreign, reason: 'not_assigned' }]);
    expect(res.body.saved).toEqual([{ id: owned, revision: 1, assignedDoctorUserId: null }]);
  });

  it('동시 최초 저장 경합: 담당의 요청이 커밋되기 전에 시작한 비담당 요청은 담당의 데이터를 덮어쓰지 못한다', async () => {
    const pid = crypto.randomUUID();
    const t1 = await pool.connect();
    try {
      // T1 = "아직 커밋 안 된 담당의 A의 동시 요청"을 결정적으로 흉내낸다.
      // 환자 id별 advisory lock(hashtext(id))을 쥐고 A 소유 행을 INSERT한 채 대기.
      await t1.query('BEGIN');
      await t1.query('SELECT pg_advisory_xact_lock(hashtext($1))', [pid]);
      const person = await t1.query<{ id: string }>(
        `INSERT INTO patient_persons (organization_id, name) VALUES ($1,$2) RETURNING id`,
        [orgId, 'race-person'],
      );
      await t1.query(
        `INSERT INTO patient_records
           (id, organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id, name, revision, payload)
         VALUES ($1,$2,$3,$3,$4,$5,1,$6)`,
        [pid, orgId, docA.id, person.rows[0].id, 'race', JSON.stringify({ marker: 'A-concurrent' })],
      );

      // B의 저장 시작 — 이 시점 B의 스냅샷에는 A의 미커밋 행이 보이지 않는다.
      const pendingB = Promise.resolve(save(nurseB, [patient(pid, 'B-race', { doctorName: 'Doc A' })]));

      // B가 실제로 DB 락 대기에 들어갈 때까지 기다린다(sleep이 아니라 상태 조회).
      const deadline = Date.now() + 5000;
      let waiting = false;
      while (!waiting && Date.now() < deadline) {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
        );
        waiting = rows.length > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, 'B 요청이 락 대기 상태에 들어가지 않았다').toBe(true);

      await t1.query('COMMIT');
      const res = await pendingB;

      expect(await row(pid)).toMatchObject({ revision: 1, marker: 'A-concurrent', assigned: docA.id });
      expect(res.body.skipped).toEqual([{ id: pid, reason: 'not_assigned' }]);
    } finally {
      await t1.query('ROLLBACK').catch(() => {});
      t1.release();
    }
  });

  describe('저장 결과가 스냅샷·클라이언트 상태로 이어진다', () => {
    function put(user: TestUser, workspaceId: string, patients: unknown[], name = 'ws', hooks: Hooks = {}): request.Test {
      return request(app(hooks))
        .put(`/api/workspaces/${workspaceId}`)
        .set('Authorization', `Bearer ${user.token}`)
        .set('X-CSRF-Token', CSRF_TOKEN)
        .send({ name, patients });
    }

    async function deleteAs(user: TestUser, patientId: string, revision: number): Promise<void> {
      await request(app())
        .delete(`/api/patients/${patientId}`)
        .query({ revision })
        .set('Authorization', `Bearer ${user.token}`)
        .set('X-CSRF-Token', CSRF_TOKEN)
        .expect(204);
    }

    it('응답의 저장 항목과 DB에 영속된 스냅샷 모두 확정 revision·담당의가 찍혀 있다', async () => {
      const pid = crypto.randomUUID();
      const res = await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
      const item = res.body.items[0];

      expect(item.patients[0].sync).toMatchObject({ serverId: pid, revision: 1, syncStatus: 'synced' });
      expect(item.patients[0].assignedDoctorUserId).toBe(docA.id);
      const { rows } = await pool.query<{ snapshot_payload: Array<{ sync: { revision: number } }> }>(
        `SELECT snapshot_payload FROM workspaces WHERE id = $1`, [item.id],
      );
      expect(rows[0].snapshot_payload[0].sync.revision).toBe(1);
    });

    it('방금 저장한 저장 항목을 불러와 다시 저장해도 자기 저장과 충돌하지 않는다', async () => {
      const pid = crypto.randomUUID();
      const first = await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
      const loaded = first.body.items[0].patients[0]; // 클라이언트가 이 항목을 불러온 상태

      const second = await save(docA, [{ ...loaded, marker: 'A-2' }]);

      expect(second.body.conflicts).toEqual([]);
      expect(second.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
      expect((await row(pid)).marker).toBe('A-2');
    });

    it('PUT(덮어쓰기)도 확정 revision을 스냅샷에 찍는다', async () => {
      const pid = crypto.randomUUID();
      const first = await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
      const workspaceId = first.body.items[0].id;

      const res = await put(docA, workspaceId, [{ ...first.body.items[0].patients[0], marker: 'A-2' }]);

      expect(res.status).toBe(200);
      expect(res.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
      const { rows } = await pool.query<{ snapshot_payload: Array<{ sync: { revision: number } }> }>(
        `SELECT snapshot_payload FROM workspaces WHERE id = $1`, [workspaceId],
      );
      expect(rows[0].snapshot_payload[0].sync.revision).toBe(2);
    });

    it('저장되지 않은(제외된) 환자의 스냅샷 사본은 그대로 둔다 — 서버에 더 새로운 버전이 있으므로 충돌이 계속 보여야 한다', async () => {
      const pid = crypto.randomUUID();
      await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);

      const res = await save(nurseB, [patient(pid, 'B-copy', { doctorName: 'Doc A', revision: 1 })]);

      expect(res.body.skipped).toEqual([{ id: pid, reason: 'not_assigned' }]);
      expect(res.body.items[0].patients[0].sync).toEqual({ revision: 1, syncStatus: 'synced' }); // 찍히지 않음
      expect(res.body.items[0].patients[0].assignedDoctorUserId).toBeUndefined();
    });

    it('담당의가 없는 신규 환자는 saved에 assignedDoctorUserId: null로 확정된다', async () => {
      const pid = crypto.randomUUID();
      const res = await save(nurseB, [patient(pid, 'B-new')]);
      expect(res.body.saved).toEqual([{ id: pid, revision: 1, assignedDoctorUserId: null }]);
    });

    it('P1: 저장 도중 환자가 삭제돼 스냅샷에서 가려졌다면, 이어지는 보정이 환자 정보를 되살리지 않는다', async () => {
      const pid = crypto.randomUUID();

      // 환자 기록은 저장됐고(saved), 보정 직전에 그 환자의 삭제가 끝나 스냅샷 항목이 { id, redacted } 로 바뀐다.
      const res = await save(docA, [patient(pid, 'A-secret', { doctorName: 'Doc A' })], {}, {
        beforeStamp: () => deleteAs(docA, pid, 1),
      });

      expect(res.status).toBe(201);
      const { rows } = await pool.query<{ snapshot_payload: unknown[] }>(
        `SELECT snapshot_payload FROM workspaces WHERE organization_id = $1`, [orgId],
      );
      expect(rows[0].snapshot_payload).toEqual([{ id: pid, redacted: true }]);
      expect(JSON.stringify(rows[0].snapshot_payload)).not.toContain('환자-A-secret');
      expect(JSON.stringify(res.body.items)).not.toContain('환자-A-secret'); // 응답의 저장 항목도 마찬가지
    });

    it('P1: 같은 저장 항목에 더 나중 저장이 먼저 끝났다면, 늦게 끝난 이전 저장의 보정이 그 저장본을 덮어쓰지 않는다', async () => {
      const p1 = crypto.randomUUID();
      const p2 = crypto.randomUUID();
      const first = await save(docA, [patient(p1, 'A-1', { doctorName: 'Doc A' })]);
      const workspaceId = first.body.items[0].id;

      // A: 이 항목을 p1로 덮어쓰는 PUT. 보정 직전에 B(같은 항목을 p2로 덮어쓰는 PUT)가 끝난다.
      await put(docA, workspaceId, [{ ...first.body.items[0].patients[0], marker: 'A-2' }], 'name-A', {
        beforeStamp: async () => {
          await put(docA, workspaceId, [patient(p2, 'B-1', { doctorName: 'Doc A' })], 'name-B').expect(200);
        },
      }).expect(200);

      // 최종 저장본은 B의 것이어야 하고, 이름·patient_ids·payload가 서로 어긋나면 안 된다.
      const { rows } = await pool.query<{ name: string; patient_ids: string[]; snapshot_payload: Array<{ id: string }> }>(
        `SELECT name, patient_ids, snapshot_payload FROM workspaces WHERE id = $1`, [workspaceId],
      );
      expect(rows[0].name).toBe('name-B');
      expect(rows[0].patient_ids).toEqual([p2]);
      expect(rows[0].snapshot_payload.map((p) => p.id)).toEqual([p2]);
    });
  });

  describe('락 enforcement 모드', () => {
    async function holdLock(userId: string, holderName: string, pid: string): Promise<string> {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await lockPatientAnchor(c as unknown as QueryRunner, { patientId: pid, orgId });
        const r = await acquireLock(c as unknown as QueryRunner, {
          patientId: pid, orgId, userId, holderName, clientInstanceId: crypto.randomUUID(),
        });
        await c.query('COMMIT');
        if (!r.ok) throw new Error('lock not acquired');
        return r.leaseToken;
      } finally {
        c.release();
      }
    }

    it('본인 락의 lease token을 lockTokens로 보내면 저장된다', async () => {
      const pid = crypto.randomUUID();
      await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
      lockMode.mode = 'enforce';
      const leaseToken = await holdLock(docA.id, 'Doc A', pid);

      const res = await save(docA, [patient(pid, 'A-2', { doctorName: 'Doc A', revision: 1 })], {
        lockTokens: { [pid]: leaseToken },
      });

      expect(await row(pid)).toMatchObject({ revision: 2, marker: 'A-2' });
      expect(res.body.saved).toEqual([{ id: pid, revision: 2, assignedDoctorUserId: docA.id }]);
    });

    it('다른 사용자가 락을 쥔 환자는 admin이어도 저장되지 않고 lockedByOther로 보고된다', async () => {
      const pid = crypto.randomUUID();
      await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
      lockMode.mode = 'enforce';
      await holdLock(docA.id, 'Doc A', pid);

      const res = await save(adminC, [patient(pid, 'C-blocked', { doctorName: 'Doc A', revision: 1 })]);

      expect(await row(pid)).toMatchObject({ revision: 1, marker: 'A-1' });
      expect(res.body.lockedByOther).toHaveLength(1);
      expect(res.body.lockedByOther[0]).toMatchObject({ id: pid, holder: { holderName: 'Doc A' } });
      // lease token / 사용자 id는 응답에 노출되지 않는다
      expect(JSON.stringify(res.body)).not.toMatch(/leaseToken|lease_token/i);
    });

    it('락이 있는데 토큰 없이 보내면(enforce) 본인이어도 lockedByOther', async () => {
      const pid = crypto.randomUUID();
      await save(docA, [patient(pid, 'A-1', { doctorName: 'Doc A' })]);
      lockMode.mode = 'enforce';
      await holdLock(docA.id, 'Doc A', pid);

      const res = await save(docA, [patient(pid, 'A-no-token', { doctorName: 'Doc A', revision: 1 })]);
      expect((await row(pid)).marker).toBe('A-1');
      expect(res.body.lockedByOther.map((l: { id: string }) => l.id)).toEqual([pid]);
    });
  });
});
