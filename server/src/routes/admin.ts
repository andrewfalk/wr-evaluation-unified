import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import type { Pool } from 'pg';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { adminOnly } from '../middleware/adminOnly';
import { writeAuditLog } from '../middleware/audit';
import { checkPasswordPolicy, appendPasswordHistory } from '../auth/passwordPolicy';

// ---------------------------------------------------------------------------
// GET /api/admin/devices
// Returns all devices with user meta. The `suspicious` flag is set when the
// registered UA does not contain 'Electron/' — surfaced as a red badge in UI.
// ---------------------------------------------------------------------------
interface DeviceRow {
  id:              string;
  user_id:         string;
  user_name:       string;
  user_login_id:   string;
  organization_id: string | null;
  public_key:      string;
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

async function listDevices(pool: Pool, req: Request, res: Response): Promise<void> {
  // Org-scoped: admin with an org sees only their org's devices.
  // Admin without an org (system-level superadmin) sees all.
  const orgId = req.sessionInfo?.organizationId ?? null;
  const { rows } = await pool.query<DeviceRow>(
    `SELECT
       d.id, d.user_id, u.name AS user_name, u.login_id AS user_login_id,
       d.organization_id, d.public_key, d.build_target, d.status,
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

// ---------------------------------------------------------------------------
// POST /api/admin/devices/:id/approve
// ---------------------------------------------------------------------------
async function approveDevice(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = req.sessionInfo!;
  const orgId   = session.organizationId ?? null;

  const { rows } = await pool.query<{ id: string; status: string }>(
    `UPDATE devices
     SET status = 'active', approved_by = $1, approved_at = now()
     WHERE id = $2 AND status = 'pending'
       AND ($3::uuid IS NULL OR organization_id = $3)
     RETURNING id, status`,
    [session.userId, id, orgId]
  );

  if (rows.length === 0) {
    // Either not found, not pending, or outside org scope
    const existing = await pool.query<{ status: string }>(
      `SELECT status FROM devices
       WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
      [id, orgId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ code: 'DEVICE_NOT_FOUND', error: 'Device not found' });
    } else {
      res.status(409).json({
        code:   'DEVICE_NOT_PENDING',
        error:  `Device is already ${existing.rows[0].status}`,
        status: existing.rows[0].status,
      });
    }
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'device_approve',
    targetType:  'device',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(200).json({ deviceId: rows[0].id, status: rows[0].status });
}

