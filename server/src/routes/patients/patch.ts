// PATCH /api/patients/:id. Split out of routes/patients.ts (S5 P1-29); the transaction and its deadlock retry
// moved to domain/patients/patchPatient.ts (S7-4), the responses are unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { patchPatient as patchPatientRecord } from '../../domain/patients/patientRecordsService';
import { lockOf } from '../../http/lockToken';
import { patientWriteContextOf } from '../../http/patientWriteContext';
import { PatchBody } from './schemas';
import { uniqueConflictResponse, identityConflictResponse, personVanishedResponse, invalidBirthDateResponse, lockHeldResponse, toResponse } from './shared';

// ---------------------------------------------------------------------------
// PATCH /api/patients/:id
// Requires If-Match: <revision> header. Returns 409 on mismatch.
// ---------------------------------------------------------------------------
export async function patchPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  // 세션·조직 확인(sessionOf → orgIdOf)은 이전처럼 맨 앞. 락 토큰은 X-Lock-Token.
  const ctx    = patientWriteContextOf(req);
  const { id } = req.params;

  const { ifMatch: expectedRevision } = lockOf(req); // requireLockToken() on the route (S4 / P1-18)

  const parse = PatchBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }

  const { phase, data, modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion } = parse.data;

  // 트랜잭션(앵커 FOR UPDATE → 담당의 재확인 → revision → 락 게이트 → 날짜·이름 → person → UPDATE →
  // 옛 person 해제)과 교착 재시도는 domain/patients/patchPatient.ts(S7-4). 결과마다 이전과 같은 응답을 쓴다.
  const result = await patchPatientRecord(pool, ctx, {
    id,
    expectedRevision,
    phase,
    data,
    report: { modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion },
  });
  switch (result.kind) {
    case 'updated':
      res.status(200).json(toResponse(result.row, result.warnings));
      return;
    case 'not_found':
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    case 'forbidden':
      res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
      return;
    case 'revision_mismatch':
      res.status(409).json({
        code:            'CONFLICT',
        error:           'Revision mismatch. Fetch the latest version before retrying.',
        currentRevision: result.currentRevision,
      });
      return;
    case 'lock_held':
      res.status(423).json(lockHeldResponse(result.heldBy));
      return;
    case 'invalid_dates':
      res.status(400).json(invalidBirthDateResponse(result.failures));
      return;
    case 'name_required':
      res.status(400).json({ code: 'NAME_REQUIRED', error: 'Patient name (data.shared.name) is required' });
      return;
    case 'identity_conflict':
      res.status(409).json(identityConflictResponse());
      return;
    case 'person_vanished':
      res.status(409).json(personVanishedResponse());
      return;
    case 'unique_conflict':
      res.status(409).json(uniqueConflictResponse(result.error));
      return;
    case 'concurrent_modification':
      res.status(409).json({
        code:  'CONFLICT',
        error: 'Concurrent modification detected. Please retry.',
      });
      return;
  }
}
