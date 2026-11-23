import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

// audit.js·auditQueue.js를 가짜 electron(scripts/lib/fakeElectron.cjs)으로 불러 지금 동작을 고정한다(EA-5 특성화).
// "PC" 하나 = userData 폴더 하나, "앱 재시작" = 모듈을 새로 불러오기.
const require = createRequire(import.meta.url);
const { createFakeElectron, loadShellModule } = require('../../scripts/lib/fakeElectron.cjs');
const ELECTRON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 분리 전 코드(7.1.4 릴리스와 같은 사본) — 같은 특성화를 양쪽에 돌려 분리가 동작을 바꾸지 않았음을 보인다.
const LEGACY_DIR = path.resolve(ELECTRON_DIR, '..', 'scripts', 'tier3', 'fixtures', 'shell-7.1.4');
const SHELLS = [['현재 설치본 코드', ELECTRON_DIR], ['분리 전(7.1.4) 코드', LEGACY_DIR]];

const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const TOKEN = jwt({ sub: 'user-1', orgId: 'org-1' });

// 서버 흉내: 경로별 응답 함수. 받은 요청을 기록한다.
function makeServer(routes) {
  const requests = [];
  const send = async (req) => {
    const pathname = new URL(req.url).pathname;
    const entry = { path: pathname, headers: req.headers, body: req.body.length ? JSON.parse(req.body.toString('utf8')) : null };
    requests.push(entry);
    const route = routes[pathname];
    if (!route) throw new Error(`no route ${pathname}`);
    const res = await route(entry, requests);
    if (res instanceof Error) throw res;
    return { status: res.status, body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body) };
  };
  return { requests, send, audits: () => requests.filter((r) => r.path === '/api/audit/emr') };
}

const ok = { status: 200, body: { ok: true } };
const registered = (status) => () => ({ status: 200, body: { deviceId: 'server-row-id', status } });

let dirs = [];
function newPc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-audit-char-'));
  dirs.push(dir);
  return dir;
}

let SHELL_DIR = ELECTRON_DIR;
function start(pcDir, server, options = {}) {
  const fake = createFakeElectron({ userDataDir: pcDir, send: server.send, encryptionAvailable: options.encryptionAvailable });
  const audit = loadShellModule(SHELL_DIR, 'audit.js', fake);
  return { audit, fake };
}

