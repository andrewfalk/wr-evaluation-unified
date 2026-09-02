import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { writeAuditLog } from './audit';
import { getStatsWorkbenchAvailability } from '../statsWorkbenchRuntimeState';

// PR0-A: 통계 워크벤치 capability 게이트. 판정 = 역할 기본값(default_all_roles) ∪
// 유효(미만료·미회수) grant. Must be used after auth so req.sessionInfo is populated.
//
// 런타임 가용성이 꺼져 있으면(비-intranet 배포, feature flag off) 403이 아니라 404를
// 반환한다 — patientAccess.ts의 cross-org 404 관례와 동일하게, 기능 자체의 존재를
// 노출하지 않는다.
export function requireCapability(pool: Pool, capability: string): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!getStatsWorkbenchAvailability().available) {
      res.status(404).json({ code: 'NOT_FOUND', error: 'Not found' });
      return;
    }

    const session = req.sessionInfo!;
    const orgId = session.organizationId;

    if (orgId === null) {
      res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
      return;
    }

    try {
      const { rows } = await pool.query<{ has_default: boolean; has_grant: boolean }>(
        `SELECT
           EXISTS(SELECT 1 FROM capabilities WHERE key = $1 AND default_all_roles = true) AS has_default,
           EXISTS(SELECT 1 FROM user_capability_grants
                  WHERE user_id = $2 AND organization_id = $3 AND capability = $1
                    AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) AS has_grant`,
        [capability, session.userId, orgId]
      );

      if (rows[0]?.has_default || rows[0]?.has_grant) {
        next();
        return;
      }

      // Fire-and-forget — a denial audit failing shouldn't itself 500 the request.
      void writeAuditLog(pool, {
        actorUserId: session.userId,
        actorOrgId:  orgId,
        action:      'stats_access_denied',
        targetType:  'capability',
        targetId:    capability,
        outcome:     'denied',
        ip:          req.ip ?? null,
        userAgent:   req.headers['user-agent'] ?? null,
        extra:       { capability },
      });

      res.status(403).json({ code: 'FORBIDDEN', error: 'Missing required capability', capability });
    } catch (err) {
      next(err);
    }
  };
}
