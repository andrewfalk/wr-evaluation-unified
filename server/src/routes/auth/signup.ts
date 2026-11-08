// POST /api/auth/signup-requests — always 202 (SEC-B L4).
// Split out of routes/auth.ts (S5 P1-32); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { writeAuditLog } from '../../middleware/audit';

// ---------------------------------------------------------------------------
// POST /api/auth/signup-requests  (public — no auth required)
// Submits a new account request.  Admins approve/reject in the admin console.
// Always answers 202 ACCEPTED once the body is valid (SEC-B L4): a login ID that is already an account
// or already has a pending request is silently ignored (the existing row stays), so the answer does
// not reveal which login IDs exist. The audit row records what actually happened.
// ---------------------------------------------------------------------------
const signupRequestSchema = z.object({
  loginId:       z.string().trim().min(3).max(50).regex(/^[a-zA-Z0-9_.-]+$/),
  name:          z.string().trim().min(1).max(100),
  requestedRole: z.enum(['doctor', 'nurse', 'staff']),
  note:          z.string().max(500).optional(),
});

export async function createSignupRequest(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = signupRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', errors: parsed.error.flatten().fieldErrors });
    return;
  }
  const { loginId, name, requestedRole, note } = parsed.data;

  const audit = (outcome: 'success' | 'failure', targetId: string | null, reason?: string) => writeAuditLog(pool, {
    actorUserId: null,
    actorOrgId:  null,
    action:      'signup_request_create',
    targetType:  'signup_request',
    targetId,
    outcome,
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
    extra:       reason ? { reason } : null,
  });

  const { rows: existing } = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE login_id = $1 LIMIT 1`,
    [loginId]
  );
  if (existing.length > 0) {
    audit('failure', null, 'login_id_taken');
    res.status(202).json(SIGNUP_ACCEPTED_BODY);
    return;
  }

  // The partial unique index (one pending request per login_id) makes a duplicate a no-op, including
  // two identical requests arriving together.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO user_signup_requests (login_id, name, requested_role, note)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (login_id) WHERE status = 'pending' DO NOTHING
     RETURNING id`,
    [loginId, name, requestedRole, note ?? null]
  );
  if (rows.length === 0) audit('failure', null, 'already_requested');
  else audit('success', rows[0].id);
  res.status(202).json(SIGNUP_ACCEPTED_BODY);
}

const SIGNUP_ACCEPTED_BODY = Object.freeze({
  code:    'ACCEPTED',
  message: 'Signup request received; an administrator will review it',
});
