import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { createAuditQueueStore } from '../auditQueueStore.js';
import { classifySendFailure, interpretHttpResponse } from '../auditLogic.js';

// EA-8: 재전송 정책 — 한 번에 한 회차, 응답별 처리, 항목 단위 격리, 전송 중 추가된 항목 보존, 원본을 잘라 쓰지 않음.
const require = createRequire(import.meta.url);
const { createFakeElectron, loadShellModule, SAFE_PREFIX } = require('../../scripts/lib/fakeElectron.cjs');
const ELECTRON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_DIR = path.resolve(ELECTRON_DIR, '..', 'scripts', 'tier3', 'fixtures', 'shell-7.1.4');

let dirs = [];
function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-resend-'));
  dirs.push(d);
  return d;
}
const crypt = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(SAFE_PREFIX + s, 'utf8'),
  decryptString: (b) => {
    const s = Buffer.from(b).toString('utf8');
    if (!s.startsWith(SAFE_PREFIX)) throw new Error('bad');
    return s.slice(SAFE_PREFIX.length);
  },
};
const quiet = { error: () => {}, warn: () => {} };
function makeStore(dir, extra = {}) {
  return createAuditQueueStore({ file: path.join(dir, 'audit-emr-pending.enc'), ...crypt, log: quiet, ...extra });
}
const fileLines = (dir, name = 'audit-emr-pending.enc') => (fs.existsSync(path.join(dir, name))
  ? fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean) : []);
const entries = (dir, name) => fileLines(dir, name).map((l) => JSON.parse(crypt.decryptString(Buffer.from(l.slice(4), 'base64'))));
const e = (i) => ({ action: 'emr_extract_record', outcome: 'failure', targetId: `t${i}` });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('응답 분류', () => {
  const err = (status, code, extra = {}) => Object.assign(new Error('x'), { status, code, ...extra });
  it.each([
    ['429 + Retry-After', err(429, 'RATE_LIMITED', { retryAfterSec: 7 }), { kind: 'stop', retryAfterMs: 7000 }],
    ['429(Retry-After 없음)', err(429, 'RATE_LIMITED'), { kind: 'stop', retryAfterMs: 60000 }],
    ['5xx', err(503, null), { kind: 'stop' }],
    ['네트워크 오류·시간 초과', new Error('request timeout'), { kind: 'stop' }],
    ['403', err(403, 'FORBIDDEN'), { kind: 'stop' }],
    ['형식을 알 수 없는 응답', new Error('parse error HTTP 200'), { kind: 'stop' }],
    ['JSON이 아닌 429 + Retry-After', interpretHttpResponse(429, 'Too Many Requests', { 'retry-after': '900' }), { kind: 'stop', retryAfterMs: 900_000 }],
    ['JSON이 아닌 413(프록시)', interpretHttpResponse(413, '<html>Request Entity Too Large</html>', {}), { kind: 'quarantine' }],
    ['JSON이 아닌 502', interpretHttpResponse(502, '<html>bad gateway</html>', {}), { kind: 'stop' }],
    ['400 INVALID_BODY', err(400, 'INVALID_BODY'), { kind: 'quarantine' }],
    ['400(다른 코드)', err(400, 'OTHER'), { kind: 'stop' }],
    ['413', err(413, null), { kind: 'quarantine' }],
    ['장치 문제 401', err(401, 'UNAUTHORIZED'), { kind: 'device_problem' }],
  ])('%s', (_name, input, expected) => {
    expect(classifySendFailure(input)).toEqual(expected);
  });
});