// ---------------------------------------------------------------------------
// POST /api/admin/devices/:id/revoke
// ---------------------------------------------------------------------------
async function revokeDevice(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = req.sessionInfo!;
  const orgId   = session.organizationId ?? null;

  const { rows } = await pool.query<{ id: string; status: string }>(
    `UPDATE devices
     SET status = 'revoked', revoked_at = now()
     WHERE id = $1 AND status != 'revoked'
       AND ($2::uuid IS NULL OR organization_id = $2)
     RETURNING id, status`,
    [id, orgId]
  );

  if (rows.length === 0) {
    const existing = await pool.query<{ status: string }>(
      `SELECT status FROM devices
       WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
      [id, orgId]
    );
    if (existing.rows.length === 0) {
      res.status(404).json({ code: 'DEVICE_NOT_FOUND', error: 'Device not found' });
    } else {
      res.status(409).json({ code: 'DEVICE_ALREADY_REVOKED', error: 'Device is already revoked' });
    }
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'device_revoke',
    targetType:  'device',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(200).json({ deviceId: rows[0].id, status: rows[0].status });
}

// ---------------------------------------------------------------------------
// GET /api/admin/audit
// Paginated audit log query. Uses the read-only auditPool (wr_audit_reader).
// Query params: page, limit (max 200), action, actorUserId, targetType, from, to
// ---------------------------------------------------------------------------
const MAX_AUDIT_LIMIT = 200;

const auditQuerySchema = z.object({
  page:        z.coerce.number().int().min(1).default(1),
  limit:       z.coerce.number().int().min(1).max(MAX_AUDIT_LIMIT).default(50),
  action:      z.string().max(100).optional(),
  actorUserId: z.string().uuid().optional(),
  targetType:  z.string().max(100).optional(),
  from:        z.string().datetime({ offset: true }).optional(),
  to:          z.string().datetime({ offset: true }).optional(),
});

interface AuditRow {
  id:            string;
  actor_user_id: string | null;
  actor_org_id:  string | null;
  action:        string;
  target_type:   string | null;
  target_id:     string | null;
  outcome:       string;
  ip:            string | null;
  user_agent:    string | null;
  extra:         unknown;
  created_at:    Date;
}

async function listAuditLogs(pool: Pool, auditPool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_PARAMS', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { page, limit, action, actorUserId, targetType, from, to } = parsed.data;
  const offset = (page - 1) * limit;
  const orgId  = req.sessionInfo?.organizationId ?? null;

  // Build dynamic WHERE clause; org-scoped for non-superadmin.
  const conditions: string[] = [];
  const params: unknown[]    = [];
  let   p = 1;

  if (orgId !== null) {
    conditions.push(`actor_org_id = $${p++}`);
    params.push(orgId);
  }
  if (action) {
    conditions.push(`action = $${p++}`);
    params.push(action);
  }
  if (actorUserId) {
    conditions.push(`actor_user_id = $${p++}`);
    params.push(actorUserId);
  }
  if (targetType) {
    conditions.push(`target_type = $${p++}`);
    params.push(targetType);
  }
  if (from) {
    conditions.push(`created_at >= $${p++}`);
    params.push(from);
  }
  if (to) {
    conditions.push(`created_at <= $${p++}`);
    params.push(to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [{ rows: countRows }, { rows }] = await Promise.all([
    auditPool.query<{ total: string }>(`SELECT COUNT(*) AS total FROM audit_logs ${where}`, params),
    auditPool.query<AuditRow>(
      `SELECT id, actor_user_id, actor_org_id, action, target_type, target_id,
              outcome, ip, user_agent, extra, created_at
       FROM audit_logs
       ${where}
       ORDER BY created_at DESC
       LIMIT $${p} OFFSET $${p + 1}`,
      [...params, limit, offset]
    ),
  ]);

  const total = parseInt(countRows[0]?.total ?? '0', 10);

  // Audit the audit query itself — filter params recorded, no PHI in extra.
  const session = req.sessionInfo!;
  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'admin_audit_view',
    targetType:  'audit_logs',
    targetId:    null,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
    extra:       { page, limit, action, actorUserId, targetType, from, to, total },
  });

  res.status(200).json({
    items: rows.map((r) => ({
      id:          r.id,
      actorUserId: r.actor_user_id,
      actorOrgId:  r.actor_org_id,
      action:      r.action,
      targetType:  r.target_type,
      targetId:    r.target_id,
      outcome:     r.outcome,
      ip:          r.ip,
      userAgent:   r.user_agent,
      extra:       r.extra,
      createdAt:   r.created_at,
    })),
    total,
    page,
    limit,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/workspaces/:id/purge
// Hard-deletes a workspace row immediately (bypasses the 5-year retention window).
// Org-scoped: an admin with an org can only purge workspaces in their org.
// ---------------------------------------------------------------------------
async function purgeWorkspace(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = req.sessionInfo!;
  const orgId   = session.organizationId ?? null;

  const { rows } = await pool.query<{ id: string }>(
    `DELETE FROM workspaces
     WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)
     RETURNING id`,
    [id, orgId]
  );

  if (rows.length === 0) {
    res.status(404).json({ code: 'WORKSPACE_NOT_FOUND', error: 'Workspace not found' });
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'admin_workspace_purge',
    targetType:  'workspace',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(204).end();
}

// ---------------------------------------------------------------------------
// GET /api/admin/users
// ---------------------------------------------------------------------------
interface UserRow {
  id:                   string;
  login_id:             string;
  name:                 string;
  role:                 string;
  organization_id:      string | null;
  must_change_password: boolean;
  disabled_at:          Date | null;
  created_at:           Date;
  last_login_at:        Date | null;
}

async function listUsers(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId = req.sessionInfo?.organizationId ?? null;
  const { rows } = await pool.query<UserRow>(
    `SELECT id, login_id, name, role, organization_id, must_change_password,
            disabled_at, created_at, last_login_at
     FROM users
     WHERE ($1::uuid IS NULL OR organization_id = $1)
     ORDER BY created_at DESC`,
    [orgId]
  );
  res.status(200).json({
    users: rows.map((u) => ({
      id:                  u.id,
      loginId:             u.login_id,
      name:                u.name,
      role:                u.role,
      organizationId:      u.organization_id,
      mustChangePassword:  u.must_change_password,
      disabled:            u.disabled_at !== null,
      disabledAt:          u.disabled_at,
      createdAt:           u.created_at,
      lastLoginAt:         u.last_login_at,
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/users
// ---------------------------------------------------------------------------
const createUserSchema = z.object({
  loginId:  z.string().trim().min(2).max(100),
  name:     z.string().trim().min(1).max(100),
  role:     z.enum(['admin', 'doctor', 'nurse', 'staff']),
  password: z.string().min(1).max(200),
});

async function createUser(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', errors: parsed.error.flatten().fieldErrors });
    return;
  }
  const { loginId, name, role, password } = parsed.data;

  const policyCheck = checkPasswordPolicy(password);
  if (!policyCheck.ok) {
    res.status(400).json({ code: 'PASSWORD_POLICY', error: policyCheck.error });
    return;
  }
  const session = req.sessionInfo!;
  const orgId   = session.organizationId ?? null;
  const hash    = await bcrypt.hash(password, 12);

  try {
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (login_id, password_hash, name, role, organization_id, must_change_password)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       RETURNING id, login_id, name, role, organization_id, must_change_password, created_at, last_login_at, disabled_at`,
      [loginId, hash, name, role, orgId]
    );

    writeAuditLog(pool, {
      actorUserId: session.userId,
      actorOrgId:  session.organizationId ?? null,
      action:      'admin_user_create',
      targetType:  'user',
      targetId:    rows[0].id,
      outcome:     'success',
      ip:          req.ip ?? null,
      userAgent:   req.headers['user-agent'] ?? null,
    });

    res.status(201).json({
      user: {
        id:                 rows[0].id,
        loginId:            rows[0].login_id,
        name:               rows[0].name,
        role:               rows[0].role,
        organizationId:     rows[0].organization_id,
        mustChangePassword: rows[0].must_change_password,
        disabled:           false,
      },
    });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException & { code?: string }).code === '23505') {
      res.status(409).json({ code: 'LOGIN_ID_TAKEN', error: 'Login ID already exists' });
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/reset-password
// ---------------------------------------------------------------------------
const resetPasswordSchema = z.object({
  password: z.string().min(1).max(200),
});

async function resetUserPassword(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const parsed  = resetPasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const policyCheck = checkPasswordPolicy(parsed.data.password);
  if (!policyCheck.ok) {
    res.status(400).json({ code: 'PASSWORD_POLICY', error: policyCheck.error });
    return;
  }

  const session = req.sessionInfo!;
  const orgId   = session.organizationId ?? null;
  const hash    = await bcrypt.hash(parsed.data.password, 12);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Fetch current hash and history so the old password is preserved in history.
    // This prevents the user from immediately reverting to the pre-reset password
    // when they are forced to change it after admin reset.
    const { rows: userRows } = await client.query<{
      password_hash:    string;
      password_history: string[];
    }>(
      `SELECT password_hash, password_history FROM users
       WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
      [id, orgId]
    );

    if (userRows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'USER_NOT_FOUND', error: 'User not found' });
      return;
    }

    const { password_hash: oldHash, password_history } = userRows[0];
    const newHistory = appendPasswordHistory([...(password_history ?? []), oldHash], hash);

    await client.query(
      `UPDATE users SET password_hash = $1, password_history = $2, must_change_password = TRUE
       WHERE id = $3`,
      [hash, newHistory, id]
    );

    // Invalidate all active sessions — no grace window (invalidated_at, not revoked_at).
    await client.query(
      `UPDATE sessions SET invalidated_at = now()
       WHERE user_id = $1 AND invalidated_at IS NULL`,
      [id]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'admin_user_reset_password',
    targetType:  'user',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(200).json({ userId: id });
}

// ---------------------------------------------------------------------------
// POST /api/admin/users/:id/disable  &  /enable
// ---------------------------------------------------------------------------
async function disableUser(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = req.sessionInfo!;
  const orgId   = session.organizationId ?? null;

  if (id === session.userId) {
    res.status(400).json({ code: 'CANNOT_DISABLE_SELF', error: 'Cannot disable your own account' });
    return;
  }

  const { rows } = await pool.query<{ id: string }>(
    `UPDATE users SET disabled_at = now()
     WHERE id = $1 AND disabled_at IS NULL
       AND ($2::uuid IS NULL OR organization_id = $2)
     RETURNING id`,
    [id, orgId]
  );

  if (rows.length === 0) {
    const { rows: existing } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
      [id, orgId]
    );
    if (existing.length === 0) {
      res.status(404).json({ code: 'USER_NOT_FOUND', error: 'User not found' });
    } else {
      res.status(409).json({ code: 'USER_ALREADY_DISABLED', error: 'User is already disabled' });
    }
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'admin_user_disable',
    targetType:  'user',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(200).json({ userId: id });
}

async function enableUser(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = req.sessionInfo!;
  const orgId   = session.organizationId ?? null;

  const { rows } = await pool.query<{ id: string }>(
    `UPDATE users SET disabled_at = NULL
     WHERE id = $1 AND disabled_at IS NOT NULL
       AND ($2::uuid IS NULL OR organization_id = $2)
     RETURNING id`,
    [id, orgId]
  );

  if (rows.length === 0) {
    const { rows: existing } = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND ($2::uuid IS NULL OR organization_id = $2)`,
      [id, orgId]
    );
    if (existing.length === 0) {
      res.status(404).json({ code: 'USER_NOT_FOUND', error: 'User not found' });
    } else {
      res.status(409).json({ code: 'USER_ALREADY_ENABLED', error: 'User is already enabled' });
    }
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'admin_user_enable',
    targetType:  'user',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(200).json({ userId: id });
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

export function createAdminRouter(pool: Pool, auditPool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);
  const admin  = adminOnly();

  // All admin routes require auth + admin role.
  // Mutating routes also require CSRF.
  router.get(
    '/devices',
    auth, admin,
    (req, res) => listDevices(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/devices/:id/approve',
    auth, admin, csrfMiddleware,
    (req, res) => approveDevice(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/devices/:id/revoke',
    auth, admin, csrfMiddleware,
    (req, res) => revokeDevice(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.get(
    '/audit',
    auth, admin,
    (req, res) => listAuditLogs(pool, auditPool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.delete(
    '/workspaces/:id/purge',
    auth, admin, csrfMiddleware,
    (req, res) => purgeWorkspace(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.get(
    '/users',
    auth, admin,
    (req, res) => listUsers(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/users',
    auth, admin, csrfMiddleware,
    (req, res) => createUser(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/users/:id/reset-password',
    auth, admin, csrfMiddleware,
    (req, res) => resetUserPassword(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/users/:id/disable',
    auth, admin, csrfMiddleware,
    (req, res) => disableUser(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/users/:id/enable',
    auth, admin, csrfMiddleware,
    (req, res) => enableUser(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  return router;
}
