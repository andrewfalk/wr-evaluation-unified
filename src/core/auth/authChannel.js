// BroadcastChannel singleton for cross-tab auth event coordination.
// A single instance per tab: the spec guarantees a channel will not receive
// its own posted messages, so send and receive share one object safely.
const _ch = (() => {
  if (typeof BroadcastChannel === 'undefined') return null;
  try { return new BroadcastChannel('wr-auth'); }
  catch { return null; }
})();

// Within-tab in-flight refresh lock.
// Multiple concurrent 401s in the same tab share one refresh call.
let _inFlightRefresh = null;

// Wraps doRefresh with:
//   1. Within-tab deduplication — concurrent callers await the same promise
//   2. Cross-tab broadcast — on resolve/reject, other tabs learn the outcome
export async function runRefreshWithBroadcast(doRefresh) {
  if (_inFlightRefresh) return _inFlightRefresh;

  _inFlightRefresh = (async () => {
    try {
      const newSession = await doRefresh();
      _ch?.postMessage({ type: 'REFRESH_SUCCESS', accessToken: newSession.accessToken });
      return newSession;
    } catch (err) {
      _ch?.postMessage({ type: 'REFRESH_FAILURE' });
      throw err;
    } finally {
      _inFlightRefresh = null;
    }
  })();

  return _inFlightRefresh;
}

// Subscribe to auth events from other tabs.
// handler receives the message payload object.
// Returns an unsubscribe function.
export function onAuthBroadcast(handler) {
  if (!_ch) return () => {};
  const listener = (e) => handler(e.data);
  _ch.addEventListener('message', listener);
  return () => _ch.removeEventListener('message', listener);
}

export function broadcastLogout() {
  _ch?.postMessage({ type: 'LOGOUT' });
}