const meta = (pcDir) => JSON.parse(fs.readFileSync(path.join(pcDir, 'wr-device.json'), 'utf8'));
const queueFile = (pcDir) => path.join(pcDir, 'audit-emr-pending.enc');
const queueEntries = (pcDir, fake) => (fs.existsSync(queueFile(pcDir))
  ? fs.readFileSync(queueFile(pcDir), 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(fake.safeStorage.decryptString(Buffer.from(l.slice(4), 'base64'))))
  : []);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe.each(SHELLS)('%s', (_label, shellDir) => {
beforeEach(() => { SHELL_DIR = shellDir; });

describe('audit.js 특성화 — 장치와 등록', () => {
  it('첫 실행: 장치 ID(로컬 UUID)·키(암호화)를 만들고 등록, 응답의 상태만 저장한다(서버 행 ID는 저장하지 않음)', async () => {
    const pc = newPc();
    const server = makeServer({ '/api/devices/register': registered('pending') });
    const { audit } = start(pc, server);
    await audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test/' });

    const m = meta(pc);
    expect(m.deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.status).toBe('pending');
    expect(Object.keys(m).sort()).toEqual(['deviceId', 'publicKeyB64', 'status']);
    expect(fs.readFileSync(path.join(pc, 'wr-device-key.enc'), 'utf8')).toMatch(/^enc:/);
    expect(audit.getDeviceStatus()).toEqual({ status: 'pending', deviceId: m.deviceId });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      path: '/api/devices/register',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: { publicKey: m.publicKeyB64, buildTarget: 'intranet' },
    });
  });

  // EA-6에서 바뀐 동작: 현재 설치본은 프로세스마다 첫 토큰에서 상태를 한 번 확인한다(해지·기관을 반영하려고).
  it('active 응답 → active 저장. 재시작 뒤 등록 호출: 7.1.4는 없음(로컬 active), 현재 설치본은 첫 토큰에서 한 번', async () => {
    const pc = newPc();
    const server = makeServer({ '/api/devices/register': registered('active') });
    await start(pc, server).audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' });
    expect(meta(pc).status).toBe('active');
    const { audit } = start(pc, server);
    await audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' });
    expect(server.requests.filter((r) => r.path === '/api/devices/register')).toHaveLength(SHELL_DIR === LEGACY_DIR ? 1 : 2);
    expect(audit.getDeviceStatus().status).toBe('active');
  });

  // EA-6에서 바뀐 동작: 현재 설치본은 실패한 호출로 상태를 바꾸지 않는다(7.1.4는 5xx·네트워크에서 메모리 상태 error).
  it('등록 실패: 429·비밀번호 변경 필요는 상태 유지, 5xx·네트워크는 7.1.4만 메모리 상태 error(파일은 그대로)', async () => {
    for (const [reply, expected] of [
      [{ status: 429, body: { code: 'RATE_LIMITED', error: 'x' } }, 'unregistered'],
      [{ status: 403, body: { code: 'PASSWORD_CHANGE_REQUIRED', error: 'x' } }, 'unregistered'],
      [{ status: 500, body: { code: 'INTERNAL_ERROR', error: 'x' } }, SHELL_DIR === LEGACY_DIR ? 'error' : 'unregistered'],
      [new Error('ECONNREFUSED'), SHELL_DIR === LEGACY_DIR ? 'error' : 'unregistered'],
    ]) {
      const pc = newPc();
      const server = makeServer({ '/api/devices/register': () => reply });
      const { audit } = start(pc, server);
      await audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' });
      expect(audit.getDeviceStatus().status).toBe(expected);
      expect(meta(pc).status).toBe('unregistered');
    }
  });

  it('재등록은 20분에 한 번(그사이 tryRegister는 요청하지 않음), 임시 비밀번호 토큰이면 요청하지 않음', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
    const pc = newPc();
    const server = makeServer({ '/api/devices/register': registered('pending') });
    const tokens = { current: jwt({ sub: 'u', mustChangePassword: true }) };
    const { audit } = start(pc, server);
    await audit.initAudit({ getAccessToken: () => tokens.current, apiBaseUrl: 'https://server.test' });
    expect(server.requests).toHaveLength(0);
    tokens.current = TOKEN;
    await audit.tryRegister();
    expect(server.requests).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-23T00:19:00Z'));
    await audit.tryRegister();
    await audit.flushQueue();
    expect(server.requests).toHaveLength(1);
    vi.setSystemTime(new Date('2026-11-23T00:20:01Z'));
    await audit.flushQueue();
    expect(server.requests).toHaveLength(2);
  });

  // 현재 설치본만: 등록 요청에 시간 제한이 있다 — 응답이 끝나지 않는 요청이 그 뒤의 상태 확인을 막지 않는다.
  it.runIf(shellDir === ELECTRON_DIR)('응답이 끝나지 않는 등록 요청은 시간 제한으로 끊기고, 정해진 간격 뒤 다시 확인한다', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
    const pc = newPc();
    let calls = 0;
    const server = makeServer({
      '/api/devices/register': () => { calls += 1; return calls === 1 ? new Promise(() => {}) : registered('active')(); },
    });
    const { audit } = start(pc, server);
    let initDone = false;
    const init = audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' }).then(() => { initDone = true; });
    await vi.advanceTimersByTimeAsync(29_000);
    expect(initDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await init;
    expect(audit.getDeviceStatus().status).toBe('unregistered');
    await vi.advanceTimersByTimeAsync(62_000);
    expect(server.requests.filter((r) => r.path === '/api/devices/register')).toHaveLength(2);
    expect(audit.getDeviceStatus().status).toBe('active');
  });

  it('safeStorage를 못 쓰면 감사 모듈이 꺼진다(요청 없음, 상태 error)', async () => {
    const pc = newPc();
    const server = makeServer({});
    const { audit } = start(pc, server, { encryptionAvailable: () => false });
    await audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' });
    expect(audit.getDeviceStatus().status).toBe('error');
    expect(server.requests).toHaveLength(0);
    await audit.recordAudit({ action: 'emr_inject', outcome: 'success' });
    expect(server.requests).toHaveLength(0);
  });
});

