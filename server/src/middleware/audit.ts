import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Pool } from 'pg';

export type AuditOutcome = 'success' | 'failure' | 'denied';

export interface AuditEntry {
  actorUserId?: string | null;
  actorOrgId?:  string | null;
  action:       string;
  targetType?:  string | null;
  targetId?:    string | null;
  outcome:      AuditOutcome;
  ip?:          string | null;
  userAgent?:   string | null;
  extra?:       Record<string, unknown> | null;
}

const AUDIT_SQL = `
  INSERT INTO audit_logs
    (actor_user_id, actor_org_id, action, target_type, target_id, outcome, ip, user_agent, extra)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`;

function auditParams(entry: AuditEntry): unknown[] {
  return [
    entry.actorUserId ?? null,
    entry.actorOrgId  ?? null,
    entry.action,
    entry.targetType  ?? null,
    entry.targetId    ?? null,
    entry.outcome,
    entry.ip          ?? null,
    entry.userAgent   ?? null,
    entry.extra       ? JSON.stringify(entry.extra) : null,
  ];
}

// Fire-and-forget INSERT into audit_logs. Errors are logged but never thrown —
// an audit failure must never break the main request path.
export async function writeAuditLog(pool: Pool, entry: AuditEntry): Promise<void> {
  try {
    await pool.query(AUDIT_SQL, auditParams(entry));
  } catch (err) {
    console.error('[audit] failed to write audit log', { action: entry.action, err });
  }
}

// Strict INSERT: throws on DB failure. Use when the audit row IS the primary
// purpose of the request (e.g. POST /api/audit/emr) so the caller can return
// 500 instead of silently losing the record.
export async function writeAuditLogStrict(pool: Pool, entry: AuditEntry): Promise<void> {
  await pool.query(AUDIT_SQL, auditParams(entry));
}

// ---------------------------------------------------------------------------
// Route-level audit middleware factory
//
// Usage:
//   router.post('/patients', authMiddleware, auditMiddleware(pool, 'patient_create', 'patient'), handler)
//
// Uses res.on('finish') so the audit fires regardless of response method
// (json, send, end, pipe, stream). For error responses, route handlers
// should set res.locals.auditErrorCode before sending so it can be captured.
// ---------------------------------------------------------------------------
export function auditMiddleware(
  pool:       Pool,
  action:     string,
  targetType: string | null = null,
  getTargetId?: (req: Request) => string | null,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      const status  = res.statusCode;
      const outcome: AuditOutcome =
        status === 401 || status === 403 ? 'denied' :
        status >= 400                    ? 'failure' : 'success';

      const session   = req.sessionInfo;
      const errorCode = res.locals.auditErrorCode as string | undefined;

      writeAuditLog(pool, {
        actorUserId: session?.userId         ?? null,
        actorOrgId:  session?.organizationId ?? null,
        action,
        targetType,
        targetId:    getTargetId ? getTargetId(req) : (req.params.id ?? null),
        outcome,
        ip:          req.ip                    ?? null,
        userAgent:   req.headers['user-agent'] ?? null,
        extra:       errorCode ? { responseCode: errorCode } : null,
      });
    });

    next();
  };
}

// ---------------------------------------------------------------------------
// Auth-specific audit helpers (login success/fail, logout, refresh fail)
// These are called explicitly from route handlers because the session is not
// yet available on req when login runs.
// ---------------------------------------------------------------------------
export function auditLogin(
  pool:    Pool,
  req:     Request,
  outcome: AuditOutcome,
  userId?: string | null,
  orgId?:  string | null,
): void {
  writeAuditLog(pool, {
    actorUserId: userId   ?? null,
    actorOrgId:  orgId    ?? null,
    action:      'auth_login',
    targetType:  'session',
    outcome,
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });
}

export function auditLogout(pool: Pool, req: Request): void {
  const session = req.sessionInfo;
  writeAuditLog(pool, {
    actorUserId: session?.userId         ?? null,
    actorOrgId:  session?.organizationId ?? null,
    action:      'auth_logout',
    targetType:  'session',
    targetId:    session?.sessionId      ?? null,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });
}

export function auditRefreshFail(pool: Pool, req: Request, code: string): void {
  writeAuditLog(pool, {
    action:     'auth_refresh_fail',
    targetType: 'session',
    outcome:    'failure',
    ip:         req.ip ?? null,
    userAgent:  req.headers['user-agent'] ?? null,
    extra:      { code },
  });
}

export function auditRefreshSuccess(
  pool:      Pool,
  req:       Request,
  userId:    string,
  orgId:     string | null,
  sessionId: string,
): void {
  writeAuditLog(pool, {
    actorUserId: userId,
    actorOrgId:  orgId,
    action:      'auth_refresh',
    targetType:  'session',
    targetId:    sessionId,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });
}
