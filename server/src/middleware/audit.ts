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
//
// Pool뿐 아니라 PoolClient도 받는다 — 정정처럼 "감사 기록이 남지 않으면 변경도 남으면
// 안 되는" 작업은 변경과 같은 트랜잭션에서 기록해야 하기 때문.
export async function writeAuditLogStrict(
  db: { query(text: string, params?: unknown[]): Promise<unknown> },
  entry: AuditEntry,
): Promise<void> {
  await db.query(AUDIT_SQL, auditParams(entry));
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
export interface AuditMiddlewareOptions {
  /**
   * 이 요청을 기록할지 결정한다. 미지정 시 모든 응답을 기록(기존 동작).
   *
   * 성공 경로에서 핸들러가 트랜잭션 안에 직접 감사 기록을 남기는 경우, 미들웨어까지
   * 기록하면 같은 사건이 두 건 남는다. 그럴 때 실패/거부만 남기도록 좁히는 용도.
   */
  shouldWrite?: (ctx: { status: number; outcome: AuditOutcome }) => boolean;
}

/** 4xx/5xx만 기록하는 predicate — 성공은 핸들러가 직접 남기는 경우에 쓴다. */
export const auditFailuresOnly = (ctx: { status: number }): boolean => ctx.status >= 400;

export function auditMiddleware(
  pool:       Pool,
  action:     string,
  targetType: string | null = null,
  getTargetId?: (req: Request) => string | null,
  options: AuditMiddlewareOptions = {},
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    res.on('finish', () => {
      const status  = res.statusCode;
      const outcome: AuditOutcome =
        status === 401 || status === 403 ? 'denied' :
        status >= 400                    ? 'failure' : 'success';

      if (options.shouldWrite && !options.shouldWrite({ status, outcome })) return;

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

// logout no longer sits behind the Bearer-auth middleware (it authenticates
// via the refresh cookie instead, so it still works with an expired access
// token — see auth.ts), so req.sessionInfo isn't populated here. Callers pass
// the identity explicitly, resolved from verifySession().
export function auditLogout(
  pool:       Pool,
  req:        Request,
  userId?:    string | null,
  orgId?:     string | null,
  sessionId?: string | null,
): void {
  writeAuditLog(pool, {
    actorUserId: userId    ?? null,
    actorOrgId:  orgId     ?? null,
    action:      'auth_logout',
    targetType:  'session',
    targetId:    sessionId ?? null,
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