describe('대기열 회차(auditQueueStore)', () => {
  it('한 번에 한 회차: 회차 도중 다시 부르면 바로 끝난다', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.enqueue(e(1));
    let release;
    const first = store.flush(() => new Promise((r) => { release = () => r('ok'); }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(await store.flush(async () => 'ok')).toMatchObject({ skipped: true });
    release();
    expect(await first).toMatchObject({ sent: 1 });
  });

  it('회차당 상한, 요청 사이 간격', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    for (let i = 0; i < 5; i += 1) store.enqueue(e(i));
    const sleeps = [];
    const r = await store.flush(async () => 'ok', { maxPerRound: 3, gapMs: 20, sleep: async (ms) => { sleeps.push(ms); } });
    expect(r).toMatchObject({ sent: 3, remaining: 2 });
    expect(sleeps).toEqual([20, 20]);
    expect(entries(dir).map((x) => x.targetId)).toEqual(['t3', 't4']);
  });

  it('항목 하나의 문제(격리)는 뒤 항목을 막지 않고, 멈춤은 그 항목과 나머지를 남긴다', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    for (let i = 0; i < 5; i += 1) store.enqueue(e(i));
    const verdicts = ['ok', 'quarantine', 'ok', 'stop'];
    const r = await store.flush(async () => verdicts.shift());
    expect(r).toMatchObject({ sent: 2, quarantined: { corrupt: 0, rejected: 1 }, stopped: true });
    expect(entries(dir).map((x) => x.targetId)).toEqual(['t3', 't4']);
    expect(entries(dir, 'audit-emr-quarantine.enc').map((x) => x.targetId)).toEqual(['t1']);
  });

  it('손상은 그 줄만 격리하고 정상 줄은 보낸다', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.enqueue(e(1));
    fs.appendFileSync(path.join(dir, 'audit-emr-pending.enc'), 'enc:bm90LW91cnM=\nnot-even-enc\n');
    store.enqueue(e(2));
    const sent = [];
    const r = await store.flush(async (entry) => { sent.push(entry.targetId); return 'ok'; });
    expect(sent).toEqual(['t1', 't2']);
    expect(r.quarantined).toEqual({ corrupt: 2, rejected: 0 });
    expect(fileLines(dir)).toEqual([]);
    expect(fileLines(dir, 'audit-emr-quarantine.enc')).toEqual(['enc:bm90LW91cnM=', 'not-even-enc']);
  });

  it('전송 중과 교체 직전에 추가된 항목은 지워지지 않는다', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.enqueue(e(1));
    store.enqueue(e(2));
    const r = await store.flush(async (entry) => {
      if (entry.targetId === 't1') { await new Promise((res) => setTimeout(res, 5)); store.enqueue(e('during')); }
      if (entry.targetId === 't2') store.enqueue(e('just-before-replace')); // 마지막 전송 직후 — 다음은 동기 교체 구간
      return 'ok';
    });
    expect(r.sent).toBe(2);
    expect(entries(dir).map((x) => x.targetId)).toEqual(['tduring', 'tjust-before-replace']);
  });

  it('이름 바꾸기가 실패하면 원본을 그대로 두고, 다음 회차에 이미 보낸 줄을 다시 보내지 않는다', async () => {
    const dir = tempDir();
    let failRename = true;
    const fsProxy = { ...fs, renameSync: (...a) => { if (failRename) throw new Error('EPERM'); return fs.renameSync(...a); } };
    const store = makeStore(dir, { fs: fsProxy });
    for (let i = 0; i < 3; i += 1) store.enqueue(e(i));
    const before = fs.readFileSync(path.join(dir, 'audit-emr-pending.enc'), 'utf8');
    const sent = [];
    const verdicts = ['ok', 'ok', 'stop'];
    await store.flush(async (entry) => { sent.push(entry.targetId); return verdicts.shift(); });
    expect(fs.readFileSync(path.join(dir, 'audit-emr-pending.enc'), 'utf8')).toBe(before); // 원본 그대로
    expect(fs.existsSync(path.join(dir, 'audit-emr-pending.enc.tmp'))).toBe(false);
    failRename = false;
    sent.length = 0;
    await store.flush(async (entry) => { sent.push(entry.targetId); return 'ok'; });
    expect(sent).toEqual(['t2']); // t0·t1은 다시 보내지 않고 이번에 파일에서 뺀다
    expect(fileLines(dir)).toEqual([]);
  });

  it('임시 파일 쓰기 도중 중단돼도 원본은 온전하고, 시작할 때 남은 임시 파일은 버린다', async () => {
    const dir = tempDir();
    const fsProxy = { ...fs, writeFileSync: (p, ...a) => { if (String(p).endsWith('.tmp')) { fs.writeFileSync(p, 'enc:partial'); throw new Error('ENOSPC'); } return fs.writeFileSync(p, ...a); } };
    const store = makeStore(dir, { fs: fsProxy });
    for (let i = 0; i < 2; i += 1) store.enqueue(e(i));
    const before = fs.readFileSync(path.join(dir, 'audit-emr-pending.enc'), 'utf8');
    await store.flush(async (entry) => (entry.targetId === 't0' ? 'ok' : 'stop'));
    expect(fs.readFileSync(path.join(dir, 'audit-emr-pending.enc'), 'utf8')).toBe(before);
    fs.writeFileSync(path.join(dir, 'audit-emr-pending.enc.tmp'), 'enc:leftover'); // 프로세스가 죽었다면 남았을 파일
    makeStore(dir); // 다음 시작
    expect(fs.existsSync(path.join(dir, 'audit-emr-pending.enc.tmp'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'audit-emr-pending.enc'), 'utf8')).toBe(before);
  });

  it('다른 프로세스의 잠금: 오래된 잠금은 넘겨받고, 살아 있는 잠금이면 대기열 파일을 건드리지 않고 보조 파일에 쓴 뒤 다음 회차가 옮긴다', async () => {
    const dir = tempDir();
    const lock = path.join(dir, 'audit-emr-pending.enc.lock');
    fs.writeFileSync(lock, '999999999:gone'); // 끝난 프로세스의 잠금
    const store = makeStore(dir);
    store.enqueue(e(1));
    expect(entries(dir).map((x) => x.targetId)).toEqual(['t1']);
    expect(fs.existsSync(lock)).toBe(false);

    fs.writeFileSync(lock, `${process.ppid}:live`); // 살아 있는 프로세스의 잠금
    let t = Date.now();
    const fastClock = makeStore(dir, { now: () => { t += 500; return t; } });
    fastClock.enqueue(e(2));
    expect(entries(dir).map((x) => x.targetId)).toEqual(['t1']); // 잠금 없이 대기열 파일을 바꾸지 않는다
    const spooled = fs.readdirSync(dir).filter((n) => n.startsWith('audit-emr-pending.spool-'));
    expect(spooled).toHaveLength(1);
    expect(spooled[0]).toMatch(/\.enc$/); // 다 쓴 뒤 게시된 이름
    expect(entries(dir, spooled[0]).map((x) => x.targetId)).toEqual(['t2']);
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.ppid}:live`); // 남의 잠금은 지우지 않는다
    // 잠금이 살아 있는 동안 회차는 시작하지 않는다.
    expect(await fastClock.flush(async () => 'ok')).toMatchObject({ skipped: true });
    fs.unlinkSync(lock);
    const sent = [];
    await makeStore(dir).flush(async (entry) => { sent.push(entry.targetId); return 'ok'; });
    expect(sent).toEqual(['t1', 't2']);
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('audit-emr-pending.spool-'))).toEqual([]);
    expect(fileLines(dir)).toEqual([]);
  });

  it('넘겨받으려던 잠금이 그사이 다른 프로세스의 새 잠금으로 바뀌었으면 지우지 않고 되돌려 놓는다', () => {
    const dir = tempDir();
    const lock = path.join(dir, 'audit-emr-pending.enc.lock');
    fs.writeFileSync(lock, '999999999:gone');
    let swapped = false;
    const fsProxy = {
      ...fs,
      renameSync: (from, to) => {
        if (from === lock && !swapped) { swapped = true; fs.writeFileSync(lock, `${process.ppid}:new-owner`); } // 확인과 옮기기 사이
        return fs.renameSync(from, to);
      },
    };
    let t = Date.now();
    const store = makeStore(dir, { fs: fsProxy, now: () => { t += 500; return t; } });
    store.enqueue(e(1));
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.ppid}:new-owner`);
    expect(fileLines(dir)).toEqual([]); // 잠금이 없으니 대기열 파일은 그대로
    expect(fs.readdirSync(dir).filter((n) => n.startsWith('audit-emr-pending.spool-'))).toHaveLength(1);
    expect(fs.readdirSync(dir).filter((n) => n.includes('.stale-'))).toEqual([]);
  });

  it('잠금을 풀 때 자기 잠금만 지운다', () => {
    const dir = tempDir();
    const lock = path.join(dir, 'audit-emr-pending.enc.lock');
    const fsProxy = {
      ...fs,
      appendFileSync: (p, ...a) => {
        const r = fs.appendFileSync(p, ...a);
        if (String(p).endsWith('audit-emr-pending.enc')) fs.writeFileSync(lock, `${process.ppid}:someone-else`); // 잠금이 바뀐 상황
        return r;
      },
    };
    makeStore(dir, { fs: fsProxy }).enqueue(e(1));
    expect(fs.readFileSync(lock, 'utf8')).toBe(`${process.ppid}:someone-else`);
  });

  it('게시되지 않은 보조 파일: 막 쓰는 중이면 두고, 오래되고 완성된 줄이면 옮긴다', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    const line = fileLines((() => { const d = tempDir(); makeStore(d).enqueue(e('orphan')); return d; })())[0];
    const young = path.join(dir, 'audit-emr-pending.spool-1-1-1.tmp');
    const old = path.join(dir, 'audit-emr-pending.spool-2-2-2.tmp');
    fs.writeFileSync(young, line + '\n');
    fs.writeFileSync(old, line + '\n');
    const past = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(old, past, past);
    const sent = [];
    await store.flush(async (entry) => { sent.push(entry.targetId); return 'ok'; });
    expect(sent).toEqual(['torphan']);
    expect(fs.existsSync(young)).toBe(true);
    expect(fs.existsSync(old)).toBe(false);
  });

  it('회차 끝에 잠금을 못 잡으면 파일을 바꾸지 않고(다른 프로세스의 추가 보존), 보낸 줄은 다음 회차에 다시 보내지 않는다', async () => {
    const dir = tempDir();
    const lock = path.join(dir, 'audit-emr-pending.enc.lock');
    let t = Date.now();
    const store = makeStore(dir, { now: () => { t += 500; return t; } });
    store.enqueue(e(1));
    store.enqueue(e(2));
    const sent = [];
    await store.flush(async (entry) => {
      sent.push(entry.targetId);
      if (entry.targetId === 't2') {
        fs.writeFileSync(lock, `${process.ppid}:other`);                              // 다른 프로세스가 잠금을 잡고
        fs.appendFileSync(path.join(dir, 'audit-emr-pending.enc'), fileLines(dir)[0].replace(/./, 'e') + '\n'); // 줄을 더했다(형식만 흉내)
      }
      return 'ok';
    });
    expect(fileLines(dir)).toHaveLength(3); // 바꾸지 않았다
    fs.unlinkSync(lock);
    sent.length = 0;
    await store.flush(async (entry) => { sent.push(entry.targetId); return 'ok'; });
    expect(sent).toEqual(['t1']); // 다른 프로세스가 더한 줄(같은 내용)만 보내고 t1·t2는 다시 보내지 않는다
    expect(fileLines(dir)).toEqual([]);
  });

  it('7.1.4 설치본이 새 설치본의 대기열 파일을 읽고 보낼 수 있다', async () => {
    const dir = tempDir();
    const store = makeStore(dir);
    store.enqueue({ ...e(1), extra: { source: 'auto', occurredAt: '2026-11-24T00:00:00.000Z', eventId: 'ev', actorUserId: 'u', shellAudit: 2 } });
    store.enqueue(e(2));
    const sent = [];
    const fake = createFakeElectron({
      userDataDir: dir,
      send: async (req) => { sent.push(JSON.parse(req.body.toString('utf8'))); return { status: 200, body: '{"ok":true}' }; },
    });
    loadShellModule(LEGACY_DIR, 'audit.js', fake);
    const legacyQueue = require(path.join(LEGACY_DIR, 'auditQueue.js'));
    expect(legacyQueue.checkCorrupt()).toBe(false);
    await legacyQueue.flush(async (entry) => { sent.push(entry); });
    expect(sent.map((x) => x.targetId)).toEqual(['t1', 't2']);
    expect(sent[0].extra).toMatchObject({ source: 'auto', shellAudit: 2 });
    expect(fileLines(dir)).toEqual([]);
  });
});

