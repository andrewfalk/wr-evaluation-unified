import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { requestMultipart, requestBlob, configureHttpClient } from '../httpClient.js';
import { uploadClip, fetchSampleFrame } from '../videoAnalysisClient.js';
import { canDetectClip } from '../../components/VideoAnalysisStep.jsx';

// 제어 가능한 XMLHttpRequest 목. send() 후 테스트가 finish()로 응답을 흘린다.
class MockXHR {
  constructor() {
    this.headers = {};
    this.upload = {};
    this.withCredentials = false;
    MockXHR.instances.push(this);
  }
  open(method, url) { this.method = method; this.url = url; }
  setRequestHeader(k, v) { this.headers[k] = v; }
  send(body) { this.body = body; }
  finish(status, payload) {
    this.status = status;
    this.responseText = JSON.stringify(payload);
    this.onload();
  }
  emitProgress(loaded, total) {
    this.upload.onprogress({ lengthComputable: true, loaded, total });
  }
}
MockXHR.instances = [];

describe('requestMultipart', () => {
  beforeEach(() => {
    MockXHR.instances = [];
    globalThis.document = { cookie: 'wr_csrf=csrf-1' };
    globalThis.XMLHttpRequest = MockXHR;
    globalThis.FormData = class { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } };
  });
  afterEach(() => { delete globalThis.XMLHttpRequest; delete globalThis.FormData; });

  it('파일·필드를 FormData로 보내고 CSRF/세션 헤더를 설정', async () => {
    const p = requestMultipart('/api/x', {
      baseUrl: 'http://srv', file: 'BLOB', fields: { a: '1' },
      session: { accessToken: 'tok' },
    });
    const xhr = MockXHR.instances[0];
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('http://srv/api/x');
    expect(xhr.withCredentials).toBe(true);
    expect(xhr.headers['X-CSRF-Token']).toBe('csrf-1');
    // Content-Type은 지정하지 않는다(브라우저가 boundary 설정).
    expect(xhr.headers['Content-Type']).toBeUndefined();
    expect(xhr.body.parts).toContainEqual(['a', '1']);
    expect(xhr.body.parts).toContainEqual(['file', 'BLOB']);
    xhr.finish(200, { ok: true });
    await expect(p).resolves.toEqual({ ok: true });
  });

  it('진행률 콜백을 호출', async () => {
    const onProgress = vi.fn();
    const p = requestMultipart('/api/x', { file: 'B', onProgress });
    const xhr = MockXHR.instances[0];
    xhr.emitProgress(50, 100);
    expect(onProgress).toHaveBeenCalledWith({ loaded: 50, total: 100 });
    xhr.finish(200, {});
    await p;
  });

  it('비200 → status·data 포함 에러', async () => {
    const p = requestMultipart('/api/x', { file: 'B' });
    const xhr = MockXHR.instances[0];
    xhr.finish(413, { code: 'FILE_TOO_LARGE', error: 'too big' });
    await expect(p).rejects.toMatchObject({ status: 413, data: { code: 'FILE_TOO_LARGE' } });
  });

  it('이미 abort된 signal → pending 없이 즉시 reject', async () => {
    const signal = { aborted: true, addEventListener: vi.fn() };
    await expect(requestMultipart('/api/x', { file: 'B', signal })).rejects.toMatchObject({ status: 0 });
  });
});

describe('uploadClip', () => {
  beforeEach(() => {
    MockXHR.instances = [];
    globalThis.document = { cookie: 'wr_csrf=csrf-1' };
    globalThis.XMLHttpRequest = MockXHR;
    globalThis.FormData = class { constructor() { this.parts = []; } append(k, v) { this.parts.push([k, v]); } };
  });
  afterEach(() => { delete globalThis.XMLHttpRequest; delete globalThis.FormData; });

  it('인트라넷 세션에서 clip upload 경로로 POST', async () => {
    const p = uploadClip('clip-1', 'FILE', { session: { mode: 'intranet', apiBaseUrl: 'http://srv' } });
    const xhr = MockXHR.instances[0];
    expect(xhr.url).toBe('http://srv/api/video-analysis/clips/clip-1/upload');
    xhr.finish(200, { clipId: 'clip-1', sha256: 'abc' });
    await expect(p).resolves.toEqual({ clipId: 'clip-1', sha256: 'abc' });
  });

  it('비인트라넷 → VIDEO_UNSUPPORTED_MODE', async () => {
    await expect(uploadClip('c', 'F', { session: { mode: 'web' } }))
      .rejects.toMatchObject({ code: 'VIDEO_UNSUPPORTED_MODE' });
  });
});

