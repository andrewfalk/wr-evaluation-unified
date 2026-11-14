// T6 — httpClient blob 계열 특성화(REFACTORING_ROADMAP Phase 2 P2-08). C2(P2-16)가 401-refresh·CSRF 재시도·
// 에러 추출을 apiClient 파이프라인 한 벌로 합칠 때 requestBlob(GET)·requestBlobPost(POST)의 함수별 차이를 그대로
// 옵션으로 보존하는지 지킨다. 기존 httpClient.test.js(requestJson CSRF·requestBlobPost 성공·로컬 세션)는 그대로 둔다.
//
// 지금의 차이(그대로 얼림):
//   requestBlob     — 헤더는 세션 헤더만(Content-Type·CSRF 없음), 404 → null, 그 밖의 실패는 본문을 읽지 않고
//                     "Request failed (status)", CSRF_INVALID 재시도 없음.
//   requestBlobPost — JSON 본문 + CSRF, 실패 본문의 error.message / error(문자열)를 메시지로, 403 CSRF_INVALID는
//                     forceCsrf refresh 뒤 1회 재시도, 404도 오류.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { configureHttpClient, requestBlob, requestBlobPost } from '../httpClient.js';

const blob = (text = 'bin') => new Blob([text]);
const res = (status, { json, blobValue } = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn(async () => { if (json === undefined) throw new Error('no json'); return json; }),
  blob: vi.fn(async () => blobValue ?? blob()),
});
const INTRANET = { mode: 'intranet', accessToken: 'old', user: { id: 'u1', organizationId: 'o1' } };
const REFRESHED = { ...INTRANET, accessToken: 'new' };

let onRefresh;
let onLogout;

beforeEach(() => {
  globalThis.fetch = vi.fn();
  onRefresh = vi.fn(async () => REFRESHED);
  onLogout = vi.fn();
  configureHttpClient({ onRefresh, onLogout });
  globalThis.document = { cookie: 'wr_csrf=csrf-1' };
});

