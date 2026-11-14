// @vitest-environment jsdom
//
// T5 — authChannel 탭 간 refresh 조정 특성화(REFACTORING_ROADMAP Phase 2 P2-06, 보안 묶음 "authChannel 탭 간
// refresh 락 테스트" 겸함). 지금까지는 useAuthSync.test.jsx가 간접으로만 덮었다.
//
// 탭 = authChannel 모듈 인스턴스 하나(vi.resetModules 뒤 다시 import → TAB_ID·BroadcastChannel이 따로 생김).
// 같은 origin이므로 localStorage(jsdom)와 BroadcastChannel('wr-auth')(이 파일 안의 가짜 — 아래)는 두 탭이 공유한다.
// navigator.locks는 jsdom에 없어서 ifAvailable만 흉내 내는 최소 구현을 두 탭이 공유하게 설치한다.
//
// 지키는 것: ① 동시 refresh는 한 탭만 서버를 부르고 나머지는 브로드캐스트로 토큰을 받는다(locks·CAS 두 경로)
// ② 보유 탭 실패 → 대기 탭이 직접 refresh ③ 같은 탭 안 중복 호출은 1회 ④ localStorage에는 토큰을 쓰지 않는다
// ⑤ CAS 락 TTL(10초)이 지나면 넘겨받는다 ⑥ 키 이름(탭 간 프로토콜 — 구·신 번들 탭이 섞여도 같아야 함).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeBroadcastChannel } from '../../../testing/fakeBroadcastChannel';

// Node 내장 BroadcastChannel은 vitest의 다른 worker(다른 테스트 파일)에도 전달된다 — 여기서 보내는 LOGOUT이 동시에 도는
// 앱 테스트를 로그아웃시키지 않도록 이 파일 안에서만 오가는 가짜를 쓴다(authChannel import 전에 설치 — openTab이 동적 import).
installFakeBroadcastChannel();

const LOCK_KEY = 'wr-auth-refresh-lock';
const SIGNAL_KEY = 'wr-auth-refresh-sig';

function installFakeLocks() {
  const held = new Set();
  navigator.locks = {
    async request(name, options, callback) {
      if (options?.ifAvailable && held.has(name)) return callback(null);
      held.add(name);
      try { return await callback({ name }); }
      finally { held.delete(name); }
    },
  };
}

async function openTab() {
  vi.resetModules();
  return import('../authChannel.js');
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const SESSION = { accessToken: 'tok-new', accessExpiresAt: '2099-01-01T00:00:00.000Z', user: { id: 'u1' } };

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  delete navigator.locks;
  vi.useRealTimers();
});

describe('navigator.locks 경로', () => {
  beforeEach(() => installFakeLocks());

  it('두 탭이 동시에 refresh하면 서버 호출은 1회, 대기 탭은 브로드캐스트 토큰을 적용한다', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const gate = deferred();
    const doRefreshA = vi.fn(async () => { await gate.promise; return SESSION; });
    const doRefreshB = vi.fn(async () => ({ accessToken: 'tok-B' }));
    const applyB = vi.fn((update) => ({ applied: update }));

    const a = tabA.runRefreshWithBroadcast(doRefreshA, vi.fn());
    await tick();
    const b = tabB.runRefreshWithBroadcast(doRefreshB, applyB);
    await tick();
    gate.resolve();

    await expect(a).resolves.toBe(SESSION);
    await expect(b).resolves.toEqual({ applied: { accessToken: 'tok-new', accessExpiresAt: SESSION.accessExpiresAt, user: { id: 'u1' } } });
    expect(doRefreshA).toHaveBeenCalledTimes(1);
    expect(doRefreshB).not.toHaveBeenCalled();
  });

  it('보유 탭이 실패하면(REFRESH_FAILURE) 대기 탭이 직접 refresh한다', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const gate = deferred();
    const a = tabA.runRefreshWithBroadcast(async () => { await gate.promise; throw new Error('401'); }, vi.fn());
    await tick();
    const doRefreshB = vi.fn(async () => ({ accessToken: 'tok-B' }));
    const b = tabB.runRefreshWithBroadcast(doRefreshB, vi.fn());
    await tick();
    gate.resolve();
    await expect(a).rejects.toThrow('401');
    await expect(b).resolves.toEqual({ accessToken: 'tok-B' });
    expect(doRefreshB).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(SIGNAL_KEY)).status).toBe('success');
  });

  it('같은 탭 안의 중복 호출은 진행 중인 refresh 하나를 공유한다', async () => {
    const tab = await openTab();
    const gate = deferred();
    const doRefresh = vi.fn(async () => { await gate.promise; return SESSION; });
    const p1 = tab.runRefreshWithBroadcast(doRefresh, vi.fn());
    const p2 = tab.runRefreshWithBroadcast(doRefresh, vi.fn());
    gate.resolve();
    // async 함수라 바깥 Promise 객체는 다르지만 같은 진행 중 refresh의 결과를 받는다.
    await expect(p1).resolves.toBe(SESSION);
    await expect(p2).resolves.toBe(SESSION);
    expect(doRefresh).toHaveBeenCalledTimes(1);
    // 끝난 뒤에는 새로 refresh한다
    await tab.runRefreshWithBroadcast(doRefresh, vi.fn());
    expect(doRefresh).toHaveBeenCalledTimes(2);
  });

  it('localStorage 신호에는 상태와 시각만 — 토큰은 쓰지 않는다', async () => {
    const tab = await openTab();
    await tab.runRefreshWithBroadcast(async () => SESSION, vi.fn());
    const all = Object.keys(localStorage).map((k) => localStorage.getItem(k)).join('\n');
    expect(all).not.toContain('tok-new');
    expect(Object.keys(JSON.parse(localStorage.getItem(SIGNAL_KEY))).sort()).toEqual(['completedAt', 'status']);
    expect(localStorage.getItem(LOCK_KEY)).toBeNull(); // locks 경로는 CAS 키를 쓰지 않는다
  });
});

