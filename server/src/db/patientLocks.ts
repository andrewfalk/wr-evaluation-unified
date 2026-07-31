import crypto from 'crypto';
import { hashToken } from '../auth/sessionStore';
import type { QueryRunner } from './patientPersons';

// 환자 단위 TTL lease lock — heartbeat 25s / TTL 100s(여유 4배). 이 값 하나가 유일한
// 소스: acquire/force 응답의 expiresAt/ttlMs로부터 클라이언트가 자기 renew 주기를 역산한다.
export const LOCK_TTL_MS = 100_000;

export interface LockRow {
  patientId: string;
  clientInstanceId: string;
  userId: string;
  holderName: string;
  acquiredAt: Date;
  expiresAt: Date;
}

interface PatientLockDbRow {
  patient_id: string;
  client_instance_id: string;
  user_id: string;
  holder_name: string;
  acquired_at: Date;
  expires_at: Date;
  lease_token_hash?: string;
}

function mapRow(row: PatientLockDbRow): LockRow {
  return {
    patientId: row.patient_id,
    clientInstanceId: row.client_instance_id,
    userId: row.user_id,
    holderName: row.holder_name,
    acquiredAt: row.acquired_at,
    expiresAt: row.expires_at,
  };
}

function generateLeaseToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// 락 관련 트랜잭션(acquire/renew/force/release/patch/delete/apply/assign)의 공통 앵커.
// patient_records 행을 FOR UPDATE로 잡아, 그 뒤 patient_locks에 대한 모든 검사·갱신이
// 반드시 직전에 커밋된 최신 상태를 보도록 직렬화한다(§3 DB 직렬화).
// 삭제된 환자는 앵커 자체를 못 잡게 해 잠금 대상에서 제외한다.
export class PatientLockTargetNotFoundError extends Error {
  constructor() {
    super('Patient not found or has been deleted');
    this.name = 'PatientLockTargetNotFoundError';
  }
}

