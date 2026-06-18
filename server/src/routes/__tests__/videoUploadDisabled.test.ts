import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

// uploadDir 미설정 → 업로드 라우트 비활성(UPLOAD_DISABLED) 검증 전용. config를 uploadDir:null로 mock.
vi.mock('../../config', () => ({
  default: {
    env: 'test',
    cors: { origins: [] },
    auth: { accessTokenTtl: 900, accessTokenSecret: 'test-access-secret', refreshTokenSecret: 'test-refresh-secret' },
    videoAnalysisEnabled: true,
    video: { fixtureMode: false, fixtureDir: '/tmp/fx', scriptsDir: '/tmp/s', python: '/tmp/p', uploadDir: null },
  },
}));
vi.mock('../../workers/fixturePath', () => ({ resolveFixtureClip: vi.fn(() => null), resolveUploadedClipPath: vi.fn(() => null) }));
vi.mock('../../workers/sampleDetect', () => ({ runSampleDetect: vi.fn() }));
vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn(), auditMiddleware: vi.fn(() => (_q: unknown, _r: unknown, n: () => void) => n()) }));

import { createVideoAnalysisRouter } from '../videoAnalysis';
import { generateAccessToken } from '../../auth/tokens';
import type { Pool } from 'pg';

const CSRF_TOKEN = 'ok';
const CSRF_HASH = crypto.createHash('sha256').update(CSRF_TOKEN).digest('hex');
const CLIP_ID = '22222222-2222-2222-2222-222222222222';

function token(): string {
  return generateAccessToken({
    sub: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', sessionId: 's1',
    orgId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', role: 'doctor',
    name: 'Dr', mustChangePassword: false, csrfHash: CSRF_HASH,
  }).token;
}

describe('POST /clips/:id/upload — uploadDir 미설정', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uploadDir 없음 → 503 UPLOAD_DISABLED', async () => {
    const pool = { connect: vi.fn(), query: vi.fn().mockResolvedValue({ rows: [{ exists: 1 }] }) } as unknown as Pool;
    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use('/api/video-analysis', createVideoAnalysisRouter(pool));
    const res = await request(app)
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set('Authorization', `Bearer ${token()}`).set('x-csrf-token', CSRF_TOKEN)
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('UPLOAD_DISABLED');
  });
});
