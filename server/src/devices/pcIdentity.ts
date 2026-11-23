// A "PC" is a device signing key: one public key fingerprint (SHA-256 of the raw Ed25519 key). The desktop
// shell keeps its key in the Windows user profile and signs EMR audit events with it; the registration table
// may hold several rows for one key (one per user who registered it). This module finds the PC a signed
// request came from and summarises its rows — organisation, status and the fixed row that keys nonces and
// per-PC limits.
//
// The device id in the request header is only part of the signed message: the PC is found by the signature.
import crypto from 'crypto';
import type { Pool } from 'pg';
import { createKeyedLimiter } from '../middleware/rateLimit';

export type PcStatus = 'active' | 'pending' | 'revoked';

export interface PcRow {
  id: string;
  user_id: string;
  organization_id: string | null;
  status: string;
  registered_at: Date | string;
}

export interface PcInfo {
  fingerprint: string;
  rows: PcRow[];
  /** revoked if any row is revoked, else active if any row is active, else pending. */
  status: PcStatus;
  /** The first registered row (any status, ties by id) — nonce and per-PC limit key; never changes. */
  anchorId: string;
  /** Distinct organisations of the rows (null counts as a value). */
  orgIds: (string | null)[];
  /** True when every row points at the same organisation (or the same null). */
  orgResolved: boolean;
  /** The PC's organisation when orgResolved, otherwise null. */
  orgId: string | null;
  /** The user of the first registered active row, or null when no row is active. */
  registrantUserId: string | null;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** SHA-256 hex of the raw 32-byte key (accepts standard base64 and base64url). Same value as devices.public_key_fingerprint. */
export function keyFingerprint(publicKeyBase64: string): string {
  const normalized = publicKeyBase64.replace(/-/g, '+').replace(/_/g, '/');
  return crypto.createHash('sha256').update(Buffer.from(normalized, 'base64')).digest('hex');
}

// Ed25519 SPKI DER header (12 bytes) for a raw 32-byte key.
const SPKI_HEADER = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyDeviceSignature(publicKeyBase64: string, message: string, signatureBase64: string): boolean {
  try {
    const raw = Buffer.from(publicKeyBase64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_HEADER, raw]), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

function registeredMs(row: PcRow): number {
  return new Date(row.registered_at).getTime();
}

function byRegistration(a: PcRow, b: PcRow): number {
  const d = registeredMs(a) - registeredMs(b);
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Pure summary of one fingerprint's rows (rows must be non-empty). */
export function summarizePc(fingerprint: string, rows: PcRow[]): PcInfo {
  if (rows.length === 0) throw new Error('summarizePc: no rows');
  const sorted = [...rows].sort(byRegistration);
  const status: PcStatus = sorted.some((r) => r.status === 'revoked')
    ? 'revoked'
    : sorted.some((r) => r.status === 'active') ? 'active' : 'pending';
  const orgIds = [...new Set(sorted.map((r) => r.organization_id ?? null))];
  const orgResolved = orgIds.length === 1;
  const firstActive = sorted.find((r) => r.status === 'active') ?? null;
  return {
    fingerprint,
    rows: sorted,
    status,
    anchorId: sorted[0].id,
    orgIds,
    orgResolved,
    orgId: orgResolved ? orgIds[0] : null,
    registrantUserId: firstActive?.user_id ?? null,
  };
}

export async function loadPcRows(db: Pick<Pool, 'query'>, fingerprint: string): Promise<(PcRow & { public_key: string })[]> {
  const { rows } = await db.query<PcRow & { public_key: string }>(
    `SELECT id, user_id, organization_id, status, registered_at, public_key
       FROM devices WHERE public_key_fingerprint = $1`,
    [fingerprint],
  );
  return rows;
}

export type PcLookup =
  | { kind: 'found'; pc: PcInfo }
  /** No registered key verifies the signature (or the header id is not a UUID). */
  | { kind: 'not_found' }
  /** Too many full key scans right now — try again later. */
  | { kind: 'scan_limited'; retryAfterSec: number };

export interface PcResolverOptions {
  /** Keys without an active row tried per full scan (approved PCs are always all tried). Default 50. */
  inactiveKeyCap?: number;
  /** Full scans per minute across the server. Default 600. */
  scansPerMinute?: number;
  /** Full scans running at once. Default 4. */
  maxConcurrentScans?: number;
  /** Remembered "header id → fingerprint" pairs of verified requests. Default 1000. */
  cacheSize?: number;
  now?: () => number;
}

export interface PcResolver {
  /** Finds the PC whose key verifies `signature` over `message`. `headerId` is the request's device id header. */
  resolve(headerId: string, message: string, signature: string): Promise<PcLookup>;
}

export const PC_SCAN_DEFAULTS = {
  inactiveKeyCap: 50,
  scansPerMinute: 600,
  maxConcurrentScans: 4,
  cacheSize: 1000,
} as const;

/**
 * Finds a PC by signature. A header id seen with a verified signature is remembered, and the next request with
 * that id is checked against that one key only (one verification per request for a known PC — a failure there
 * is a 401 without a full scan). Other requests scan the registered keys: every key with an active row, then
 * at most `inactiveKeyCap` other keys (newest first). Full scans are limited per minute and in parallel across
 * the server; over the limit nothing is scanned.
 */
export function createPcResolver(pool: Pick<Pool, 'query'>, options: PcResolverOptions = {}): PcResolver {
  const inactiveKeyCap = options.inactiveKeyCap ?? PC_SCAN_DEFAULTS.inactiveKeyCap;
  const maxConcurrent = options.maxConcurrentScans ?? PC_SCAN_DEFAULTS.maxConcurrentScans;
  const cacheSize = options.cacheSize ?? PC_SCAN_DEFAULTS.cacheSize;
  const scanWindow = createKeyedLimiter({
    windowMs: 60 * 1000,
    max: options.scansPerMinute ?? PC_SCAN_DEFAULTS.scansPerMinute,
    maxKeys: 1,
    now: options.now,
  });
  const known = new Map<string, string>(); // header id → fingerprint, oldest first
  let running = 0;

  function remember(headerId: string, fingerprint: string): void {
    known.delete(headerId);
    known.set(headerId, fingerprint);
    while (known.size > cacheSize) known.delete(known.keys().next().value as string);
  }

  async function found(fingerprint: string): Promise<PcLookup> {
    const rows = await loadPcRows(pool, fingerprint);
    if (rows.length === 0) return { kind: 'not_found' };
    return { kind: 'found', pc: summarizePc(fingerprint, rows) };
  }

  return {
    async resolve(headerId, message, signature) {
      if (!isUuid(headerId)) return { kind: 'not_found' };

      const knownFp = known.get(headerId);
      if (knownFp !== undefined) {
        const rows = await loadPcRows(pool, knownFp);
        if (rows.length === 0 || !verifyDeviceSignature(rows[0].public_key, message, signature)) return { kind: 'not_found' };
        remember(headerId, knownFp);
        return { kind: 'found', pc: summarizePc(knownFp, rows) };
      }

      if (running >= maxConcurrent) return { kind: 'scan_limited', retryAfterSec: 1 };
      const slot = scanWindow.hit('scan');
      if (!slot.allowed) return { kind: 'scan_limited', retryAfterSec: slot.retryAfterSec };
      running += 1;
      try {
        const { rows: keys } = await pool.query<{ fp: string; public_key: string; has_active: boolean; last_registered: Date | string }>(
          `SELECT public_key_fingerprint AS fp, min(public_key) AS public_key,
                  bool_or(status = 'active') AS has_active, max(registered_at) AS last_registered
             FROM devices
            GROUP BY public_key_fingerprint`,
        );
        const active = keys.filter((k) => k.has_active);
        const inactive = keys
          .filter((k) => !k.has_active)
          .sort((a, b) => new Date(b.last_registered).getTime() - new Date(a.last_registered).getTime())
          .slice(0, inactiveKeyCap);
        for (const key of [...active, ...inactive]) {
          if (verifyDeviceSignature(key.public_key, message, signature)) {
            remember(headerId, key.fp);
            return await found(key.fp);
          }
        }
        return { kind: 'not_found' };
      } finally {
        running -= 1;
      }
    },
  };
}