export async function lockPatientAnchor(
  runner: QueryRunner,
  { patientId, orgId }: { patientId: string; orgId: string }
): Promise<void> {
  const { rows } = await runner.query(
    `SELECT id FROM patient_records WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [patientId, orgId]
  );
  if (rows.length === 0) throw new PatientLockTargetNotFoundError();
}

// 최초 획득 또는 "같은 탭의 재획득"(client_instance_id + user_id + organization_id 자기매칭,
// F5 복구 포함) 전용. 항상 새 leaseToken을 발급한다. 다른 탭이 살아있는 락을 쥐고 있으면 실패
// — 실패 시 현재 보유자 정보를 조회해 heldBy로 반환한다(호출자가 423 바디를 구성할 수 있게).
// 호출 전 lockPatientAnchor()로 앵커를 잡아둔 상태여야 한다.
export async function acquireLock(
  runner: QueryRunner,
  params: { patientId: string; orgId: string; userId: string; holderName: string; clientInstanceId: string }
): Promise<{ ok: true; leaseToken: string; lock: LockRow } | { ok: false; heldBy: LockRow }> {
  const { patientId, orgId, userId, holderName, clientInstanceId } = params;
  const leaseToken = generateLeaseToken();
  const leaseTokenHash = hashToken(leaseToken);
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS);

  const { rows } = await runner.query<PatientLockDbRow>(
    `INSERT INTO patient_locks
       (patient_id, lease_token_hash, client_instance_id, user_id, organization_id, holder_name, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (patient_id) DO UPDATE
       SET lease_token_hash = EXCLUDED.lease_token_hash,
           client_instance_id = EXCLUDED.client_instance_id,
           user_id = EXCLUDED.user_id,
           holder_name = EXCLUDED.holder_name,
           acquired_at = now(),
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
     WHERE patient_locks.expires_at <= now()
        OR (patient_locks.client_instance_id = EXCLUDED.client_instance_id
            AND patient_locks.user_id = EXCLUDED.user_id
            AND patient_locks.organization_id = EXCLUDED.organization_id)
     RETURNING *`,
    [patientId, leaseTokenHash, clientInstanceId, userId, orgId, holderName, expiresAt]
  );

  if (rows.length > 0) {
    return { ok: true, leaseToken, lock: mapRow(rows[0]) };
  }

  const heldBy = await peekLock(runner, { patientId, orgId });
  // heldBy는 앵커로 patient_records를 이미 FOR UPDATE로 잡은 상태에서 조회하므로 반드시 존재한다
  // (그렇지 않다면 위 UPSERT의 WHERE expires_at<=now() 분기에 걸려 성공했을 것이다).
  return { ok: false, heldBy: heldBy as LockRow };
}

// 본인 소유 확인(토큰 일치) 후 expires_at만 연장한다. 토큰을 절대 회전시키지 않으므로
// 동시에 나간 renew 두 개가 응답 순서와 무관하게 안전하다. 토큰 불일치/락 없음/만료면
// ok:false — 클라이언트는 이를 'lost'로 처리해야 하며 자동 재-acquire로 이어지면 안 된다.
export async function renewLock(
  runner: QueryRunner,
  params: { patientId: string; orgId: string; leaseToken: string }
): Promise<{ ok: true; expiresAt: Date } | { ok: false }> {
  const { patientId, orgId, leaseToken } = params;
  const leaseTokenHash = hashToken(leaseToken);
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS);

  const { rows } = await runner.query<{ expires_at: Date }>(
    `UPDATE patient_locks
     SET expires_at = $1, updated_at = now()
     WHERE patient_id = $2 AND organization_id = $3 AND lease_token_hash = $4 AND expires_at > now()
     RETURNING expires_at`,
    [expiresAt, patientId, orgId, leaseTokenHash]
  );

  if (rows.length === 0) return { ok: false };
  return { ok: true, expiresAt: rows[0].expires_at };
}

// 무조건 덮어씀(선점) — 항상 새 leaseToken을 발급해 기존 토큰을 즉시 무효화한다.
// 호출 전 lockPatientAnchor()로 앵커를 잡아둔 상태여야 한다.
export async function forceLock(
  runner: QueryRunner,
  params: { patientId: string; orgId: string; userId: string; holderName: string; clientInstanceId: string }
): Promise<{ leaseToken: string; lock: LockRow }> {
  const { patientId, orgId, userId, holderName, clientInstanceId } = params;
  const leaseToken = generateLeaseToken();
  const leaseTokenHash = hashToken(leaseToken);
  const expiresAt = new Date(Date.now() + LOCK_TTL_MS);

  const { rows } = await runner.query<PatientLockDbRow>(
    `INSERT INTO patient_locks
       (patient_id, lease_token_hash, client_instance_id, user_id, organization_id, holder_name, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (patient_id) DO UPDATE
       SET lease_token_hash = EXCLUDED.lease_token_hash,
           client_instance_id = EXCLUDED.client_instance_id,
           user_id = EXCLUDED.user_id,
           holder_name = EXCLUDED.holder_name,
           acquired_at = now(),
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
     RETURNING *`,
    [patientId, leaseTokenHash, clientInstanceId, userId, orgId, holderName, expiresAt]
  );

  return { leaseToken, lock: mapRow(rows[0]) };
}

// 조회 전용, 부작용 없음. 살아있는(expires_at > now()) 락이 없으면 null.
export async function peekLock(
  runner: QueryRunner,
  params: { patientId: string; orgId: string }
): Promise<LockRow | null> {
  const { rows } = await runner.query<PatientLockDbRow>(
    `SELECT patient_id, client_instance_id, user_id, holder_name, acquired_at, expires_at
     FROM patient_locks
     WHERE patient_id = $1 AND organization_id = $2 AND expires_at > now()`,
    [params.patientId, params.orgId]
  );
  return rows.length > 0 ? mapRow(rows[0]) : null;
}

// 본인 토큰이 일치할 때만 삭제. 토큰 불일치/락 없음도 no-op(호출자 관점에서 "내 락은 이제 없다"는
// 목표가 이미 달성된 상태이므로 에러가 아니다).
export async function releaseLock(
  runner: QueryRunner,
  params: { patientId: string; orgId: string; leaseToken: string }
): Promise<void> {
  const leaseTokenHash = hashToken(params.leaseToken);
  await runner.query(
    `DELETE FROM patient_locks WHERE patient_id = $1 AND organization_id = $2 AND lease_token_hash = $3`,
    [params.patientId, params.orgId, leaseTokenHash]
  );
}

// 소프트 삭제 시 락 행을 명시적으로 정리(ON DELETE CASCADE는 소프트 삭제라 발동하지 않는다).
export async function deleteLockForPatient(
  runner: QueryRunner,
  params: { patientId: string; orgId: string }
): Promise<void> {
  await runner.query(
    `DELETE FROM patient_locks WHERE patient_id = $1 AND organization_id = $2`,
    [params.patientId, params.orgId]
  );
}

export type LockCheckResult = { ok: true } | { ok: false; heldBy: LockRow };

// patchPatient/deletePatient/applyJob/assignPatient의 쓰기 게이트.
// "락 행이 없으면 통과(opt-in), 있으면 제출된 leaseToken이 그 락과 일치해야 통과."
// 호출 전 lockPatientAnchor()로 앵커를 잡아둔 상태여야 하며, 이 함수 자체는 조회만 한다
// — 실제 강제는 앵커가 이미 담당했으므로(그 트랜잭션이 끝날 때까지 다른 acquire/force가
// patient_locks를 못 건드림) 이 SELECT는 그 시점의 최신 상태를 정확히 본다.
export async function checkLockForWrite(
  runner: QueryRunner,
  params: { patientId: string; orgId: string; leaseToken: string | null }
): Promise<LockCheckResult> {
  const { rows } = await runner.query<PatientLockDbRow>(
    `SELECT patient_id, client_instance_id, user_id, holder_name, acquired_at, expires_at, lease_token_hash
     FROM patient_locks
     WHERE patient_id = $1 AND organization_id = $2 AND expires_at > now()`,
    [params.patientId, params.orgId]
  );
  if (rows.length === 0) return { ok: true }; // 락 없음 — opt-in, 통과

  const row = rows[0];
  if (params.leaseToken && hashToken(params.leaseToken) === row.lease_token_hash) {
    return { ok: true };
  }
  return { ok: false, heldBy: mapRow(row) };
}
