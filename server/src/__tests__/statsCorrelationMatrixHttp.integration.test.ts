// PR3-B 상관행렬 HTTP 라우트 wiring — routes/__tests__/stats.test.ts의 두 테스트
// ("정상 경로 200 + cells 3개", "요청 단위 억제면 cells 전부 suppressed:true")가
// PR4-B1의 admission 도입으로 pool.query 순서 mock을 더 이상 재현할 수 없어 깨졌다
// (§statsDescriptiveHttp.integration.test.ts 상단 주석과 동일한 이유). statsBivariateHttp.
// integration.test.ts와 동일한 패턴(TEST_DATABASE_URL 없으면 전체 skip, 실제
// Postgres+실제 Python+실제 워커)으로 다시 증명한다.
//
//   TEST_DATABASE_URL=postgres://wr_user:<POSTGRES_PASSWORD>@localhost:5432/wr_evaluation \
//     npx vitest run --config vitest.config.ts src/__tests__/statsCorrelationMatrixHttp.integration.test.ts
import crypto from 'crypto';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { Pool } from 'pg';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

vi.mock('../statsWorkbenchRuntimeState', () => ({
  getStatsWorkbenchAvailability: () => ({ available: true, reason: null, checkedAt: null }),
  setStatsWorkbenchHealthy: () => {},
}));

import { createStatsRouter } from '../routes/stats';
import { createStatsRunsQueueWorker } from '../statsRunsQueue';
import { generateAccessToken } from '../auth/tokens';
import { hashToken, generateToken } from '../auth/tokenHash';

const TEST_DB_URL = process.env.TEST_DATABASE_URL;
const CSRF_TOKEN = 'itest-corrmatrix-csrf';

