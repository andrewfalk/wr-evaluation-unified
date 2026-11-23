import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { createAuditContext, stampEntry, forQueuedSend, isStampedEntry } from '../auditLogic.js';
import { readTokenIdentity } from '../accessTokenClaims.js';

// EA-7: 기록 시점 정보(occurredAt·actorUserId·eventId·shellAudit)를 동작을 시작할 때 잡아 끝까지 쓴다.
const require = createRequire(import.meta.url);
const { createFakeElectron, loadShellModule } = require('../../scripts/lib/fakeElectron.cjs');
const ELECTRON_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const jwt = (claims) => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const tokenA = jwt({ sub: 'user-a', orgId: 'org-1' });
const tokenB = jwt({ sub: 'user-b', orgId: 'org-1' });

describe('기록 시점 정보 — 순수 함수', () => {
  const deps = { now: () => new Date('2026-11-24T01:02:03.000Z'), randomUUID: () => 'evt-1', identity: readTokenIdentity };

  it('동작 시작 때의 사용자·시각·eventId', () => {
    expect(createAuditContext(tokenA, deps)).toEqual({ occurredAt: '2026-11-24T01:02:03.000Z', eventId: 'evt-1', actorUserId: 'user-a' });
    expect(createAuditContext(null, deps)).toEqual({ occurredAt: '2026-11-24T01:02:03.000Z', eventId: 'evt-1' });
    expect(createAuditContext('garbage', deps)).not.toHaveProperty('actorUserId');
  });

  it('extra에 넣고 기존 extra 값(source·corruptFile)은 그대로; 항목 형식은 그대로', () => {
    const ctx = createAuditContext(tokenA, deps);
    expect(stampEntry({ action: 'emr_inject', outcome: 'success', targetId: 't', extra: { source: 'edited' } }, ctx)).toEqual({
      action: 'emr_inject', outcome: 'success', targetId: 't',
      extra: { source: 'edited', occurredAt: ctx.occurredAt, eventId: 'evt-1', actorUserId: 'user-a', shellAudit: 2 },
    });
    expect(stampEntry({ action: 'audit_queue_corrupt', outcome: 'failure', extra: { corruptFile: 'f.bin' } }, ctx).extra.corruptFile).toBe('f.bin');
  });

  it('대기열에서 나갈 때: 이 설치본의 항목만 queued: true, 이전 형식은 손대지 않는다', () => {
    const stamped = stampEntry({ action: 'emr_inject', outcome: 'success' }, createAuditContext(tokenA, deps));
    expect(isStampedEntry(stamped)).toBe(true);
    expect(forQueuedSend(stamped).extra.queued).toBe(true);
    const legacy = { action: 'emr_inject', outcome: 'success', extra: { source: 'auto' } };
    expect(forQueuedSend(legacy)).toBe(legacy);
  });
});

// ── audit.js로(가짜 electron) ────────────────────────────────────────────────

let dirs = [];
function setup({ registerStatus = 'active', auditStatus = () => 200 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wr-audit-ctx-'));
  dirs.push(dir);
  const sent = [];
  const send = async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/api/devices/register') {
      return { status: 200, body: JSON.stringify({ deviceId: 'srv', status: registerStatus, deviceScope: 'pc', organizationId: 'org-1' }) };
    }
    const body = JSON.parse(req.body.toString('utf8'));
    sent.push({ body, auth: req.headers.Authorization ?? null });
    const status = auditStatus(body);
    return { status, body: status === 200 ? '{"ok":true}' : '{"code":"X","error":"x"}' };
  };
  const fake = createFakeElectron({ userDataDir: dir, send });
  const audit = loadShellModule(ELECTRON_DIR, 'audit.js', fake);
  const queue = require(path.join(ELECTRON_DIR, 'auditQueue.js'));
  const lines = () => (fs.existsSync(path.join(dir, 'audit-emr-pending.enc'))
    ? fs.readFileSync(path.join(dir, 'audit-emr-pending.enc'), 'utf8').split('\n').filter(Boolean)
      .map((l) => JSON.parse(fake.safeStorage.decryptString(Buffer.from(l.slice(4), 'base64'))))
    : []);
  return { audit, queue, sent, lines };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});

