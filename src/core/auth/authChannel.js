// Cross-tab auth coordination via BroadcastChannel + localStorage lock.
//
// Lock protocol (best-effort CAS):
//   tryAcquireLock() writes { ownerId, expiresAt } to localStorage only when
//   no valid lock exists. JS is single-threaded per tab so the read-then-write
//   window is tiny; the server's 30 s refresh-token grace window (T09) absorbs
//   the rare case where two tabs both "win" the lock simultaneously.

const TAB_ID = Math.random().toString(36).slice(2, 10);
const LOCK_KEY = 'wr-auth-refresh-lock';
const LOCK_TTL_MS = 10_000;
const WAIT_TIMEOUT_MS = 12_000; // slightly longer than TTL so expiry fires first

const _ch = (() => {
  if (typeof BroadcastChannel === 'undefined') return null;
  try { return new BroadcastChannel('wr-auth'); }
  catch { return null; }
})();

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
    return true;
  } catch {
    return true; // localStorage unavailable — proceed without lock
  }
}

function releaseLock() {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    const existing = raw ? JSON.parse(raw) : null;
    if (existing?.ownerId === TAB_ID) localStorage.removeItem(LOCK_KEY);
  } catch (_e) {
    // localStorage unavailable — lock will expire via TTL
  }
}

// Wait for REFRESH_SUCCESS or REFRESH_FAILURE from the tab that holds the lock.
// Resolves with the new accessToken; rejects on failure or timeout.
function waitForRefreshBroadcast() {
  return new Promise((resolve, reject) => {
    if (!_ch) { reject(new Error('BroadcastChannel unavailable')); return; }

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

// Within-tab in-flight lock — concurrent requests in the same tab share one refresh.
let _inFlightRefresh = null;

// Runs doRefresh with full cross-tab coordination:
//   1. Tries to acquire the localStorage lock.
//   2. If lock not acquired → waits for REFRESH_SUCCESS/FAILURE broadcast.
//      On success: calls applyToken(accessToken) to update session state.
//      On failure/timeout: attempts to take over the lock and run doRefresh itself.
//   3. If lock acquired → runs doRefresh, broadcasts result, releases lock.
//
// applyToken(accessToken) → session — called when another tab did the refresh.
export async function runRefreshWithBroadcast(doRefresh, applyToken) {
  if (_inFlightRefresh) return _inFlightRefresh;

  _inFlightRefresh = (async () => {
    let hasLock = tryAcquireLock();

    if (!hasLock) {
      // Another tab is refreshing — wait for its broadcast.
      try {
        const accessToken = await waitForRefreshBroadcast();
        return applyToken(accessToken);
      } catch {
        // Timeout or other tab failed — try to take over.
        hasLock = tryAcquireLock();
        if (!hasLock) throw new Error('Refresh lock unavailable after timeout');
        // Fall through to run doRefresh below.
      }
    }

    // This tab holds the lock.
    try {
      const newSession = await doRefresh();
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

// Subscribe to auth events from other tabs.
// Returns an unsubscribe function (call it in useEffect cleanup).
export function onAuthBroadcast(handler) {
  if (!_ch) return () => {};
  const listener = (e) => handler(e.data);
  _ch.addEventListener('message', listener);
  return () => _ch.removeEventListener('message', listener);
}

export function broadcastLogout() {
  _ch?.postMessage({ type: 'LOGOUT' });
}
