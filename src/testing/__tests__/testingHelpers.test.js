// src/testing 헬퍼 자체 검사(REFACTORING_ROADMAP Phase 2 P2-02).
import { describe, expect, it } from 'vitest';
import surface from '../fixtures/legacyShellSurface.json';
import golden from '../../../electron/__tests__/__goldens__/preload-surface.json';
import { legacyShellKeys, makeBridgeStub } from '../bridgeStub';
import { createFetchRouter } from '../fetchRouter';

describe('legacyShellSurface.json (구 셸 표면 고정)', () => {
  // 구 셸 = 현장 설치본(E0 전). 새 셸 표면(G10 골든)은 Phase 2 동안 키를 "추가만" 한다 —
  // 구 셸 키가 골든에서 빠지면 현장 설치본이 새 화면에서 기대하는 키가 사라진 것이다.
  it.each(['intranet', 'standalone'])('%s: every legacy key is still on the current preload surface', (target) => {
    const current = Object.keys(golden[`preload-${target}.js`]);
    expect(current).toEqual(expect.arrayContaining(legacyShellKeys(target)));
  });

  it('records the kind of every key', () => {
    for (const target of ['intranet', 'standalone']) {
      for (const kind of Object.values(surface[target])) expect(['invoke', 'send', 'subscribe', 'value']).toContain(kind);
    }
  });
});

describe('makeBridgeStub', () => {
  it('exposes exactly the legacy keys (+ buildTarget only when given)', () => {
    expect(Object.keys(makeBridgeStub('intranet')).sort()).toEqual(legacyShellKeys('intranet').sort());
    expect(makeBridgeStub('standalone', { buildTarget: 'standalone' }).buildTarget).toBe('standalone');
    expect('buildTarget' in makeBridgeStub('standalone')).toBe(false);
  });

  it('records calls, resolves invokes, and emits to subscribers', async () => {
    const bridge = makeBridgeStub('standalone', { overrides: { fsLoadSettings: async () => ({ a: 1 }) } });
    await expect(bridge.fsLoadSettings()).resolves.toEqual({ a: 1 });
    await expect(bridge.fsLoadAutoSave()).resolves.toBeUndefined();
    const seen = [];
    const off = bridge.onMenuNew((...args) => seen.push(args));
    bridge.__emit('onMenuNew', 'x');
    off();
    bridge.__emit('onMenuNew', 'y');
    expect(seen).toEqual([['x']]);
    expect(bridge.__callsOf('fsLoadSettings')).toEqual([[]]);
  });

  it('a subscribe override replaces the subscription (its unsubscribe is returned as is)', () => {
    const off = () => 'off';
    const custom = (listener) => { custom.listener = listener; return off; };
    const bridge = makeBridgeStub('standalone', { overrides: { onMenuNew: custom } });
    const handler = () => {};
    expect(bridge.onMenuNew(handler)).toBe(off);
    expect(custom.listener).toBe(handler);
    expect(bridge.__callsOf('onMenuNew')).toEqual([[]]);
  });

  it('rejects overrides for keys the legacy shell does not have', () => {
    expect(() => makeBridgeStub('intranet', { overrides: { fsLoadSettings: () => null } })).toThrow(/not on the intranet shell surface/);
  });
});

describe('createFetchRouter', () => {
  it('answers registered routes, counts calls, and rejects + records the rest', async () => {
    const router = createFetchRouter({
      'GET /api/config/public': { mode: 'intranet' },
      'POST /api/auth/csrf': (req) => ({ status: 401, body: { seen: req.body } }),
    });
    const ok = await router.fetch('https://srv.test/api/config/public?x=1');
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ mode: 'intranet' });
    const denied = await router.fetch('/api/auth/csrf', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toEqual({ seen: { a: 1 } });
    await expect(router.fetch('/api/nope')).rejects.toThrow(TypeError);
    expect(router.unhandled).toEqual(['GET /api/nope']);
    expect(router.count('POST /api/auth/csrf')).toBe(1);
  });

  it('accepts URL objects and Request objects like fetch does', async () => {
    const router = createFetchRouter({ 'GET /api/config/public': { ok: 1 }, 'POST /api/x': { ok: 2 } });
    await expect((await router.fetch(new URL('https://srv.test/api/config/public'))).json()).resolves.toEqual({ ok: 1 });
    await expect((await router.fetch(new Request('https://srv.test/api/x', { method: 'POST' }))).json()).resolves.toEqual({ ok: 2 });
    expect(router.unhandled).toEqual([]);
  });

  it('reads body and headers from a Request unless init overrides them', async () => {
    const router = createFetchRouter({ 'POST /api/x': (req) => ({ body: { body: req.body, auth: req.headers.authorization ?? req.headers.Authorization } }) });
    const request = new Request('https://srv.test/api/x', { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { Authorization: 'Bearer t' } });
    await expect((await router.fetch(request)).json()).resolves.toEqual({ body: { a: 1 }, auth: 'Bearer t' });
    const overridden = await router.fetch(new Request('https://srv.test/api/x', { method: 'POST', body: '{"a":1}' }), { body: '{"b":2}', headers: { Authorization: 'Bearer u' } });
    await expect(overridden.json()).resolves.toEqual({ body: { b: 2 }, auth: 'Bearer u' });
  });

  it('matches `:param` patterns after exact keys', async () => {
    const router = createFetchRouter({
      'POST /api/patients/:id/lock': (req) => ({ body: { id: req.params.id } }),
      'POST /api/patients/special/lock': { exact: true },
    });
    await expect((await router.fetch('/api/patients/p%201/lock', { method: 'POST' })).json()).resolves.toEqual({ id: 'p 1' });
    await expect((await router.fetch('/api/patients/special/lock', { method: 'POST' })).json()).resolves.toEqual({ exact: true });
    await expect(router.fetch('/api/patients/p1/lock/x', { method: 'POST' })).rejects.toThrow(TypeError);
    expect(router.count('POST /api/patients/:id/lock')).toBe(1);
  });
});

describe('FakeBroadcastChannel', () => {
  it('delivers asynchronously to other instances with the same name only (not to itself, not after close)', async () => {
    const { FakeBroadcastChannel } = await import('../fakeBroadcastChannel');
    const a = new FakeBroadcastChannel('wr-test');
    const b = new FakeBroadcastChannel('wr-test');
    const other = new FakeBroadcastChannel('wr-other');
    const seen = { a: [], b: [], other: [] };
    a.addEventListener('message', (e) => seen.a.push(e.data));
    b.onmessage = (e) => seen.b.push(e.data);
    other.addEventListener('message', (e) => seen.other.push(e.data));
    const payload = { type: 'LOGOUT', nested: { x: 1 } };
    a.postMessage(payload);
    expect(seen.b).toEqual([]); // async
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual({ a: [], b: [{ type: 'LOGOUT', nested: { x: 1 } }], other: [] });
    expect(seen.b[0]).not.toBe(payload); // structured clone
    b.close();
    a.postMessage({ type: 'X' });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.b).toHaveLength(1);
    a.close();
    other.close();
  });
});
