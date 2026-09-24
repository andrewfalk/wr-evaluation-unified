// PR4-B1 §A — admission. 계획서(pr4-b-virtual-pnueli.md) 11차 통합본 §A 참고.
// 순서: 캐시확인 → 기존 in-flight 합류(join) → (신규 계산일 때만) degraded/quota
// 검사 → 예약. join이 quota보다 먼저인 이유는 합류가 새 리소스를 소비하지 않기
// 때문이다(execution_digest가 이미 requestedBy를 해시에 포함하므로 합류는 항상
// 같은 사용자의 중복 요청에서만 일어난다).
//
// 감사는 "그 사건이 일어나는 트랜잭션 안"에서 즉시 쓴다 — 캐시hit/합류/거절
// 전부 여기서 감사하고 COMMIT한다. 거절 분기는 ROLLBACK이 아니라 감사를 쓰고
// COMMIT한다 — 이 시점까지 트랜잭션은 읽기만 했으므로 "롤백할 변경"이 없고,
// 감사 자체가 이 트랜잭션의 유일한 쓰기라 그걸 남기는 게 목적이다. 감사 쓰기
// 자체가 실패하면 트랜잭션이 커밋되지 않고 throw되며, 호출부(§0)는 기존 가드A
// 429 경로와 같은 원칙으로 500을 반환한다(감사 없는 거절 응답을 내보내지 않음).
import { randomUUID } from 'crypto';
import type { Pool, PoolClient } from 'pg';
import type { AnalysisContext } from './statsAnalysisContext';
import type { FrozenAnalysisInput } from './statsAnalysisContext';
import { STATS_RUN_COLUMNS, type StatsRunRow } from './statsRunRow';
import { buildPendingStatsRunManifest } from './statsRunManifest';
import { writeAuditLogStrict, type AuditOutcome } from './middleware/audit';
import { isEngineDegraded } from './statsEngine';
import { StatsEngineProcessError } from './statsEngine';
import { withWriteTransaction } from './db/withWriteTransaction';
import { statsRunExpiresAt } from './statsRunExpiry';
import config from './config';

// B1의 기존 analysisMode 전부 기존 기본값 그대로 — B2가 prediction 분기를 추가할 때
// 여기를 확장한다(상한은 config.stats.async.maxJobTimeoutMs).
export function estimateEngineTimeoutMs(_ctx: AnalysisContext): number {
  return Math.min(config.stats.timeoutMs, config.stats.async.maxJobTimeoutMs);
}

export type AdmissionResult =
  | { kind: 'cache_hit'; row: StatsRunRow }
  | { kind: 'joined'; row: StatsRunRow }
  | { kind: 'admitted'; row: StatsRunRow }
  | { kind: 'denied'; status: number; code: string };

function auditExtra(ctx: AnalysisContext, executionDigest: string, extra: Record<string, unknown>) {
  return {
    executionDigest,
    recipeDigest: ctx.recipeDigest,
    sourceDigest: ctx.snapshot.sourceDigest,
    grain: ctx.recipe.grain,
    variableKeys: ctx.recipe.variableKeys,
    analysisPurpose: ctx.recipe.analysisPurpose,
    formulaPolicies: ctx.recipe.formulaPolicies,
    ...extra,
  };
}

async function auditAdmission(
  client: PoolClient,
  ctx: AnalysisContext,
  executionDigest: string,
  outcome: AuditOutcome,
  extra: Record<string, unknown>,
): Promise<void> {
  await writeAuditLogStrict(client, {
    actorUserId: ctx.userId,
    actorOrgId: ctx.orgId,
    action: 'stats_analyze',
    targetType: 'analysis_recipe',
    targetId: ctx.recipeDigest,
    outcome,
    extra: auditExtra(ctx, executionDigest, extra),
  });
}

