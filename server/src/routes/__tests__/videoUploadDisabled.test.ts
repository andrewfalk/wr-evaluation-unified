import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// uploadDir 미설정 → 업로드 라우트 비활성(UPLOAD_DISABLED) 검증 전용. config를 uploadDir:null로 mock.
vi.mock('../../config', async () => ({
  default: (await import('../../testing/configMock.js')).testConfig({
    videoAnalysisEnabled: true,
    video: { fixtureMode: false, fixtureDir: '/tmp/fx', scriptsDir: '/tmp/s', python: '/tmp/p', uploadDir: null },
  }),
}));
vi.mock('../../workers/fixturePath', () => ({ resolveFixtureClip: vi.fn(() => null), resolveUploadedClipPath: vi.fn(() => null) }));
vi.mock('../../workers/sampleDetect', () => ({ runSampleDetect: vi.fn() }));
vi.mock('../../middleware/audit', () => ({ writeAuditLog: vi.fn(), auditMiddleware: vi.fn(() => (_q: unknown, _r: unknown, n: () => void) => n()) }));

import { createVideoAnalysisRouter } from '../videoAnalysis';
import { createFakePool, authSessionHandler } from '../../testing/fakePool';
import { makeRouterApp } from '../../testing/app';
import { makeAccessToken, authHeaders } from '../../testing/tokens';

const CLIP_ID = '22222222-2222-2222-2222-222222222222';

// sub/orgId는 testing/tokens 기본 UUID, CSRF 원문 'ok'(기본값) — 기존 로컬 도우미와 같은 클레임.
function token(): string {
  return makeAccessToken({ sessionId: 's1', name: 'Dr' });
}

describe('POST /clips/:id/upload — uploadDir 미설정', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('uploadDir 없음 → 503 UPLOAD_DISABLED', async () => {
    // 인증 미들웨어의 세션 확인만 거친 뒤 비활성 핸들러가 503을 낸다 — DB 쿼리는 그 하나뿐이어야 한다.
    const fake = createFakePool({ handlers: [authSessionHandler()] });
    const app = makeRouterApp(a => a.use('/api/video-analysis', createVideoAnalysisRouter(fake.pool)));
    const res = await request(app)
      .post(`/api/video-analysis/clips/${CLIP_ID}/upload`)
      .set(authHeaders(token()))
      .send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('UPLOAD_DISABLED');
    fake.assertNoUnmatched();
    expect(fake.callsTo('auth.session')).toHaveLength(1);
    expect(fake.connected).toBe(0);
  });
});
