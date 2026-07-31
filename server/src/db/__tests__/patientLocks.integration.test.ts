// 실제 Postgres(두 개의 진짜 동시 커넥션)로만 증명 가능한 시나리오 전용 통합 테스트.
// mock QueryRunner(patientLocks.test.ts)로는 "동시 acquire 경합"이나 "FOR UPDATE 앵커가
// 실제로 다른 트랜잭션을 블록하는지"를 증명할 수 없다 — 여기서만 검증한다.
//
// 실행 조건: TEST_DATABASE_URL 환경변수가 실제로 접근 가능한 Postgres를 가리켜야 한다.
// 없으면 이 파일 전체를 건너뛴다(CI/로컬에 DB가 없어도 나머지 테스트에 영향 없음).
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/db/__tests__/patientLocks.integration.test.ts
//
// 이 테스트는 자신만의 organizations/users/patient_records fixture 행을 만들고 afterAll에서
// 전부 삭제한다 — 기존 dev DB의 다른 데이터를 절대 건드리지 않는다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { acquireLock, forceLock, lockPatientAnchor, peekLock } from '../patientLocks';
import type { QueryRunner } from '../patientPersons';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('patientLocks — 실제 동시 DB 커넥션 (integration)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_patientLocks_org__']
    );
    orgId = org.rows[0].id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_patientLocks_user_${Date.now()}__`, 'x', 'Test Doctor', orgId]
    );
    userId = user.rows[0].id;
  });

  afterAll(async () => {
    // patient_records는 각 it()이 만들고 그 안에서 지우지만, 실패로 남은 게 있어도
    // 여기서 org 단위로 한 번 더 정리한다(patient_records → patient_persons → user → org 순서,
    // patient_person_id FK가 ON DELETE RESTRICT라 이 순서를 지켜야 한다).
    await pool.query('DELETE FROM patient_records WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM patient_persons WHERE organization_id = $1', [orgId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await pool.end();
  });

  async function createTestPatient(name: string): Promise<string> {
    const person = await pool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1,$2) RETURNING id`,
      [orgId, name]
    );
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO patient_records (organization_id, owner_user_id, patient_person_id, name, revision, payload)
       VALUES ($1,$2,$3,$4,1,'{}') RETURNING id`,
      [orgId, userId, person.rows[0].id, name]
    );
    return rows[0].id;
  }

  it('동시에 두 클라이언트가 잠기지 않은 환자를 acquire하면 정확히 하나만 성공한다', async () => {
    const patientId = await createTestPatient('Race Patient — concurrent acquire');
    try {
      const runAcquire = async (clientInstanceId: string) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await lockPatientAnchor(client as unknown as QueryRunner, { patientId, orgId });
          const result = await acquireLock(client as unknown as QueryRunner, {
            patientId, orgId, userId, holderName: 'Racer', clientInstanceId,
          });
          await client.query(result.ok ? 'COMMIT' : 'ROLLBACK');
          return result;
        } finally {
          client.release();
        }
      };

      const [a, b] = await Promise.all([
        runAcquire('11111111-1111-1111-1111-111111111111'),
        runAcquire('22222222-2222-2222-2222-222222222222'),
      ]);

      const successes = [a, b].filter((r) => r.ok);
      expect(successes.length).toBe(1);
      // 진 쪽은 이긴 쪽의 holder 정보를 정확히 봐야 한다(같은 행을 두고 경합했으므로).
      const loser = [a, b].find((r) => !r.ok);
      expect(loser && !loser.ok ? loser.heldBy.holderName : null).toBe('Racer');
    } finally {
      await pool.query('DELETE FROM patient_records WHERE id = $1', [patientId]);
    }
  });

  it('FOR UPDATE 앵커를 쥔 트랜잭션이 커밋되기 전에는 다른 트랜잭션이 앵커를 잡지 못한다(직렬화)', async () => {
    const patientId = await createTestPatient('Race Patient — anchor serialization');
    const clientA = await pool.connect();
    const clientB = await pool.connect();
    try {
      let aCommitted = false;

      await clientA.query('BEGIN');
      await lockPatientAnchor(clientA as unknown as QueryRunner, { patientId, orgId });

      // B가 같은 환자의 앵커를 잡으려 시도 — A가 커밋할 때까지 이 await는 리턴되면 안 된다.
      const bPromise = (async () => {
        await clientB.query('BEGIN');
        await lockPatientAnchor(clientB as unknown as QueryRunner, { patientId, orgId });
        return aCommitted; // 이 시점에 A가 이미 커밋했어야 참이어야 한다.
      })();

      // B가 실제로 쿼리를 던지고 행 락 대기에 들어갈 시간을 준다.
      await new Promise((resolve) => setTimeout(resolve, 300));

      // 이 시점에 B는 아직 진행하지 못했어야 한다 — A가 아직 커밋 전이므로.
      const forced = await forceLock(clientA as unknown as QueryRunner, {
        patientId, orgId, userId, holderName: 'Serializer A', clientInstanceId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      });
      expect(forced.lock.holderName).toBe('Serializer A');
      aCommitted = true;
      await clientA.query('COMMIT');

      const bSawCommittedFirst = await bPromise;
      expect(bSawCommittedFirst).toBe(true);

      // B가 앵커를 잡은 뒤 보는 patient_locks 상태는 A가 커밋한 최신 상태여야 한다.
      const seenByB = await peekLock(clientB as unknown as QueryRunner, { patientId, orgId });
      expect(seenByB?.holderName).toBe('Serializer A');

      await clientB.query('ROLLBACK');
    } finally {
      clientA.release();
      clientB.release();
      await pool.query('DELETE FROM patient_records WHERE id = $1', [patientId]);
    }
  });

  it('만료된 락은 다음 acquire가 경합 없이 덮어쓴다', async () => {
    const patientId = await createTestPatient('Race Patient — expired overwrite');
    try {
      const client1 = await pool.connect();
      try {
        await client1.query('BEGIN');
        await lockPatientAnchor(client1 as unknown as QueryRunner, { patientId, orgId });
        await acquireLock(client1 as unknown as QueryRunner, {
          patientId, orgId, userId, holderName: 'Expired Holder', clientInstanceId: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        });
        await client1.query('COMMIT');
      } finally {
        client1.release();
      }
      // 실제로 만료시키기 위해 expires_at을 과거로 앞당긴다(TTL을 실제로 기다리지 않기 위한
      // 테스트 전용 조작 — 프로덕션 코드 경로는 그대로 통과한다).
      await pool.query(`UPDATE patient_locks SET expires_at = now() - interval '1 second' WHERE patient_id = $1`, [patientId]);

      const client2 = await pool.connect();
      try {
        await client2.query('BEGIN');
        await lockPatientAnchor(client2 as unknown as QueryRunner, { patientId, orgId });
        const result = await acquireLock(client2 as unknown as QueryRunner, {
          patientId, orgId, userId, holderName: 'New Holder', clientInstanceId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
        });
        expect(result.ok).toBe(true);
        await client2.query(result.ok ? 'COMMIT' : 'ROLLBACK');
      } finally {
        client2.release();
      }
    } finally {
      await pool.query('DELETE FROM patient_records WHERE id = $1', [patientId]);
    }
  });
});
