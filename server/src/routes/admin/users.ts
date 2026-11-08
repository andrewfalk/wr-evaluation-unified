// Admin console: user list, create, password reset, disable and enable.
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import type { Request, Response } from 'express';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import type { Pool } from 'pg';
import { sessionOf } from '../../http/authz';
import { writeAuditLog } from '../../middleware/audit';
import { checkPasswordPolicy, appendPasswordHistory } from '../../auth/passwordPolicy';

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

export async function listUsers(pool: Pool, req: Request, res: Response): Promise<void> {
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
  password: z.string().min(1), // length/strength: checkPasswordPolicy (max 128, SEC-A L6)
});

export async function createUser(pool: Pool, req: Request, res: Response): Promise<void> {
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
  const session = sessionOf(req);
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
  password: z.string().min(1), // length/strength: checkPasswordPolicy (max 128, SEC-A L6)
});

export async function resetUserPassword(pool: Pool, req: Request, res: Response): Promise<void> {
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

  const session = sessionOf(req);
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
export async function disableUser(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = sessionOf(req);
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

export async function enableUser(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = sessionOf(req);
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
