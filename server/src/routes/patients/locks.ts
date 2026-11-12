// Patient lease lock: acquire/renew, release, peek (S7: lock).
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import { writeAuditLog } from '../../middleware/audit';
import { toQueryRunner } from '../../db/queryRunner';
import type { QueryRunner } from '../../db/patientPersons';
import { acquireLock, renewLock, forceLock, peekLock, releaseLock, lockPatientAnchor, assertAssignedOrAdmin, PatientLockTargetNotFoundError, PatientLockForbiddenError, LOCK_TTL_MS } from '../../db/patientLocks';
import { lockTokenOf } from '../../http/lockToken';
import { lockHolderResponse } from '../../http/lockGate';
import { orgIdOf, sessionOf } from '../../http/authz';
import { lockHeldResponse } from './shared';

// ---------------------------------------------------------------------------
// POST /api/patients/:id/lock
//   - X-Lock-Token 헤더 없음, ?force 없음 → acquire(clientInstanceId 자기매칭 포함, F5 복구)
//   - X-Lock-Token 헤더 있음                → renew(토큰 불변, expires_at만 연장)
//   - ?force=true                          → force-takeover(항상 성공, 새 토큰 발급)
// acquire/force(최초 획득·선점)만 감사 로그를 남긴다 — renew는 25초마다 불리므로 제외.
// ---------------------------------------------------------------------------
const LockBody = z.object({
  clientInstanceId: z.string().uuid(),
});

export async function acquireOrRenewPatientLock(pool: Pool, req: Request, res: Response): Promise<void> {
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

  const force = req.query['force'] === 'true';
  const presentedToken = lockTokenOf(req);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const anchor = await lockPatientAnchor(client as QueryRunner, { patientId: id, orgId });
    // assignedDoctorOrAdmin 미들웨어의 확인과 이 시점 사이에 재배정됐을 수 있으므로 재확인.
    assertAssignedOrAdmin(anchor, session);

    // renew: 토큰이 제출됐고 force가 아니면 renew 경로. 토큰을 절대 회전시키지 않는다.
    if (presentedToken && !force) {
      const result = await renewLock(client as QueryRunner, { patientId: id, orgId, leaseToken: presentedToken });
      if (!result.ok) {
        await client.query('ROLLBACK');
        res.status(423).json({ code: 'LOCK_LOST', error: 'Lock not held or expired' });
        return;
      }
      await client.query('COMMIT');
      res.status(200).json({ expiresAt: result.expiresAt.toISOString(), ttlMs: LOCK_TTL_MS });
      return;
    }

    const parse = LockBody.safeParse(req.body);
    if (!parse.success) {
      await client.query('ROLLBACK');
      res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
      return;
    }
    const { clientInstanceId } = parse.data;

    if (force) {
      // 감사 로그에는 "누구를 밀어냈는지"가 의미 있는 정보다 — forceLock은 무조건 덮어써서
      // 이전 보유자를 반환하지 않으므로, 덮어쓰기 전에 peekLock으로 먼저 조회해둔다.
      const previousHolder = await peekLock(client as QueryRunner, { patientId: id, orgId });
      const { leaseToken, lock } = await forceLock(client as QueryRunner, {
        patientId: id, orgId, userId: session.userId, holderName: session.name, clientInstanceId,
      });
      await client.query('COMMIT');
      void writeAuditLog(pool, {
        actorUserId: session.userId, actorOrgId: orgId, action: 'patient_lock_takeover',
        targetType: 'patient', targetId: id, outcome: 'success',
        ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
        extra: { previousHolderName: previousHolder?.holderName ?? null, newHolderName: lock.holderName },
      });
      res.status(200).json({ leaseToken, expiresAt: lock.expiresAt.toISOString(), ttlMs: LOCK_TTL_MS });
      return;
    }

    // acquire: 토큰 미제출, force 아님.
    const result = await acquireLock(client as QueryRunner, {
      patientId: id, orgId, userId: session.userId, holderName: session.name, clientInstanceId,
    });
    if (!result.ok) {
      await client.query('ROLLBACK');
      res.status(423).json(lockHeldResponse(result.heldBy));
      return;
    }
    await client.query('COMMIT');
    void writeAuditLog(pool, {
      actorUserId: session.userId, actorOrgId: orgId, action: 'patient_lock_acquire',
      targetType: 'patient', targetId: id, outcome: 'success',
      ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null, extra: null,
    });
    res.status(200).json({ leaseToken: result.leaseToken, expiresAt: result.lock.expiresAt.toISOString(), ttlMs: LOCK_TTL_MS });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PatientLockTargetNotFoundError) {
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
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

// ---------------------------------------------------------------------------
// DELETE /api/patients/:id/lock — 본인 토큰 일치 시에만 삭제. 토큰 없음/불일치/환자 소실도
// 전부 204 no-op(호출자 관점에서 "내 락은 이제 없다"는 목표가 이미 달성된 상태).
// ---------------------------------------------------------------------------
export async function releasePatientLock(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

  const token = lockTokenOf(req);
  if (!token) {
    res.status(204).end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await lockPatientAnchor(client as QueryRunner, { patientId: id, orgId });
    await releaseLock(client as QueryRunner, { patientId: id, orgId, leaseToken: token });
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PatientLockTargetNotFoundError) {
      res.status(204).end();
      return;
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// GET /api/patients/:id/lock — 조회 전용, 부작용 없음. 기존 GET /:id와 동일한 권한 모델
// (assignedDoctorOrAdmin 아님 — 조회는 더 넓게 허용). lock 필드는 PatientSchema/일반 GET
// 응답에는 절대 넣지 않는다(일시적 락 상태가 pull/merge/workspace 스냅샷에 영속화되는 것 방지).
// ---------------------------------------------------------------------------
export async function peekPatientLock(pool: Pool, req: Request, res: Response): Promise<void> {
  const orgId   = orgIdOf(req);
  const { id }  = req.params;

  const lock = await peekLock(toQueryRunner(pool), { patientId: id, orgId });
  res.status(200).json({ lock: lock ? lockHolderResponse(lock) : null });
}
