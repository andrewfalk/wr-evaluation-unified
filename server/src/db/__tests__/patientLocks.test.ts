import { describe, it, expect, vi } from 'vitest';
import {
  acquireLock,
  renewLock,
  forceLock,
  peekLock,
  releaseLock,
  deleteLockForPatient,
  checkLockForWrite,
  lockPatientAnchor,
  assertAssignedOrAdmin,
  PatientLockTargetNotFoundError,
  PatientLockForbiddenError,
} from '../patientLocks';
import type { QueryRunner } from '../patientPersons';

const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
const ORG_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CLIENT_INSTANCE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const LOCK_DB_ROW = {
  patient_id: PATIENT_ID,
  client_instance_id: CLIENT_INSTANCE_ID,
  user_id: USER_ID,
  holder_name: 'Dr. Kim',
  acquired_at: new Date('2024-06-01T10:00:00Z'),
  expires_at: new Date('2024-06-01T10:01:40Z'),
};

// 순서대로 결과를 반환하는 mock QueryRunner. 각 항목은 { rows } — 실제 patientLocks.ts는
// rowCount를 쓰지 않으므로 rows만으로 충분하다.
function makeRunner(...results: { rows: unknown[] }[]): QueryRunner & { query: ReturnType<typeof vi.fn> } {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  return { query } as unknown as QueryRunner & { query: ReturnType<typeof vi.fn> };
}

describe('lockPatientAnchor', () => {
  it('환자가 존재하면 id와 담당의를 반환한다(TOCTOU 재검증용)', async () => {
    const runner = makeRunner({ rows: [{ id: PATIENT_ID, assigned_doctor_user_id: USER_ID }] });
    await expect(lockPatientAnchor(runner, { patientId: PATIENT_ID, orgId: ORG_ID }))
      .resolves.toEqual({ id: PATIENT_ID, assignedDoctorUserId: USER_ID });
    expect(runner.query.mock.calls[0][0]).toMatch(/FOR UPDATE/);
  });

  it('환자가 없거나 삭제됐으면 PatientLockTargetNotFoundError를 던진다', async () => {
    const runner = makeRunner({ rows: [] });
    await expect(lockPatientAnchor(runner, { patientId: PATIENT_ID, orgId: ORG_ID }))
      .rejects.toBeInstanceOf(PatientLockTargetNotFoundError);
  });
});

describe('assertAssignedOrAdmin — TOCTOU 재검증 (2라운드 외부 리뷰 반영)', () => {
  const anchor = { id: PATIENT_ID, assignedDoctorUserId: USER_ID };

  it('담당의 본인이면 통과', () => {
    expect(() => assertAssignedOrAdmin(anchor, { role: 'doctor', userId: USER_ID })).not.toThrow();
  });

  it('admin이면 담당의 일치 여부와 무관하게 통과', () => {
    expect(() => assertAssignedOrAdmin(anchor, { role: 'admin', userId: 'someone-else' })).not.toThrow();
  });

  it('담당의가 아니면(재배정 등) PatientLockForbiddenError', () => {
    expect(() => assertAssignedOrAdmin(anchor, { role: 'doctor', userId: 'other-doctor' }))
      .toThrow(PatientLockForbiddenError);
  });

  it('미배정(assignedDoctorUserId=null)이면 admin 외 누구도 통과 못 함', () => {
    const unassigned = { id: PATIENT_ID, assignedDoctorUserId: null };
    expect(() => assertAssignedOrAdmin(unassigned, { role: 'doctor', userId: USER_ID }))
      .toThrow(PatientLockForbiddenError);
  });
});

