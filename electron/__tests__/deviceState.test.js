import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import {
  REGISTER_MIN_SPACING_MS,
  REGISTER_MAX_PER_HOUR,
  interpretRegisterResult,
  applyRegisterOutcome,
  emrGateDecision,
  sendingAllowed,
  shouldRegister,
} from '../deviceState.js';
import { readTokenIdentity } from '../accessTokenClaims.js';

// EA-6: 승인 상태를 기관에 묶고, 서버의 명시적 응답으로만 내린다(원칙 9).
const require = createRequire(import.meta.url);
const { createFakeElectron, loadShellModule } = require('../../scripts/lib/fakeElectron.cjs');
const ELECTRON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const ORG_A = 'org-a';
const ORG_B = 'org-b';
const tokenA = jwt({ sub: 'user-a1', orgId: ORG_A });
const tokenA2 = jwt({ sub: 'user-a2', orgId: ORG_A });
const tokenB = jwt({ sub: 'user-b1', orgId: ORG_B });

const pcAnswer = (status, organizationId = ORG_A) => ({ status: 200, body: { deviceId: 'srv', status, deviceScope: 'pc', organizationId } });
const otherOrgAnswer = (organizationId) => ({ status: 409, body: { code: 'DEVICE_REGISTERED_TO_OTHER_ORG', error: 'x', deviceScope: 'pc', status: 'other_org', organizationId } });
const oldServerAnswer = (status) => ({ status: 200, body: { deviceId: 'srv', status } });
const FAILURES = [
  ['네트워크 오류', () => new Error('ECONNRESET')],
  ['5xx', () => ({ status: 503, body: { error: 'down' } })],
  ['401', () => ({ status: 401, body: { code: 'TOKEN_INVALID', error: 'x' } })],
  ['403', () => ({ status: 403, body: { code: 'FORBIDDEN', error: 'x' } })],
  ['429', () => ({ status: 429, body: { code: 'RATE_LIMITED', error: 'x' } })],
  ['파싱 오류', () => ({ status: 200, body: '<html>' })],
  ['알 수 없는 새 서버 응답', () => ({ status: 200, body: { deviceScope: 'pc', status: 'weird', organizationId: ORG_A } })],
];

