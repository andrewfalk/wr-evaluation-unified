// 실제 Postgres(두 개의 진짜 동시 커넥션)로만 증명 가능한 시나리오 전용 통합 테스트.
// mock 기반 sessionStore.test.ts로는 "동시 rotation 경합"이나 "logout이 rotation과
// 경합할 때 family 잠금이 실제로 다른 트랜잭션을 블록하는지"를 증명할 수 없다 — 여기서만
// 검증한다. (server/src/db/__tests__/patientLocks.integration.test.ts와 동일한 패턴.)
//
// 실행 조건: TEST_DATABASE_URL 환경변수가 실제로 접근 가능한 Postgres를 가리켜야 한다.
// 없으면 이 파일 전체를 건너뛴다(CI/로컬에 DB가 없어도 나머지 테스트에 영향 없음).
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/auth/__tests__/sessionStore.integration.test.ts
//
// 이 테스트는 자신만의 organizations/users fixture 행을 만들고 afterAll에서 전부
// 삭제한다(sessions는 users.id에 ON DELETE CASCADE라 함께 정리된다).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { createSession, rotateSession, revokeSessionFamily } from '../sessionStore';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('sessionStore — 실제 동시 DB 커넥션 (integration)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_sessionStore_org__']
    );
    orgId = org.rows[0].id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_sessionStore_user_${Date.now()}__`, 'x', 'Test Doctor', orgId]
    );
    userId = user.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM users WHERE id = $1', [userId]); // cascades to sessions
    await pool.query('DELETE FROM organizations WHERE id = $1', [orgId]);
    await pool.end();
  });

  async function createTestSession() {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const session = await createSession(client, userId, {}, 3600);
      await client.query('COMMIT');
      return session;
    } finally {
      client.release();
    }
  }

  // rotateSession()/revokeSessionFamily()가 잡는 것과 동일한 순서로 잠금을 수동
  // 재현한다: family 단위 advisory lock → 대상 행의 FOR UPDATE. 실제 구현과 같은 잠금
  // 순서를 써야 "진짜 경쟁자"를 흉내 낸 테스트가 된다(순서가 다르면 교착 상태나
  // 잘못된 통과가 나올 수 있음).
  async function acquireFamilyAndRowLock(client: import('pg').PoolClient, familyId: string, rowId: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [familyId]);
    await client.query('SELECT id FROM sessions WHERE id = $1 FOR UPDATE', [rowId]);
  }

  it('두 /refresh(rotateSession)가 같은 토큰으로 동시에 경합하면 정확히 하나만 성공한다', async () => {
    // 자연 Promise.all 경합만으로는 타이밍이 너무 짧아 잠금이 없어도 우연히 통과할 수 있다
    // (실제로 확인함). patientLocks 통합 테스트와 동일하게, 한쪽을 수동으로 락을 쥔 채
    // 대기시켜 경합 구간을 강제로 넓히는 결정론적 방식으로 검증한다.
    const s1 = await createTestSession();

    const clientA = await pool.connect();
    let winnerCommitted = false;

    try {
      await clientA.query('BEGIN');
      await acquireFamilyAndRowLock(clientA, s1.familyId, s1.sessionId);

      // 같은 토큰으로 진짜 rotateSession()이 동시에 들어옴("패자" 후보) — clientA가
      // 커밋하기 전까지 이 await는 리턴되면 안 된다.
      const loserPromise = (async () => {
        const result = await rotateSession(pool, s1.refreshToken, {}, 3600);
        return { result, sawWinnerCommittedFirst: winnerCommitted };
      })();

      // rotateSession()이 실제로 잠금 대기에 들어갈 시간을 준다.
      await new Promise((resolve) => setTimeout(resolve, 300));

      await clientA.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [s1.sessionId]);
      await createSession(clientA, userId, {}, 3600, true, s1.familyId);
      winnerCommitted = true;
      await clientA.query('COMMIT'); // 단언보다 먼저

      const { result: loserResult, sawWinnerCommittedFirst } = await loserPromise;

      expect(sawWinnerCommittedFirst).toBe(true); // rotateSession()이 실제로 블록했다가 재개했음을 증명
      expect(loserResult).toBeNull(); // 승자가 이미 rotate했으므로 패자는 "이미 rotation됨"으로 판정
    } finally {
      clientA.release();
    }
  });

  it('logout이 진행 중인 rotation과 같은 행을 두고 경합해도, 그 rotation이 만든 새 세션까지 무효화한다', async () => {
    const s1 = await createTestSession();

    const clientA = await pool.connect();
    let rotationCommitted = false;
    let s2Id = '';

    try {
      await clientA.query('BEGIN');
      await acquireFamilyAndRowLock(clientA, s1.familyId, s1.sessionId);

      // logout()이 동시에 들어옴 — clientA가 아직 락을 쥐고 있으므로 이 await는
      // clientA가 커밋하기 전까지 리턴되면 안 된다.
      const revokePromise = (async () => {
        const result = await revokeSessionFamily(pool, s1.refreshToken, s1.csrfToken);
        return { result, sawCommittedFirst: rotationCommitted };
      })();

      await new Promise((resolve) => setTimeout(resolve, 300));

      await clientA.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [s1.sessionId]);
      const created = await createSession(clientA, userId, {}, 3600, true, s1.familyId);
      s2Id = created.sessionId;
      rotationCommitted = true;
      await clientA.query('COMMIT'); // 단언보다 먼저 — 실패해도 트랜잭션이 열린 채 release되지 않도록

      const { result, sawCommittedFirst } = await revokePromise;

      expect(sawCommittedFirst).toBe(true); // revokeSessionFamily가 실제로 블록했다가 재개했음을 증명
      expect(result).toEqual({ status: 'revoked', sessionId: s1.sessionId, userId, familyId: s1.familyId });
    } finally {
      clientA.release();
    }

    const { rows: finalRows } = await pool.query<{ id: string; invalidated_at: string | null }>(
      `SELECT id, invalidated_at FROM sessions WHERE id = ANY($1::uuid[])`,
      [[s1.sessionId, s2Id]]
    );
    expect(finalRows).toHaveLength(2);
    // S1(logout이 원래 알던 세션)과 S2(경합 중 rotation이 만든 새 세션) 둘 다 죽어야 한다.
    expect(finalRows.every((r) => r.invalidated_at !== null)).toBe(true);
  });

  it('logout이 "이전 세대" 토큰(S1)을 들고 있는 사이 "현재 세대" 토큰(S2)으로 동시 refresh가 S3을 만들어도, family 단위 잠금으로 S3까지 무효화한다', async () => {
    // 이게 이번에 고친 핵심 시나리오: logout과 concurrent refresh가 서로 다른 행(S1 vs
    // S2)을 잡고 있으면, 행 단위 잠금만으로는 둘이 아예 경합하지 않는다 — family 전체를
    // advisory lock으로 묶어야만 서로를 기다리게 된다.
    const s1 = await createTestSession();
    const s2 = await rotateSession(pool, s1.refreshToken, {}, 3600); // 실제로 한 세대 진행시켜 둔다
    expect(s2).not.toBeNull();

    const clientA = await pool.connect(); // "동시에 들어오는 refresh" 역할 — 현재 세대(S2)를 잡는다.
    let rotationCommitted = false;
    let s3Id = '';

    try {
      await clientA.query('BEGIN');
      await acquireFamilyAndRowLock(clientA, s1.familyId, s2!.sessionId);

      // logout()이 "오래된" S1 토큰을 들고 동시에 들어옴 — 서로 다른 행(S1 vs S2)이지만
      // family_id는 같으므로, family 단위 잠금이 없었다면 이 await는 clientA를 전혀
      // 기다리지 않고 바로 리턴됐을 것이다.
      const revokePromise = (async () => {
        const result = await revokeSessionFamily(pool, s1.refreshToken, s1.csrfToken);
        return { result, sawCommittedFirst: rotationCommitted };
      })();

      await new Promise((resolve) => setTimeout(resolve, 300));

      await clientA.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [s2!.sessionId]);
      const s3 = await createSession(clientA, userId, {}, 3600, true, s1.familyId);
      s3Id = s3.sessionId;
      rotationCommitted = true;
      await clientA.query('COMMIT');

      const { result, sawCommittedFirst } = await revokePromise;

      expect(sawCommittedFirst).toBe(true); // family 단위 잠금 덕에 실제로 블록했다가 재개했음을 증명
      expect(result).toEqual({ status: 'revoked', sessionId: s1.sessionId, userId, familyId: s1.familyId });
    } finally {
      clientA.release();
    }

    const { rows: finalRows } = await pool.query<{ id: string; invalidated_at: string | null }>(
      `SELECT id, invalidated_at FROM sessions WHERE id = ANY($1::uuid[])`,
      [[s1.sessionId, s2!.sessionId, s3Id]]
    );
    expect(finalRows).toHaveLength(3);
    // S1, S2(logout 시점의 "현재" 세대), S3(경합 중 만들어진 "다음" 세대) 전부 죽어야 한다.
    expect(finalRows.every((r) => r.invalidated_at !== null)).toBe(true);
  });

  it('경합 없는 일반 케이스에서는 하나의 세션만 존재하고 정상적으로 무효화된다', async () => {
    const s1 = await createTestSession();

    const result = await revokeSessionFamily(pool, s1.refreshToken, s1.csrfToken);
    expect(result).toEqual({ status: 'revoked', sessionId: s1.sessionId, userId, familyId: s1.familyId });

    const { rows } = await pool.query<{ invalidated_at: string | null }>(
      `SELECT invalidated_at FROM sessions WHERE id = $1`,
      [s1.sessionId]
    );
    expect(rows[0].invalidated_at).not.toBeNull();
  });

  it('CSRF 토큰이 안 맞으면 아무것도 무효화하지 않고 csrf_invalid를 반환한다', async () => {
    const s1 = await createTestSession();

    const result = await revokeSessionFamily(pool, s1.refreshToken, 'wrong-csrf-token');
    expect(result).toEqual({ status: 'csrf_invalid' });

    const { rows } = await pool.query<{ invalidated_at: string | null }>(
      `SELECT invalidated_at FROM sessions WHERE id = $1`,
      [s1.sessionId]
    );
    expect(rows[0].invalidated_at).toBeNull();
  });
});
