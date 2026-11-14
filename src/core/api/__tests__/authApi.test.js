// src/core/api/authApi — 예전 raw fetch 3곳(AuthContext 부팅 확인·useAuthSync CSRF 갱신·refresh)과 요청 모양이 같은지
// (REFACTORING_ROADMAP Phase 2 P2-17). 인터셉터(401 refresh)를 타지 않는 것도 함께 본다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureApiClient, requestEnvelope } from '../client';
import { refreshAccessToken, renewCsrf, verifyStoredSession } from '../authApi';

const res = (status, json) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn(async () => { if (json === undefined) throw new Error('no json'); return json; }),
});

let onRefresh;
beforeEach(() => {
  globalThis.fetch = vi.fn();
  globalThis.document = { cookie: 'wr_csrf=from-cookie' };
  onRefresh = vi.fn();
  configureApiClient({ onRefresh, onLogout: vi.fn() });
});

describe('verifyStoredSession — AuthContext 부팅 확인', () => {
  it('POST /api/auth/csrf, credentials include, 헤더·본문 없음(쿠키의 CSRF도 싣지 않음)', async () => {
    fetch.mockResolvedValueOnce(res(200, { accessToken: 't' }));
    await expect(verifyStoredSession('https://srv')).resolves.toEqual({ ok: true, status: 200, data: { accessToken: 't' } });
    expect(fetch).toHaveBeenCalledWith('https://srv/api/auth/csrf', { method: 'POST', credentials: 'include', headers: {} });
  });

  it('401이어도 던지지 않고 refresh도 하지 않는다(호출부가 로컬로 되돌림), 비JSON 성공 본문은 data null', async () => {
    fetch.mockResolvedValueOnce(res(401, { error: 'x' }));
    await expect(verifyStoredSession('')).resolves.toMatchObject({ ok: false, status: 401 });
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/csrf');
    fetch.mockResolvedValueOnce(res(200));
    await expect(verifyStoredSession('')).resolves.toEqual({ ok: true, status: 200, data: null });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('네트워크 오류는 그대로 던진다', async () => {
    fetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(verifyStoredSession('')).rejects.toThrow('Failed to fetch');
  });
});

describe('renewCsrf·refreshAccessToken — useAuthSync refresh', () => {
  it('CSRF 갱신: POST + Content-Type만(X-CSRF-Token 없음), 실패하면 "CSRF renewal failed"', async () => {
    fetch.mockResolvedValueOnce(res(200, { accessToken: 'n' }));
    await expect(renewCsrf('https://srv')).resolves.toEqual({ accessToken: 'n' });
    expect(fetch).toHaveBeenCalledWith('https://srv/api/auth/csrf', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    });
    fetch.mockResolvedValueOnce(res(401, {}));
    await expect(renewCsrf('')).rejects.toThrow('CSRF renewal failed');
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('refresh: POST + Content-Type + 넘긴 X-CSRF-Token, 실패하면 "Refresh failed", 401에도 인터셉터를 타지 않는다', async () => {
    fetch.mockResolvedValueOnce(res(200, { accessToken: 'r' }));
    await expect(refreshAccessToken('https://srv', 'csrf-x')).resolves.toEqual({ accessToken: 'r' });
    expect(fetch).toHaveBeenCalledWith('https://srv/api/auth/refresh', {
      method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf-x' },
    });
    fetch.mockResolvedValueOnce(res(401, {}));
    await expect(refreshAccessToken('', 'c')).rejects.toThrow('Refresh failed');
    expect(onRefresh).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('성공인데 본문이 JSON이 아니면 실패(예전 response.json()이 던지던 자리)', async () => {
    fetch.mockResolvedValueOnce(res(200));
    await expect(renewCsrf('')).rejects.toThrow();
    fetch.mockResolvedValueOnce(res(200));
    await expect(refreshAccessToken('', 'c')).rejects.toThrow();
  });
});

describe('requestEnvelope — 정적 파일·외부 엔드포인트', () => {
  it('credentials null이면 키를 넣지 않는다(브라우저 기본)', async () => {
    fetch.mockResolvedValueOnce(res(200, { presets: [] }));
    await requestEnvelope('./job-presets.json', { credentials: null });
    expect(fetch).toHaveBeenCalledWith('./job-presets.json', { method: 'GET', headers: {} });
  });
});
