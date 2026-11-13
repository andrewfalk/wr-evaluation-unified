// 공용 테스트 하네스(src/testing)로 실제 라우터를 끝까지 통과시키는 사용 예 — 새 라우트 테스트의 견본.
// 호출 순서 큐(mockResolvedValueOnce) 대신 SQL로 응답을 고르고, 미매치 쿼리·client 누수를 검사한다.
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

vi.mock('../../config', async () => ({
  default: (await import('../configMock.js')).testConfig(),
}));

import { createPresetsRouter } from '../../routes/presets';
import { createFakePool, authSessionHandler, type QueryHandler } from '../fakePool';
import { makeRouterApp } from '../app';
import { makeAccessToken, authHeaders, TEST_USER_ID, TEST_ORG_ID, TEST_CSRF_TOKEN } from '../tokens';

const NOW = new Date('2025-01-01T00:00:00.000Z');

function presetRow(overrides: Record<string, unknown> = {}) {
  return {
    id:              'cccccccc-cccc-cccc-cccc-cccccccccccc',
    organization_id: TEST_ORG_ID,
    owner_user_id:   TEST_USER_ID,
    job_name:        '건설 근로자',
    category:        '건설업',
    description:     '',
    visibility:      'private',
    revision:        1,
    modules:         { knee: { weight: 20 } },
    created_at:      NOW,
    updated_at:      NOW,
    ...overrides,
  };
}

function setup(handlers: QueryHandler[]) {
  const fake = createFakePool({ handlers: [authSessionHandler(), ...handlers] });
  const app = makeRouterApp(a => a.use('/api/presets', createPresetsRouter(fake.pool)));
  return { fake, app };
}

describe('harness usage — presets router', () => {
  it('GET /api/presets lists presets for the signed-in user', async () => {
    const { fake, app } = setup([
      { name: 'presets.list', match: /FROM custom_presets cp/, reply: { rows: [presetRow()] } },
    ]);

    const res = await request(app).get('/api/presets').set(authHeaders(makeAccessToken()));

    expect(res.status).toBe(200);
    expect(res.body.presets).toHaveLength(1);
    expect(res.body.presets[0].jobName).toBe('건설 근로자');
    expect(fake.callsTo('presets.list')[0]!.params).toEqual([TEST_ORG_ID, TEST_USER_ID]);
    fake.assertNoUnmatched();
    fake.assertAllReleased();
  });

  it('a revoked session is rejected by the auth middleware before any route query', async () => {
    const fake = createFakePool({ handlers: [authSessionHandler({ revoked: true })] });
    const app = makeRouterApp(a => a.use('/api/presets', createPresetsRouter(fake.pool)));

    const res = await request(app).get('/api/presets').set(authHeaders(makeAccessToken()));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('SESSION_REVOKED');
    expect(fake.calls.map(c => c.handler)).toEqual(['auth.session']);
  });

  it('POST /api/presets creates a preset (CSRF from authHeaders) and writes an audit row', async () => {
    const { fake, app } = setup([
      { name: 'presets.findExisting', match: /SELECT \* FROM custom_presets\s+WHERE deleted_at IS NULL/, reply: { rows: [] } },
      { name: 'presets.insert', match: /INSERT INTO custom_presets/, reply: (_sql, params) => ({ rows: [presetRow({ id: params[0] })] }) },
      { name: 'audit.insert', match: /INSERT INTO public[.]audit_logs/, reply: { rows: [] } },
    ]);

    const res = await request(app)
      .post('/api/presets')
      .set(authHeaders(makeAccessToken()))
      .send({ jobName: '건설 근로자', category: '건설업', description: '', modules: { knee: { weight: 20 } } });

    expect(res.status).toBe(201);
    expect(fake.callsTo('presets.insert')).toHaveLength(1);
    expect(fake.callsTo('audit.insert')[0]!.params[2]).toBe('preset.create');
    fake.assertNoUnmatched();
  });

  it('a mutating request without the matching CSRF token is refused', async () => {
    const { fake, app } = setup([]);

    const res = await request(app)
      .post('/api/presets')
      .set(authHeaders(makeAccessToken({ csrfToken: TEST_CSRF_TOKEN }), 'wrong-token'))
      .send({ jobName: 'x', category: 'y', description: '', modules: {} });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
    fake.assertNoUnmatched();
  });

  it('an unprepared query surfaces as an unmatched query instead of a silent empty result', async () => {
    const { fake, app } = setup([]);

    const res = await request(app).get('/api/presets').set(authHeaders(makeAccessToken()));

    expect(res.status).toBe(500);
    expect(() => fake.assertNoUnmatched()).toThrow(/FROM custom_presets cp/);
  });
});
