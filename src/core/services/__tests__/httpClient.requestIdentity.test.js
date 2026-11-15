// 요청 신원 고정(계정 전환 수정 — main의 apiClient.requestIdentity.test.js를 이 브랜치의 httpClient.js에 맞게 옮김).
// 인증 갱신이 다른 계정의 세션을 돌려주거나, 요청을 보낸 계정이 이미 현재 계정이 아니면 같은 본문을 다시 보내지 않는다.
// 신원 = 인트라넷 세션의 `user.id|organizationId`. 재시도 자리 다섯 곳(requestJson 401·403, requestBlob 401, requestBlobPost 401·403).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHttpClient, requestBlob, requestBlobPost, requestJson } from '../httpClient';
import { intranetIdentityOf } from '../../../platform/dataMode';

const res = (status, json) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn(async () => json),
  blob: vi.fn(async () => new Blob(['b'])),
});

const sessionOf = (userId, organizationId = 'org-1', accessToken = `tok-${userId}`) => ({
  mode: 'intranet', accessToken, user: { id: userId, organizationId },
});

beforeEach(() => {
  globalThis.document = { cookie: 'wr_csrf=csrf-1' };
  globalThis.fetch = vi.fn();
});
afterEach(() => { configureHttpClient({ onRefresh: null, onLogout: null, getCurrentSession: null }); });

function queue(...responses) { for (const r of responses) globalThis.fetch.mockResolvedValueOnce(r); }

describe('intranetIdentityOf', () => {
  it('인트라넷 세션이면 user.id|organizationId, 아니면 null', () => {
    expect(intranetIdentityOf(sessionOf('a', 'o1'))).toBe('a|o1');
    expect(intranetIdentityOf({ mode: 'intranet' })).toBeNull();
    expect(intranetIdentityOf({ mode: 'local', user: { id: 'a' } })).toBeNull();
    expect(intranetIdentityOf(null)).toBeNull();
  });
});

describe('R1 — 인증 갱신이 다른 계정의 세션을 돌려주면 다시 보내지 않는다', () => {
  it.each([
    ['requestJson 401', () => requestJson('/api/patients/p1', { method: 'PATCH', body: {}, session: sessionOf('a') }), res(401, {})],
    ['requestJson 403 CSRF', () => requestJson('/api/patients/p1', { method: 'PATCH', body: {}, session: sessionOf('a') }), res(403, { code: 'CSRF_INVALID' })],
    ['requestBlob 401', () => requestBlob('/api/x', { session: sessionOf('a') }), res(401, {})],
    ['requestBlobPost 401', () => requestBlobPost('/api/x', { body: {}, session: sessionOf('a') }), res(401, {})],
    ['requestBlobPost 403 CSRF', () => requestBlobPost('/api/x', { body: {}, session: sessionOf('a') }), res(403, { code: 'CSRF_INVALID' })],
  ])('%s → 갱신 결과가 다른 user.id면 재시도 0회, 401, 로그아웃 처리기 미호출', async (_name, call, first) => {
    queue(first, res(200, { ok: 1 }));
    const onLogout = vi.fn();
    configureHttpClient({ onRefresh: vi.fn(async () => sessionOf('b')), onLogout });
    await expect(call()).rejects.toMatchObject({ status: 401 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('같은 계정이면 지금처럼 새 토큰으로 다시 보낸다', async () => {
    queue(res(401, {}), res(200, { ok: 1 }));
    configureHttpClient({ onRefresh: vi.fn(async () => sessionOf('a', 'org-1', 'tok-new')), onLogout: vi.fn() });
    await expect(requestJson('/x', { session: sessionOf('a') })).resolves.toEqual({ ok: 1 });
    expect(globalThis.fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-new');
  });
});

describe('R2 — 요청을 보낸 계정이 현재 계정이 아니면 갱신·로그아웃을 하지 않는다', () => {
  it.each([
    ['401', res(401, {}), 'POST'],
    ['403 CSRF', res(403, { code: 'CSRF_INVALID' }), 'PATCH'],
  ])('%s → refresh·logout 미호출, 401', async (_name, first, method) => {
    queue(first, res(200, { ok: 1 }));
    const onRefresh = vi.fn(async () => sessionOf('b'));
    const onLogout = vi.fn();
    configureHttpClient({ onRefresh, onLogout, getCurrentSession: () => sessionOf('b') });
    await expect(requestJson('/api/patients', { method, body: {}, session: sessionOf('a') })).rejects.toMatchObject({ status: 401 });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('갱신을 기다리는 사이 현재 계정이 바뀐 뒤 갱신이 실패해도 로그아웃 처리기를 부르지 않는다', async () => {
    queue(res(401, {}));
    let current = sessionOf('a');
    let rejectRefresh;
    const onRefresh = vi.fn(() => new Promise((_, reject) => { rejectRefresh = reject; }));
    const onLogout = vi.fn();
    configureHttpClient({ onRefresh, onLogout, getCurrentSession: () => current });
    const pending = requestJson('/api/patients', { method: 'POST', body: {}, session: sessionOf('a') });
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    current = sessionOf('b');
    rejectRefresh(new Error('Refresh failed'));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('갱신을 기다리는 사이 현재 계정이 바뀌면, 갱신이 이전 계정으로 성공해도 다시 보내지 않는다', async () => {
    queue(res(401, {}), res(200, { ok: 1 }));
    let current = sessionOf('a');
    let resolveRefresh;
    const onRefresh = vi.fn(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    configureHttpClient({ onRefresh, onLogout: vi.fn(), getCurrentSession: () => current });
    const pending = requestJson('/api/patients', { method: 'POST', body: {}, session: sessionOf('a') });
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    current = sessionOf('b');
    resolveRefresh(sessionOf('a', 'org-1', 'tok-a2'));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('신원 없는 요청(모드 없는 세션)·같은 계정의 갱신 실패는 예전처럼', async () => {
    queue(res(401, {}), res(200, { ok: 1 }));
    configureHttpClient({ onRefresh: vi.fn(async () => ({ accessToken: 'new' })), onLogout: vi.fn(), getCurrentSession: () => sessionOf('b') });
    await expect(requestJson('/x', { session: { accessToken: 'old' } })).resolves.toEqual({ ok: 1 });
    queue(res(401, {}));
    const onLogout = vi.fn();
    configureHttpClient({ onRefresh: vi.fn(async () => { throw new Error('Refresh failed'); }), onLogout, getCurrentSession: () => sessionOf('a') });
    await expect(requestJson('/x', { session: sessionOf('a') })).rejects.toMatchObject({ status: 401 });
    expect(onLogout).toHaveBeenCalledTimes(1);
  });
});
