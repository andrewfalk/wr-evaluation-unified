import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import {
  CreateCapabilityGrantRequestSchema,
  RevokeCapabilityGrantRequestSchema,
} from '@wr/contracts';
import { createAuthMiddleware } from '../middleware/auth';
import { csrfMiddleware } from '../middleware/csrf';
import { adminOnly } from '../middleware/adminOnly';
import { writeAuditLogStrict } from '../middleware/audit';

// PR0-A: 통계 워크벤치 권한 부여/회수. `/api/admin`에 두지 않고 별도 마운트(`/api/capabilities`)
// 한다 — admin.ts는 "모든 라우트가 균일하게 auth+admin"을 전제하는데, 여기엔 self-revoke·
// 본인조회처럼 비균일 인가가 섞여 있어 그 전제를 깨지 않기 위해 분리한다.

const internalError = () => ({ code: 'INTERNAL_ERROR', error: 'Internal server error' });

interface CapabilityCatalogRow {
  key:                 string;
  label:               string;
  description:         string | null;
  default_all_roles:   boolean;
  requires_step_up:    boolean;
  requires_admin_role: boolean;
}

async function listCatalog(pool: Pool, _req: Request, res: Response): Promise<void> {
  const { rows } = await pool.query<CapabilityCatalogRow>(
    `SELECT key, label, description, default_all_roles, requires_step_up, requires_admin_role
     FROM capabilities ORDER BY key`
  );
  res.status(200).json({
    capabilities: rows.map((r) => ({
      key:               r.key,
      label:             r.label,
      description:       r.description,
      defaultAllRoles:   r.default_all_roles,
      requiresStepUp:    r.requires_step_up,
      requiresAdminRole: r.requires_admin_role,
    })),
  });
}

interface GrantRow {
  id:                string;
  user_id:           string;
  user_name:         string;
  capability:        string;
  granted_by:        string | null;
  granted_by_name:   string | null;
  granted_at:        Date;
  expires_at:        Date | null;
  reason:            string;
  revoked_at:        Date | null;
  revocation_reason: string | null;
}

const GRANT_SELECT = `
  SELECT g.id, g.user_id, u.name AS user_name, g.capability,
         g.granted_by, gb.name AS granted_by_name,
         g.granted_at, g.expires_at, g.reason, g.revoked_at, g.revocation_reason
  FROM user_capability_grants g
  JOIN users u ON u.id = g.user_id
  LEFT JOIN users gb ON gb.id = g.granted_by`;

function grantStatus(row: GrantRow): 'active' | 'expired' | 'revoked' {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at !== null && row.expires_at.getTime() <= Date.now()) return 'expired';
  return 'active';
}

function toGrantResponse(row: GrantRow) {
  return {
    id:               row.id,
    userId:           row.user_id,
    userName:         row.user_name,
    capability:       row.capability,
    grantedBy:        row.granted_by,
    grantedByName:    row.granted_by_name,
    grantedAt:        row.granted_at.toISOString(),
    expiresAt:        row.expires_at?.toISOString() ?? null,
    reason:           row.reason,
    revokedAt:        row.revoked_at?.toISOString() ?? null,
    revocationReason: row.revocation_reason,
    status:           grantStatus(row),
  };
}

async function listGrants(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId = req.sessionInfo!.organizationId;
  const { rows } = await pool.query<GrantRow>(
    `${GRANT_SELECT} WHERE g.organization_id = $1 ORDER BY g.granted_at DESC`,
    [orgId]
  );
  res.status(200).json({ grants: rows.map(toGrantResponse) });
}

// 호출자 본인의 grant 목록. Self-revoke는 API로는 admin이 아니어도 가능하지만, 관리자
// 콘솔에 접근할 수 없는 비-admin 사용자는 자기 grant id를 알 방법이 없었다 — 그 격차를 메운다.
async function listMyGrants(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const { rows } = await pool.query<GrantRow>(
    `${GRANT_SELECT} WHERE g.organization_id = $1 AND g.user_id = $2 ORDER BY g.granted_at DESC`,
    [session.organizationId, session.userId]
  );
  res.status(200).json({ grants: rows.map(toGrantResponse) });
}