describe('acquireLock', () => {
  it('락이 없으면 성공하고 leaseToken을 발급한다', async () => {
    const runner = makeRunner({ rows: [LOCK_DB_ROW] });
    const result = await acquireLock(runner, {
      patientId: PATIENT_ID, orgId: ORG_ID, userId: USER_ID, holderName: 'Dr. Kim', clientInstanceId: CLIENT_INSTANCE_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.leaseToken).toBe('string');
      expect(result.leaseToken.length).toBeGreaterThan(20);
      expect(result.lock.holderName).toBe('Dr. Kim');
    }
    // UPSERT의 자기매칭 WHERE 절에 client_instance_id/user_id/organization_id 세 조건이 모두 있는지 확인
    const sql = runner.query.mock.calls[0][0] as string;
    const whereClause = sql.slice(sql.indexOf('WHERE patient_locks.expires_at'));
    expect(whereClause).toMatch(/client_instance_id = EXCLUDED\.client_instance_id/);
    expect(whereClause).toMatch(/user_id = EXCLUDED\.user_id/);
    expect(whereClause).toMatch(/organization_id = EXCLUDED\.organization_id/);
    // renew처럼 토큰 자체로 자기매칭하는 분기가 WHERE 절에 없어야 한다(2라운드 지적: 위험한 두 번째 비밀).
    // (SET 절에서 lease_token_hash 컬럼값을 갱신하는 것 자체는 정상이므로 WHERE 절만 검사한다.)
    expect(whereClause).not.toMatch(/lease_token_hash/);
  });

  it('다른 세션이 살아있는 락을 쥐고 있으면 ok:false + heldBy 반환', async () => {
    // 1st call: UPSERT returns 0 rows (WHERE 불만족) / 2nd call: peekLock이 현재 보유자 조회
    const runner = makeRunner({ rows: [] }, { rows: [LOCK_DB_ROW] });
    const result = await acquireLock(runner, {
      patientId: PATIENT_ID, orgId: ORG_ID, userId: 'other-user', holderName: 'Dr. Lee', clientInstanceId: 'other-instance',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.heldBy.holderName).toBe('Dr. Kim');
  });
});

describe('renewLock', () => {
  it('토큰이 일치하면 만료시각만 연장하고 성공', async () => {
    const runner = makeRunner({ rows: [{ expires_at: new Date('2024-06-01T10:03:20Z') }] });
    const result = await renewLock(runner, { patientId: PATIENT_ID, orgId: ORG_ID, leaseToken: 'sometoken' });
    expect(result.ok).toBe(true);
    // renew는 INSERT/UPSERT가 아니라 순수 UPDATE여야 하고, SET 절에 lease_token_hash가
    // 없어야 한다(WHERE 절의 lease_token_hash = $N 비교는 본인 확인용으로 정상 — 토큰을
    // "SET"으로 회전시키는지 여부만 검사).
    const sql = runner.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/^\s*UPDATE patient_locks/);
    expect(sql).not.toMatch(/INSERT/);
    const setClause = sql.slice(sql.indexOf('SET'), sql.indexOf('WHERE'));
    expect(setClause).not.toMatch(/lease_token_hash/);
  });

  it('토큰 불일치/락 만료/락 없음이면 ok:false', async () => {
    const runner = makeRunner({ rows: [] });
    const result = await renewLock(runner, { patientId: PATIENT_ID, orgId: ORG_ID, leaseToken: 'wrong' });
    expect(result.ok).toBe(false);
  });
});

describe('forceLock', () => {
  it('항상 성공하고 새 leaseToken을 발급한다(WHERE 절 없는 무조건 UPSERT)', async () => {
    const runner = makeRunner({ rows: [LOCK_DB_ROW] });
    const result = await forceLock(runner, {
      patientId: PATIENT_ID, orgId: ORG_ID, userId: USER_ID, holderName: 'Dr. Park', clientInstanceId: CLIENT_INSTANCE_ID,
    });
    expect(typeof result.leaseToken).toBe('string');
    const sql = runner.query.mock.calls[0][0] as string;
    expect(sql).not.toMatch(/WHERE patient_locks\.expires_at/); // 조건부 WHERE 없음 — 무조건 덮어씀
  });
});

