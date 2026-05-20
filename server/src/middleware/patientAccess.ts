import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Pool } from 'pg';

// PATCH/DELETE /api/patients/:id 전용 권한 가드.
// admin 또는 해당 환자의 assigned_doctor_user_id == session.userId 인 경우에만 통과.
// 다른 org 또는 존재하지 않는 환자는 404 (존재 누설 방지). 그 외 권한 거부는 403.
// Must be used after auth so req.sessionInfo is populated.
export function assignedDoctorOrAdmin(pool: Pool): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const session = req.sessionInfo!;
    const orgId = session.organizationId;
    const { id } = req.params;

    if (orgId === null) {
      res.status(403).json({ code: 'FORBIDDEN', error: 'Organization context required' });
      return;
    }

    if (session.role === 'admin') {
      next();
      return;
    }

    try {
      const { rows } = await pool.query<{ assigned_doctor_user_id: string | null }>(
        `SELECT assigned_doctor_user_id FROM patient_records
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
        [id, orgId]
      );

      if (rows.length === 0) {
        res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
        return;
      }

      if (rows[0].assigned_doctor_user_id !== session.userId) {
        res.status(403).json({
          code: 'FORBIDDEN',
          error: 'Only the assigned doctor can modify this patient',
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
