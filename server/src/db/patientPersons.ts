interface QueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

export interface QueryRunner {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface PatientPersonMeta {
  name: string;
  patientNo: string | null;
  birthDate: string | null;
}

interface PatientPersonRow {
  id: string;
  name: string;
  birth_date: string | Date | null;
}

export interface PatientPersonWarning {
  code: string;
  message: string;
  existingName?: string;
  incomingName?: string;
}

export interface ResolvePatientPersonResult {
  personId: string;
  warnings: PatientPersonWarning[];
}

export class PatientIdentityConflictError extends Error {
  constructor(message = 'Patient number matches an existing patient with a different birth date') {
    super(message);
    this.name = 'PatientIdentityConflictError';
  }
}

// pg의 DATE 컬럼은 type parser 없이 로컬 자정 JS Date로 온다. toISOString()(UTC)으로 자르면
// UTC+ 타임존(예: KST)에서 하루 밀려(1961-02-15 → 1961-02-14) 생년월일 비교가 잘못 충돌한다
// (운영 docker는 UTC라 잠복, 네이티브 비-UTC 실행에서 발현). 캘린더 날짜는 로컬 컴포넌트로 포맷한다.
export function dateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function assertCompatibleBirthDate(existing: string | Date | null, incoming: string | null): void {
  const current = dateOnly(existing);
  const next = dateOnly(incoming);
  if (current && next && current !== next) {
    throw new PatientIdentityConflictError();
  }
}

function normalizeName(value: string | null | undefined): string {
  return String(value || '').trim();
}

function buildNameMismatchWarning(row: PatientPersonRow, meta: PatientPersonMeta): PatientPersonWarning[] {
  const currentBirthDate = dateOnly(row.birth_date);
  const incomingBirthDate = dateOnly(meta.birthDate);
  const existingName = normalizeName(row.name);
  const incomingName = normalizeName(meta.name);

  if (!currentBirthDate || !incomingBirthDate || currentBirthDate !== incomingBirthDate) return [];
  if (!existingName || !incomingName || existingName === incomingName) return [];

  return [{
    code: 'PATIENT_NAME_MISMATCH',
    message: 'Same patient number and birth date, but the name differs. Confirm whether this is a legal name change or a data entry issue.',
    existingName,
    incomingName,
  }];
}

/**
 * 경합으로 person이 사라진 뒤(soft-delete) 갱신을 시도한 경우.
 * 호출부는 트랜잭션을 되돌리고 재시도하거나 500으로 올린다.
 */
export class PatientPersonVanishedError extends Error {
  constructor(message = 'Patient person was deleted concurrently') {
    super(message);
    this.name = 'PatientPersonVanishedError';
  }
}

async function updateExistingPerson(
  db: QueryRunner,
  personId: string,
  orgId: string,
  meta: PatientPersonMeta,
): Promise<string> {
  // deleted_at IS NULL 조건이 필요한 이유: 이 UPDATE 시점에 다른 트랜잭션이 마지막 case를
  // 삭제하며 person을 soft-delete 했을 수 있다. 조건 없이 갱신하면 죽은 person을 되살리지는
  // 않으면서 이름/생년월일만 바꿔 놓아 상태가 어긋난다. rowCount로 실제 갱신 여부를 확인한다.
  const result = await db.query(
    `UPDATE patient_persons
     SET name = $3,
         birth_date = COALESCE(birth_date, $4)
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
    [personId, orgId, meta.name, meta.birthDate]
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new PatientPersonVanishedError();
  }
  return personId;
}

/**
 * 마지막 활성 case가 사라진 person을 soft-delete해 (organization_id, patient_no)
 * 유니크 공간을 해제한다. 살아있는 patient_records가 하나라도 남아 있으면 아무것도 하지 않는다.
 *
 * 반드시 삭제와 같은 트랜잭션에서 호출할 것 — person 행을 FOR UPDATE로 먼저 잡아
 * "참조 0건" 판정과 soft-delete 사이에 새 case가 끼어드는 것을 막는다.
 * (resolvePatientPersonId도 같은 행을 FOR UPDATE로 잡으므로 서로 직렬화된다.)
 *
 * @returns 실제로 해제했으면 true
 */
export async function releasePersonIfOrphaned(
  db: QueryRunner,
  personId: string | null | undefined,
  orgId: string,
): Promise<boolean> {
  if (!personId) return false;

  const locked = await db.query<{ id: string }>(
    `SELECT id
     FROM patient_persons
     WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
     FOR UPDATE`,
    [personId, orgId]
  );
  if (locked.rows.length === 0) return false;

  const result = await db.query(
    `UPDATE patient_persons
     SET deleted_at = now()
     WHERE id = $1
       AND organization_id = $2
       AND deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM patient_records
         WHERE patient_person_id = $1 AND deleted_at IS NULL
       )`,
    [personId, orgId]
  );

  return (result.rowCount ?? 0) > 0;
}

export async function resolvePatientPersonId(
  db: QueryRunner,
  orgId: string,
  meta: PatientPersonMeta,
  existingPersonId?: string | null,
): Promise<ResolvePatientPersonResult> {
  if (!meta.patientNo) {
    if (existingPersonId) {
      // 기존 person이 등록번호를 갖고 있는데 새 값이 공란이면 그 person을 재사용하면 안 된다.
      // 재사용하면 record의 patient_no만 비고 patient_persons.patient_no에는 옛 번호가
      // 그대로 남아 계속 점유된다(호출부의 "person이 바뀌었나" 판정도 발동하지 않는다).
      // 익명 person을 새로 만들어 record를 옮기고, 옛 person은 호출부가 해제한다.
      const current = await db.query<{ patient_no: string | null }>(
        `SELECT patient_no FROM patient_persons
         WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
         FOR UPDATE`,
        [existingPersonId, orgId]
      );

      if (current.rows.length > 0 && current.rows[0].patient_no !== null) {
        const moved = await db.query<{ id: string }>(
          `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date)
           VALUES ($1, NULL, $2, $3)
           RETURNING id`,
          [orgId, meta.name, meta.birthDate]
        );
        return { personId: moved.rows[0].id, warnings: [] };
      }

      const personId = await updateExistingPerson(db, existingPersonId, orgId, meta);
      return { personId, warnings: [] };
    }

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date)
       VALUES ($1, NULL, $2, $3)
       RETURNING id`,
      [orgId, meta.name, meta.birthDate]
    );
    return { personId: rows[0].id, warnings: [] };
  }

  // FOR UPDATE 필수: 이 SELECT와 아래 updateExistingPerson 사이에 다른 트랜잭션이
  // 마지막 case를 삭제하며 person을 soft-delete할 수 있다. 행을 잡아두지 않으면
  // 살아있는 record가 이미 죽은 person을 참조하게 된다(삭제 트랜잭션도 같은 행을
  // FOR UPDATE로 잡으므로 둘 중 하나가 대기한다).
  const existing = await db.query<PatientPersonRow>(
    `SELECT id, name, birth_date
     FROM patient_persons
     WHERE organization_id = $1
       AND patient_no = $2
       AND deleted_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [orgId, meta.patientNo]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    assertCompatibleBirthDate(row.birth_date, meta.birthDate);
    const warnings = buildNameMismatchWarning(row, meta);
    const personId = await updateExistingPerson(db, row.id, orgId, meta);
    return { personId, warnings };
  }

  try {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [orgId, meta.patientNo, meta.name, meta.birthDate]
    );
    return { personId: inserted.rows[0].id, warnings: [] };
  } catch (err) {
    // A concurrent request may have inserted the same person after our SELECT.
    // 위 SELECT와 같은 이유로 여기서도 FOR UPDATE로 행을 잡아야 한다.
    const retry = await db.query<PatientPersonRow>(
      `SELECT id, name, birth_date
       FROM patient_persons
       WHERE organization_id = $1
         AND patient_no = $2
         AND deleted_at IS NULL
       LIMIT 1
       FOR UPDATE`,
      [orgId, meta.patientNo]
    );
    if (retry.rows.length > 0) {
      const row = retry.rows[0];
      assertCompatibleBirthDate(row.birth_date, meta.birthDate);
      const warnings = buildNameMismatchWarning(row, meta);
      const personId = await updateExistingPerson(db, row.id, orgId, meta);
      return { personId, warnings };
    }
    throw err;
  }
}
