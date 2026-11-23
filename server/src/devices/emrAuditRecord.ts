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

/** What the current shell says about who started the EMR action (`extra.actorUserId`), after the server checked it. */
export interface ActorClaim {
  /** The event carried an actorUserId at all. */
  present: boolean;
  userId: string | null;
  /** UUID, the user exists, and the user's organisation is the PC's (a disabled account still counts). */
  valid: boolean;
}

/**
 * Actor of a current-shell event (the table in the plan):
 *  - claim = session user → the session user (`actor_source: 'session'`, no uncertainty flag);
 *  - a valid claim otherwise (no session, or a different session user) → the claimed user, flagged
 *    `actor_unverified` (`actor_source: 'device_claim'`), with `sent_by_user_id` when a session sent it;
 *  - anything else → fallbackActor (always `actor_uncertain`), plus `actor_claim_rejected` when a claim was sent.
 */
export function currentShellActor(pc: PcInfo, session: SessionIdentity | null, claim: ActorClaim): ActorDecision {
  if (pc.orgResolved && session && claim.present && claim.userId === session.userId) {
    return { actorUserId: session.userId, actorOrgId: pc.orgId, flags: { actor_source: 'session' } };
  }
  if (pc.orgResolved && claim.valid && claim.userId) {
    return {
      actorUserId: claim.userId,
      actorOrgId: pc.orgId,
      flags: {
        actor_source: 'device_claim',
        actor_unverified: true,
        ...(session ? { sent_by_user_id: session.userId } : { session_missing: true, actor_from_queue: true }),
      },
    };
  }
  return fallbackActor(pc, session, claim.present ? { actor_claim_rejected: true } : {});
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * The current shell's event time (`extra.occurredAt`): an ISO-8601 UTC time not later than the signed request
 * time → `occurred_at`; present but malformed or later → `occurred_at_invalid` (the row is still recorded);
 * absent → `occurred_at_unknown`. The row's created_at stays the time the server received it.
 */
export function occurredAtFlags(occurredAt: unknown, signedAtMs: number): Record<string, unknown> {
  if (occurredAt === undefined || occurredAt === null) return { occurred_at_unknown: true };
  if (typeof occurredAt !== 'string' || !ISO_UTC.test(occurredAt)) return { occurred_at_invalid: true };
  const t = Date.parse(occurredAt);
  // Date.parse rolls impossible dates over (02-30 → 03-02): the parsed time must read back as the same date and time.
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 19) !== occurredAt.slice(0, 19) || t > signedAtMs) {
    return { occurred_at_invalid: true };
  }
  return { occurred_at: new Date(t).toISOString() };
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
