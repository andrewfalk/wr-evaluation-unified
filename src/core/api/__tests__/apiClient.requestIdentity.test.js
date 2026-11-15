// 요청 신원 고정(계정 전환 수정 AS-1) — 인증 갱신이 다른 계정의 세션을 돌려주거나, 요청을 보낸 계정이 이미
// 현재 계정이 아니면 같은 본문을 다시 보내지 않는다. 신원 = 인트라넷 세션의 `user.id|organizationId`.
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../apiClient';
import { intranetIdentityOf, sessionIdentityOf } from '../../../platform/dataMode';

const res = (status, json) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn(async () => json),
  blob: vi.fn(async () => new Blob(['b'])),
});

const sessionOf = (userId, organizationId = 'org-1', accessToken = `tok-${userId}`) => ({
  mode: 'intranet', accessToken, user: { id: userId, organizationId },
});

function makeClient(responses) {
  const fetchImpl = vi.fn();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  const client = createApiClient({
    fetchImpl,
    getCsrfToken: () => 'csrf-1',
    buildSessionHeaders: (s) => (s?.accessToken ? { Authorization: `Bearer ${s.accessToken}` } : {}),
  });
  return { client, fetchImpl };
}

describe('intranetIdentityOf', () => {
  it('인트라넷 세션이면 user.id|organizationId, 아니면 null', () => {
    expect(intranetIdentityOf(sessionOf('a', 'o1'))).toBe('a|o1');
    expect(intranetIdentityOf({ mode: 'intranet', user: { id: 'a' } })).toBe('a|');
    expect(intranetIdentityOf({ mode: 'intranet' })).toBeNull();
    expect(intranetIdentityOf({ mode: 'local', user: { id: 'a', organizationId: 'o1' } })).toBeNull();
    expect(intranetIdentityOf({ accessToken: 't' })).toBeNull();
    expect(intranetIdentityOf(null)).toBeNull();
    expect(intranetIdentityOf(undefined)).toBeNull();
  });

  it('역할·이름·토큰이 달라도 같은 신원', () => {
    const a1 = { mode: 'intranet', accessToken: 't1', user: { id: 'a', organizationId: 'o', role: 'doctor', name: 'x' } };
    const a2 = { mode: 'intranet', accessToken: 't2', user: { id: 'a', organizationId: 'o', role: 'admin', name: 'y' } };
    expect(intranetIdentityOf(a1)).toBe(intranetIdentityOf(a2));
  });
});

