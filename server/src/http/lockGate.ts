// Patient lease-lock write gate shared by the patients and workspaces routes. Moved from
// routes/patients.ts (P1-27) next to the other request-level lock helpers (http/lockToken.ts) — it reads
// the request (X-Lock-Token, session) and writes the observe-mode audit row, so it lives in the http
// layer rather than db/patientLocks.ts. Bodies unchanged.
import type { Request } from 'express';
import type { Pool } from 'pg';
import config from '../config';
import type { QueryRunner } from '../db/patientPersons';
import { sessionOf } from './authz';
import { lockTokenOf } from './lockToken';
import type { PatientWriteContext } from '../domain/patients/context';
import { runLockGate, lockHolderResponse } from '../domain/patients/lockGate';

// lockHolderResponse moved to domain/patients/lockGate.ts (S7-1); re-exported.
export { lockHolderResponse };

// patchPatient/deletePatient/assignPatient의 쓰기 게이트. 호출 전 lockPatientAnchor()로
// 앵커(FOR UPDATE)를 이미 잡아둔 상태여야 한다.
// off: 항상 통과(구버전 배포 호환). observe: 평가·감사로그만, 절대 막지 않음. enforce: 실제 차단.
// S7-0: 본문은 domain/patients/lockGate.ts runLockGate로 옮겼고 이 함수는 요청을 컨텍스트로 바꾸는
// 어댑터다(S7 경로가 모두 서비스로 옮겨지면 S7-8a에서 삭제).
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
  const session = sessionOf(req);
  const ctx: PatientWriteContext = {
    actor: { userId: session.userId, role: session.role, name: session.name },
    orgId,
    leaseToken,
    audit: { ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null },
  };
  const { blocked } = await runLockGate(client, pool, ctx, { patientId, leaseToken });
  if (!blocked) return null;

  return {
    status: 423,
    body: { code: 'LOCK_HELD', error: `Currently being edited by ${blocked.holderName}`, holder: lockHolderResponse(blocked) },
  };
}
