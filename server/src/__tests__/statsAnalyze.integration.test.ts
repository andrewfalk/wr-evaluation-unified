// PR1 계획서 §9-item9 — 실제 Postgres로만 증명 가능한 stats_runs DDL 시나리오.
// mock 기반 단위 테스트로는 파셜 유니크 인덱스의 ON CONFLICT 동작, CHECK 제약, PG16
// 컬럼 지정 ON DELETE SET NULL을 증명할 수 없다 — statsSnapshot.integration.test.ts와
// 동일 패턴(TEST_DATABASE_URL 없으면 전체 skip, 자체 fixture 생성/정리).
//
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/__tests__/statsAnalyze.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB_URL)('stats_runs DDL — 실제 Postgres (integration)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_statsAnalyze_org__'],
    );
    orgId = org.rows[0].id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_statsAnalyze_user_${Date.now()}__`, 'x', 'Test Doctor', orgId],
    );
    userId = user.rows[0].id;
  });

  afterAll(async () => {
    // users.organization_id는 ON DELETE SET NULL이라(0001_init.sql:26) organizations를
    // 지워도 user 행은 안 지워진다 — fixture user까지 명시적으로 정리해야 한다.
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM users WHERE organization_id = $1 OR login_id LIKE '__test_statsAnalyze_%'`, [orgId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  function insertSucceeded(digest: string, cacheable: boolean, manifestOutcome = 'succeeded') {
    const manifest = JSON.stringify({ analysisRunId: crypto.randomUUID(), outcome: manifestOutcome, resultDigest: 'd' });
    return pool.query<{ id: string }>(
      `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
         requested_disclosure_profile, cacheable, manifest, result, expires_at, finished_at)
       VALUES ($1,$2,'succeeded','r','s',$3,'aggregate',$4,$5,'{}'::jsonb, now() + interval '1 day', now())
       ON CONFLICT (organization_id, execution_digest) WHERE status = 'succeeded' AND cacheable
       DO NOTHING
       RETURNING id`,
      [orgId, userId, digest, cacheable, manifest],
    );
  }

  it('stats_runs_succeeded_uniq — cacheable=true 동일 digest 동시 INSERT는 하나만 성공한다', async () => {
    const digest = `digest-conflict-${Date.now()}`;
    const [r1, r2] = await Promise.all([insertSucceeded(digest, true), insertSucceeded(digest, true)]);
    const inserted = [r1, r2].filter((r) => r.rows.length > 0);
    expect(inserted).toHaveLength(1);
  });

  it('cacheable=false는 같은 digest로 여러 행이 쌓여도 충돌하지 않는다', async () => {
    const digest = `digest-suppressed-${Date.now()}`;
    const r1 = await insertSucceeded(digest, false);
    const r2 = await insertSucceeded(digest, false);
    expect(r1.rows).toHaveLength(1);
    expect(r2.rows).toHaveLength(1);
    expect(r1.rows[0].id).not.toBe(r2.rows[0].id);
  });

  it('run_result_error_pairing — succeeded는 result 필수, failed는 error_code 필수', async () => {
    await expect(
      pool.query(
        `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
           requested_disclosure_profile, cacheable, manifest, result, expires_at, finished_at)
         VALUES ($1,$2,'succeeded','r','s',$3,'aggregate',true,'{}'::jsonb, NULL, now() + interval '1 day', now())`,
        [orgId, userId, `digest-bad-succeeded-${Date.now()}`],
      ),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation

    await expect(
      pool.query(
        `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
           requested_disclosure_profile, cacheable, manifest, result, error_code, expires_at, finished_at)
         VALUES ($1,$2,'failed','r','s',$3,'aggregate',true,'{}'::jsonb, '{}'::jsonb, NULL, now() + interval '1 day', now())`,
        [orgId, userId, `digest-bad-failed-${Date.now()}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('run_terminal_fields — succeeded/failed는 finished_at 필수', async () => {
    await expect(
      pool.query(
        `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
           requested_disclosure_profile, cacheable, manifest, result, expires_at)
         VALUES ($1,$2,'succeeded','r','s',$3,'aggregate',true,'{}'::jsonb,'{}'::jsonb, now() + interval '1 day')`,
        [orgId, userId, `digest-no-finished-${Date.now()}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('사용자 삭제 시 requested_by만 NULL이 되고 organization_id·행 자체는 유지된다', async () => {
    const throwawayUser = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,'x','Throwaway','doctor',$2) RETURNING id`,
      [`__test_statsAnalyze_throwaway_${Date.now()}__`, orgId],
    );
    const throwawayUserId = throwawayUser.rows[0].id;
    const digest = `digest-user-delete-${Date.now()}`;
    const manifest = JSON.stringify({ analysisRunId: crypto.randomUUID(), outcome: 'succeeded', resultDigest: 'd' });
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
         requested_disclosure_profile, cacheable, manifest, result, expires_at, finished_at)
       VALUES ($1,$2,'succeeded','r','s',$3,'aggregate',true,$4,'{}'::jsonb, now() + interval '1 day', now())
       RETURNING id`,
      [orgId, throwawayUserId, digest, manifest],
    );
    const runId = ins.rows[0].id;

    await pool.query(`DELETE FROM users WHERE id = $1`, [throwawayUserId]);

    const check = await pool.query<{ requested_by: string | null; organization_id: string }>(
      `SELECT requested_by, organization_id FROM stats_runs WHERE id = $1`,
      [runId],
    );
    expect(check.rows).toHaveLength(1);
    expect(check.rows[0].requested_by).toBeNull();
    expect(check.rows[0].organization_id).toBe(orgId);
  });

  it('DELETE-then-INSERT — 만료된 cacheable 행은 새 성공 결과로 교체된다', async () => {
    const digest = `digest-expired-${Date.now()}`;
    const oldManifest = JSON.stringify({ analysisRunId: crypto.randomUUID(), outcome: 'succeeded', resultDigest: 'old' });
    await pool.query(
      `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
         requested_disclosure_profile, cacheable, manifest, result, expires_at, finished_at)
       VALUES ($1,$2,'succeeded','r','s',$3,'aggregate',true,$4,'{"old":true}'::jsonb, now() - interval '1 hour', now())`,
      [orgId, userId, digest, oldManifest],
    );

    // 캐시 조회는 expires_at > now()라 이 행을 무시해야 한다.
    const cacheCheck = await pool.query(
      `SELECT 1 FROM stats_runs WHERE organization_id=$1 AND execution_digest=$2 AND status='succeeded' AND cacheable AND expires_at > now()`,
      [orgId, digest],
    );
    expect(cacheCheck.rows).toHaveLength(0);

    // DELETE-then-INSERT 절차(statsAnalyzeHandler.ts와 동일 SQL)로 교체.
    await pool.query(
      `DELETE FROM stats_runs WHERE organization_id=$1 AND execution_digest=$2 AND status='succeeded' AND cacheable AND expires_at <= now()`,
      [orgId, digest],
    );
    const newManifest = JSON.stringify({ analysisRunId: crypto.randomUUID(), outcome: 'succeeded', resultDigest: 'new' });
    const reinsert = await pool.query<{ id: string }>(
      `INSERT INTO stats_runs (organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
         requested_disclosure_profile, cacheable, manifest, result, expires_at, finished_at)
       VALUES ($1,$2,'succeeded','r','s',$3,'aggregate',true,$4,'{"new":true}'::jsonb, now() + interval '1 day', now())
       ON CONFLICT (organization_id, execution_digest) WHERE status='succeeded' AND cacheable DO NOTHING
       RETURNING id`,
      [orgId, userId, digest, newManifest],
    );
    expect(reinsert.rows).toHaveLength(1);
  });
});
