// 실제 Postgres(두 개의 진짜 동시 커넥션)로만 증명 가능한 시나리오 전용 통합 테스트.
// mock 기반 capabilityGrants.test.ts로는 복합 FK 무결성이나 "동시 재부여 경쟁"을
// 증명할 수 없다 — 여기서만 검증한다. (patientLocks.integration.test.ts와 동일한 패턴.)
//
// 실행 조건: TEST_DATABASE_URL 환경변수가 실제로 접근 가능한 Postgres를 가리켜야 한다.
// 없으면 이 파일 전체를 건너뛴다(CI/로컬에 DB가 없어도 나머지 테스트에 영향 없음).
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/db/__tests__/capabilityGrants.integration.test.ts
//
// 이 테스트는 자신만의 organizations/users fixture 행을 만들고 afterAll에서 전부
// 삭제한다(user_capability_grants는 users.id에 ON DELETE CASCADE라 함께 정리된다).
//
// 머지 전 CI에서는 이 파일이 반드시 통과해야 한다 — 로컬 세션에 DB가 없어 스킵되는 것은
// 이 파일 한정이며, PR 병합 게이트에서는 필수 통과 조건이다.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, type PoolClient } from 'pg';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('user_capability_grants — 실제 동시 DB 커넥션 (integration)', () => {
  let pool: Pool;
  let orgAId: string;
  let orgBId: string;
  let userAId: string; // org A
  let userBId: string; // org B

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const orgA = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_capabilityGrants_orgA__']
    );
    orgAId = orgA.rows[0].id;
    const orgB = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_capabilityGrants_orgB__']
    );
    orgBId = orgB.rows[0].id;
    const userA = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_capgrants_userA_${Date.now()}__`, 'x', 'Test Doctor A', orgAId]
    );
    userAId = userA.rows[0].id;
    const userB = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_capgrants_userB_${Date.now()}__`, 'x', 'Test Doctor B', orgBId]
    );
    userBId = userB.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[userAId, userBId]]); // cascades grants
    await pool.query('DELETE FROM organizations WHERE id = ANY($1)', [[orgAId, orgBId]]);
    await pool.end();
  });

  async function clearGrants(userId: string) {
    await pool.query('DELETE FROM user_capability_grants WHERE user_id = $1', [userId]);
  }

  it('복합 FK가 실제로는 다른 조직 소속인 granted_by를 거부한다', async () => {
    await clearGrants(userAId);
    try {
      // grant_granter_org CHECK는 통과시키되(granted_by_org = organization_id) 실제
      // (userBId, orgAId) 조합이 users 테이블에 없으므로 grant_granter_in_org FK가 막는다.
      await expect(
        pool.query(
          `INSERT INTO user_capability_grants
             (user_id, organization_id, capability, granted_by, granted_by_org, reason)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [userAId, orgAId, 'stats.view', userBId, orgAId, 'cross-org forgery attempt']
        )
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await clearGrants(userAId);
    }
  });

  it('열린 grant 유니크 인덱스가 동일 (user, capability) 중복 오픈을 막는다', async () => {
    await clearGrants(userAId);
    try {
      await pool.query(
        `INSERT INTO user_capability_grants (user_id, organization_id, capability, reason)
         VALUES ($1,$2,$3,$4)`,
        [userAId, orgAId, 'stats.view', 'first grant']
      );
      await expect(
        pool.query(
          `INSERT INTO user_capability_grants (user_id, organization_id, capability, reason)
           VALUES ($1,$2,$3,$4)`,
          [userAId, orgAId, 'stats.view', 'duplicate open grant']
        )
      ).rejects.toMatchObject({ code: '23505', constraint: 'user_capability_grants_open_uniq' });
    } finally {
      await clearGrants(userAId);
    }
  });

  it('회수된(revoked) grant는 유니크 인덱스에 걸리지 않는다 — 부분 인덱스가 WHERE revoked_at IS NULL만 본다', async () => {
    await clearGrants(userAId);
    try {
      await pool.query(
        `INSERT INTO user_capability_grants (user_id, organization_id, capability, reason, revoked_at, revocation_reason)
         VALUES ($1,$2,$3,$4,now(),'manual')`,
        [userAId, orgAId, 'stats.view', 'old, already revoked']
      );
      // 두 번째(열린) grant는 막히지 않아야 한다 — revoked 행은 부분 인덱스 대상이 아니므로.
      await expect(
        pool.query(
          `INSERT INTO user_capability_grants (user_id, organization_id, capability, reason)
           VALUES ($1,$2,$3,$4)`,
          [userAId, orgAId, 'stats.view', 'new open grant after revoke']
        )
      ).resolves.toBeDefined();
    } finally {
      await clearGrants(userAId);
    }
  });

  // §7.2 재부여 트랜잭션(만료 grant를 만나면 close→insert)을 두 커넥션이 동시에 시도한다.
  // capabilityGrants.ts의 createGrant()와 동일한 SQL 순서를 그대로 재현 — 실제 라우트가
  // 이 경합에서 정확히 한쪽만 성공시키고, 다른 쪽은 user_capability_grants_open_uniq
  // 위반을 409로 매핑하는지(라우트 자체는 mock 테스트가 검증)의 DB 쪽 절반을 증명한다.
  async function attemptRegrant(client: PoolClient, userId: string, orgId: string, capability: string, reason: string) {
    await client.query('BEGIN');
    try {
      const { rows } = await client.query<{ id: string; expires_at: Date | null }>(
        `SELECT id, expires_at FROM user_capability_grants
         WHERE user_id = $1 AND capability = $2 AND revoked_at IS NULL
         FOR UPDATE`,
        [userId, capability]
      );
      if (rows.length > 0) {
        const isExpired = rows[0].expires_at !== null && rows[0].expires_at.getTime() <= Date.now();
        if (isExpired) {
          await client.query(
            `UPDATE user_capability_grants SET revoked_at = now(), revocation_reason = 'expired_regrant' WHERE id = $1`,
            [rows[0].id]
          );
        } else {
          await client.query('ROLLBACK');
          return { ok: false as const, reason: 'active_exists' };
        }
      }
      await client.query(
        `INSERT INTO user_capability_grants (user_id, organization_id, capability, reason) VALUES ($1,$2,$3,$4)`,
        [userId, orgId, capability, reason]
      );
      await client.query('COMMIT');
      return { ok: true as const };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const pgErr = err as { code?: string };
      if (pgErr.code === '23505') return { ok: false as const, reason: 'unique_violation' };
      throw err;
    }
  }

  it('동시 재부여 경쟁 — 만료된 grant를 두 트랜잭션이 동시에 재부여 시도하면 정확히 하나만 성공한다', async () => {
    await clearGrants(userAId);
    try {
      // grant_ttl CHECK 요구사항(expires_at > granted_at)을 만족시키면서도 지금 시점엔
      // 이미 만료된 상태를 만들어야 한다 — granted_at도 함께 과거로 둔다.
      await pool.query(
        `INSERT INTO user_capability_grants (user_id, organization_id, capability, reason, granted_at, expires_at)
         VALUES ($1,$2,$3,$4, now() - interval '2 hours', now() - interval '1 hour')`,
        [userAId, orgAId, 'stats.regression', 'expired original']
      );

      const clientA = await pool.connect();
      const clientB = await pool.connect();
      try {
        const [a, b] = await Promise.all([
          attemptRegrant(clientA, userAId, orgAId, 'stats.regression', 'racer A'),
          attemptRegrant(clientB, userAId, orgAId, 'stats.regression', 'racer B'),
        ]);

        const successes = [a, b].filter((r) => r.ok);
        expect(successes.length).toBe(1);

        const { rows: open } = await pool.query(
          `SELECT reason FROM user_capability_grants
           WHERE user_id = $1 AND capability = $2 AND revoked_at IS NULL`,
          [userAId, 'stats.regression']
        );
        expect(open.length).toBe(1);
        expect(['racer A', 'racer B']).toContain(open[0].reason);
      } finally {
        clientA.release();
        clientB.release();
      }
    } finally {
      await clearGrants(userAId);
    }
  });
});
