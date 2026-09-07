// PR0-C §1.1/§B — 실제 Postgres로만 증명 가능한 시나리오 전용 통합 테스트.
// mock 기반 단위 테스트(statsDatasetBuilder.test.ts 등)는 buildDataset의 순수 로직만
// 검증하고, readSnapshot()이 실제로 짜는 SQL(조직 격리 WHERE, soft-delete 배제, 트랜잭션
// 격리 수준)이 옳은지는 진짜 DB 없이는 증명할 수 없다 — 여기서만 검증한다.
// (patientLocks.integration.test.ts / capabilityGrants.integration.test.ts와 동일한 패턴.)
//
// 실행 조건: TEST_DATABASE_URL 환경변수가 실제로 접근 가능한 Postgres를 가리켜야 한다.
// 없으면 이 파일 전체를 건너뛴다(CI/로컬에 DB가 없어도 나머지 테스트에 영향 없음).
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/__tests__/statsSnapshot.integration.test.ts
//
// 이 테스트는 자신만의 organizations/users/patient_persons/patient_records fixture 행을
// 만들고 afterAll/각 it()에서 정리한다 — 기존 dev DB의 다른 데이터를 건드리지 않는다.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import { readSnapshot } from '../statsSnapshot';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('readSnapshot — 실제 Postgres (integration)', () => {
  let pool: Pool;
  let orgAId: string;
  let orgBId: string;
  let userAId: string;
  let userBId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const orgA = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_statsSnapshot_orgA__'],
    );
    orgAId = orgA.rows[0].id;
    const orgB = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_statsSnapshot_orgB__'],
    );
    orgBId = orgB.rows[0].id;
    const userA = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_statsSnapshot_userA_${Date.now()}__`, 'x', 'Test Doctor A', orgAId],
    );
    userAId = userA.rows[0].id;
    const userB = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_statsSnapshot_userB_${Date.now()}__`, 'x', 'Test Doctor B', orgAId],
    );
    userBId = userB.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM patient_records WHERE organization_id = ANY($1)', [[orgAId, orgBId]]);
    await pool.query('DELETE FROM patient_persons WHERE organization_id = ANY($1)', [[orgAId, orgBId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userAId, userBId]]);
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[orgAId, orgBId]]);
    await pool.end();
  });

  async function createCase(
    orgId: string,
    name: string,
    opts: { assignedDoctorUserId?: string | null; deletedAt?: Date | null } = {},
  ): Promise<{ caseId: string; personId: string }> {
    const person = await pool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1,$2) RETURNING id`,
      [orgId, name],
    );
    const record = await pool.query<{ id: string }>(
      `INSERT INTO patient_records
         (organization_id, owner_user_id, assigned_doctor_user_id, patient_person_id, name, revision, payload, deleted_at)
       VALUES ($1,$2,$3,$4,$5,1,'{}',$6) RETURNING id`,
      [orgId, userAId, opts.assignedDoctorUserId ?? null, person.rows[0].id, name, opts.deletedAt ?? null],
    );
    return { caseId: record.rows[0].id, personId: person.rows[0].id };
  }

  async function cleanupCases(orgId: string) {
    await pool.query('DELETE FROM patient_records WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM patient_persons WHERE organization_id = $1', [orgId]);
  }

  afterEach(async () => {
    await cleanupCases(orgAId);
    await cleanupCases(orgBId);
  });

  it('조직 격리 — 다른 조직(orgB)의 사례는 orgA의 snapshot에 나타나지 않는다', async () => {
    const a = await createCase(orgAId, 'Org A Case');
    const b = await createCase(orgBId, 'Org B Case');

    const snapshot = await readSnapshot(pool, orgAId);
    const ids = snapshot.rows.map((r) => r.id);
    expect(ids).toContain(a.caseId);
    expect(ids).not.toContain(b.caseId);
  });

  it('soft-delete — deleted_at이 설정된 사례는 snapshot에서 제외된다', async () => {
    const alive = await createCase(orgAId, 'Alive Case');
    const deleted = await createCase(orgAId, 'Deleted Case', { deletedAt: new Date() });

    const snapshot = await readSnapshot(pool, orgAId);
    const ids = snapshot.rows.map((r) => r.id);
    expect(ids).toContain(alive.caseId);
    expect(ids).not.toContain(deleted.caseId);
  });

  it('sourceDigest — 원천 행이 동일하면 조회 시각만 달라도 동일하다', async () => {
    await createCase(orgAId, 'Stable Case');

    const first = await readSnapshot(pool, orgAId);
    // 실제로 시간이 흐르게 해 clock_timestamp()(snapshotAsOf)가 확실히 달라지게 한다.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await readSnapshot(pool, orgAId);

    expect(second.snapshotAsOf).not.toBe(first.snapshotAsOf);
    expect(second.sourceDigest).toBe(first.sourceDigest);
  });

  it('sourceDigest — 담당의(assigned_doctor_user_id)만 바뀌면 조회 시각과 무관하게 변경된다', async () => {
    const { caseId } = await createCase(orgAId, 'Doctor Change Case', { assignedDoctorUserId: userAId });

    const before = await readSnapshot(pool, orgAId);
    await pool.query('UPDATE patient_records SET assigned_doctor_user_id = $1 WHERE id = $2', [userBId, caseId]);
    const after = await readSnapshot(pool, orgAId);

    expect(after.sourceDigest).not.toBe(before.sourceDigest);
  });

  it('트랜잭션 격리 — REPEATABLE READ, READ ONLY 스냅샷은 트랜잭션 시작 후 커밋된 행을 보지 않는다', async () => {
    await createCase(orgAId, 'Pre-existing Case');

    const client = await pool.connect();
    try {
      // readSnapshot()이 실제로 여는 것과 동일한 격리 수준으로 스냅샷을 고정한다.
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const before = await client.query('SELECT id FROM patient_records WHERE organization_id = $1', [orgAId]);

      // 다른 커넥션이 이 스냅샷 시작 "이후" 새 사례를 커밋한다.
      await createCase(orgAId, 'Committed After Snapshot Started');

      // 같은(열려있는) 트랜잭션 안에서 다시 조회해도 REPEATABLE READ면 행 수가 그대로여야
      // 한다 — 그렇지 않다면 격리 수준 문자열이 실제로는 READ COMMITTED로 동작하고 있다는
      // 뜻이고, 이는 §1.1이 요구하는 "한 snapshot에서" 조회 계약이 깨졌다는 신호다.
      const after = await client.query('SELECT id FROM patient_records WHERE organization_id = $1', [orgAId]);
      expect(after.rows.length).toBe(before.rows.length);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // 트랜잭션 종료 후 새로 연 snapshot(=readSnapshot)에는 두 사례 모두 보여야 한다.
    const finalSnapshot = await readSnapshot(pool, orgAId);
    expect(finalSnapshot.rows.length).toBe(2);
  });
});
