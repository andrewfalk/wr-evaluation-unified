// exitFlow.js — Pure decision logic for the close/reload confirmation gate
// (unsaved 종합소견 편집 draft 보호). Extracted so it's unit-testable without
// BrowserWindow/dialog mocks (see migrationGate.js precedent). The native
// confirm dialog and the actual close/reload call stay in main.js.

// 'ignore'  — a confirm dialog is already in flight; do nothing (prevents duplicates).
// 'proceed' — no unsaved draft; continue immediately with the normal action.
// 'confirm' — unsaved draft present; show the native confirm dialog first.
function decideExitAction({ hasUnsavedDraft, exitFlowInFlight }) {
  if (exitFlowInFlight) return 'ignore';
  if (!hasUnsavedDraft) return 'proceed';
  return 'confirm';
}

// Update-install prompt has no "silent proceed" branch (unlike close/reload it
// always asks something — see D-3 in the track-2 plan), so it only needs the
// in-flight dedup half of decideExitAction's logic.
function decideUpdatePromptAction({ exitFlowInFlight }) {
  return exitFlowInFlight ? 'ignore' : 'prompt';
}

// showDialog is always invoked *inside* the .then() callback — a synchronous
// throw from showDialog becomes a rejection instead of unwinding past finally(),
// so setInFlight(false) is guaranteed to run no matter how showDialog fails.
// (Regression test for a real bug: an earlier version wrapped showDialog() in
// Promise.resolve(showDialog()) directly, which let a sync throw skip finally
// and leave the mutex permanently held.)
function withExitFlowMutex(showDialog, setInFlight) {
  setInFlight(true);
  return Promise.resolve()
    .then(showDialog)
    .finally(() => setInFlight(false));
}

// Guarantees quitAndInstall() (or any other post-logout action) never runs
// before the renderer logout promise has resolved.
function installAfterLogout(logoutPromise, install) {
  return logoutPromise.then(install);
}

module.exports = { decideExitAction, decideUpdatePromptAction, withExitFlowMutex, installAfterLogout };
