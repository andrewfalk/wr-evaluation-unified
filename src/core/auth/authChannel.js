// Cross-tab auth coordination via BroadcastChannel + localStorage lock.
//
// Lock protocol (read-back CAS):
//   tryAcquireLock() writes { ownerId, expiresAt } then immediately re-reads
//   to confirm ownership. If another tab overwrote the entry between the
//   write and read-back the lock is considered lost and the tab falls into
//   the broadcast-wait path instead.
//
// Missed-broadcast recovery:
//   The lock holder writes the result to RESULT_KEY before broadcasting.
//   A waiter checks RESULT_KEY first so a message that arrived before the
//   listener was registered is not missed.
//
// BroadcastChannel fallback:
//   When BroadcastChannel is unavailable the waiter polls RESULT_KEY every
//   500 ms until the result appears or the lock TTL expires.
//
// Security note: RESULT_KEY stores the access token in localStorage for up
//   to 30 s. This is intentional and acceptable for same-origin intranet
//   deployments protected by strict CSP (connect-src 'self').

const TAB_ID = Math.random().toString(36).slice(2, 10);
const LOCK_KEY = 'wr-auth-refresh-lock';
const RESULT_KEY = 'wr-auth-refresh-result';
const LOCK_TTL_MS = 10_000;
const RESULT_TTL_MS = 30_000;
const WAIT_TIMEOUT_MS = 12_000; // slightly longer than LOCK_TTL so expiry fires first
const POLL_INTERVAL_MS = 500;

const _ch = (() => {
  if (typeof BroadcastChannel === 'undefined') return null;
  try { return new BroadcastChannel('wr-auth'); }
  catch { return null; }
})();

// --- Lock helpers ---

function tryAcquireLock() {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const existing = raw ? JSON.parse(raw) : null;
    if (existing && existing.ownerId !== TAB_ID && existing.expiresAt > Date.now()) {
      return false; // valid lock held by another tab
    }
    localStorage.setItem(LOCK_KEY, JSON.stringify({
      ownerId: TAB_ID,
      expiresAt: Date.now() + LOCK_TTL_MS,
    }));
    // Read-back verification: if another tab won the simultaneous write race
    // the entry will have a different ownerId — treat that as lock loss.
    const readBack = localStorage.getItem(LOCK_KEY);
    const confirmed = readBack ? JSON.parse(readBack) : null;
    return confirmed?.ownerId === TAB_ID;
  } catch {
    return true; // localStorage unavailable — proceed without lock
  }
}

function releaseLock() {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const confirmed = raw ? JSON.parse(raw) : null;
    if (confirmed?.ownerId === TAB_ID) localStorage.removeItem(LOCK_KEY);
  } catch (_e) {
    // localStorage unavailable — lock will expire via TTL
  }
}

// --- Result storage (missed-broadcast recovery) ---

function storeResult(accessToken) {
  try {
    localStorage.setItem(RESULT_KEY, JSON.stringify({
      accessToken,
      expiresAt: Date.now() + RESULT_TTL_MS,
    }));
  } catch (_e) { /* best-effort */ }
}

function checkStoredResult() {
  try {
    const raw = localStorage.getItem(RESULT_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw);
    return r.expiresAt > Date.now() ? r.accessToken : null;
  } catch {
    return null;
  }
}

function isLockExpired() {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return true;
    return JSON.parse(raw).expiresAt <= Date.now();
  } catch {
    return true;
  }
}

// --- Wait helpers ---

// Polling fallback for environments without BroadcastChannel.
function pollForResult() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    const interval = setInterval(() => {
      const accessToken = checkStoredResult();
      if (accessToken) {
        clearInterval(interval);
        resolve(accessToken);
        return;
      }
      if (isLockExpired() || Date.now() >= deadline) {
        clearInterval(interval);
        reject(new Error('Lock expired without broadcast result'));
      }
    }, POLL_INTERVAL_MS);
  });
}

// Waits for the lock-holding tab to broadcast its result.
// Checks RESULT_KEY first so a message that arrived before the listener was
// registered (tiny race between tryAcquireLock and addEventListener) is caught.
function waitForRefreshBroadcast() {
  const stored = checkStoredResult();
  if (stored) return Promise.resolve(stored);

  if (!_ch) return pollForResult();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      _ch.removeEventListener('message', onMsg);
      reject(new Error('Cross-tab refresh timeout'));
    }, WAIT_TIMEOUT_MS);

    function onMsg(e) {
      if (e.data?.type !== 'REFRESH_SUCCESS' && e.data?.type !== 'REFRESH_FAILURE') return;
      clearTimeout(timer);
      _ch.removeEventListener('message', onMsg);
      if (e.data.type === 'REFRESH_SUCCESS') resolve(e.data.accessToken);
      else reject(new Error('Refresh failed in another tab'));
    }

    _ch.addEventListener('message', onMsg);
  });
}

// --- Public API ---

// Within-tab in-flight lock: concurrent requests in the same tab share one refresh.
let _inFlightRefresh = null;

// Full cross-tab coordination:
//   doRefresh()          — called by the tab that won the lock; returns newSession
//   applyToken(token)    — called by waiting tabs on REFRESH_SUCCESS; returns newSession
export async function runRefreshWithBroadcast(doRefresh, applyToken) {
  if (_inFlightRefresh) return _inFlightRefresh;

  _inFlightRefresh = (async () => {
    let hasLock = tryAcquireLock();

    if (!hasLock) {
      // Another tab holds the lock — wait for its broadcast.
      try {
        const accessToken = await waitForRefreshBroadcast();
        return applyToken(accessToken);
      } catch {
        // Timed out or other tab failed — attempt takeover.
        hasLock = tryAcquireLock();
        if (!hasLock) throw new Error('Refresh lock unavailable after timeout');
        // Fall through to run doRefresh below.
      }
    }

    // This tab holds the lock — perform the refresh.
    try {
      const newSession = await doRefresh();
      // Store before broadcast so waiters that missed the message find it.
      storeResult(newSession.accessToken);
      _ch?.postMessage({ type: 'REFRESH_SUCCESS', accessToken: newSession.accessToken });
      return newSession;
    } catch (err) {
      _ch?.postMessage({ type: 'REFRESH_FAILURE' });
      throw err;
    } finally {
      releaseLock();
    }
  })().finally(() => { _inFlightRefresh = null; });

  return _inFlightRefresh;
}

// Subscribe to auth events from other tabs. Returns an unsubscribe function.
export function onAuthBroadcast(handler) {
  if (!_ch) return () => {};
  const listener = (e) => handler(e.data);
  _ch.addEventListener('message', listener);
  return () => _ch.removeEventListener('message', listener);
}

export function broadcastLogout() {
  _ch?.postMessage({ type: 'LOGOUT' });
}
