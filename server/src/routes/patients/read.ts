// GET /api/patients/:id.
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { orgIdOf } from '../../http/authz';
import { PatientRow, SELECT_COLS } from './schemas';
import { toResponse } from './shared';

// ---------------------------------------------------------------------------
// GET /api/patients/:id
// ---------------------------------------------------------------------------
export async function getPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

  const { rows } = await pool.query<PatientRow>(
    `SELECT ${SELECT_COLS}
     FROM patient_records
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [id, orgId]
  );

  if (rows.length === 0) {
    res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    return;
  }

  res.status(200).json(toResponse(rows[0]));
}
