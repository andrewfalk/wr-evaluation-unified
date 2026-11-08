// Admin console: organization inference device settings.
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { OrgInferenceSettingsSchema } from '@wr/contracts';
import { orgIdOf, sessionOf } from '../../http/authz';
import { writeAuditLog } from '../../middleware/audit';
import { probeGpu } from './gpu';

// 시스템 관리자(organizationId 없음)는 대상 조직이 불명확 → 라우트의 requireOrg()가 403. 다조직 운용 필요 시
// 별도 superadmin 경로로 분리.
export async function getOrgSettings(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId = orgIdOf(req);
  const { rows } = await pool.query<{ inference_device: string }>(
    `SELECT inference_device FROM organizations WHERE id = $1`, [orgId],
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'ORG_NOT_FOUND', error: 'Organization not found' });
    return;
  }
  const gpu = await probeGpu();
  res.status(200).json({ inferenceDevice: rows[0].inference_device, gpu });
}

export async function updateOrgSettings(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId = orgIdOf(req);
  const parsed = OrgInferenceSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: 'inferenceDevice must be one of auto|cpu|cuda' });
    return;
  }
  const { rows } = await pool.query<{ inference_device: string }>(
    `UPDATE organizations SET inference_device = $2 WHERE id = $1 RETURNING inference_device`,
    [orgId, parsed.data.inferenceDevice],
  );
  if (rows.length === 0) {
    res.status(404).json({ code: 'ORG_NOT_FOUND', error: 'Organization not found' });
    return;
  }
  writeAuditLog(pool, {
    actorUserId: sessionOf(req).userId,
    actorOrgId:  orgId,
    action:      'org_settings_update',
    targetType:  'organization',
    targetId:    orgId,
    outcome:     'success',
    ip:          req.ip ?? null,
    userAgent:   req.headers['user-agent'] ?? null,
  });
  res.status(200).json({ inferenceDevice: rows[0].inference_device });
}
