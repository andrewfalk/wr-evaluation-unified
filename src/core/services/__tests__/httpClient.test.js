import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHttpClient, requestBlob, requestJson } from '../httpClient.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn(async () => body),
  };
}

describe('requestJson CSRF recovery', () => {
  beforeEach(() => {
    globalThis.document = { cookie: 'wr_csrf=old-csrf' };
    globalThis.fetch = vi.fn();
    configureHttpClient({ onRefresh: null, onLogout: null });
  });

  it('reissues CSRF once and retries mutating requests after CSRF_INVALID', async () => {
    const oldSession = { accessToken: 'old-token' };
    const newSession = { accessToken: 'new-token' };
    const onRefresh = vi.fn(async () => {
      globalThis.document.cookie = 'wr_csrf=new-csrf';
      return newSession;
    });

    configureHttpClient({ onRefresh, onLogout: vi.fn() });
    globalThis.fetch
      .mockResolvedValueOnce(jsonResponse(403, {
        code: 'CSRF_INVALID',
        error: 'Invalid or missing CSRF token',
      }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    const result = await requestJson('/api/patients', {
      method: 'PATCH',
      body: { name: 'Kim' },
      session: oldSession,
    });

    expect(result).toEqual({ ok: true });
    expect(onRefresh).toHaveBeenCalledWith({ baseUrl: '', forceCsrf: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);

    const firstHeaders = globalThis.fetch.mock.calls[0][1].headers;
    expect(firstHeaders.Authorization).toBe('Bearer old-token');
    expect(firstHeaders['X-CSRF-Token']).toBe('old-csrf');

    const retryHeaders = globalThis.fetch.mock.calls[1][1].headers;
    expect(retryHeaders.Authorization).toBe('Bearer new-token');
    expect(retryHeaders['X-CSRF-Token']).toBe('new-csrf');
  });
});

describe('local-session auth failures', () => {
  beforeEach(() => {
    globalThis.document = { cookie: '' };
    globalThis.fetch = vi.fn();
    configureHttpClient({ onRefresh: null, onLogout: null });
  });

  it('returns a JSON 401 without attempting refresh or logout', async () => {
    const onRefresh = vi.fn();
    const onLogout = vi.fn();
    configureHttpClient({ onRefresh, onLogout });
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(401, {
      code: 'UNAUTHORIZED',
      error: 'Authentication required',
    }));

    await expect(requestJson('/api/auth/me', {
      session: { mode: 'local' },
    })).rejects.toMatchObject({ status: 401 });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('returns a Blob 401 without attempting refresh or logout', async () => {
    const onRefresh = vi.fn();
    const onLogout = vi.fn();
    configureHttpClient({ onRefresh, onLogout });
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(401, {
      code: 'UNAUTHORIZED',
      error: 'Authentication required',
    }));

    await expect(requestBlob('/api/patients/p1/image', {
      session: { mode: 'local' },
    })).rejects.toMatchObject({ status: 401 });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });

  it('does not renew CSRF for a local-session CSRF_INVALID response', async () => {
    const onRefresh = vi.fn();
    const onLogout = vi.fn();
    configureHttpClient({ onRefresh, onLogout });
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(403, {
      code: 'CSRF_INVALID',
      error: 'Invalid or missing CSRF token',
    }));

    await expect(requestJson('/api/patients', {
      method: 'PATCH',
      body: { name: 'Kim' },
      session: { mode: 'local' },
    })).rejects.toMatchObject({ status: 403 });

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
  });
});
