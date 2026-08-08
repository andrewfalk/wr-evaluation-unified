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

module.exports = { decideExitAction };