describe('deviceState — 순수 함수', () => {
  it('토큰의 사용자·기관', () => {
    expect(readTokenIdentity(tokenA)).toEqual({ userId: 'user-a1', orgId: ORG_A });
    expect(readTokenIdentity(jwt({ sub: 'root', orgId: null }))).toEqual({ userId: 'root', orgId: null });
    expect(readTokenIdentity(jwt({ orgId: ORG_A }))).toBeNull();
    expect(readTokenIdentity('garbage')).toBeNull();
  });

  it('등록 결과 해석: 새 서버(표식)·옛 서버·다른 기관 거부·실패', () => {
    expect(interpretRegisterResult({ ok: true, data: pcAnswer('revoked').body })).toEqual({ kind: 'pc', orgId: ORG_A, status: 'revoked' });
    expect(interpretRegisterResult({ ok: true, data: oldServerAnswer('active').body })).toEqual({ kind: 'legacy', status: 'active' });
    expect(interpretRegisterResult({ ok: true, data: oldServerAnswer('revoked').body })).toEqual({ kind: 'legacy', status: 'pending' });
    const err = Object.assign(new Error('x'), { status: 409, code: 'DEVICE_REGISTERED_TO_OTHER_ORG', body: otherOrgAnswer(ORG_B).body });
    expect(interpretRegisterResult({ ok: false, err })).toEqual({ kind: 'pc', orgId: ORG_B, status: 'other_org' });
    expect(interpretRegisterResult({ ok: false, err: Object.assign(new Error('x'), { status: 409, body: { code: 'OTHER' } }) })).toEqual({ kind: 'failed' });
    expect(interpretRegisterResult({ ok: false, err: Object.assign(new Error('x'), { status: 429 }) })).toEqual({ kind: 'retry_later' });
  });

  it('옛 서버의 응답은 active로 올릴 수는 있어도 내리지 않는다; 새 서버 응답은 그대로 저장', () => {
    const active = { deviceId: 'd', status: 'active' };
    expect(applyRegisterOutcome(active, { kind: 'legacy', status: 'pending' }, 0)).toBe(active);
    expect(applyRegisterOutcome({ deviceId: 'd', status: 'unregistered' }, { kind: 'legacy', status: 'active' }, 0).status).toBe('active');
    const revoked = applyRegisterOutcome(active, { kind: 'pc', orgId: ORG_A, status: 'revoked' }, 0);
    expect(revoked).toMatchObject({ status: 'active', pc: { orgId: ORG_A, status: 'revoked' } });
    expect(applyRegisterOutcome(active, { kind: 'failed' }, 0)).toBe(active);
  });

  it('게이트: pc가 있으면 그 기관의 로그인 + active일 때만; 없으면 프로필 상태', () => {
    const meta = { status: 'active', pc: { orgId: ORG_A, status: 'active' } };
    expect(emrGateDecision(meta, { userId: 'u', orgId: ORG_A }, 'active')).toEqual({ allowed: true, reason: 'ok' });
    expect(emrGateDecision(meta, { userId: 'u', orgId: ORG_B }, 'active')).toEqual({ allowed: false, reason: 'org_unconfirmed' });
    expect(emrGateDecision(meta, null, 'active')).toEqual({ allowed: false, reason: 'org_unconfirmed' });
    for (const status of ['pending', 'revoked', 'other_org']) {
      expect(emrGateDecision({ status: 'active', pc: { orgId: ORG_A, status } }, { userId: 'u', orgId: ORG_A }, 'active')).toEqual({ allowed: false, reason: status });
    }
    expect(emrGateDecision({ status: 'active' }, null, 'active')).toEqual({ allowed: true, reason: 'ok' });
    expect(emrGateDecision({ status: 'pending' }, null, 'pending')).toEqual({ allowed: false, reason: 'pending' });
    expect(emrGateDecision({ status: 'active', pc: { orgId: 1, status: 'x' } }, null, 'active').allowed).toBe(true); // 형식이 틀린 pc는 없는 것으로
  });

  it('전송 허용: pc가 있으면 pc가 active일 때, 없으면 프로필 상태', () => {
    expect(sendingAllowed({ status: 'active', pc: { orgId: ORG_A, status: 'revoked' } }, 'active')).toBe(false);
    expect(sendingAllowed({ status: 'pending', pc: { orgId: ORG_A, status: 'active' } }, 'pending')).toBe(true);
    expect(sendingAllowed({ status: 'active' }, 'active')).toBe(true);
  });

  it('등록 호출은 61초 간격·한 시간 5회를 넘지 않는다', () => {
    const login = { userId: 'u', orgId: ORG_A };
    const attempts = [];
    let t = 0;
    let calls = 0;
    for (; t < 2 * 60 * 60 * 1000; t += 1000) {
      const d = shouldRegister({ meta: { status: 'unregistered' }, login, startedFresh: true, deviceProblem: false, attempts }, t);
      if (d.register) { attempts.push(t); calls += 1; }
    }
    for (let i = 1; i < attempts.length; i += 1) expect(attempts[i] - attempts[i - 1]).toBeGreaterThanOrEqual(REGISTER_MIN_SPACING_MS);
    for (const a of attempts) expect(attempts.filter((b) => b > a - 60 * 60 * 1000 && b <= a).length).toBeLessThanOrEqual(REGISTER_MAX_PER_HOUR);
    expect(calls).toBeGreaterThan(0);
  });

  it('호출 이유: 첫 토큰 · 기관 바뀜 · 장치 문제 · 승인 대기(20분) — active이고 같은 기관이면 부르지 않는다', () => {
    const login = { userId: 'u', orgId: ORG_A };
    const active = { status: 'active', pc: { orgId: ORG_A, status: 'active' } };
    const base = { meta: active, login, startedFresh: false, deviceProblem: false, attempts: [0] };
    const later = 10 * 60 * 1000;
    expect(shouldRegister(base, later)).toEqual({ register: false });
    expect(shouldRegister({ ...base, startedFresh: true }, later)).toEqual({ register: true, reason: 'first_token' });
    expect(shouldRegister({ ...base, login: { userId: 'b', orgId: ORG_B } }, later)).toEqual({ register: true, reason: 'org_changed' });
    expect(shouldRegister({ ...base, deviceProblem: true }, later)).toEqual({ register: true, reason: 'device_problem' });
    const pending = { ...base, meta: { status: 'pending', pc: { orgId: ORG_A, status: 'pending' } } };
    expect(shouldRegister(pending, later).register).toBe(false);
    expect(shouldRegister(pending, 21 * 60 * 1000)).toEqual({ register: true, reason: 'pending_recheck' });
    expect(shouldRegister({ ...base, login: null }, later)).toEqual({ register: false });
  });
});

