// POST /api/patients/:id/assignment — admin only. Split out of routes/patients.ts (S5 P1-29); the work moved to
// domain/patients/assignPatient.ts (S7-6), the responses are unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { assignPatient as assignPatientRecord } from '../../domain/patients/patientRecordsService';
import { patientWriteContextOf } from '../../http/patientWriteContext';
import { lockHeldResponse } from './shared';

// ---------------------------------------------------------------------------
// POST /api/patients/:id/assignment  (admin only)
// Changes the owning doctor (owner_user_id) of a patient record.
// The target user must belong to the same organisation.
// ---------------------------------------------------------------------------
const AssignmentBody = z.object({
  assignedUserId: z.string().uuid().nullable(),
});

export async function assignPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  // 세션·조직 확인(sessionOf → orgIdOf)은 이전처럼 본문 검증보다 먼저.
  const ctx = patientWriteContextOf(req);

  const parsed = AssignmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { assignedUserId } = parsed.data;
  const force = req.query['force'] === 'true';

  // 대상 사용자 확인(트랜잭션 전) → (off가 아니면) 앵커·락 → 이전 담당의 → UPDATE → COMMIT 뒤 감사는
  // domain/patients/assignPatient.ts(S7-6). 결과마다 이전과 같은 응답을 쓴다.
  const result = await assignPatientRecord(pool, ctx, { id, assignedUserId, force });
  switch (result.kind) {
    case 'assigned':
      res.status(200).json({ patientId: id, assignedUserId, revision: result.revision });
      return;
    case 'user_not_found':
      res.status(404).json({ code: 'USER_NOT_FOUND', error: 'User not found in this organization' });
      return;
    case 'target_not_a_doctor':
      res.status(422).json({ code: 'TARGET_NOT_A_DOCTOR', error: 'Assigned user must have the doctor role' });
      return;
    case 'not_found':
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    case 'lock_held':
      res.status(423).json(lockHeldResponse(result.heldBy));
      return;
  }
}
