// DELETE /api/patients/:id — soft delete with workspace redaction and autosave cleanup. Split out of
// routes/patients.ts (S5 P1-29); the transaction moved to domain/patients/softDeletePatient.ts (S7-5), the
// responses are unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { softDeletePatient } from '../../domain/patients/patientRecordsService';
import { parsePositiveInt } from '../../http/lockToken';
import { patientWriteContextOf } from '../../http/patientWriteContext';
import { lockHeldResponse } from './shared';

// ---------------------------------------------------------------------------
// DELETE /api/patients/:id?revision=N
// Soft-delete (sets deleted_at). Within the same transaction, redacts the
// deleted patient's PHI from every workspace snapshot in this org so that
// { id, redacted: true } stubs remain without exposing name/birth_date/etc.,
// and removes the patient from autosave snapshots (SEC-B L12).
// Returns 409 on revision mismatch.
// ---------------------------------------------------------------------------
export async function deletePatient(pool: Pool, req: Request, res: Response): Promise<void> {
  // 세션·조직 확인(sessionOf → orgIdOf)은 이전처럼 맨 앞. 락 토큰은 X-Lock-Token.
  const ctx    = patientWriteContextOf(req);
  const { id } = req.params;

  const revParam = req.query['revision'];
  if (!revParam) {
    res.status(400).json({ code: 'REVISION_REQUIRED', error: 'revision query parameter is required' });
    return;
  }
  const revision = parsePositiveInt(revParam);
  if (revision === null) {
    res.status(400).json({ code: 'INVALID_REVISION', error: 'revision must be a positive integer' });
    return;
  }

  // 트랜잭션(앵커 → 담당의 재확인 → 락 게이트 → soft delete → 워크스페이스 가림 → autosave 정리 → 락 행
  // 삭제 → person 해제)은 domain/patients/softDeletePatient.ts(S7-5). 결과마다 이전과 같은 응답을 쓴다.
  const result = await softDeletePatient(pool, ctx, { id, revision });
  switch (result.kind) {
    case 'deleted':
      res.status(204).end();
      return;
    case 'not_found':
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    case 'forbidden':
      res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
      return;
    case 'lock_held':
      res.status(423).json(lockHeldResponse(result.heldBy));
      return;
    case 'revision_mismatch':
      res.status(409).json({
        code:            'CONFLICT',
        error:           'Revision mismatch.',
        currentRevision: result.currentRevision,
      });
      return;
  }
}