// ── audit.js로(가짜 electron): 응답별 회차 ───────────────────────────────────

const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const TOKEN = jwt({ sub: 'user-1', orgId: 'org-1' });

function setup(auditReply) {
  const dir = tempDir();
  const requests = [];
  const send = async (req) => {
    const p = new URL(req.url).pathname;
    const body = req.body.length ? JSON.parse(req.body.toString('utf8')) : null;
    requests.push({ path: p, body, auth: req.headers.Authorization ?? null });
    if (p === '/api/devices/register') {
      return { status: 200, body: JSON.stringify({ deviceId: 's', status: 'active', deviceScope: 'pc', organizationId: 'org-1' }) };
    }
    const r = await auditReply(body, req);
    if (r instanceof Error) throw r;
    return { status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? { ok: true }), headers: r.headers };
  };
  const fake = createFakeElectron({ userDataDir: dir, send });
  const audit = loadShellModule(ELECTRON_DIR, 'audit.js', fake);
  const queue = require(path.join(ELECTRON_DIR, 'auditQueue.js'));
  const audits = () => requests.filter((r) => r.path === '/api/audit/emr');
  return { dir, audit, queue, requests, audits };
}

describe('audit.js 재전송 회차 — 응답별', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  async function started(reply, n = 4) {
    const s = setup(reply);
    await s.audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' });
    for (let i = 0; i < n; i += 1) s.queue.enqueue(e(i));
    s.requests.length = 0;
    return s;
  }

  it('429: 회차를 멈추고 남기며, Retry-After가 지날 때까지 다음 회차를 하지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let limited = true;
    const s = await started((body) => (body.targetId === 't1' && limited
      ? { status: 429, body: { code: 'RATE_LIMITED', error: 'x' }, headers: { 'retry-after': '30' } } : { status: 200 }));
    await s.audit.flushQueue();
    expect(s.audits().map((r) => r.body.targetId)).toEqual(['t0', 't1']);
    expect(entries(s.dir).map((x) => x.targetId)).toEqual(['t1', 't2', 't3']);
    s.requests.length = 0;
    vi.setSystemTime(Date.now() + 10_000);
    await s.audit.flushQueue();
    expect(s.requests).toHaveLength(0);
    limited = false;
    vi.setSystemTime(Date.now() + 21_000);
    await s.audit.flushQueue();
    expect(entries(s.dir)).toEqual([]);
  });

  it.each([
    ['5xx', () => ({ status: 503, body: { error: 'down' } })],
    ['네트워크 오류', () => new Error('ECONNRESET')],
    ['403', () => ({ status: 403, body: { code: 'FORBIDDEN', error: 'x' } })],
    ['형식을 알 수 없는 응답', () => ({ status: 502, body: '<html>bad gateway</html>' })],
  ])('%s: 회차를 멈추고 그 항목과 나머지를 남긴다', async (_name, failure) => {
    const s = await started((body) => (body.targetId === 't1' ? failure() : { status: 200 }));
    await s.audit.flushQueue();
    expect(s.audits().map((r) => r.body.targetId)).toEqual(['t0', 't1']);
    expect(entries(s.dir).map((x) => x.targetId)).toEqual(['t1', 't2', 't3']);
  });

  it.each([
    ['400 INVALID_BODY', { status: 400, body: { code: 'INVALID_BODY', error: [] } }],
    ['413', { status: 413, body: { code: 'PAYLOAD_TOO_LARGE', error: 'x' } }],
  ])('%s: 그 항목만 격리하고 뒤 항목을 보내며, 격리 건수를 진단 기록으로 알린다', async (_name, refusal) => {
    const s = await started((body) => (body.targetId === 't1' ? refusal : { status: 200 }));
    await s.audit.flushQueue();
    expect(s.audits().map((r) => r.body.targetId ?? r.body.action)).toEqual(['t0', 't1', 't2', 't3', 'audit_queue_corrupt']);
    expect(entries(s.dir)).toEqual([]);
    expect(entries(s.dir, 'audit-emr-quarantine.enc').map((x) => x.targetId)).toEqual(['t1']);
    expect(s.audits().at(-1).body.extra).toMatchObject({ kind: 'set_aside', corruptLines: 0, rejectedLines: 1, quarantineFile: 'audit-emr-quarantine.enc' });
  });

  it('장치 문제 401: 회차를 멈추고 장치 상태를 다시 묻는다', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = await started((body) => (body.targetId === 't1' ? { status: 401, body: { code: 'UNAUTHORIZED', error: 'Device not recognized' } } : { status: 200 }));
    vi.setSystemTime(Date.now() + 61_000);
    await s.audit.flushQueue();
    expect(s.audits().map((r) => r.body.targetId)).toEqual(['t0', 't1']);
    await vi.waitFor(() => expect(s.requests.filter((r) => r.path === '/api/devices/register')).toHaveLength(1));
    expect(entries(s.dir).map((x) => x.targetId)).toEqual(['t1', 't2', 't3']);
  });

  it.each(['TOKEN_INVALID', 'SESSION_REVOKED', 'SESSION_EXPIRED', 'USER_DISABLED'])('토큰 문제 401(%s): 토큰 없이 한 번 더 보낸다', async (code) => {
    const s = await started((body, req) => (req.headers.Authorization ? { status: 401, body: { code, error: 'x' } } : { status: 200 }), 1);
    await s.audit.flushQueue();
    expect(s.audits().map((r) => r.auth === null)).toEqual([false, true]);
    expect(entries(s.dir)).toEqual([]);
  });

  it('응답이 오지 않는 요청은 제한 시간 뒤 실패로 보고 회차를 멈춘다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = await started((body) => (body.targetId === 't0' ? new Promise(() => {}) : { status: 200 }), 2);
    const round = s.audit.flushQueue();
    await vi.advanceTimersByTimeAsync(30_000);
    await round;
    expect(s.audits()).toHaveLength(1);
    expect(entries(s.dir).map((x) => x.targetId)).toEqual(['t0', 't1']);
  });

  it('즉시 전송의 격리가 실패하면(격리 파일을 쓸 수 없음) 버리지 않고 대기열에 둔다', async () => {
    const s = await started((body) => (body.action === 'emr_inject' ? { status: 413, body: { error: 'too large' } } : { status: 200 }), 0);
    fs.mkdirSync(path.join(s.dir, 'audit-emr-quarantine.enc')); // 파일 자리에 폴더 — 추가가 실패한다
    await s.audit.recordAudit({ action: 'emr_inject', outcome: 'success' });
    expect(entries(s.dir).map((x) => x.action)).toEqual(['emr_inject']);
  });

  it('회차는 상태 확인부터 끝까지 하나 — 상태 확인 응답을 기다리는 동안 다시 부르면 바로 끝난다(Retry-After를 건너뛰지 않음)', async () => {
    const dir = tempDir();
    // 먼저 승인된 PC로 만들어 둔다(이전 실행).
    const first = loadShellModule(ELECTRON_DIR, 'audit.js', createFakeElectron({ userDataDir: dir, send: async () => ({ status: 200,
      body: JSON.stringify({ deviceId: 's', status: 'active', deviceScope: 'pc', organizationId: 'org-1' }) }) }));
    await first.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' });
    let releaseRegister;
    const audits = [];
    const send = async (req) => {
      const p = new URL(req.url).pathname;
      if (p === '/api/devices/register') {
        await new Promise((r) => { releaseRegister = r; });
        return { status: 200, body: JSON.stringify({ deviceId: 's', status: 'active', deviceScope: 'pc', organizationId: 'org-1' }) };
      }
      audits.push(JSON.parse(req.body.toString('utf8')));
      return { status: 200, body: '{"ok":true}' };
    };
    const audit = loadShellModule(ELECTRON_DIR, 'audit.js', createFakeElectron({ userDataDir: dir, send }));
    const queue = require(path.join(ELECTRON_DIR, 'auditQueue.js'));
    const init = audit.initAudit({ getAccessToken: () => TOKEN, apiBaseUrl: 'https://server.test' });
    await vi.waitFor(() => expect(releaseRegister).toBeTypeOf('function')); // 첫 회차가 상태 확인 응답을 기다리는 중
    queue.enqueue(e(1));
    await audit.flushQueue(); // 두 번째 회차 — 바로 끝나야 한다
    expect(audits).toHaveLength(0);
    releaseRegister();
    await init;
    expect(audits.map((b) => b.targetId)).toEqual(['t1']);
  });

  it('즉시 전송이 그 항목만의 문제로 거부되면 대기열이 아니라 격리 파일로 간다', async () => {
    const s = await started((body) => (body.action === 'emr_inject' ? { status: 400, body: { code: 'INVALID_BODY', error: [] } } : { status: 200 }), 0);
    await s.audit.recordAudit({ action: 'emr_inject', outcome: 'success' });
    expect(entries(s.dir)).toEqual([]);
    expect(entries(s.dir, 'audit-emr-quarantine.enc').map((x) => x.action)).toEqual(['emr_inject']);
    expect(s.audits().at(-1).body).toMatchObject({ action: 'audit_queue_corrupt', extra: { kind: 'set_aside', rejectedLines: 1 } });
  });
});
