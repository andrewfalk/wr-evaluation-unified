// Admin console: audit log search (read through the audit reader pool).
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Pool } from 'pg';
import { sessionOf } from '../../http/authz';
import { writeAuditLog } from '../../middleware/audit';

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

export async function listAuditLogs(pool: Pool, auditPool: Pool, req: Request, res: Response): Promise<void> {
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
  const session = sessionOf(req);
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
