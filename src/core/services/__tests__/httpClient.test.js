import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHttpClient, requestBlob, requestBlobPost, requestJson } from '../httpClient.js';

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn(async () => body),
  };
}

function blobSuccessResponse(blob) {
  return {
    status: 200,
    ok: true,
    json: vi.fn(async () => { throw new Error('should not parse json on success'); }),
    blob: vi.fn(async () => blob),
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

describe('requestBlobPost (PR2 §9 — CSV 등 POST 바디+CSRF가 필요한 다운로드)', () => {
  beforeEach(() => {
    globalThis.document = { cookie: 'wr_csrf=old-csrf' };
    globalThis.fetch = vi.fn();
    configureHttpClient({ onRefresh: null, onLogout: null });
  });

  it('성공 시 response.json()을 호출하지 않고 blob을 그대로 반환한다', async () => {
    const fakeBlob = { size: 3, type: 'text/csv' };
    globalThis.fetch.mockResolvedValueOnce(blobSuccessResponse(fakeBlob));
    const result = await requestBlobPost('/api/stats/export', {
      body: { analysisRunId: 'r1' },
      session: { accessToken: 'tok' },
    });
    expect(result).toBe(fakeBlob);
    const headers = globalThis.fetch.mock.calls[0][1].headers;
    expect(headers['X-CSRF-Token']).toBe('old-csrf'); // POST는 mutating이라 CSRF가 실려야 함
  });

  it('CSRF_INVALID면 토큰을 재발급하고 같은 POST를 재시도한다', async () => {
    const newSession = { accessToken: 'new-token' };
    const onRefresh = vi.fn(async () => {
      globalThis.document.cookie = 'wr_csrf=new-csrf';
      return newSession;
    });
    configureHttpClient({ onRefresh, onLogout: vi.fn() });
    const fakeBlob = { size: 1 };
    globalThis.fetch
      .mockResolvedValueOnce(jsonResponse(403, { code: 'CSRF_INVALID', error: 'bad csrf' }))
      .mockResolvedValueOnce(blobSuccessResponse(fakeBlob));

    const result = await requestBlobPost('/api/stats/export', {
      body: { analysisRunId: 'r1' },
      session: { accessToken: 'old-token' },
    });
    expect(result).toBe(fakeBlob);
    expect(onRefresh).toHaveBeenCalledWith({ baseUrl: '', forceCsrf: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('401이면 세션을 갱신하고 재시도한다', async () => {
    const newSession = { accessToken: 'new-token' };
    const onRefresh = vi.fn(async () => newSession);
    configureHttpClient({ onRefresh, onLogout: vi.fn() });
    const fakeBlob = { size: 1 };
    globalThis.fetch
      .mockResolvedValueOnce(jsonResponse(401, { code: 'UNAUTHORIZED', error: 'expired' }))
      .mockResolvedValueOnce(blobSuccessResponse(fakeBlob));

    const result = await requestBlobPost('/api/stats/export', {
      body: { analysisRunId: 'r1' },
      session: { accessToken: 'old-token' },
    });
    expect(result).toBe(fakeBlob);
    expect(onRefresh).toHaveBeenCalledWith({ baseUrl: '' });
  });

  it('에러 응답은 JSON으로 파싱해 error.data/message/status에 담아 던진다', async () => {
    globalThis.fetch.mockResolvedValueOnce(jsonResponse(410, { code: 'RUN_EXPIRED', error: { message: '만료됨' } }));
    await expect(requestBlobPost('/api/stats/export', {
      body: { analysisRunId: 'r1' },
      session: { accessToken: 'tok' },
    })).rejects.toMatchObject({ status: 410, message: '만료됨', data: { code: 'RUN_EXPIRED' } });
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