describe('peekLock', () => {
  it('살아있는 락이 없으면 null', async () => {
    const runner = makeRunner({ rows: [] });
    await expect(peekLock(runner, { patientId: PATIENT_ID, orgId: ORG_ID })).resolves.toBeNull();
  });

  it('락이 있으면 holder 정보를 반환(내부 토큰/식별자 미노출 필드만 매핑)', async () => {
    const runner = makeRunner({ rows: [LOCK_DB_ROW] });
    const lock = await peekLock(runner, { patientId: PATIENT_ID, orgId: ORG_ID });
    expect(lock).toEqual({
      patientId: PATIENT_ID,
      clientInstanceId: CLIENT_INSTANCE_ID,
      userId: USER_ID,
      holderName: 'Dr. Kim',
      acquiredAt: LOCK_DB_ROW.acquired_at,
      expiresAt: LOCK_DB_ROW.expires_at,
    });
  });
});

describe('releaseLock / deleteLockForPatient', () => {
  it('releaseLock은 DELETE만 실행하고 결과와 무관하게 반환한다(no-op 허용)', async () => {
    const runner = makeRunner({ rows: [] });
    await expect(releaseLock(runner, { patientId: PATIENT_ID, orgId: ORG_ID, leaseToken: 'x' })).resolves.toBeUndefined();
    expect(runner.query.mock.calls[0][0]).toMatch(/^\s*DELETE FROM patient_locks/);
  });

  it('deleteLockForPatient은 leaseToken 조건 없이 그 환자의 락 행을 무조건 삭제한다', async () => {
    const runner = makeRunner({ rows: [] });
    await deleteLockForPatient(runner, { patientId: PATIENT_ID, orgId: ORG_ID });
    const [sql, params] = runner.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM patient_locks/);
    expect(params).toEqual([PATIENT_ID, ORG_ID]);
  });
});

describe('checkLockForWrite — opt-in 의미론', () => {
  it('락 행이 없으면 통과(opt-in)', async () => {
    const runner = makeRunner({ rows: [] });
    const result = await checkLockForWrite(runner, { patientId: PATIENT_ID, orgId: ORG_ID, leaseToken: null });
    expect(result.ok).toBe(true);
  });

  it('락이 있고 토큰이 일치하면 통과', async () => {
    // acquireLock에서 발급한 실제 토큰의 해시와 비교해야 하므로, hashToken을 우회해 같은 해시 로직을 재현하기보다
    // acquireLock으로 실제 발급 후 checkLockForWrite에 그 leaseToken을 넘겨 왕복 검증한다.
    const acquireRunner = makeRunner({ rows: [LOCK_DB_ROW] });
    const acquired = await acquireLock(acquireRunner, {
      patientId: PATIENT_ID, orgId: ORG_ID, userId: USER_ID, holderName: 'Dr. Kim', clientInstanceId: CLIENT_INSTANCE_ID,
    });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    // checkLockForWrite가 보는 DB 행의 lease_token_hash는 acquire가 계산해 INSERT에 넘긴 값과 같아야 한다.
    const insertedHash = acquireRunner.query.mock.calls[0][1]?.[1] as string;
    const checkRunner = makeRunner({ rows: [{ ...LOCK_DB_ROW, lease_token_hash: insertedHash }] });
    const result = await checkLockForWrite(checkRunner, { patientId: PATIENT_ID, orgId: ORG_ID, leaseToken: acquired.leaseToken });
    expect(result.ok).toBe(true);
  });

  it('락이 있는데 토큰이 불일치하면 ok:false + heldBy', async () => {
    const runner = makeRunner({ rows: [{ ...LOCK_DB_ROW, lease_token_hash: 'some-other-hash' }] });
    const result = await checkLockForWrite(runner, { patientId: PATIENT_ID, orgId: ORG_ID, leaseToken: 'wrong-token' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.heldBy.holderName).toBe('Dr. Kim');
  });

  it('락이 있는데 토큰을 아예 안 보냈으면(null) ok:false', async () => {
    const runner = makeRunner({ rows: [{ ...LOCK_DB_ROW, lease_token_hash: 'irrelevant' }] });
    const result = await checkLockForWrite(runner, { patientId: PATIENT_ID, orgId: ORG_ID, leaseToken: null });
    expect(result.ok).toBe(false);
  });
});