// 동시실행 quota(리소스 점유량) — queued+running 카운트.
async function inFlightCount(client: PoolClient, column: 'requested_by' | 'organization_id', value: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM stats_runs WHERE ${column}=$1 AND status IN ('queued','running')`,
    [value],
  );
  return Number(rows[0].count);
}

// 시간당 quota(요청 빈도, 상태 무관) — 최근 1시간 내 생성된 행 카운트.
async function hourlyCount(client: PoolClient, column: 'requested_by' | 'organization_id', value: string): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM stats_runs WHERE ${column}=$1 AND created_at > now() - interval '1 hour'`,
    [value],
  );
  return Number(rows[0].count);
}

const ADMIT_RETRY_ATTEMPTS = 3;

export async function admitAnalysisRun(
  pool: Pool,
  ctx: AnalysisContext,
  executionDigest: string,
  engineTimeoutMs: number,
): Promise<AdmissionResult> {
  for (let attempt = 0; attempt < ADMIT_RETRY_ATTEMPTS; attempt += 1) {
    const outcome = await admitOnce(pool, ctx, executionDigest, engineTimeoutMs);
    if (outcome !== 'retry') return outcome;
  }
  // 이론상 advisory lock으로 도달 불가능 — 같은 org 안에서 이 함수를 부르는 모든
  // admission이 같은 org advisory lock을 거치므로 진짜 동시 경합은 없다. 그래도
  // 미정의 상태로 남기지 않고 명확히 실패시킨다(기존 sync computeAndPersist 관례).
  throw new StatsEngineProcessError('PROCESS_ERROR', 'execution_digest admission 경쟁이 재시도 한도 내에 해소되지 않음');
}

