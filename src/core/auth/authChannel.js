// Cross-tab auth coordination.
//
// Primary:  navigator.locks  — true mutual exclusion, no race window.
// Fallback: localStorage CAS — best-effort; TOCTOU window is tiny and
//           the server's 30 s grace window (T09) absorbs the rare double-refresh.
//
// Security: access tokens are NEVER written to localStorage.
//   SIGNAL_KEY stores only { status, completedAt } — no token.
//   Tokens travel exclusively via BroadcastChannel payload (in-memory delivery).

const TAB_ID = Math.random().toString(36).slice(2, 10);
const LOCK_NAME = 'wr-auth-refresh';       // navigator.locks key
const LOCK_KEY = 'wr-auth-refresh-lock';   // localStorage fallback key
const SIGNAL_KEY = 'wr-auth-refresh-sig';  // { status:'success'|'failure', completedAt } — no token
const LOCK_TTL_MS = 10_000;
const WAIT_TIMEOUT_MS = 12_000;
const POLL_INTERVAL_MS = 300;
const SIGNAL_TTL_MS = 5_000;

const _ch = (() => {
  if (typeof BroadcastChannel === 'undefined') return null;
  try { return new BroadcastChannel('wr-auth'); }
  catch { return null; }
})();

// --- Signal helpers (status only, no token) ---

function storeSignal(status) {
  try {
    localStorage.setItem(SIGNAL_KEY, JSON.stringify({ status, completedAt: Date.now() }));
  } catch (_e) { /* best-effort */ }
}

function checkRecentSuccess() {
  try {
    const raw = localStorage.getItem(SIGNAL_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    return s.status === 'success' && (Date.now() - s.completedAt) < SIGNAL_TTL_MS;
  } catch { return false; }
}

// --- localStorage lock helpers (fallback only) ---

function tryAcquireLock() {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const existing = raw ? JSON.parse(raw) : null;
    if (existing && existing.ownerId !== TAB_ID && existing.expiresAt > Date.now()) return false;
    localStorage.setItem(LOCK_KEY, JSON.stringify({ ownerId: TAB_ID, expiresAt: Date.now() + LOCK_TTL_MS }));
    // Read-back CAS: verify we were not overwritten in the write race
    const readBack = localStorage.getItem(LOCK_KEY);
    const confirmed = readBack ? JSON.parse(readBack) : null;
    return confirmed?.ownerId === TAB_ID;
  } catch { return true; } // localStorage unavailable — proceed without lock
}

function releaseLock() {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const confirmed = raw ? JSON.parse(raw) : null;
    if (confirmed?.ownerId === TAB_ID) localStorage.removeItem(LOCK_KEY);
  } catch (_e) { /* lock expires via TTL */ }
}

function isLockFree() {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return true;
    return JSON.parse(raw).expiresAt <= Date.now();
  } catch { return true; }
}

// --- Broadcast wait ---

// Returns a promise that resolves with the new auth update from another tab.
// Token comes ONLY from the BroadcastChannel message — never from localStorage.
function waitForRefreshBroadcast(timeoutMs = WAIT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!_ch) { reject(new Error('BroadcastChannel unavailable')); return; }

    const timer = setTimeout(() => {
      _ch.removeEventListener('message', onMsg);
      reject(new Error('Cross-tab refresh timeout'));
    }, timeoutMs);

    function onMsg(e) {
      if (e.data?.type !== 'REFRESH_SUCCESS' && e.data?.type !== 'REFRESH_FAILURE') return;
      clearTimeout(timer);
      _ch.removeEventListener('message', onMsg);
      if (e.data.type === 'REFRESH_SUCCESS') {
        resolve({
          accessToken:     e.data.accessToken,
          accessExpiresAt: e.data.accessExpiresAt,
          user:            e.data.user,
        });
      }
      else reject(new Error('Refresh failed in another tab'));
    }

    _ch.addEventListener('message', onMsg);
  });
}

function postRefreshSuccess(session) {
  _ch?.postMessage({
    type:            'REFRESH_SUCCESS',
    accessToken:     session?.accessToken,
    accessExpiresAt: session?.accessExpiresAt,
    user:            session?.user,
  });
}

// Polls until the lock is released or the deadline passes (no-BC fallback).
function pollUntilLockFree() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    const id = setInterval(() => {
      if (isLockFree() || Date.now() >= deadline) {
        clearInterval(id);
        if (isLockFree()) resolve();
        else reject(new Error('Polling timeout'));
      }
    }, POLL_INTERVAL_MS);
  });
}

// --- Lock-path implementations ---

