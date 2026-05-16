// migrationGate.js — Pure gate evaluation for the migration IPC.
// Extracted so the gate logic is unit-testable without ipcMain/dialog mocks.
// The actual native confirm dialog and disk read live in main.js.

function evaluateMigrationGate({ isIntranet, senderUrl, allowedOrigin, accessToken }) {
  if (!isIntranet) {
    return { allowed: false, reason: 'not_intranet_build' };
  }
  if (!allowedOrigin) {
    return { allowed: false, reason: 'origin_not_allowed' };
  }
  let senderOrigin = null;
  try { senderOrigin = new URL(senderUrl).origin; } catch { /* invalid */ }
  if (senderOrigin !== allowedOrigin) {
    return { allowed: false, reason: 'origin_not_allowed' };
  }
  if (!accessToken) {
    return { allowed: false, reason: 'not_authenticated' };
  }
  return { allowed: true, reason: null };
}

module.exports = { evaluateMigrationGate };