async function admitOnce(
  pool: Pool,
  ctx: AnalysisContext,
  executionDigest: string,
  engineTimeoutMs: number,
): Promise<AdmissionResult | 'retry'> {
  return withWriteTransaction(pool, async (client) => {
    // 항상 이 순서로(사용자 락 → 조직 락) — 데드락 방지.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stats_admit_user:${ctx.userId}`]);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`stats_admit_org:${ctx.orgId}`]);

    // 1) 캐시 확인
    const cacheHit = await client.query<StatsRunRow>(
      `SELECT ${STATS_RUN_COLUMNS} FROM stats_runs
        WHERE organization_id=$1 AND execution_digest=$2 AND status='succeeded' AND cacheable AND expires_at>now()
        LIMIT 1`,
      [ctx.orgId, executionDigest],
    );
    if (cacheHit.rows.length > 0) {
      const row = cacheHit.rows[0];
      await auditAdmission(client, ctx, executionDigest, 'success', { analysisRunId: row.analysis_run_id, cached: true });
      return { kind: 'cache_hit', row };
    }

    // 2) 기존 in-flight 확인 — quota/degraded보다 먼저. stats_runs_inflight_uniq
    //    (org, execution_digest) WHERE status IN ('queued','running')가 "한 행뿐"을
    //    보장하므로 합류는 새 리소스를 소비하지 않는다.
    const existing = await client.query<StatsRunRow>(
      `SELECT ${STATS_RUN_COLUMNS} FROM stats_runs
        WHERE organization_id=$1 AND execution_digest=$2 AND status IN ('queued','running')
        LIMIT 1`,
      [ctx.orgId, executionDigest],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      await auditAdmission(client, ctx, executionDigest, 'success', { analysisRunId: row.analysis_run_id, joinedInFlight: true });
      return { kind: 'joined', row };
    }

    // 3) 여기부터 "진짜 새 계산" — degraded와 quota를 이 순서로 확인한다. degraded를
    //    admission 이전에 두면 위 1)의 유효한 캐시hit까지 막아버리므로 여기(캐시/합류
    //    확인 이후)에 둔다.
    if (isEngineDegraded()) {
      await auditAdmission(client, ctx, executionDigest, 'denied', { reasonCode: 'ENGINE_DEGRADED' });
      return { kind: 'denied', status: 503, code: 'ENGINE_DEGRADED' };
    }
    if ((await inFlightCount(client, 'requested_by', ctx.userId)) >= config.stats.async.maxConcurrentPerUser) {
      await auditAdmission(client, ctx, executionDigest, 'denied', { reasonCode: 'USER_CONCURRENCY_LIMIT' });
      return { kind: 'denied', status: 429, code: 'USER_CONCURRENCY_LIMIT' };
    }
    if ((await inFlightCount(client, 'organization_id', ctx.orgId)) >= config.stats.async.maxConcurrentPerOrg) {
      await auditAdmission(client, ctx, executionDigest, 'denied', { reasonCode: 'ORG_CONCURRENCY_LIMIT' });
      return { kind: 'denied', status: 429, code: 'ORG_CONCURRENCY_LIMIT' };
    }
    if ((await hourlyCount(client, 'requested_by', ctx.userId)) >= config.stats.async.maxHourlyPerUser) {
      await auditAdmission(client, ctx, executionDigest, 'denied', { reasonCode: 'USER_HOURLY_LIMIT' });
      return { kind: 'denied', status: 429, code: 'USER_HOURLY_LIMIT' };
    }
    if ((await hourlyCount(client, 'organization_id', ctx.orgId)) >= config.stats.async.maxHourlyPerOrg) {
      await auditAdmission(client, ctx, executionDigest, 'denied', { reasonCode: 'ORG_HOURLY_LIMIT' });
      return { kind: 'denied', status: 429, code: 'ORG_HOURLY_LIMIT' };
    }

    // 4) 예약 — org 단위 advisory lock을 쥐고 있으므로 같은 org 안에서 이 INSERT는
    //    경합하지 않는다(ON CONFLICT는 방어적으로만 유지).
    const analysisRunId = randomUUID();
    const manifest = buildPendingStatsRunManifest({
      recipeDigest: ctx.recipeDigest,
      sourceDigest: ctx.snapshot.sourceDigest,
      snapshotAsOf: ctx.snapshot.snapshotAsOf,
      formulaPolicies: ctx.recipe.formulaPolicies,
      analysisMode: ctx.recipe.analysisMode,
      analysisRunId,
    });
    // §저장 데이터 최소화 — buildAnalysisContext 꼬리가 실제로 소비하는 형태 이상으로
    // 키우지 않는다.
    const frozen: FrozenAnalysisInput = {
      recipe: ctx.recipe,
      dataset: ctx.dataset,
      recipeDigest: ctx.recipeDigest,
      sourceDigest: ctx.snapshot.sourceDigest,
      snapshotAsOf: ctx.snapshot.snapshotAsOf,
    };

    const insertResult = await client.query<StatsRunRow>(
      `INSERT INTO stats_runs (
         organization_id, requested_by, status, recipe_digest, source_digest, execution_digest,
         requested_disclosure_profile, cacheable, manifest, frozen_dataset, engine_timeout_ms,
         expires_at, analysis_run_id
       ) VALUES ($1,$2,'queued',$3,$4,$5,'aggregate',true,$6,$7,$8,$9,$10)
       ON CONFLICT (organization_id, execution_digest) WHERE status IN ('queued','running')
       DO NOTHING
       RETURNING ${STATS_RUN_COLUMNS}`,
      [
        ctx.orgId, ctx.userId, ctx.recipeDigest, ctx.snapshot.sourceDigest, executionDigest,
        JSON.stringify(manifest), JSON.stringify(frozen), engineTimeoutMs, statsRunExpiresAt(), analysisRunId,
      ],
    );
    if (insertResult.rows.length > 0) {
      return { kind: 'admitted', row: insertResult.rows[0] };
    }

    // 이론상 advisory lock으로 도달 불가능하지만 방어적으로 재조회.
    const reselect = await client.query<StatsRunRow>(
      `SELECT ${STATS_RUN_COLUMNS} FROM stats_runs
        WHERE organization_id=$1 AND execution_digest=$2 AND status IN ('queued','running')
        LIMIT 1`,
      [ctx.orgId, executionDigest],
    );
    if (reselect.rows.length > 0) {
      const row = reselect.rows[0];
      await auditAdmission(client, ctx, executionDigest, 'success', { analysisRunId: row.analysis_run_id, joinedInFlight: true });
      return { kind: 'joined', row };
    }
    return 'retry';
  });
}
