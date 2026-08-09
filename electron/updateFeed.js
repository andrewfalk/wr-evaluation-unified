// updateFeed.js — Pure decision logic for electron-updater's feed config and the
// admin on/off switch gate (트랙 2 계획 A-1/G-2). Extracted so it's unit-testable
// without electron/net.request mocks (see exitFlow.js/migrationGate.js precedent).

const ALLOWED_CHANNELS = new Set(['latest', 'canary']);

// Single normalization point shared by buildUpdateFeedConfig and
// shouldCheckForUpdates — an unrecognized/typo'd WR_UPDATE_CHANNEL value always
// falls back to 'latest' rather than producing two different channel values in
// the feed config vs. the policy check.
function resolveUpdateChannel(raw) {
  return ALLOWED_CHANNELS.has(raw) ? raw : 'latest';
}

function buildUpdateFeedConfig({ isIntranetBuild, intranetUrl, channel }) {
  if (!isIntranetBuild || !intranetUrl) return null;
  const base = intranetUrl.replace(/\/+$/, '');
  const resolved = resolveUpdateChannel(channel);
  return {
    provider: 'generic',
    url: `${base}/updates`,
    ...(resolved !== 'latest' ? { channel: resolved } : {}), // 'latest' is electron-updater's own default
  };
}

// Admin on/off switch (트랙 2 계획 G-2) — fail-closed by design. This is a safety
// boundary: any format deviation drops straight to "don't check," never to "check
// everything." A single operator typo (e.g. channels as a string instead of an
// array) must not turn on updates fleet-wide.
function shouldCheckForUpdates({ policy, channel }) {
  if (policy?.enabled !== true) return false;                             // null/false/missing/non-object
  if (!Array.isArray(policy.channels)) return false;                      // wrong type (e.g. a bare string)
  if (policy.channels.length === 0) return false;                         // empty array = fully disabled
  if (!policy.channels.every((v) => ALLOWED_CHANNELS.has(v))) return false; // any unknown channel rejects the whole policy
  return policy.channels.includes(channel);
}

// Skip re-checking while a download is in flight, an install is staged, or an
// install attempt is running — checkForUpdates() has nothing useful to do in
// any of these states, and calling it anyway would race the in-progress work.
const SKIP_CHECK_PHASES = new Set(['downloading', 'ready', 'installing']);
function shouldSkipUpdateCheck(phase) {
  return SKIP_CHECK_PHASES.has(phase);
}

// Table-driven phase transitions for electron-updater's event stream (트랙 2
// 계획 E-1). Centralizing this as data — instead of inline mutation in each
// main.js listener — makes the whole state machine exhaustively testable
// without mocking autoUpdater/BrowserWindow. `timerAction` tells the caller
// what to do with the polling timer; main.js is the only place that actually
// owns a timer, so it just switches on the returned action.
//   'none'           — leave the timer alone
//   'clear'          — stop polling (a download/install is in progress)
//   'scheduleStable' — resume the normal STABLE_INTERVAL_MS cadence
const PHASE_TRANSITIONS = {
  checking:     { phase: 'checking',    timerAction: 'none' },
  available:    { phase: 'downloading', timerAction: 'clear' },
  notAvailable: { phase: 'idle',        timerAction: 'scheduleStable' },
  downloaded:   { phase: 'ready',       timerAction: 'clear' },
  installStart: { phase: 'installing',  timerAction: 'none' },
  installFail:  { phase: 'ready',       timerAction: 'none' }, // 설치 실패 → ready 복귀, 추가 백오프 없음
};

function decideUpdatePhaseTransition(event) {
  const transition = PHASE_TRANSITIONS[event];
  if (!transition) throw new Error(`unknown update phase event: ${event}`);
  return transition;
}

module.exports = {
  resolveUpdateChannel,
  buildUpdateFeedConfig,
  shouldCheckForUpdates,
  shouldSkipUpdateCheck,
  decideUpdatePhaseTransition,
};