// ── audit.js로(가짜 electron): 서버 응답 순서대로 ─────────────────────────────

let dirs = [];
function newPc() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-device-state-'));
  dirs.push(dir);
  return dir;
}

function shell(pcDir, replies, tokenRef) {
  const requests = [];
  const send = async (req) => {
    const p = new URL(req.url).pathname;
    requests.push({ path: p, headers: req.headers });
    if (p === '/api/audit/emr') return { status: 200, body: '{"ok":true}' };
    const next = replies.shift();
    if (!next) throw new Error('no reply queued');
    const r = typeof next === 'function' ? next() : next;
    if (r instanceof Error) throw r;
    return { status: r.status, body: typeof r.body === 'string' ? r.body : JSON.stringify(r.body) };
  };
  const audit = loadShellModule(ELECTRON_DIR, 'audit.js', createFakeElectron({ userDataDir: pcDir, send }));
  const init = () => audit.initAudit({ getAccessToken: () => tokenRef.current, apiBaseUrl: 'https://server.test' });
  return { audit, init, requests, registers: () => requests.filter((r) => r.path === '/api/devices/register') };
}

const meta = (pcDir) => JSON.parse(fs.readFileSync(path.join(pcDir, 'wr-device.json'), 'utf8'));
let now = Date.parse('2026-11-24T00:00:00Z');
const advance = (ms) => { now += ms; vi.setSystemTime(now); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(now);
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

// 새 서버에서 active를 받은 PC(기관 A)를 만들고 앱을 다시 시작한다.
async function approvedPc(tokenRef) {
  const pc = newPc();
  const first = shell(pc, [pcAnswer('active')], tokenRef);
  await first.init();
  expect(first.audit.getEmrGate()).toEqual({ allowed: true, reason: 'ok' });
  advance(REGISTER_MIN_SPACING_MS);
  return pc;
}

describe('audit.js — 상태 갱신과 기관에 묶인 게이트', () => {
  it.each(FAILURES)('갱신 실패(%s)는 저장된 상태와 게이트를 바꾸지 않는다', async (_name, failure) => {
    const tokenRef = { current: tokenA };
    const pc = await approvedPc(tokenRef);
    const before = meta(pc);
    const s = shell(pc, [failure()], tokenRef);
    await s.init();
    expect(s.registers()).toHaveLength(1); // 첫 토큰 확인은 했다
    expect(meta(pc)).toEqual(before);
    expect(s.audit.getEmrGate()).toEqual({ allowed: true, reason: 'ok' });
  });

  it('새 서버의 revoked·pending·다른 기관 거부는 게이트를 닫는다(재시작 뒤 첫 토큰에서)', async () => {
    for (const [answer, reason] of [[pcAnswer('revoked'), 'revoked'], [pcAnswer('pending'), 'pending'], [otherOrgAnswer(ORG_A), 'other_org']]) {
      const tokenRef = { current: tokenA };
      const pc = await approvedPc(tokenRef);
      const s = shell(pc, [answer], tokenRef);
      await s.init();
      expect(s.audit.getEmrGate()).toEqual({ allowed: false, reason });
      advance(REGISTER_MIN_SPACING_MS);
    }
  });

  it('옛 서버가 pending을 줘도 active를 유지한다(서버를 이전 버전으로 되돌린 동안)', async () => {
    const tokenRef = { current: tokenA };
    const pc = newPc();
    const old = shell(pc, [oldServerAnswer('active')], tokenRef);
    await old.init();
    advance(REGISTER_MIN_SPACING_MS);
    const s = shell(pc, [oldServerAnswer('pending')], tokenRef);
    await s.init();
    expect(meta(pc).status).toBe('active');
    expect(meta(pc)).not.toHaveProperty('pc');
    expect(s.audit.getEmrGate()).toEqual({ allowed: true, reason: 'ok' });
  });

  it('새 서버 응답을 받기 전에는 지금처럼 프로필 전체의 상태(다른 기관 로그인도 열림)', async () => {
    const tokenRef = { current: tokenA };
    const pc = newPc();
    const old = shell(pc, [oldServerAnswer('active')], tokenRef);
    await old.init();
    tokenRef.current = tokenB;
    expect(old.audit.getEmrGate()).toEqual({ allowed: true, reason: 'ok' });
  });

  it('새 서버 응답을 받은 뒤 다른 기관으로 로그인하면 닫힌다 — 통신 오류 중에도, 그 기관의 응답이 올 때까지', async () => {
    const tokenRef = { current: tokenA };
    const pc = await approvedPc(tokenRef);
    const s = shell(pc, [pcAnswer('active'), new Error('ECONNRESET'), otherOrgAnswer(ORG_B), pcAnswer('active')], tokenRef);
    await s.init();
    expect(s.audit.getEmrGate().allowed).toBe(true);
    tokenRef.current = tokenB;
    expect(s.audit.getEmrGate()).toEqual({ allowed: false, reason: 'org_unconfirmed' });
    advance(REGISTER_MIN_SPACING_MS);
    await s.audit.tryRegister(); // 기관 바뀜 → 호출 → 통신 오류
    expect(s.audit.getEmrGate()).toEqual({ allowed: false, reason: 'org_unconfirmed' });
    advance(REGISTER_MIN_SPACING_MS);
    await s.audit.tryRegister(); // 다른 기관 거부
    expect(s.audit.getEmrGate()).toEqual({ allowed: false, reason: 'other_org' });
    tokenRef.current = tokenA;
    expect(s.audit.getEmrGate()).toEqual({ allowed: false, reason: 'org_unconfirmed' });
    advance(REGISTER_MIN_SPACING_MS);
    await s.audit.tryRegister(); // 원래 기관 → active
    expect(s.audit.getEmrGate()).toEqual({ allowed: true, reason: 'ok' });
    expect(s.registers()).toHaveLength(4);
  });

  it('같은 기관의 다른 사용자로 바뀌어도 호출하지 않고 열려 있다', async () => {
    const tokenRef = { current: tokenA };
    const pc = await approvedPc(tokenRef);
    const s = shell(pc, [pcAnswer('active')], tokenRef);
    await s.init();
    tokenRef.current = tokenA2;
    advance(REGISTER_MIN_SPACING_MS);
    await s.audit.tryRegister();
    expect(s.registers()).toHaveLength(1);
    expect(s.audit.getEmrGate().allowed).toBe(true);
  });

  it('감사 전송이 장치 문제 401을 받으면 상태를 다시 묻는다(해지 반영)', async () => {
    const tokenRef = { current: tokenA };
    const pc = await approvedPc(tokenRef);
    const replies = [pcAnswer('active'), pcAnswer('revoked')];
    const requests = [];
    const send = async (req) => {
      const p = new URL(req.url).pathname;
      requests.push(p);
      if (p === '/api/audit/emr') return { status: 401, body: '{"code":"UNAUTHORIZED","error":"Device not recognized"}' };
      const r = replies.shift();
      return { status: r.status, body: JSON.stringify(r.body) };
    };
    const audit = loadShellModule(ELECTRON_DIR, 'audit.js', createFakeElectron({ userDataDir: pc, send }));
    await audit.initAudit({ getAccessToken: () => tokenRef.current, apiBaseUrl: 'https://server.test' });
    advance(REGISTER_MIN_SPACING_MS);
    await audit.recordAudit({ action: 'emr_inject', outcome: 'success' });
    await vi.waitFor(() => expect(audit.getEmrGate()).toEqual({ allowed: false, reason: 'revoked' }));
    expect(requests.filter((p) => p === '/api/devices/register')).toHaveLength(2);
  });

  it('첫 응답을 못 받으면 61초 뒤 다시 묻는다(제한 안에서), 받으면 멈춘다', async () => {
    const tokenRef = { current: tokenA };
    const pc = newPc();
    const s = shell(pc, [{ status: 429, body: { code: 'RATE_LIMITED', error: 'x' } }, pcAnswer('pending')], tokenRef);
    await s.init();
    expect(s.registers()).toHaveLength(1);
    advance(REGISTER_MIN_SPACING_MS + 1000);
    await vi.advanceTimersByTimeAsync(REGISTER_MIN_SPACING_MS + 1000);
    await vi.waitFor(() => expect(s.registers()).toHaveLength(2));
    expect(s.audit.getEmrGate()).toEqual({ allowed: false, reason: 'pending' });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(s.registers()).toHaveLength(2);
  });
});
