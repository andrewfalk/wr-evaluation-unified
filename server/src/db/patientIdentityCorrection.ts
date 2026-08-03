import type { QueryRunner } from './patientPersons';

// ---------------------------------------------------------------------------
// 생년월일 정정 — 범용 resolver와 의도적으로 분리된 경로.
//
// resolvePatientPersonId에 "override" 옵션을 달지 않는 이유:
//  (a) 미래의 다른 호출부가 실수로 assertCompatibleBirthDate 안전장치를 우회할 수 있고,
//  (b) resolver는 등록번호로 person을 *검색*하므로 대상이 아닌 person을 고칠 위험이 있으며,
//  (c) workspace 저장처럼 정정과 무관한 경로까지 영향 범위가 넓어진다.
// 여기서는 대상 record의 patient_person_id로 person을 직접 지정해 고친다.
// ---------------------------------------------------------------------------

/** 활성 case 집합이 잠금 사이에 바뀜 — 호출부가 롤백 후 재시도해야 한다. */
export class IdentitySetChangedError extends Error {
  constructor(message = 'Active case set changed while acquiring locks') {
    super(message);
    this.name = 'IdentitySetChangedError';
  }
}

export class IdentityTargetNotFoundError extends Error {
  constructor(message = 'Patient not found') {
    super(message);
    this.name = 'IdentityTargetNotFoundError';
  }
}

export class IdentityRevisionMismatchError extends Error {
  constructor(public readonly currentRevision: number) {
    super('Revision mismatch');
    this.name = 'IdentityRevisionMismatchError';
  }
}

export class IdentityForbiddenError extends Error {
  constructor(public readonly requiresAdmin: boolean, message = 'Not allowed to correct this patient identity') {
    super(message);
    this.name = 'IdentityForbiddenError';
  }
}

export class IdentityCaseLockedError extends Error {
  constructor(public readonly holderName: string) {
    super(`A related case is being edited by ${holderName}`);
    this.name = 'IdentityCaseLockedError';
  }
}

export interface CorrectIdentityParams {
  targetId:      string;
  orgId:         string;
  expectedRevision: number;
  birthDate:     string;   // canonical YYYY-MM-DD, 빈 값 불가(호출부에서 검증)
  session:       { userId: string; role: string };
}

export interface CorrectIdentityResult {
  personId:           string;
  affectedPatientIds: string[];
  caseCount:          number;
}

interface TargetRow {
  id: string;
  patient_person_id: string | null;
  revision: number;
  assigned_doctor_user_id: string | null;
}

/**
 * person의 생년월일과, 그 person을 참조하는 모든 활성 case의 birth_date/payload를 정정한다.
 *
 * 반드시 호출부가 연 트랜잭션 안에서 실행할 것. IdentitySetChangedError가 던져지면
 * 롤백 후 처음부터 재시도해야 한다.
 *
 * 잠금 순서(데드락 회피):
 *   1) 대상을 *잠금 없이* 읽어 person id만 확보
 *   2) 그 person의 활성 case 전체를 ORDER BY id FOR UPDATE
 *   3) 대상 재검증(존재·revision·person 연결·권한)
 *   4) person FOR UPDATE
 *   5) 활성 case 집합 재확인
 *
 * 대상을 먼저 잠그면 안 된다 — 같은 person의 case A/B를 동시에 정정할 때
 * 〈T1: A 보유 → B 대기〉와 〈T2: B 보유 → A 대기〉로 순환 대기가 생겨
 * "ID 오름차순" 정렬 효과가 무의미해진다.
 */
