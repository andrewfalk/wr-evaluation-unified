// POST /api/patients/:id/identity-correction (S7: correctIdentity).
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { writeAuditLogStrict } from '../../middleware/audit';
import { correctPatientIdentity, IdentityCaseLockedError, IdentityForbiddenError, IdentityRevisionMismatchError, IdentitySetChangedError, IdentityTargetNotFoundError } from '../../db/patientIdentityCorrection';
import type { QueryRunner } from '../../db/patientPersons';
import { validatePastDate } from '@wr/contracts';
import { PatientLockTargetNotFoundError, PatientLockForbiddenError } from '../../db/patientLocks';
import { lockOf, lockTokenOf } from '../../http/lockToken';
import { evaluateLockGate } from '../../http/lockGate';
import { orgIdOf, sessionOf } from '../../http/authz';
import { PatientRow, SELECT_COLS } from './schemas';
import { invalidBirthDateResponse, toResponse } from './shared';

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

// 활성 case 집합이 계속 바뀌면 무한 재시도로 커넥션을 묶지 않고 포기한다.
const IDENTITY_CORRECTION_MAX_ATTEMPTS = 3;

export async function correctPatientIdentityRoute(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

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

  for (let attempt = 1; attempt <= IDENTITY_CORRECTION_MAX_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const lockBlock = await evaluateLockGate(pool, client as QueryRunner, req, id, orgId);
      if (lockBlock) {
        await client.query('ROLLBACK');
        res.status(lockBlock.status).json(lockBlock.body);
        return;
      }

      const result = await correctPatientIdentity(client as QueryRunner, {
        targetId: id,
        orgId,
        expectedRevision,
        birthDate: checked.normalized,
        session: { userId: session.userId, role: session.role },
        // 권위 있는 락 판정은 correctPatientIdentity가 활성 case를 잠근 뒤 수행한다.
        // 위 evaluateLockGate는 앵커 없이 도는 값싼 조기 차단일 뿐이다.
        leaseToken: lockTokenOf(req),
      });

      // 감사 기록은 변경과 같은 트랜잭션에서 — 기록이 남지 않으면 변경도 남지 않아야 한다.
      // 라우터의 attempt 미들웨어는 실패/거부만 남기므로 여기서 중복되지 않는다.
      await writeAuditLogStrict(client as unknown as { query(t: string, p?: unknown[]): Promise<unknown> }, {
        actorUserId: session.userId,
        actorOrgId:  orgId,
        action:      'patient_identity_correct',
        targetType:  'patient_person',
        targetId:    result.personId,
        outcome:     'success',
        ip:          req.ip ?? null,
        userAgent:   req.headers['user-agent'] ?? null,
        // 생년월일은 PHI이므로 기록하지 않는다. person UUID는 targetId에 이미 있다.
        extra:       { reasonCode, affectedCaseCount: result.caseCount },
      });

      const { rows } = await client.query<PatientRow>(
        `SELECT ${SELECT_COLS} FROM patient_records WHERE id = $1`,
        [id]
      );

      await client.query('COMMIT');
      res.status(200).json({
        ...toResponse(rows[0]),
        // 복수 case 정정 시 나머지 로컬 case의 revision이 뒤처지므로 클라이언트가
        // 이 목록으로 pull sync를 돌려 후속 revision conflict를 예방한다.
        affectedPatientIds: result.affectedPatientIds,
      });
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});

      if (err instanceof IdentitySetChangedError) {
        if (attempt < IDENTITY_CORRECTION_MAX_ATTEMPTS) continue;
        res.status(409).json({
          code:      'IDENTITY_SET_CHANGED',
          error:     'Related cases kept changing while applying the correction. Please retry.',
          retriable: true,
        });
        return;
      }
      if (err instanceof IdentityTargetNotFoundError || err instanceof PatientLockTargetNotFoundError) {
        res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
        return;
      }
      if (err instanceof IdentityRevisionMismatchError) {
        res.status(409).json({ code: 'CONFLICT', error: 'Revision mismatch.', currentRevision: err.currentRevision });
        return;
      }
      if (err instanceof IdentityForbiddenError) {
        res.status(403).json({
          code:  err.requiresAdmin ? 'IDENTITY_CORRECTION_REQUIRES_ADMIN' : 'FORBIDDEN',
          error: err.requiresAdmin
            ? 'This patient number has multiple active cases; only an administrator can correct it'
            : 'Only the assigned doctor can modify this patient',
        });
        return;
      }
      if (err instanceof IdentityCaseLockedError) {
        res.status(423).json({ code: 'LOCK_HELD', error: err.message });
        return;
      }
      if (err instanceof PatientLockForbiddenError) {
        res.status(403).json({ code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