describe.skipIf(!TEST_DB_URL)('상관행렬(correlation_matrix) — 실데이터 HTTP 통합(POST /analyze)', () => {
  let pool: Pool;
  let orgId: string;
  let userId: string;
  let accessToken: string;
  let worker: { stop: () => void };

  beforeAll(async () => {
    pool = new Pool({ connectionString: TEST_DB_URL });
    worker = createStatsRunsQueueWorker(pool);
    const org = await pool.query<{ id: string }>(
      `INSERT INTO organizations (name) VALUES ($1) RETURNING id`,
      ['__test_corrMatrixHttp_org__'],
    );
    orgId = org.rows[0].id;
    const user = await pool.query<{ id: string }>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id)
       VALUES ($1,$2,$3,'doctor',$4) RETURNING id`,
      [`__test_corrMatrixHttp_user_${Date.now()}__`, 'x', 'Test Doctor', orgId],
    );
    userId = user.rows[0].id;
    const sessionId = crypto.randomUUID();
    const csrfHash = hashToken(CSRF_TOKEN);
    await pool.query(
      `INSERT INTO sessions (id, user_id, refresh_token_hash, csrf_token_hash, expires_at, family_id)
       VALUES ($1,$2,$3,$4, now() + interval '1 day', $5)`,
      [sessionId, userId, hashToken(generateToken()), csrfHash, crypto.randomUUID()],
    );
    accessToken = generateAccessToken({
      sub: userId, sessionId, orgId, role: 'doctor', name: 'Test Doctor',
      mustChangePassword: false, csrfHash,
    }).token;
  });

  afterAll(async () => {
    worker.stop();
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await pool.query(`DELETE FROM organizations WHERE id = $1`, [orgId]);
    await pool.end();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM stats_runs WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_records WHERE organization_id = $1`, [orgId]);
    await pool.query(`DELETE FROM patient_persons WHERE organization_id = $1`, [orgId]);
  });

  function app() {
    const a = express();
    a.use(express.json());
    a.use(cookieParser());
    a.use('/api/stats', createStatsRouter(pool));
    return a;
  }

  function authed(req: request.Test): request.Test {
    return req.set('Authorization', `Bearer ${accessToken}`).set('X-CSRF-Token', CSRF_TOKEN);
  }

  async function insertPatient(payload: unknown, personName: string): Promise<void> {
    const person = await pool.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, name) VALUES ($1,$2) RETURNING id`,
      [orgId, personName],
    );
    await pool.query(
      `INSERT INTO patient_records (organization_id, owner_user_id, patient_person_id, name, revision, payload)
       VALUES ($1,$2,$3,$4,1,$5)`,
      [orgId, userId, person.rows[0].id, personName, payload],
    );
  }

  const JOBS = [{ id: 'job-1', jobName: '조립공', startDate: '2010-01-01', endDate: '2020-01-01', workDaysPerYear: 250 }];
  const KNEE_BURDEN_BINS = {
    low: [500, 10] as const, lowMid: [500, 90] as const, highMid: [3500, 90] as const, high: [3500, 130] as const,
  };
  const KNEE_BIN_ORDER: Array<keyof typeof KNEE_BURDEN_BINS> = ['low', 'lowMid', 'highMid', 'high'];

  function payloadFor(i: number) {
    const [weight, squatting] = KNEE_BURDEN_BINS[KNEE_BIN_ORDER[i % KNEE_BIN_ORDER.length]];
    return {
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: JOBS, diagnoses: [] },
        modules: {
          knee: { jobs: [{ startDate: '2000-01-01', endDate: '2010-01-01', weight: String(weight), squatting: String(squatting) }], jobExtras: [] },
          spine: { mddmStatus: 'present', formulaVersion: 'v5.1.3', tasks: [{ sharedJobId: 'job-1', name: '중량물 취급', posture: 'G3', weight: 35 + i * 3, frequency: 80, timeValue: 5, timeUnit: 'sec', correctionFactor: 1.0 }] },
          cervical: { tasks: [{ id: `task-${i}`, sharedJobId: 'job-1', name: '박스 운반', exposure_types: ['shoulder_heavy_load'], load_weight_kg: String(10 + i * 4), carry_hours_per_shift: '2', forced_neck_posture: 'yes' }] },
        },
        activeModules: ['knee', 'spine', 'cervical'],
      },
    };
  }
  async function seedCohort(n: number): Promise<void> {
    for (let i = 0; i < n; i += 1) {
      await insertPatient(payloadFor(i), `corrmatrix-${i}-${crypto.randomUUID()}`);
    }
  }

  const VARIABLE_KEYS = ['knee.relatedness.max', 'cervical.case.maxJobCumulativeKgHours', 'spine.mddm.lifetimeDoseMNh'];
  const RECIPE_BASE = {
    grain: 'case' as const, filters: [], analysisPurpose: 'association' as const,
    formulaPolicies: { spine_mddm: 'recompute_current' }, analysisMode: 'correlation_matrix' as const,
    requestedMethod: 'pearson_correlation' as const, variableKeys: VARIABLE_KEYS,
  };

  it('정상 경로 — 200 + cells 3개(C(3,2)) + adjustedPWithheld:false', async () => {
    await seedCohort(12);
    const res = await authed(request(app()).post('/api/stats/analyze')).send(RECIPE_BASE);
    expect(res.status).toBe(200);
    const correlationMatrix = res.body.result.correlationMatrix;
    expect(correlationMatrix.cells).toHaveLength(3);
    expect(correlationMatrix.adjustedPWithheld).toBe(false);
    for (const cell of correlationMatrix.cells) {
      expect(cell.suppressed).toBe(false);
      expect(Number.isFinite(cell.r)).toBe(true);
    }
  }, 30000);

  it('요청 단위 억제(코호트 미달)면 cells 전부 suppressed:true + adjustedPWithheld:true(불변조건)', async () => {
    await seedCohort(5); // <10 — 전체 억제
    const res = await authed(request(app()).post('/api/stats/analyze')).send(RECIPE_BASE);
    expect(res.status).toBe(200);
    const correlationMatrix = res.body.result.correlationMatrix;
    expect(correlationMatrix.cells).toHaveLength(3);
    expect(correlationMatrix.cells.every((c: { suppressed: boolean }) => c.suppressed)).toBe(true);
    expect(correlationMatrix.adjustedPWithheld).toBe(true);
  }, 30000);
});