describe('requestBlob (GET)', () => {
  it('성공: blob을 돌려주고, GET·credentials include·세션 헤더만 보낸다', async () => {
    const b = blob('img');
    fetch.mockResolvedValueOnce(res(200, { blobValue: b }));
    await expect(requestBlob('/api/x/image', { baseUrl: 'https://srv/', session: INTRANET, headers: { 'X-Extra': '1' } })).resolves.toBe(b);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://srv/api/x/image');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
    expect(init.headers).toEqual({
      Authorization: 'Bearer old', 'X-WR-User-Id': 'u1', 'X-WR-Org-Id': 'o1', 'X-WR-Auth-Mode': 'intranet', 'X-Extra': '1',
    });
    expect('signal' in init).toBe(false);
  });

  it('404 → null, 그 밖의 실패는 본문을 읽지 않고 "Request failed (status)"', async () => {
    fetch.mockResolvedValueOnce(res(404));
    await expect(requestBlob('/a', { session: INTRANET })).resolves.toBeNull();
    const failed = res(500, { json: { error: { message: '서버 메시지' } } });
    fetch.mockResolvedValueOnce(failed);
    await expect(requestBlob('/a', { session: INTRANET })).rejects.toMatchObject({ message: 'Request failed (500)', status: 500 });
    expect(failed.json).not.toHaveBeenCalled();
  });

  it('401(인트라넷): refresh 1회 뒤 새 세션 헤더로 재시도', async () => {
    fetch.mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(200));
    await expect(requestBlob('/a', { baseUrl: 'https://srv', session: INTRANET })).resolves.toBeInstanceOf(Blob);
    expect(onRefresh).toHaveBeenCalledWith({ baseUrl: 'https://srv' });
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe('Bearer new');
  });

  it('재시도도 401이면 다시 refresh하지 않고 실패', async () => {
    fetch.mockResolvedValueOnce(res(401)).mockResolvedValueOnce(res(401));
    await expect(requestBlob('/a', { session: INTRANET })).rejects.toMatchObject({ status: 401, message: 'Request failed (401)' });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('refresh 실패: retryable이면 로그아웃 없이 retryable 오류, 아니면 onLogout + 만료 메시지', async () => {
    fetch.mockResolvedValueOnce(res(401));
    onRefresh.mockRejectedValueOnce(Object.assign(new Error('lock'), { retryable: true }));
    await expect(requestBlob('/a', { session: INTRANET })).rejects.toMatchObject({
      status: 401, retryable: true, message: '일시적인 인증 조율 오류입니다. 잠시 후 다시 시도해 주세요.',
    });
    expect(onLogout).not.toHaveBeenCalled();
    fetch.mockResolvedValueOnce(res(401));
    onRefresh.mockRejectedValueOnce(new Error('expired'));
    await expect(requestBlob('/a', { session: INTRANET })).rejects.toMatchObject({ status: 401, message: '인증이 만료되었습니다. 다시 로그인해 주세요.' });
    expect(onLogout).toHaveBeenCalledTimes(1);
  });

  it('403 CSRF_INVALID에도 재시도하지 않는다(GET)', async () => {
    fetch.mockResolvedValueOnce(res(403, { json: { code: 'CSRF_INVALID' } }));
    await expect(requestBlob('/a', { session: INTRANET })).rejects.toMatchObject({ status: 403 });
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('signal을 넘기면 그대로 전달', async () => {
    const controller = new AbortController();
    fetch.mockResolvedValueOnce(res(200));
    await requestBlob('/a', { session: INTRANET, signal: controller.signal });
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe('requestBlobPost (POST)', () => {
  it('JSON 본문을 보내고, 실패 본문의 error.message / error 문자열 / 기본 문구 순으로 메시지를 만든다', async () => {
    fetch.mockResolvedValueOnce(res(400, { json: { error: { message: '잘못된 요청' } } }));
    await expect(requestBlobPost('/e', { body: { a: 1 }, session: INTRANET })).rejects.toMatchObject({ status: 400, message: '잘못된 요청', data: { error: { message: '잘못된 요청' } } });
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'include', body: '{"a":1}' });
    fetch.mockResolvedValueOnce(res(409, { json: { error: '충돌' } }));
    await expect(requestBlobPost('/e', { body: {}, session: INTRANET })).rejects.toMatchObject({ message: '충돌' });
    fetch.mockResolvedValueOnce(res(502));
    await expect(requestBlobPost('/e', { body: {}, session: INTRANET })).rejects.toMatchObject({ message: 'Request failed (502)', data: null });
  });

  it('404도 null이 아니라 오류', async () => {
    fetch.mockResolvedValueOnce(res(404, { json: { error: 'Not found' } }));
    await expect(requestBlobPost('/e', { body: {}, session: INTRANET })).rejects.toMatchObject({ status: 404 });
  });

  it('body가 undefined면 본문 없이 보낸다', async () => {
    fetch.mockResolvedValueOnce(res(200));
    await requestBlobPost('/e', { session: INTRANET });
    expect(fetch.mock.calls[0][1].body).toBeUndefined();
  });

  it('403 CSRF_INVALID → forceCsrf refresh 뒤 1회 재시도, 그 refresh가 실패하면 403 + 원래 본문', async () => {
    fetch.mockResolvedValueOnce(res(403, { json: { code: 'CSRF_INVALID' } })).mockResolvedValueOnce(res(200));
    await expect(requestBlobPost('/e', { baseUrl: 'https://srv', body: {}, session: INTRANET })).resolves.toBeInstanceOf(Blob);
    expect(onRefresh).toHaveBeenCalledWith({ baseUrl: 'https://srv', forceCsrf: true });
    fetch.mockResolvedValueOnce(res(403, { json: { error: { code: 'CSRF_INVALID' } } }));
    onRefresh.mockRejectedValueOnce(new Error('x'));
    await expect(requestBlobPost('/e', { body: {}, session: INTRANET })).rejects.toMatchObject({
      status: 403, message: 'CSRF token renewal failed', data: { error: { code: 'CSRF_INVALID' } },
    });
  });
});