async function runWithNavigatorLocks(doRefresh, applyToken) {
  let needsWait = false;
  let newSession = null;
  let lockError = null;

  try {
    await navigator.locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) { needsWait = true; return; } // another tab holds the lock
      newSession = await doRefresh();
      storeSignal('success');
      postRefreshSuccess(newSession);
    });
  } catch (err) {
    // doRefresh() failed — we held the lock
    lockError = err;
    _ch?.postMessage({ type: 'REFRESH_FAILURE' });
    storeSignal('failure');
  }

  if (needsWait) {
    // Another tab holds the lock. Check if it already completed (tiny BC miss window).
    if (checkRecentSuccess()) {
      try {
        const authUpdate = await waitForRefreshBroadcast(1500);
        return applyToken(authUpdate);
      } catch { /* broadcast missed — fall through to own refresh */ }
    }
    // Lock holder is still running — wait for its broadcast.
    try {
      const authUpdate = await waitForRefreshBroadcast();
      return applyToken(authUpdate);
    } catch {
      // Timeout or holder failed — do own refresh (lock now released).
      try {
        const session = await doRefresh();
        storeSignal('success');
        postRefreshSuccess(session);
        return session;
      } catch (err) {
        storeSignal('failure');
        _ch?.postMessage({ type: 'REFRESH_FAILURE' });
        throw err;
      }
    }
  }

  if (lockError) throw lockError;
  return newSession;
}

async function runWithLocalStorageLock(doRefresh, applyToken) {
  let hasLock = tryAcquireLock();

  if (!hasLock) {
    if (_ch) {
      // Medium fix: check signal first — lock holder may have already broadcast
      // before we registered a listener. If signal says success, try a short BC
      // wait to catch any in-flight message; on miss, fall through to own refresh
      // (T09 grace window means re-using the new cookies will succeed).
      if (checkRecentSuccess()) {
        try {
          const authUpdate = await waitForRefreshBroadcast(1500);
          return applyToken(authUpdate);
        } catch { /* broadcast already passed — fall through to own refresh */ }
      } else {
        try {
          const authUpdate = await waitForRefreshBroadcast();
          return applyToken(authUpdate);
        } catch { /* timeout/failure — attempt takeover */ }
      }
    } else {
      // No BC: wait for lock to free, then do own refresh (server grace window).
      try { await pollUntilLockFree(); } catch { /* proceed */ }
    }
    hasLock = tryAcquireLock(); // takeover attempt (lock may have expired)

    // Another tab still holds a valid lock — wait one more cycle before giving up.
    // Throwing here (not broadcasting FAILURE) means only this request fails;
    // the caller's 401 retry logic will re-enter runRefreshWithBroadcast once the
    // lock holder finishes, avoiding a spurious logout.
    if (!hasLock) {
      try { await pollUntilLockFree(); } catch { /* proceed to final attempt */ }
      hasLock = tryAcquireLock();
      if (!hasLock) {
        const coordErr = new Error('Auth coordination: lock unavailable after wait');
        coordErr.retryable = true;
        throw coordErr;
      }
    }
  }

  try {
    const newSession = await doRefresh();
    storeSignal('success');
    postRefreshSuccess(newSession);
    return newSession;
  } catch (err) {
    // TOCTOU: another tab may have raced us and already succeeded. Its Set-Cookie
    // is now in the browser jar, so a single recovery doRefresh() will pass with
    // the new cookies — without needing the token from the broadcast (which already
    // passed). One retry only to prevent infinite loops.
    if (checkRecentSuccess()) {
      try {
        const recoverySession = await doRefresh();
        storeSignal('success');
        postRefreshSuccess(recoverySession);
        return recoverySession;
      } catch { /* recovery also failed — proceed to broadcast failure */ }
    }
    storeSignal('failure');
    _ch?.postMessage({ type: 'REFRESH_FAILURE' });
    throw err;
  } finally {
    if (hasLock) releaseLock();
  }
}

// --- Public API ---

let _inFlightRefresh = null;

// Full cross-tab refresh coordination with within-tab deduplication.
//   doRefresh()       — called by the tab that wins the lock; returns newSession
//   applyToken(update) — called by waiting tabs on REFRESH_SUCCESS; returns newSession
export async function runRefreshWithBroadcast(doRefresh, applyToken) {
  if (_inFlightRefresh) return _inFlightRefresh;

  const run =
    typeof navigator !== 'undefined' && typeof navigator.locks?.request === 'function'
      ? () => runWithNavigatorLocks(doRefresh, applyToken)
      : () => runWithLocalStorageLock(doRefresh, applyToken);

  _inFlightRefresh = run().finally(() => { _inFlightRefresh = null; });
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