describe('requestBlob', () => {
  beforeEach(() => { globalThis.fetch = vi.fn(); configureHttpClient({ onRefresh: null, onLogout: null }); });
  afterEach(() => { delete globalThis.fetch; });

  it('200 → blob 반환(인증 헤더 공유)', async () => {
    const blob = { type: 'image/jpeg' };
    globalThis.fetch.mockResolvedValueOnce({ status: 200, ok: true, blob: vi.fn(async () => blob) });
    await expect(requestBlob('/api/x', { session: { accessToken: 't' } })).resolves.toBe(blob);
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/x', expect.objectContaining({ method: 'GET', credentials: 'include' }));
  });

  it('404 → null', async () => {
    globalThis.fetch.mockResolvedValueOnce({ status: 404, ok: false });
    await expect(requestBlob('/api/x')).resolves.toBeNull();
  });

  it('그 외 오류 → throw(status)', async () => {
    globalThis.fetch.mockResolvedValueOnce({ status: 500, ok: false });
    await expect(requestBlob('/api/x')).rejects.toMatchObject({ status: 500 });
  });
});

describe('fetchSampleFrame', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
    globalThis.URL = { createObjectURL: vi.fn(() => 'blob:abc'), revokeObjectURL: vi.fn() };
    configureHttpClient({ onRefresh: null, onLogout: null });
  });
  afterEach(() => { delete globalThis.fetch; delete globalThis.URL; });

  it('인트라넷 200 → objectURL', async () => {
    globalThis.fetch.mockResolvedValueOnce({ status: 200, ok: true, blob: vi.fn(async () => ({})) });
    await expect(fetchSampleFrame('c1', { session: { mode: 'intranet' } })).resolves.toBe('blob:abc');
  });

  it('404(게이트 off/미생성) → null', async () => {
    globalThis.fetch.mockResolvedValueOnce({ status: 404, ok: false });
    await expect(fetchSampleFrame('c1', { session: { mode: 'intranet' } })).resolves.toBeNull();
  });

  it('비인트라넷 → VIDEO_UNSUPPORTED_MODE', async () => {
    await expect(fetchSampleFrame('c1', { session: { mode: 'web' } })).rejects.toMatchObject({ code: 'VIDEO_UNSUPPORTED_MODE' });
  });
});

describe('canDetectClip', () => {
  it('서버 모드 아니면 항상 false', () => {
    expect(canDetectClip({ serverMode: false, fixtureMode: true, clip: { fixtureClipName: 'x.mp4' }, upload: null })).toBe(false);
  });
  it('업로드 완료 clip → true', () => {
    expect(canDetectClip({ serverMode: true, fixtureMode: false, clip: {}, upload: { status: 'done', serverClipId: 'c1' } })).toBe(true);
  });
  it('업로드 중 → false', () => {
    expect(canDetectClip({ serverMode: true, fixtureMode: false, clip: {}, upload: { status: 'uploading' } })).toBe(false);
  });
  it('fixtureMode + fixtureClipName → true', () => {
    expect(canDetectClip({ serverMode: true, fixtureMode: true, clip: { fixtureClipName: 'x.mp4' }, upload: null })).toBe(true);
  });
  it('fixture 파일명 없고 업로드도 없으면 false', () => {
    expect(canDetectClip({ serverMode: true, fixtureMode: true, clip: {}, upload: null })).toBe(false);
  });
});