describe('R1 — 인증 갱신이 다른 계정의 세션을 돌려주면 다시 보내지 않는다', () => {
  it('401 → 갱신 결과가 다른 user.id면 재시도 0회, 401로 실패, 로그아웃 처리기는 부르지 않는다', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(200, { ok: 1 })]);
    const onRefresh = vi.fn(async () => sessionOf('b'));
    const onLogout = vi.fn();
    client.configure({ onRefresh, onLogout });
    await expect(client.request('/api/patients/p1', {
      method: 'PATCH', body: { name: '환자' }, session: sessionOf('a'),
    })).rejects.toMatchObject({ status: 401 });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('401 → 갱신 결과가 다른 조직이면 재시도 0회', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(200, { ok: 1 })]);
    client.configure({ onRefresh: vi.fn(async () => sessionOf('a', 'org-2')), onLogout: vi.fn() });
    await expect(client.request('/api/patients', { method: 'POST', body: {}, session: sessionOf('a', 'org-1') }))
      .rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('403 CSRF_INVALID → 갱신 결과가 다른 user.id면 재시도 0회', async () => {
    const { client, fetchImpl } = makeClient([res(403, { code: 'CSRF_INVALID' }), res(200, { ok: 1 })]);
    const onRefresh = vi.fn(async () => sessionOf('b'));
    client.configure({ onRefresh, onLogout: vi.fn() });
    await expect(client.request('/api/patients/p1', {
      method: 'PATCH', body: { name: '환자' }, session: sessionOf('a'),
    })).rejects.toMatchObject({ status: 401 });
    expect(onRefresh).toHaveBeenCalledWith({ baseUrl: '', forceCsrf: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('같은 신원이면 지금처럼 새 토큰으로 다시 보낸다(401·403 CSRF)', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(200, { ok: 1 }), res(403, { code: 'CSRF_INVALID' }), res(200, { ok: 2 })]);
    client.configure({ onRefresh: vi.fn(async () => sessionOf('a', 'org-1', 'tok-new')), onLogout: vi.fn() });
    await expect(client.request('/x', { session: sessionOf('a') })).resolves.toEqual({ ok: 1 });
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer tok-new');
    await expect(client.request('/y', { method: 'POST', session: sessionOf('a') })).resolves.toEqual({ ok: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
});

describe('R2 — 요청을 보낸 계정이 현재 계정이 아니면 갱신·로그아웃을 하지 않는다', () => {
  it('401 → 요청 신원 ≠ 현재 세션 신원: refresh·logout 미호출, 401로 실패', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(200, { ok: 1 })]);
    const onRefresh = vi.fn(async () => sessionOf('b'));
    const onLogout = vi.fn();
    client.configure({ onRefresh, onLogout, getCurrentSession: () => sessionOf('b') });
    await expect(client.request('/api/patients', { method: 'POST', body: { name: '환자' }, session: sessionOf('a') }))
      .rejects.toMatchObject({ status: 401 });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('403 CSRF_INVALID → 요청 신원 ≠ 현재 세션 신원: refresh 미호출', async () => {
    const { client, fetchImpl } = makeClient([res(403, { code: 'CSRF_INVALID' }), res(200, { ok: 1 })]);
    const onRefresh = vi.fn(async () => sessionOf('b'));
    client.configure({ onRefresh, onLogout: vi.fn(), getCurrentSession: () => sessionOf('b') });
    await expect(client.request('/api/patients/p1', { method: 'PATCH', body: {}, session: sessionOf('a') }))
      .rejects.toMatchObject({ status: 401 });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('현재 세션이 로컬로 돌아갔어도(로그아웃 뒤) 이전 계정 요청은 refresh·logout 미호출', async () => {
    const { client } = makeClient([res(401, {})]);
    const onRefresh = vi.fn(async () => sessionOf('a'));
    const onLogout = vi.fn();
    client.configure({ onRefresh, onLogout, getCurrentSession: () => ({ mode: 'local', user: { id: 'web-user' } }) });
    await expect(client.request('/api/patients', { session: sessionOf('a') })).rejects.toMatchObject({ status: 401 });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('갱신을 기다리는 사이 현재 계정이 바뀐 뒤 갱신이 실패해도 로그아웃 처리기를 부르지 않는다', async () => {
    const { client } = makeClient([res(401, {})]);
    let current = sessionOf('a');
    let rejectRefresh;
    const onRefresh = vi.fn(() => new Promise((_, reject) => { rejectRefresh = reject; }));
    const onLogout = vi.fn();
    client.configure({ onRefresh, onLogout, getCurrentSession: () => current });
    const pending = client.request('/api/patients', { method: 'POST', body: {}, session: sessionOf('a') });
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    current = sessionOf('b');
    rejectRefresh(new Error('Refresh failed'));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(onLogout).not.toHaveBeenCalled();
  });

  it.each([
    ['401', res(401, {}), 'POST'],
    ['403 CSRF_INVALID', res(403, { code: 'CSRF_INVALID' }), 'PATCH'],
  ])('%s: 갱신을 기다리는 사이 현재 계정이 바뀌면, 갱신이 이전 계정으로 성공해도 다시 보내지 않는다', async (_name, first, method) => {
    const { client, fetchImpl } = makeClient([first, res(200, { ok: 1 })]);
    let current = sessionOf('a');
    let resolveRefresh;
    const onRefresh = vi.fn(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    client.configure({ onRefresh, onLogout: vi.fn(), getCurrentSession: () => current });
    const pending = client.request('/api/patients', { method, body: {}, session: sessionOf('a') });
    await vi.waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    current = sessionOf('b');
    resolveRefresh(sessionOf('a', 'org-1', 'tok-a2'));
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('같은 계정 요청의 갱신이 실패하면 지금처럼 로그아웃 처리기를 부른다', async () => {
    const { client } = makeClient([res(401, {})]);
    const onLogout = vi.fn();
    client.configure({ onRefresh: vi.fn(async () => { throw new Error('Refresh failed'); }), onLogout, getCurrentSession: () => sessionOf('a') });
    await expect(client.request('/x', { session: sessionOf('a') })).rejects.toMatchObject({ status: 401 });
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('요청 신원 = 현재 세션 신원이면 지금처럼 갱신·재시도', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(200, { ok: 1 })]);
    const onRefresh = vi.fn(async () => sessionOf('a', 'org-1', 'tok-new'));
    client.configure({ onRefresh, onLogout: vi.fn(), getCurrentSession: () => sessionOf('a') });
    await expect(client.request('/x', { session: sessionOf('a') })).resolves.toEqual({ ok: 1 });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('신원 없는 요청(모드 없는 세션)은 비교하지 않는다 — 예전 흐름', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(200, { ok: 1 })]);
    const onRefresh = vi.fn(async () => ({ accessToken: 'new' }));
    client.configure({ onRefresh, onLogout: vi.fn(), getCurrentSession: () => sessionOf('b') });
    await expect(client.request('/x', { session: { accessToken: 'old' } })).resolves.toEqual({ ok: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('요청 신원에는 서버 주소도 포함된다', () => {
  const onServer = (base, userId) => ({ ...sessionOf(userId), apiBaseUrl: base });

  it('sessionIdentityOf: 정규화한 서버 주소 + 사용자·조직, 인트라넷 세션이 아니면 null', () => {
    expect(sessionIdentityOf(onServer('https://s1/', 'a'))).toBe(sessionIdentityOf(onServer('https://s1', 'a')));
    expect(sessionIdentityOf(onServer('https://s1', 'a'))).not.toBe(sessionIdentityOf(onServer('https://s2', 'a')));
    expect(sessionIdentityOf({ mode: 'local', apiBaseUrl: 'https://s1', user: { id: 'a' } })).toBeNull();
    expect(sessionIdentityOf(null)).toBeNull();
  });

  it('같은 사용자·조직 ID라도 다른 서버의 현재 세션이면 이전 서버 요청은 갱신·로그아웃하지 않는다', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(200, { ok: 1 })]);
    const onRefresh = vi.fn(async () => onServer('https://s2', 'a'));
    const onLogout = vi.fn();
    client.configure({ onRefresh, onLogout, getCurrentSession: () => onServer('https://s2', 'a') });
    await expect(client.request('/api/patients', { method: 'POST', body: {}, session: onServer('https://s1', 'a') }))
      .rejects.toMatchObject({ status: 401 });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('갱신 결과가 다른 서버의 세션이면 다시 보내지 않는다', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(200, { ok: 1 })]);
    client.configure({ onRefresh: vi.fn(async () => onServer('https://s2', 'a')), onLogout: vi.fn() });
    await expect(client.request('/x', { session: onServer('https://s1', 'a') })).rejects.toMatchObject({ status: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('주소 표기만 다른(끝의 "/") 같은 서버는 같은 신원', async () => {
    const { client } = makeClient([res(401, {}), res(200, { ok: 1 })]);
    client.configure({
      onRefresh: vi.fn(async () => onServer('https://s1/', 'a')), onLogout: vi.fn(),
      getCurrentSession: () => onServer('https://s1', 'a'),
    });
    await expect(client.request('/x', { session: onServer('https://s1', 'a') })).resolves.toEqual({ ok: 1 });
  });
});
