// POST /api/patients/:id/identity-correction. Split out of routes/patients.ts (S5 P1-29); the transaction loop
// moved to domain/patients/correctIdentity.ts (S7-7), the responses are unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { validatePastDate } from '@wr/contracts';
import { correctIdentity } from '../../domain/patients/patientRecordsService';
import { lockOf } from '../../http/lockToken';
import { patientWriteContextOf } from '../../http/patientWriteContext';
import { invalidBirthDateResponse, lockHeldResponse, toResponse } from './shared';

// ---------------------------------------------------------------------------
// POST /api/patients/:id/identity-correction
//
// 서버에 잘못 저장된 생년월일을 정정한다. POST /api/patients에는 이 기능을 절대
// 두지 않는다 — 그 라우트에는 assignedDoctorOrAdmin이 없어서, 본문 플래그만으로
// override를 허용하면 조직 내 임의 사용자가 남의 person을 고칠 수 있다.
//
// 요구사항: If-Match(대상 revision) + 편집 락 게이트 + 담당의/관리자.
// 활성 case가 여러 개면 관리자만 가능하며, 그 person의 모든 활성 case가 함께 갱신된다.
// ---------------------------------------------------------------------------
const IdentityCorrectionBody = z.object({
  // 빈 값 금지 — null로 person 생년월일을 지우면 identity 안전장치가 무력화된다.
  birthDate:  z.string().min(1),
  reasonCode: z.enum(['batch_import_typo', 'emr_mismatch', 'other']),
});

export async function correctPatientIdentityRoute(pool: Pool, req: Request, res: Response): Promise<void> {
  // 세션·조직 확인(sessionOf → orgIdOf)은 이전처럼 맨 앞. 락 토큰은 X-Lock-Token.
  const ctx    = patientWriteContextOf(req);
  const { id } = req.params;

  const { ifMatch: expectedRevision } = lockOf(req); // requireLockToken() on the route (S4 / P1-18)

  const parse = IdentityCorrectionBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }

  // 정정 값도 일반 입력과 같은 달력 규칙을 따르되 빈 값은 허용하지 않는다.
  const checked = validatePastDate(parse.data.birthDate, { allowEmpty: false });
  if (!checked.valid) {
    res.status(400).json(invalidBirthDateResponse([{ field: 'birthDate', reason: checked.reason ?? 'format' }]));
    return;
  }
  const { reasonCode } = parse.data;

  // 시도마다 조기 락 게이트 → correctPatientIdentity → 트랜잭션 안 감사 → 재조회, 집합이 바뀌면 재시도 —
  // domain/patients/correctIdentity.ts(S7-7). 결과마다 이전과 같은 응답을 쓴다.
  const result = await correctIdentity(pool, ctx, { id, expectedRevision, birthDate: checked.normalized, reasonCode });
  switch (result.kind) {
    case 'corrected':
      res.status(200).json({
        ...toResponse(result.row),
        // 복수 case 정정 시 나머지 로컬 case의 revision이 뒤처지므로 클라이언트가
        // 이 목록으로 pull sync를 돌려 후속 revision conflict를 예방한다.
        affectedPatientIds: result.affectedPatientIds,
      });
      return;
    case 'lock_held_gate':
      res.status(423).json(lockHeldResponse(result.heldBy));
      return;
    case 'set_changed':
      res.status(409).json({
        code:      'IDENTITY_SET_CHANGED',
        error:     'Related cases kept changing while applying the correction. Please retry.',
        retriable: true,
      });
      return;
    case 'not_found':
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    case 'revision_mismatch':
      res.status(409).json({ code: 'CONFLICT', error: 'Revision mismatch.', currentRevision: result.currentRevision });
      return;
    case 'forbidden':
      res.status(403).json({
        code:  result.requiresAdmin ? 'IDENTITY_CORRECTION_REQUIRES_ADMIN' : 'FORBIDDEN',
        error: result.requiresAdmin
          ? 'This patient number has multiple active cases; only an administrator can correct it'
          : 'Only the assigned doctor can modify this patient',
      });
      return;
    case 'case_locked':
      res.status(423).json({ code: 'LOCK_HELD', error: result.message });
      return;
  }
}
