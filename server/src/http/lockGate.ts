// Patient lease-lock write gate shared by the patients and workspaces routes. Moved from
// routes/patients.ts (P1-27) next to the other request-level lock helpers (http/lockToken.ts) — it reads
// the request (X-Lock-Token, session) and writes the observe-mode audit row, so it lives in the http
// layer rather than db/patientLocks.ts. Bodies unchanged.
import type { Request } from 'express';
import type { Pool } from 'pg';
import config from '../config';
import { checkLockForWrite, type LockRow } from '../db/patientLocks';
import type { QueryRunner } from '../db/patientPersons';
import { writeAuditLog } from '../middleware/audit';
import { sessionOf } from './authz';
import { lockTokenOf } from './lockToken';

// holder 응답에는 holderName/acquiredAt/expiresAt만 노출 — leaseToken/clientInstanceId/
// sessionId/userId는 절대 노출하지 않는다.
export function lockHolderResponse(lock: LockRow): { holderName: string; acquiredAt: string; expiresAt: string } {
  return {
    holderName: lock.holderName,
    acquiredAt: lock.acquiredAt.toISOString(),
    expiresAt:  lock.expiresAt.toISOString(),
  };
}

// patchPatient/deletePatient/assignPatient의 쓰기 게이트. 호출 전 lockPatientAnchor()로
// 앵커(FOR UPDATE)를 이미 잡아둔 상태여야 한다.
// off: 항상 통과(구버전 배포 호환). observe: 평가·감사로그만, 절대 막지 않음. enforce: 실제 차단.
export async function evaluateLockGate(
  pool: Pool,
  client: QueryRunner,
  req: Request,
  patientId: string,
  orgId: string,
  // 요청 하나에 환자 N명이 실리는 호출부(워크스페이스 저장)는 X-Lock-Token 헤더 하나로 토큰을 못 보낸다 —
  // 환자별 토큰을 직접 넘긴다. undefined면 기존처럼 헤더에서 읽고, null은 "토큰 없음"을 명시한다.
  leaseTokenOverride?: string | null
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  if (config.lockEnforcementMode === 'off') return null;

  const leaseToken = leaseTokenOverride !== undefined ? leaseTokenOverride : lockTokenOf(req);
  const result = await checkLockForWrite(client, { patientId, orgId, leaseToken });
  if (result.ok) return null;

  const session = sessionOf(req);
  if (config.lockEnforcementMode === 'observe') {
    // observe 모드는 console.warn이 아니라 감사 로그로 남긴다 — 운영에서 통계·추적 가능해야
    // "관찰"이 의미가 있다. 절대 요청을 막지 않는다(계속 진행).
    void writeAuditLog(pool, {
      actorUserId: session.userId, actorOrgId: orgId, action: 'patient_lock_observed_block',
      targetType: 'patient', targetId: patientId, outcome: 'success',
      ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
      extra: { holderName: result.heldBy.holderName },
    });
    return null;
  }

  return {
    status: 423,
    body: { code: 'LOCK_HELD', error: `Currently being edited by ${result.heldBy.holderName}`, holder: lockHolderResponse(result.heldBy) },
  };
}
