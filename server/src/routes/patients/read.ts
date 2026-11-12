// GET /api/patients/:id.
// Split out of routes/patients.ts (S5 P1-29); the SQL is db/patientRecordsRepo.ts selectLive (S7-8b).
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { orgIdOf } from '../../http/authz';
import { toQueryRunner } from '../../db/queryRunner';
import { selectLive } from '../../db/patientRecordsRepo';
import { toResponse } from './shared';

// ---------------------------------------------------------------------------
// GET /api/patients/:id
// ---------------------------------------------------------------------------
export async function getPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

  const row = await selectLive(toQueryRunner(pool), id, orgId);

  if (!row) {
    res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
    return;
  }

  res.status(200).json(toResponse(row));
}