describe('audit.js 특성화 — 전송과 대기열', () => {
  async function activePc(auditRoute = () => ok, tokenRef = { current: TOKEN }) {
    const pc = newPc();
    const server = makeServer({ '/api/devices/register': registered('active'), '/api/audit/emr': auditRoute });
    const started = start(pc, server);
    await started.audit.initAudit({ getAccessToken: () => tokenRef.current, apiBaseUrl: 'https://server.test' });
    return { pc, server, tokenRef, ...started };
  }

  it('active면 바로 보낸다: 헤더의 장치 ID = 로컬 ID, 서명이 로컬 공개키로 맞는다', async () => {
    const { pc, server, audit } = await activePc();
    await audit.recordAudit({ action: 'emr_inject', outcome: 'success', targetId: 'tgt', extra: { source: 'auto' } });
    const [sent] = server.audits();
    const m = meta(pc);
    expect(sent.headers).toMatchObject({ 'X-WR-Device-Id': m.deviceId, 'X-WR-Source': 'electron-main', Authorization: `Bearer ${TOKEN}` });
    expect(sent.body).toEqual({ action: 'emr_inject', outcome: 'success', targetId: 'tgt', extra: { source: 'auto' } });
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(m.publicKeyB64, 'base64')]), format: 'der', type: 'spki' });
    const sorted = Object.fromEntries(Object.entries(sent.body).sort(([a], [b]) => a.localeCompare(b)));
    const message = `${m.deviceId}.${sent.headers['X-WR-Device-Ts']}.${sent.headers['X-WR-Device-Nonce']}.${JSON.stringify(sorted)}`;
    expect(crypto.verify(null, Buffer.from(message), pub, Buffer.from(sent.headers['X-WR-Device-Sig'], 'base64'))).toBe(true);
  });

  it('승인 전(pending)이면 보내지 않고 대기열에 넣는다', async () => {
    const pc = newPc();
    const server = makeServer({ '/api/devices/register': registered('pending'), '/api/audit/emr': () => ok });
    const { audit, fake } = start(pc, server);
    await audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' });
    const entry = { action: 'emr_extract_record', outcome: 'failure', targetId: 'x' };
    await audit.recordAudit(entry);
    expect(server.audits()).toHaveLength(0);
    expect(queueEntries(pc, fake)).toEqual([entry]);
  });

  it('토큰 만료·폐기 401 → 토큰 없이 한 번 더(세션 없음 표시), 장치 문제 401 → 대기열', async () => {
    const replies = [
      { status: 401, body: { code: 'TOKEN_INVALID', error: 'x' } }, ok,
      { status: 401, body: { code: 'UNAUTHORIZED', error: 'Device not recognized' } },
    ];
    const { pc, server, audit, fake } = await activePc(() => replies.shift());
    await audit.recordAudit({ action: 'emr_inject', outcome: 'success' });
    const [first, retry] = server.audits();
    expect(first.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(retry.headers).not.toHaveProperty('Authorization');
    expect(retry.body.extra).toEqual({ session_missing: true, actor_from_queue: true });
    expect(retry.headers['X-WR-Device-Nonce']).not.toBe(first.headers['X-WR-Device-Nonce']);
    await audit.recordAudit({ action: 'emr_extract_consultation', outcome: 'success' });
    expect(server.audits()).toHaveLength(3); // no tokenless retry for a device problem
    expect(queueEntries(pc, fake)).toEqual([{ action: 'emr_extract_consultation', outcome: 'success' }]);
  });

  it('토큰이 없으면 처음부터 토큰 없이(세션 없음 표시) 보낸다', async () => {
    const tokenRef = { current: TOKEN };
    const { server, audit } = await activePc(() => ok, tokenRef);
    tokenRef.current = null;
    await audit.recordAudit({ action: 'emr_inject', outcome: 'success', extra: { source: 'edited' } });
    const [sent] = server.audits();
    expect(sent.headers).not.toHaveProperty('Authorization');
    expect(sent.body.extra).toEqual({ source: 'edited', session_missing: true, actor_from_queue: true });
  });

  it('flushQueue: 대기열 전부를 순서대로 간격 없이 보내고, 실패(이유 무관)는 남기고, 다 보내면 파일을 지운다', async () => {
    const replies = [ok, { status: 429, body: { code: 'RATE_LIMITED', error: 'x' } }, ok, { status: 400, body: { code: 'INVALID_BODY', error: [] } }, ok];
    const { pc, server, audit, fake } = await activePc(() => replies.shift() ?? ok);
    const queue = loadShellModuleCached();
    const entries = [1, 2, 3, 4, 5].map((i) => ({ action: 'emr_extract_record', outcome: 'failure', targetId: `t${i}` }));
    for (const e of entries) queue.enqueue(e);
    await audit.flushQueue();
    expect(server.audits().map((r) => r.body.targetId)).toEqual(['t1', 't2', 't3', 't4', 't5']);
    expect(queueEntries(pc, fake)).toEqual([entries[1], entries[3]]);
    await audit.flushQueue();
    expect(queueEntries(pc, fake)).toEqual([]);
    expect(fs.existsSync(queueFile(pc))).toBe(false);
  });

  it('flushQueue: 한 줄이라도 깨지면 파일 전체를 이름 바꿔 격리하고 audit_queue_corrupt를 보낸다', async () => {
    const { pc, server, audit } = await activePc();
    const queue = loadShellModuleCached();
    queue.enqueue({ action: 'emr_inject', outcome: 'success' });
    fs.appendFileSync(queueFile(pc), 'enc:bm90LW91cnM=\n');
    await audit.flushQueue();
    const renamed = fs.readdirSync(pc).filter((f) => /^audit-emr-pending-corrupt-\d+\.bin$/.test(f));
    expect(renamed).toHaveLength(1);
    expect(fs.existsSync(queueFile(pc))).toBe(false);
    expect(server.audits().map((r) => r.body)).toEqual([{ action: 'audit_queue_corrupt', outcome: 'failure', extra: { corruptFile: renamed[0] } }]);
  });

  it('전송 중에 추가된 항목은 회차 끝의 파일 쓰기에 덮일 수 있다(지금 동작 — EA-8에서 고친다)', async () => {
    let resolveFirst;
    const replies = [
      () => new Promise((r) => { resolveFirst = () => r({ status: 503, body: { error: 'x' } }); }),
    ];
    const { pc, audit, fake } = await activePc(() => (replies.length ? replies.shift()() : ok));
    const queue = loadShellModuleCached();
    queue.enqueue({ action: 'emr_inject', outcome: 'success', targetId: 'old' });
    const flushing = audit.flushQueue();
    await vi.waitFor(() => expect(resolveFirst).toBeTypeOf('function'));
    queue.enqueue({ action: 'emr_inject', outcome: 'success', targetId: 'added-during-flush' });
    resolveFirst();
    await flushing;
    expect(queueEntries(pc, fake).map((e) => e.targetId)).toEqual(['old']);
  });
});

});

// audit.js가 불러 둔 auditQueue.js(같은 가짜 electron을 쓰는 캐시된 인스턴스).
function loadShellModuleCached() {
  return require(path.join(SHELL_DIR, 'auditQueue.js'));
}
