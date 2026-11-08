// Admin console: signup request list, approve and reject (SEC-B L4 organization scope).
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import type { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import type { Pool, PoolClient } from 'pg';
import { sessionOf } from '../../http/authz';
import { writeAuditLog } from '../../middleware/audit';
import { generateTempPassword } from './shared';

// ---------------------------------------------------------------------------
// GET /api/admin/signup-requests
// ---------------------------------------------------------------------------
interface SignupRequestRow {
  id:             string;
  login_id:       string;
  name:           string;
  requested_role: string;
  note:           string | null;
  status:         string;
  reviewer_name:  string | null;
  reviewed_at:    Date | null;
  created_at:     Date;
}

// Which signup requests an admin may see and act on (SEC-B L4, migration 0041): an organization admin
// sees their own organization's rows and the unassigned ones (every pending request is unassigned —
// the form has no hospital choice); an admin without an organization (super-administrator) sees all.
// Returns a SQL condition on alias `r`/the bare table using the next parameter slot, or null for all.
function signupScope(orgId: string | null, params: unknown[], column = 'organization_id'): string | null {
  if (orgId === null) return null;
  params.push(orgId);
  return `(${column} IS NULL OR ${column} = $${params.length})`;
}

export async function listSignupRequests(pool: Pool, req: Request, res: Response): Promise<void> {
  const status  = (req.query.status as string) || 'pending';
  const allowed = ['pending', 'approved', 'rejected'];
  const orgId   = sessionOf(req).organizationId ?? null;

  const params: unknown[] = [];
  const conditions: string[] = [];
  if (allowed.includes(status)) { params.push(status); conditions.push(`r.status = $${params.length}`); }
  const scope = signupScope(orgId, params, 'r.organization_id');
  if (scope) conditions.push(scope);
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query<SignupRequestRow>(
    `SELECT r.id, r.login_id, r.name, r.requested_role, r.note,
            r.status, u.name AS reviewer_name, r.reviewed_at, r.created_at
     FROM user_signup_requests r
     LEFT JOIN users u ON u.id = r.reviewed_by
     ${where}
     ORDER BY r.created_at DESC
     LIMIT 200`,
    params
  );

  res.status(200).json({
    requests: rows.map(r => ({
      id:            r.id,
      loginId:       r.login_id,
      name:          r.name,
      requestedRole: r.requested_role,
      note:          r.note,
      status:        r.status,
      reviewerName:  r.reviewer_name,
      reviewedAt:    r.reviewed_at,
      createdAt:     r.created_at,
    })),
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/signup-requests/:id/approve
// Creates the user account with a generated temp password (must_change_password).
// Uses FOR UPDATE row lock to prevent concurrent double-approval.
// ---------------------------------------------------------------------------
export async function approveSignupRequest(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = sessionOf(req);
  const orgId   = session.organizationId ?? null;
  const tempPw  = generateTempPassword();
  const hash    = await bcrypt.hash(tempPw, 12);

  const client: PoolClient = await pool.connect();
  let committed = false;
  try {
    await client.query('BEGIN');

    const selectParams: unknown[] = [id];
    const scope = signupScope(orgId, selectParams);
    const { rows: reqRows } = await client.query<{
      id: string; login_id: string; name: string; requested_role: string; status: string;
    }>(
      `SELECT id, login_id, name, requested_role, status
       FROM user_signup_requests WHERE id = $1${scope ? ` AND ${scope}` : ''} FOR UPDATE`,
      selectParams
    );

    if (reqRows.length === 0) {
      res.status(404).json({ code: 'REQUEST_NOT_FOUND', error: 'Signup request not found' });
      return;
    }
    if (reqRows[0].status !== 'pending') {
      res.status(409).json({ code: 'ALREADY_REVIEWED', error: 'Request has already been reviewed' });
      return;
    }

    const sr = reqRows[0];
    let userId!: string;
    try {
      const { rows: userRows } = await client.query<{ id: string }>(
        `INSERT INTO users (login_id, password_hash, name, role, organization_id, must_change_password)
         VALUES ($1, $2, $3, $4, $5, TRUE)
         RETURNING id`,
        [sr.login_id, hash, sr.name, sr.requested_role, orgId]
      );
      userId = userRows[0].id;
    } catch (insertErr: unknown) {
      if ((insertErr as NodeJS.ErrnoException & { code?: string }).code === '23505') {
        res.status(409).json({ code: 'LOGIN_ID_TAKEN', error: 'Login ID is already taken' });
        return;
      }
      throw insertErr;
    }

    // The approving admin's organization is recorded on the request (SEC-B L4) — the same organization
    // the new account was created in.
    await client.query(
      `UPDATE user_signup_requests
       SET status = 'approved', reviewed_by = $1, reviewed_at = now(), organization_id = $3
       WHERE id = $2`,
      [session.userId, id, orgId]
    );

    await client.query('COMMIT');
    committed = true;

    writeAuditLog(pool, {
      actorUserId: session.userId,
      actorOrgId:  session.organizationId ?? null,
      action:      'admin_signup_approve',
      targetType:  'user',
      targetId:    userId,
      outcome:     'success',
      ip:          req.ip ?? null,
      userAgent:   req.headers['user-agent'] ?? null,
    });

    res.status(200).json({ userId, tempPassword: tempPw, loginId: sr.login_id, name: sr.name });
  } finally {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------------------
// POST /api/admin/signup-requests/:id/reject
// ---------------------------------------------------------------------------
export async function rejectSignupRequest(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id }  = req.params;
  const session = sessionOf(req);
  const orgId   = session.organizationId ?? null;

  // Like approval, the rejecting admin's organization is recorded (SEC-B L4), so the rejected row is
  // listed for that organization only.
  const updateParams: unknown[] = [session.userId, id, orgId];
  const updateScope = signupScope(orgId, updateParams);
  const { rows } = await pool.query<{ id: string }>(
    `UPDATE user_signup_requests
     SET status = 'rejected', reviewed_by = $1, reviewed_at = now(), organization_id = $3
     WHERE id = $2 AND status = 'pending'${updateScope ? ` AND ${updateScope}` : ''}
     RETURNING id`,
    updateParams
  );

  if (rows.length === 0) {
    const selectParams: unknown[] = [id];
    const selectScope = signupScope(orgId, selectParams);
    const { rows: existing } = await pool.query<{ status: string }>(
      `SELECT status FROM user_signup_requests WHERE id = $1${selectScope ? ` AND ${selectScope}` : ''}`,
      selectParams
    );
    if (existing.length === 0) {
      res.status(404).json({ code: 'REQUEST_NOT_FOUND', error: 'Signup request not found' });
    } else {
      res.status(409).json({ code: 'ALREADY_REVIEWED', error: 'Request has already been reviewed' });
    }
    return;
  }

  writeAuditLog(pool, {
    actorUserId: session.userId,
    actorOrgId:  session.organizationId ?? null,
    action:      'admin_signup_reject',
    targetType:  'signup_request',
    targetId:    id,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });

  res.status(200).json({ id });
}
