// Admin console: device registration list, approve and revoke.
// Split out of routes/admin.ts (S5 P1-28). A PC is one signing key (public key fingerprint) and may have one row
// per user who registered it: revoking revokes every row of the PC, and a PC with a revoked row cannot be
// approved again (a revoked PC is brought back by making a new device key on it and registering that).
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { sessionOf } from '../../http/authz';
import { writeAuditLog } from '../../middleware/audit';
import { lockPcRows } from '../../devices/pcIdentity';

// ---------------------------------------------------------------------------
// GET /api/admin/devices
// Returns all devices with user meta. The `suspicious` flag is set when the
// registered UA does not contain 'Electron/' — surfaced as a red badge in UI.
// `keyPrefix` (first 8 hex digits of the public key fingerprint) groups the rows of one PC.
// ---------------------------------------------------------------------------
interface DeviceRow {
  id:              string;
  user_id:         string;
  user_name:       string;
  user_login_id:   string;
  organization_id: string | null;
  public_key:      string;
  public_key_fingerprint: string;
  build_target:    string;
  status:          string;
  approved_by:     string | null;
  approver_name:   string | null;
  approved_at:     Date | null;
  registered_at:   Date;
  revoked_at:      Date | null;
  last_seen_at:    Date | null;
  register_origin: string | null;
  register_ua:     string | null;
  register_ip:     string | null;
}

export const DEVICE_KEY_PREFIX_LENGTH = 8;

export async function listDevices(pool: Pool, req: Request, res: Response): Promise<void> {
  // Org-scoped: admin with an org sees only their org's devices.
  // Admin without an org (system-level superadmin) sees all.
  const orgId = req.sessionInfo?.organizationId ?? null;
  const { rows } = await pool.query<DeviceRow>(
    `SELECT
       d.id, d.user_id, u.name AS user_name, u.login_id AS user_login_id,
       d.organization_id, d.public_key, d.public_key_fingerprint, d.build_target, d.status,
       d.approved_by, a.name AS approver_name, d.approved_at,
       d.registered_at, d.revoked_at, d.last_seen_at,
       d.register_origin, d.register_ua, d.register_ip
     FROM devices d
     JOIN users u ON u.id = d.user_id
     LEFT JOIN users a ON a.id = d.approved_by
     WHERE ($1::uuid IS NULL OR d.organization_id = $1)
     ORDER BY d.registered_at DESC`,
    [orgId]
  );

  const devices = rows.map((d) => ({
    id:             d.id,
    userId:         d.user_id,
    userName:       d.user_name,
    userLoginId:    d.user_login_id,
    organizationId: d.organization_id,
    keyPrefix:      d.public_key_fingerprint.slice(0, DEVICE_KEY_PREFIX_LENGTH),
    buildTarget:    d.build_target,
    status:         d.status,
    approvedBy:     d.approved_by,
    approverName:   d.approver_name,
    approvedAt:     d.approved_at,
    registeredAt:   d.registered_at,
    revokedAt:      d.revoked_at,
    lastSeenAt:     d.last_seen_at,
    registerOrigin: d.register_origin,
    registerUa:     d.register_ua,
    registerIp:     d.register_ip,
    // Heuristic flag for admin UI: non-Electron UA is suspicious.
    suspicious: !d.register_ua?.includes('Electron/'),
  }));

  res.status(200).json({ devices });
}

interface TargetRow { id: string; status: string; public_key_fingerprint: string }

// The row the admin may act on (org-scoped), read with its PC locked. null → 404.
async function lockTarget(client: { query: Pool['query'] }, id: string, orgId: string | null): Promise<TargetRow | null> {
  const first = await client.query<TargetRow>(
    `SELECT id, status, public_key_fingerprint FROM devices
      WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
    [id, orgId],
  );
  if (first.rows.length === 0) return null;
  await lockPcRows(client, first.rows[0].public_key_fingerprint);
  // Re-read under the lock (a concurrent revoke may have changed it).
  const locked = await client.query<TargetRow>(
    `SELECT id, status, public_key_fingerprint FROM devices WHERE id = $1`,
    [id],
  );
  return locked.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// POST /api/admin/devices/:id/approve
// ---------------------------------------------------------------------------
export async function approveDevice(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = sessionOf(req);
  const orgId   = session.organizationId ?? null;

  let result: { kind: 'not_found' } | { kind: 'not_pending'; status: string } | { kind: 'pc_revoked' } | { kind: 'approved' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await lockTarget(client, id, orgId);
    if (!target) {
      result = { kind: 'not_found' };
    } else if (target.status !== 'pending') {
      result = { kind: 'not_pending', status: target.status };
    } else {
      const revoked = await client.query(
        `SELECT 1 FROM devices WHERE public_key_fingerprint = $1 AND status = 'revoked' LIMIT 1`,
        [target.public_key_fingerprint],
      );
      if ((revoked.rowCount ?? 0) > 0) {
        result = { kind: 'pc_revoked' };
      } else {
        await client.query(
          `UPDATE devices SET status = 'active', approved_by = $1, approved_at = now() WHERE id = $2`,
          [session.userId, id],
        );
        result = { kind: 'approved' };
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (result.kind === 'not_found') {
    res.status(404).json({ code: 'DEVICE_NOT_FOUND', error: 'Device not found' });
    return;
  }
  if (result.kind === 'not_pending') {
    res.status(409).json({ code: 'DEVICE_NOT_PENDING', error: `Device is already ${result.status}`, status: result.status });
    return;
  }
  if (result.kind === 'pc_revoked') {
    res.status(409).json({
      code:  'DEVICE_PC_REVOKED',
      error: 'This PC has been revoked; register a new device key on it to use it again',
    });
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  orgId,
    action:      'device_approve',
    targetType:  'device',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(200).json({ deviceId: id, status: 'active' });
}

// ---------------------------------------------------------------------------
// POST /api/admin/devices/:id/revoke — revokes every row of the PC the admin may see.
// ---------------------------------------------------------------------------
export async function revokeDevice(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = sessionOf(req);
  const orgId   = session.organizationId ?? null;

  let revokedIds: string[] | null = null;
  let found = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const target = await lockTarget(client, id, orgId);
    if (target) {
      found = true;
      const updated = await client.query<{ id: string }>(
        `UPDATE devices SET status = 'revoked', revoked_at = now()
          WHERE public_key_fingerprint = $1 AND status != 'revoked'
            AND ($2::uuid IS NULL OR organization_id = $2)
          RETURNING id`,
        [target.public_key_fingerprint, orgId],
      );
      revokedIds = updated.rows.map((r) => r.id);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  if (!found) {
    res.status(404).json({ code: 'DEVICE_NOT_FOUND', error: 'Device not found' });
    return;
  }
  if (!revokedIds || revokedIds.length === 0) {
    res.status(409).json({ code: 'DEVICE_ALREADY_REVOKED', error: 'Device is already revoked' });
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  orgId,
    action:      'device_revoke',
    targetType:  'device',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
    extra:       { revokedDeviceIds: revokedIds },
  });

  res.status(200).json({ deviceId: id, status: 'revoked', revokedDeviceIds: revokedIds });
}