describe('audit.js — 기록 시점 정보', () => {
  it('동작 도중 사용자가 바뀌어도 시작한 사용자로 기록한다(전송 토큰은 지금 토큰)', async () => {
    const tokenRef = { current: tokenA };
    const { audit, sent } = setup();
    await audit.initAudit({ getAccessToken: () => tokenRef.current, apiBaseUrl: 'https://server.test' });
    const ctx = audit.captureAuditContext();
    tokenRef.current = tokenB; // 헬퍼가 도는 동안 계정 전환
    await audit.recordAudit({ action: 'emr_extract_record', outcome: 'success', targetId: 't' }, ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].body.extra).toEqual({ occurredAt: ctx.occurredAt, eventId: ctx.eventId, actorUserId: 'user-a', shellAudit: 2 });
    expect(sent[0].auth).toBe(`Bearer ${tokenB}`);
  });

  it('토큰이 없을 때 시작한 동작은 행위자 없이(서버가 대체 행위자를 정함), 토큰 없이 보낸다', async () => {
    const tokenRef = { current: tokenA };
    const { audit, sent } = setup();
    await audit.initAudit({ getAccessToken: () => tokenRef.current, apiBaseUrl: 'https://server.test' });
    tokenRef.current = null;
    await audit.recordAudit({ action: 'emr_inject', outcome: 'failure' });
    expect(sent[0].body.extra).not.toHaveProperty('actorUserId');
    expect(sent[0].body.extra).not.toHaveProperty('session_missing');
    expect(sent[0].body.extra).toMatchObject({ shellAudit: 2 });
    expect(sent[0].auth).toBeNull();
  });

  it('대기열을 거친 기록은 시작 때의 사용자·시각을 그대로 갖고 queued: true로 나간다; 이전 형식 줄은 손대지 않는다', async () => {
    const tokenRef = { current: tokenA };
    let accept = false;
    const { audit, queue, sent, lines } = setup({ auditStatus: () => (accept ? 200 : 503) });
    await audit.initAudit({ getAccessToken: () => tokenRef.current, apiBaseUrl: 'https://server.test' });
    queue.enqueue({ action: 'emr_inject', outcome: 'success', extra: { source: 'auto' } }); // 이전 설치본이 남긴 줄
    const ctx = audit.captureAuditContext();
    await audit.recordAudit({ action: 'emr_extract_record', outcome: 'success', targetId: 'x', extra: { source: 'edited' } }, ctx); // 503 → 대기열
    expect(lines()).toHaveLength(2);
    expect(lines()[1].extra).toEqual({ source: 'edited', occurredAt: ctx.occurredAt, eventId: ctx.eventId, actorUserId: 'user-a', shellAudit: 2 });

    tokenRef.current = tokenB;
    accept = true;
    sent.length = 0;
    await audit.flushQueue();
    expect(sent.map((s) => s.body)).toEqual([
      { action: 'emr_inject', outcome: 'success', extra: { source: 'auto' } },
      { action: 'emr_extract_record', outcome: 'success', targetId: 'x',
        extra: { source: 'edited', occurredAt: ctx.occurredAt, eventId: ctx.eventId, actorUserId: 'user-a', shellAudit: 2, queued: true } },
    ]);
    expect(lines()).toEqual([]);
  });

  it('승인 전(대기)에 쌓인 기록도 시작 때의 값을 지닌다', async () => {
    const tokenRef = { current: tokenA };
    const { audit, lines } = setup({ registerStatus: 'pending' });
    await audit.initAudit({ getAccessToken: () => tokenRef.current, apiBaseUrl: 'https://server.test' });
    const ctx = audit.captureAuditContext();
    await audit.recordAudit({ action: 'emr_extract_consultation', outcome: 'success' }, ctx);
    expect(lines()).toEqual([{ action: 'emr_extract_consultation', outcome: 'success', extra: { occurredAt: ctx.occurredAt, eventId: ctx.eventId, actorUserId: 'user-a', shellAudit: 2 } }]);
  });
});