// §7.2 재부여 트랜잭션: 열린 grant를 FOR UPDATE로 잠그고, 만료됐으면 expired_regrant로
// 닫은 뒤 새 grant를 INSERT한다. 동시 재부여 경쟁은 user_capability_grants_open_uniq가 막는다.
async function createGrant(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;
  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const parsed = CreateCapabilityGrantRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parsed.error.issues });
    return;
  }
  const { userId, capability, reason, expiresAt } = parsed.data;

  // stats.export_phi는 §7.1이 "admin 역할 + 활성 grant + step-up + 사유 모두 필요"라고
  // 규정한다 — grant 자체를 non-admin에게 부여하는 요청은 착오이므로 즉시 차단한다.
  // (사용자 확정: 부여 시점 차단. 실행 시점 게이트는 별도로 requireCapability + adminOnly가 담당.)
  if (capability === 'stats.export_phi') {
    const { rows: targetRows } = await pool.query<{ role: string }>(
      `SELECT role FROM users WHERE id = $1 AND organization_id = $2`,
      [userId, orgId]
    );
    if (targetRows.length === 0) {
      res.status(404).json({ code: 'USER_NOT_FOUND', error: 'Target user not found' });
      return;
    }
    if (targetRows[0].role !== 'admin') {
      res.status(400).json({ code: 'PHI_GRANT_REQUIRES_ADMIN', error: 'stats.export_phi can only be granted to admin users' });
      return;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: openRows } = await client.query<{ id: string; expires_at: Date | null }>(
      `SELECT id, expires_at FROM user_capability_grants
       WHERE user_id = $1 AND capability = $2 AND revoked_at IS NULL
       FOR UPDATE`,
      [userId, capability]
    );

    if (openRows.length > 0) {
      const open = openRows[0];
      const isExpired = open.expires_at !== null && open.expires_at.getTime() <= Date.now();
      if (isExpired) {
        await client.query(
          `UPDATE user_capability_grants SET revoked_at = now(), revocation_reason = 'expired_regrant'
           WHERE id = $1`,
          [open.id]
        );
      } else {
        await client.query('ROLLBACK');
        res.status(409).json({ code: 'GRANT_ALREADY_ACTIVE', error: 'An active grant for this capability already exists' });
        return;
      }
    }

    const { rows: inserted } = await client.query<{ id: string }>(
      `INSERT INTO user_capability_grants
         (user_id, organization_id, capability, granted_by, granted_by_org, reason, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id`,
      [userId, orgId, capability, session.userId, orgId, reason, expiresAt ?? null]
    );

    await writeAuditLogStrict(client, {
      actorUserId: session.userId,
      actorOrgId:  orgId,
      action:      'capability_grant',
      targetType:  'user_capability_grant',
      targetId:    inserted[0].id,
      outcome:     'success',
      ip:          req.ip ?? null,
      userAgent:   req.headers['user-agent'] ?? null,
      extra:       { userId, capability, expiresAt: expiresAt ?? null, reason, selfGrant: userId === session.userId },
    });

    await client.query('COMMIT');

    const { rows: created } = await pool.query<GrantRow>(`${GRANT_SELECT} WHERE g.id = $1`, [inserted[0].id]);
    res.status(201).json(toGrantResponse(created[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // 두 요청이 동시에 같은 만료 grant를 재부여하려 하면 둘 다 SELECT에서는 "열린 grant
    // 없음"으로 보일 수 있다(한쪽이 커밋한 직후) — user_capability_grants_open_uniq가
    // 진 쪽의 INSERT를 막아준다. 그 경쟁을 500이 아니라 409로 정상 응답한다.
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === 'user_capability_grants_open_uniq') {
      res.status(409).json({ code: 'GRANT_ALREADY_ACTIVE', error: 'An active grant for this capability already exists' });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function revokeGrant(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = req.sessionInfo!;
  const orgId   = session.organizationId;
  const { id }  = req.params;
  if (orgId === null) {
    res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
    return;
  }

  const parsed = RevokeCapabilityGrantRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parsed.error.issues });
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query<{ id: string; user_id: string; capability: string; revoked_at: Date | null }>(
      `SELECT id, user_id, capability, revoked_at FROM user_capability_grants
       WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [id, orgId]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'GRANT_NOT_FOUND', error: 'Grant not found' });
      return;
    }
    const grant = rows[0];

    const isSelf = grant.user_id === session.userId;
    if (session.role !== 'admin' && !isSelf) {
      await client.query('ROLLBACK');
      res.status(403).json({ code: 'FORBIDDEN', error: 'Only admin or the grant subject can revoke this grant' });
      return;
    }

    if (grant.revoked_at !== null) {
      await client.query('ROLLBACK');
      res.status(409).json({ code: 'ALREADY_REVOKED', error: 'Grant is already revoked' });
      return;
    }

    await client.query(
      `UPDATE user_capability_grants SET revoked_at = now(), revoked_by = $2, revoked_by_org = $3, revocation_reason = $4
       WHERE id = $1`,
      [id, session.userId, orgId, isSelf ? 'self_revoke' : 'manual']
    );

    await writeAuditLogStrict(client, {
      actorUserId: session.userId,
      actorOrgId:  orgId,
      action:      'capability_revoke',
      targetType:  'user_capability_grant',
      targetId:    id,
      outcome:     'success',
      ip:          req.ip ?? null,
      userAgent:   req.headers['user-agent'] ?? null,
      extra:       { capability: grant.capability, selfRevoke: isSelf, reason: parsed.data.reason ?? null },
    });

    await client.query('COMMIT');

    const { rows: updated } = await pool.query<GrantRow>(`${GRANT_SELECT} WHERE g.id = $1`, [id]);
    res.status(200).json(toGrantResponse(updated[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export function createCapabilityGrantsRouter(pool: Pool): Router {
  const router = Router();
  const auth  = createAuthMiddleware(pool);
  const admin = adminOnly();

  router.get(
    '/catalog',
    auth,
    (req, res) => listCatalog(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.get(
    '/grants/me',
    auth,
    (req, res) => listMyGrants(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.get(
    '/grants',
    auth, admin,
    (req, res) => listGrants(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  router.post(
    '/grants',
    auth, admin, csrfMiddleware,
    (req, res) => createGrant(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  // adminOnly 없음(의도적) — self-revoke는 비-admin도 허용해야 하므로 핸들러 내부에서
  // admin 또는 grant 본인인지 확인한다. 상태 변경 POST이므로 CSRF는 예외 없이 적용.
  router.post(
    '/grants/:id/revoke',
    auth, csrfMiddleware,
    (req, res) => revokeGrant(pool, req, res).catch(() => res.status(500).json(internalError()))
  );

  return router;
}