describe('localStorage CAS 폴백(navigator.locks 없음)', () => {
  it('두 탭이 동시에 refresh하면 서버 호출은 1회, 대기 탭은 브로드캐스트 토큰을 적용한다', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const gate = deferred();
    const doRefreshA = vi.fn(async () => { await gate.promise; return SESSION; });
    const doRefreshB = vi.fn(async () => ({ accessToken: 'tok-B' }));
    const a = tabA.runRefreshWithBroadcast(doRefreshA, vi.fn());
    await tick();
    const lock = JSON.parse(localStorage.getItem(LOCK_KEY));
    expect(Object.keys(lock).sort()).toEqual(['expiresAt', 'ownerId']);
    expect(lock.expiresAt - Date.now()).toBeGreaterThan(9_000); // TTL 10초
    const b = tabB.runRefreshWithBroadcast(doRefreshB, (update) => ({ applied: update.accessToken }));
    await tick();
    gate.resolve();
    await expect(a).resolves.toBe(SESSION);
    await expect(b).resolves.toEqual({ applied: 'tok-new' });
    expect(doRefreshB).not.toHaveBeenCalled();
    expect(localStorage.getItem(LOCK_KEY)).toBeNull(); // 보유 탭이 풀었다
  });

  it('다른 탭의 만료된 락(TTL 경과)은 바로 넘겨받는다', async () => {
    const tab = await openTab();
    localStorage.setItem(LOCK_KEY, JSON.stringify({ ownerId: 'dead-tab', expiresAt: Date.now() - 1 }));
    const doRefresh = vi.fn(async () => SESSION);
    await expect(tab.runRefreshWithBroadcast(doRefresh, vi.fn())).resolves.toBe(SESSION);
    expect(doRefresh).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LOCK_KEY)).toBeNull();
  });

  it('실패하면 failure 신호를 남기고 오류를 그대로 던진다', async () => {
    const tab = await openTab();
    await expect(tab.runRefreshWithBroadcast(async () => { throw new Error('Refresh failed'); }, vi.fn())).rejects.toThrow('Refresh failed');
    expect(JSON.parse(localStorage.getItem(SIGNAL_KEY)).status).toBe('failure');
    expect(localStorage.getItem(LOCK_KEY)).toBeNull();
  });

  it('살아 있는 다른 탭 락 + 브로드캐스트 없음 → 대기 시간(12초) 뒤 넘겨받아 직접 refresh', async () => {
    const tab = await openTab();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    localStorage.setItem(LOCK_KEY, JSON.stringify({ ownerId: 'other-tab', expiresAt: Date.now() + 10_000 }));
    const doRefresh = vi.fn(async () => SESSION);
    const p = tab.runRefreshWithBroadcast(doRefresh, vi.fn());
    await vi.advanceTimersByTimeAsync(11_000);
    expect(doRefresh).not.toHaveBeenCalled(); // 아직 브로드캐스트 대기 중(12초)
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(p).resolves.toBe(SESSION);
    expect(doRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('브로드캐스트 구독', () => {
  it('broadcastLogout은 다른 탭의 onAuthBroadcast에 LOGOUT으로 도착한다(자기 탭에는 오지 않음)', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const seenA = [];
    const seenB = [];
    const offA = tabA.onAuthBroadcast((m) => seenA.push(m));
    const offB = tabB.onAuthBroadcast((m) => seenB.push(m));
    tabA.broadcastLogout();
    await tick();
    expect(seenB).toEqual([{ type: 'LOGOUT' }]);
    expect(seenA).toEqual([]);
    offB();
    tabA.broadcastLogout();
    await tick();
    expect(seenB).toHaveLength(1);
    offA();
  });
});
