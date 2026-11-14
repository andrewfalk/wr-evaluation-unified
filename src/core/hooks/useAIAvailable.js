// @ts-nocheck
import { hasIntranetSession } from '../../platform/dataMode';
// Returns whether AI analysis is available in the current session context.
// - Local / Electron (non-intranet): always available (Vercel endpoint or Electron IPC).
// - Intranet: only when the server's /api/config/public reports aiEnabled=true.
export function useAIAvailable({ serverConfig, session } = {}) {
  const isIntranet = hasIntranetSession(session);
  if (!isIntranet) return { aiAvailable: true };
  return { aiAvailable: serverConfig?.aiEnabled === true };
}
