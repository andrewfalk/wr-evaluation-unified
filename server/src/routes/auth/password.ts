// POST /api/auth/change-password.
// Split out of routes/auth.ts (S5 P1-32); handler bodies unchanged.
import bcrypt from 'bcrypt';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { generateAccessToken } from '../../auth/tokens';
import { writeAuditLog } from '../../middleware/audit';
import { checkPasswordPolicy, isPasswordReused, appendPasswordHistory } from '../../auth/passwordPolicy';
import { sessionOf } from '../../http/authz';

// ---------------------------------------------------------------------------
// Route: POST /api/auth/change-password
// ---------------------------------------------------------------------------
const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(1),
});

export async function changePassword(pool: Pool, req: Request, res: Response): Promise<void> {
  const parse = ChangePasswordBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }
  const { currentPassword, newPassword } = parse.data;
  const { userId, organizationId, sessionId, csrfTokenHash } = sessionOf(req);

  // Policy check first (fast path before DB round-trip)
  const policy = checkPasswordPolicy(newPassword);
  if (!policy.ok) {
    res.status(400).json({ code: 'PASSWORD_POLICY_VIOLATION', error: policy.error });
    return;
  }

  const client = await pool.connect();
  let updatedUser: {
    id: string; name: string; role: string;
    organization_id: string | null; must_change_password: boolean;
  } | null = null;
  try {
    const { rows } = await client.query<{
      password_hash:    string;
      password_history: string[];
    }>(
      `SELECT password_hash, password_history FROM users WHERE id = $1`,
      [userId]
    );
    if (rows.length === 0) {
      res.status(401).json({ code: 'UNAUTHORIZED', error: 'User not found' });
      return;
    }
    const { password_hash, password_history } = rows[0];

    // Verify current password
    const currentValid = await bcrypt.compare(currentPassword, password_hash);
    if (!currentValid) {
      writeAuditLog(pool, {
        actorUserId: userId,
        actorOrgId:  organizationId ?? null,
        action:      'auth_change_password_fail',
        outcome:     'denied',
        ip:          req.ip ?? null,
        userAgent:   req.headers['user-agent'] ?? null,
        extra:       { reason: 'wrong_current_password' },
      });
      res.status(401).json({ code: 'WRONG_CURRENT_PASSWORD', error: 'Current password is incorrect' });
      return;
    }

    // Check history (includes current hash)
    const historyToCheck = [...(password_history ?? []), password_hash];
    if (await isPasswordReused(newPassword, historyToCheck)) {
      res.status(400).json({
        code:  'PASSWORD_RECENTLY_USED',
        error: '최근 사용한 비밀번호는 다시 사용할 수 없습니다.',
      });
      return;
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    const newHistory = appendPasswordHistory(historyToCheck, newHash);

    // Update password, clear must_change_password, revoke all other sessions
    await client.query('BEGIN');
    const { rows: updatedRows } = await client.query<{
      id: string; name: string; role: string;
      organization_id: string | null; must_change_password: boolean;
    }>(
      `UPDATE users
       SET password_hash = $1, password_history = $2, must_change_password = false
       WHERE id = $3
       RETURNING id, name, role, organization_id, must_change_password`,
      [newHash, newHistory, userId]
    );
    updatedUser = updatedRows[0] ?? null;
    // Revoke all sessions except the current one
    await client.query(
      `UPDATE sessions SET invalidated_at = now()
       WHERE user_id = $1 AND id != $2 AND invalidated_at IS NULL`,
      [userId, sessionOf(req).sessionId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  writeAuditLog(pool, {
    actorUserId: userId,
    actorOrgId:  organizationId ?? null,
    action:      'auth_change_password',
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  if (!updatedUser) {
    res.status(401).json({ code: 'UNAUTHORIZED', error: 'User not found' });
    return;
  }

  const { token: accessToken, expiresAt: accessExpiresAt } = generateAccessToken({
    sub:                updatedUser.id,
    sessionId,
    orgId:              updatedUser.organization_id,
    role:               updatedUser.role,
    name:               updatedUser.name,
    mustChangePassword: updatedUser.must_change_password,
    csrfHash:           csrfTokenHash,
  });

  res.status(200).json({
    ok: true,
    user: {
      id:                 updatedUser.id,
      name:               updatedUser.name,
      role:               updatedUser.role,
      organizationId:     updatedUser.organization_id,
      mustChangePassword: updatedUser.must_change_password,
    },
    accessToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
  });
}
