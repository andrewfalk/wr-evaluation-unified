// src/core/api — 파이프라인 단위 테스트(REFACTORING_ROADMAP Phase 2 P2-16). 함수별 동작은 httpClient.test.js·T6이 덮는다.
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../apiClient';
import { ApiError, errorCodeOf, errorMessageOf } from '../errors';

const res = (status, json) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn(async () => { if (json === undefined) throw new Error('no json'); return json; }),
  blob: vi.fn(async () => new Blob(['b'])),
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

describe('ApiError — 예전 Error 객체와 같은 모양', () => {
  it('자기 속성은 message·status(+ 있을 때만 data·retryable), name은 Error, code는 게터', () => {
    const plain = new ApiError('m', 500);
    expect(Object.keys(plain).sort()).toEqual(['status']);
    expect('data' in plain).toBe(false);
    expect(plain.name).toBe('Error');
    expect(String(plain)).toBe('Error: m');
    const withData = new ApiError('m', 400, { data: { error: { code: 'X' } } });
    expect(Object.keys(withData).sort()).toEqual(['data', 'status']);
    expect(withData.code).toBe('X');
    const withNull = new ApiError('m', 400, { data: null });
    expect('data' in withNull).toBe(true);
    expect(withNull.code).toBeUndefined();
    expect(Object.keys(new ApiError('m', 401, { retryable: true })).sort()).toEqual(['retryable', 'status']);
    expect(withData).toBeInstanceOf(Error);
  });

  it('errorCodeOf·errorMessageOf', () => {
    expect(errorCodeOf({ code: 'A' })).toBe('A');
    expect(errorCodeOf({ error: { code: 'B' } })).toBe('B');
    expect(errorCodeOf({ code: 'A', error: { code: 'B' } })).toBe('A');
    expect(errorCodeOf(null)).toBeUndefined();
    // 빈 최상위 code는 중첩 code로 폴백(예전 `||`와 같음 — #296 Codex)
    expect(errorCodeOf({ code: '', error: { code: 'CSRF_INVALID' } })).toBe('CSRF_INVALID');
    expect(errorCodeOf({ code: 0, error: { code: 'B' } })).toBe('B');
    expect(errorMessageOf({ error: { message: 'x' } }, 'f')).toBe('x');
    expect(errorMessageOf({ error: 'y' }, 'f')).toBe('y');
    expect(errorMessageOf({ message: 'z' }, 'f')).toBe('f');
    expect(errorMessageOf({ message: 'z' }, 'f', { allowDataMessage: true })).toBe('z');
    expect(errorMessageOf({ error: '' }, 'f')).toBe('f');
  });
});

describe('createApiClient 파이프라인', () => {
  it('401 refresh는 한 번만 — 재시도 요청은 skipAuthRefresh로 다시 refresh하지 않는다', async () => {
    const { client, fetchImpl } = makeClient([res(401, {}), res(401, { error: 'still' })]);
    const onRefresh = vi.fn(async () => ({ mode: 'intranet', accessToken: 'new' }));
    client.configure({ onRefresh, onLogout: vi.fn() });
    await expect(client.request('/a', { session: { mode: 'intranet', accessToken: 'old' } })).rejects.toMatchObject({ status: 401, message: 'still' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  });

  it('403 본문 {code:"", error:{code:"CSRF_INVALID"}}도 CSRF 갱신 뒤 재시도한다', async () => {
    const { client, fetchImpl } = makeClient([res(403, { code: '', error: { code: 'CSRF_INVALID' } }), res(200, { ok: 1 })]);
    const onRefresh = vi.fn(async () => ({ mode: 'intranet' }));
    client.configure({ onRefresh });
    await expect(client.request('/a', { method: 'POST', session: { mode: 'intranet' } })).resolves.toEqual({ ok: 1 });
    expect(onRefresh).toHaveBeenCalledWith({ baseUrl: '', forceCsrf: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('처리기를 configure하기 전에는 refresh하지 않는다', async () => {
    const { client } = makeClient([res(401, { error: 'nope' })]);
    await expect(client.request('/a', { session: { mode: 'intranet' } })).rejects.toMatchObject({ status: 401, message: 'nope' });
  });

  it('AbortError는 감싸지 않고 그대로', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const fetchImpl = vi.fn().mockRejectedValueOnce(abort);
    const client = createApiClient({ fetchImpl, getCsrfToken: () => null, buildSessionHeaders: () => ({}) });
    await expect(client.request('/a')).rejects.toBe(abort);
  });

  it('CSRF 헤더는 변경 메서드에만, jsonRequest=false면 Content-Type·CSRF·본문 없음', async () => {
    const { client, fetchImpl } = makeClient([res(200, {}), res(200, {}), res(200)]);
    await client.request('/a', { method: 'GET' });
    await client.request('/a', { method: 'delete', body: { x: 1 } });
    await client.request('/a', { method: 'GET', jsonRequest: false, parse: 'blob' });
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/json' });
    expect(fetchImpl.mock.calls[1][1].headers['X-CSRF-Token']).toBe('csrf-1');
    expect(fetchImpl.mock.calls[1][1].body).toBe('{"x":1}');
    expect(fetchImpl.mock.calls[2][1]).toEqual({ method: 'GET', credentials: 'include', headers: {} });
  });

  it('envelope: HTTP 오류로 던지지 않고 {ok,status,data}, refresh 없음 / credentials null이면 키 없음 / jsonRequest=false여도 body는 보냄', async () => {
    const { client, fetchImpl } = makeClient([res(503, { error: 'down' }), res(200)]);
    const onRefresh = vi.fn();
    client.configure({ onRefresh });
    await expect(client.request('/a', { envelope: true, session: { mode: 'intranet' } })).resolves.toEqual({ ok: false, status: 503, data: { error: 'down' } });
    await expect(client.request('/b', { envelope: true, jsonRequest: false, credentials: null, method: 'POST', body: { q: 1 }, headers: { 'Content-Type': 'application/json' } }))
      .resolves.toEqual({ ok: true, status: 200, data: null });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(fetchImpl.mock.calls[1][1]).toEqual({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"q":1}' });
  });

  it('성공 본문이 JSON이 아니면 null', async () => {
    const { client } = makeClient([res(200)]);
    await expect(client.request('/a')).resolves.toBeNull();
  });
});
