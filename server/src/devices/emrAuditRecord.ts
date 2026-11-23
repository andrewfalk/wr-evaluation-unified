// How an accepted EMR audit event is recorded: who the actor is, which organisation the row belongs to, and the
// flags the server writes into `extra`. Pure functions — routes/audit.ts does the I/O.
import type { PcInfo } from './pcIdentity';

/**
 * `extra` keys only the server writes. Any of them in the client's `extra` is removed before the server values
 * are added (the client's `source` is kept as `client_source`), so a client cannot imitate a server flag.
 */
export const SERVER_RESERVED_EXTRA_KEYS = [
  'deviceId',
  'header_device_id',
  'source',
  'client_source',
  'session_missing',
  'actor_from_queue',
  'actor_source',
  'actor_uncertain',
  'actor_unverified',
  'actor_claim_rejected',
  'sent_by_user_id',
  'legacy_shell',
  'occurred_at',
  'occurred_at_unknown',
  'occurred_at_invalid',
  'burst',
  'org_unresolved',
] as const;

const RESERVED = new Set<string>(SERVER_RESERVED_EXTRA_KEYS);

/** Marker the current desktop shell puts in `extra` (older shells send none). */
export const SHELL_AUDIT_MARKER_KEY = 'shellAudit';
export const SHELL_AUDIT_MARKER_VALUE = 2;

export function isCurrentShellEvent(clientExtra: Record<string, unknown> | null | undefined): boolean {
  return clientExtra?.[SHELL_AUDIT_MARKER_KEY] === SHELL_AUDIT_MARKER_VALUE;
}

/** Client `extra` without the server-reserved keys; `client_source` carries the client's own `source`. */
export function clientExtraWithoutReserved(clientExtra: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(clientExtra ?? {})) {
    if (!RESERVED.has(key)) out[key] = value;
  }
  if (clientExtra && Object.prototype.hasOwnProperty.call(clientExtra, 'source')) out.client_source = clientExtra.source;
  return out;
}

export interface SessionIdentity {
  userId: string;
  organizationId: string | null;
}

/**
 * Whether a session may send events for this PC: its organisation must be the PC's (an account without an
 * organisation is not checked). For a PC whose rows span several organisations the session's organisation must
 * be one of them.
 */
export function sessionMatchesPc(session: SessionIdentity, pc: PcInfo): boolean {
  if (session.organizationId === null) return true;
  return pc.orgIds.includes(session.organizationId);
}

export interface ActorDecision {
  actorUserId: string | null;
  actorOrgId: string | null;
  flags: Record<string, unknown>;
}

/**
 * Actor when the event's own actor cannot be confirmed — older shells, and events without a usable claim: the
 * session's user, otherwise the registrant of the PC's first active row. Always flagged uncertain. The row's
 * organisation is always the PC's; a PC whose rows span several organisations is recorded without actor or
 * organisation and flagged org_unresolved.
 */
export function fallbackActor(pc: PcInfo, session: SessionIdentity | null, extraFlags: Record<string, unknown> = {}): ActorDecision {
  const flags: Record<string, unknown> = {
    actor_uncertain: true,
    ...extraFlags,
    ...(session ? {} : { session_missing: true, actor_from_queue: true }),
  };
  if (!pc.orgResolved) {
    return {
      actorUserId: null,
      actorOrgId: null,
      flags: { ...flags, org_unresolved: true, actor_source: 'none', ...(session ? { sent_by_user_id: session.userId } : {}) },
    };
  }
  if (session) {
    return { actorUserId: session.userId, actorOrgId: pc.orgId, flags: { ...flags, actor_source: 'session_fallback' } };
  }
  return { actorUserId: pc.registrantUserId, actorOrgId: pc.orgId, flags: { ...flags, actor_source: 'device_registrant' } };
}

/** Events from an older shell carry no event time: the row's time is when the server received it. */
export function legacyShellFlags(): Record<string, unknown> {
  return { legacy_shell: true, occurred_at_unknown: true };
}

/** Gap under which an older shell's event counts as part of a burst (stored events sent back to back). */
export const BURST_GAP_MS = 1000;

/**
 * Remembers the last accepted event time per PC (anchor id) to flag bursts. In memory, per process; the map is
 * pruned of entries older than the gap when it grows past `maxKeys`.
 */
export function createBurstTracker(options: { gapMs?: number; maxKeys?: number; now?: () => number } = {}) {
  const gapMs = options.gapMs ?? BURST_GAP_MS;
  const maxKeys = options.maxKeys ?? 10_000;
  const now = options.now ?? Date.now;
  const last = new Map<string, number>();
  return {
    /** True when the previous accepted event of this PC was less than the gap ago. */
    isBurst(key: string): boolean {
      const prev = last.get(key);
      return prev !== undefined && now() - prev < gapMs;
    },
    accepted(key: string): void {
      const t = now();
      last.delete(key);
      last.set(key, t);
      if (last.size > maxKeys) {
        for (const [k, v] of last) if (t - v >= gapMs) last.delete(k);
        while (last.size > maxKeys) last.delete(last.keys().next().value as string);
      }
    },
  };
}

/**
 * At most one record per key per window; the next one carries how many were left out in between. For denial
 * rows that a misbehaving client could otherwise repeat for every request.
 */
export function createEventThrottle(options: { windowMs: number; maxKeys?: number; now?: () => number }) {
  const { windowMs, maxKeys = 10_000, now = Date.now } = options;
  const state = new Map<string, { at: number; suppressed: number }>();
  return {
    /** null → skip this one; otherwise record it, with the count skipped since the last record. */
    take(key: string): { suppressed: number } | null {
      const t = now();
      const s = state.get(key);
      if (s && t - s.at < windowMs) {
        s.suppressed += 1;
        return null;
      }
      const suppressed = s?.suppressed ?? 0;
      state.delete(key);
      state.set(key, { at: t, suppressed: 0 });
      if (state.size > maxKeys) {
        for (const [k, v] of state) if (t - v.at >= windowMs) state.delete(k);
        while (state.size > maxKeys) state.delete(state.keys().next().value as string);
      }
      return { suppressed };
    },
  };
}