export async function correctPatientIdentity(
  db: QueryRunner,
  params: CorrectIdentityParams,
): Promise<CorrectIdentityResult> {
  const { targetId, orgId, expectedRevision, birthDate, session } = params;

  // 1) 무잠금 읽기 — person id만 얻는다. 이 값은 3)에서 반드시 재검증한다.
  const probe = await db.query<TargetRow>(
    `SELECT id, patient_person_id, revision, assigned_doctor_user_id
     FROM patient_records
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [targetId, orgId]
  );
  if (probe.rows.length === 0) throw new IdentityTargetNotFoundError();

  const personId = probe.rows[0].patient_person_id;
  if (!personId) throw new IdentityTargetNotFoundError('Patient has no identity record');

  // 2) 이 person의 활성 case 전체를 ID 오름차순으로 잠근다.
  const lockedIds = await selectActiveCaseIds(db, personId, orgId, { forUpdate: true });

  // 3) 대상 재검증 — 1)이 무잠금이었으므로 그 사이의 변경 가능성을 여기서 닫는다.
  const target = await db.query<TargetRow>(
    `SELECT id, patient_person_id, revision, assigned_doctor_user_id
     FROM patient_records
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [targetId, orgId]
  );
  if (target.rows.length === 0) throw new IdentityTargetNotFoundError();
  const targetRow = target.rows[0];

  // person 재배정/변경이 있었으면 잠근 집합이 대상과 무관해진다 → 재시도.
  if (targetRow.patient_person_id !== personId) throw new IdentitySetChangedError();
  if (targetRow.revision !== expectedRevision) {
    throw new IdentityRevisionMismatchError(targetRow.revision);
  }

  // 트랜잭션 안에서 담당의를 다시 확인한다(미들웨어 검사 이후 재배정 TOCTOU 방지).
  if (session.role !== 'admin' && targetRow.assigned_doctor_user_id !== session.userId) {
    throw new IdentityForbiddenError(false);
  }

  // 4) person 잠금.
  const person = await db.query<{ id: string }>(
    `SELECT id FROM patient_persons
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
     FOR UPDATE`,
    [personId, orgId]
  );
  if (person.rows.length === 0) throw new IdentitySetChangedError();

  // 5) 활성 case 집합 재확인. 2)와 4) 사이에 다른 트랜잭션이 person을 먼저 잠근 채
  //    새 case를 추가했을 수 있다. 그 새 case는 우리가 잠그지 않았으므로 그대로
  //    UPDATE하면 〈우리: person 보유 → 새 case 대기〉 vs 〈저쪽: 새 case 보유 → person 대기〉
  //    데드락이 된다. 집합이 달라졌으면 전부 풀고 다시 시작한다.
  const currentIds = await selectActiveCaseIds(db, personId, orgId, { forUpdate: false });
  if (!sameIdSet(lockedIds, currentIds)) throw new IdentitySetChangedError();

  // 활성 case가 여럿이면 관리자만 정정할 수 있다 — 한 명의 정정이 다른 담당의의
  // case까지 바꾸기 때문.
  if (currentIds.length > 1 && session.role !== 'admin') {
    throw new IdentityForbiddenError(true);
  }

  // 관련 case 중 하나라도 편집 락이 걸려 있으면 차단한다.
  // evaluateLockGate는 요청 대상 한 건만 보므로 나머지는 여기서 확인해야 한다.
  //
  // 대상 case는 제외한다 — 그건 이미 evaluateLockGate가 lease token을 검증해 통과시킨
  // 건이다. 여기서 다시 보면 "환자를 편집 중인 본인"이 자기 락 때문에 정정하지 못한다
  // (편집 중에 충돌을 만나 정정하는 것이 가장 흔한 경로인데 그게 막힌다).
  await assertNoActiveLocks(db, currentIds.filter(cid => cid !== targetId), orgId);

  // 6) person + 모든 활성 case 갱신.
  await db.query(
    `UPDATE patient_persons
     SET birth_date = $3
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [personId, orgId, birthDate]
  );

  // revision을 올리지 않으면 다른 클라이언트가 구 revision으로 옛 payload를 되덮어쓴다.
  // payload JSON도 함께 고쳐야 한다 — DB 컬럼만 고치면 payload의 옛 생년월일이 다시
  // 올라와 충돌이 재발한다.
  const updated = await db.query<{ id: string }>(
    `UPDATE patient_records
     SET birth_date = $3::date,
         payload    = jsonb_set(payload, '{data,shared,birthDate}', to_jsonb($3::text), true),
         revision   = revision + 1
     WHERE patient_person_id = $1 AND organization_id = $2 AND deleted_at IS NULL
     RETURNING id`,
    [personId, orgId, birthDate]
  );

  return {
    personId,
    affectedPatientIds: updated.rows.map(r => r.id),
    caseCount: currentIds.length,
  };
}

async function selectActiveCaseIds(
  db: QueryRunner,
  personId: string,
  orgId: string,
  { forUpdate }: { forUpdate: boolean },
): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM patient_records
     WHERE patient_person_id = $1 AND organization_id = $2 AND deleted_at IS NULL
     ORDER BY id${forUpdate ? '\n     FOR UPDATE' : ''}`,
    [personId, orgId]
  );
  return rows.map(r => r.id);
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  // 두 목록 모두 ORDER BY id로 정렬돼 있으므로 위치 비교로 충분하다.
  return a.every((id, i) => id === b[i]);
}

async function assertNoActiveLocks(db: QueryRunner, caseIds: string[], orgId: string): Promise<void> {
  if (caseIds.length === 0) return;
  const { rows } = await db.query<{ holder_name: string }>(
    `SELECT holder_name FROM patient_locks
     WHERE organization_id = $1
       AND patient_id = ANY($2::uuid[])
       AND expires_at > clock_timestamp()
     LIMIT 1`,
    [orgId, caseIds]
  );
  if (rows.length > 0) throw new IdentityCaseLockedError(rows[0].holder_name);
}
