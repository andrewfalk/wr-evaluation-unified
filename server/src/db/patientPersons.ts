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
  birth_date: string | Date | null;
}

export class PatientIdentityConflictError extends Error {
  constructor(message = 'Patient number matches an existing patient with a different birth date') {
    super(message);
    this.name = 'PatientIdentityConflictError';
  }
}

function dateOnly(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function assertCompatibleBirthDate(existing: string | Date | null, incoming: string | null): void {
  const current = dateOnly(existing);
  const next = dateOnly(incoming);
  if (current && next && current !== next) {
    throw new PatientIdentityConflictError();
  }
}

async function updateExistingPerson(
  db: QueryRunner,
  personId: string,
  orgId: string,
  meta: PatientPersonMeta,
): Promise<string> {
  await db.query(
    `UPDATE patient_persons
     SET name = $3,
         birth_date = COALESCE(birth_date, $4)
     WHERE id = $1 AND organization_id = $2`,
    [personId, orgId, meta.name, meta.birthDate]
  );
  return personId;
}

export async function resolvePatientPersonId(
  db: QueryRunner,
  orgId: string,
  meta: PatientPersonMeta,
  existingPersonId?: string | null,
): Promise<string> {
  if (!meta.patientNo) {
    if (existingPersonId) {
      return updateExistingPerson(db, existingPersonId, orgId, meta);
    }

    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date)
       VALUES ($1, NULL, $2, $3)
       RETURNING id`,
      [orgId, meta.name, meta.birthDate]
    );
    return rows[0].id;
  }

  const existing = await db.query<PatientPersonRow>(
    `SELECT id, birth_date
     FROM patient_persons
     WHERE organization_id = $1
       AND patient_no = $2
       AND deleted_at IS NULL
     LIMIT 1`,
    [orgId, meta.patientNo]
  );

  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    assertCompatibleBirthDate(row.birth_date, meta.birthDate);
    return updateExistingPerson(db, row.id, orgId, meta);
  }

  try {
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [orgId, meta.patientNo, meta.name, meta.birthDate]
    );
    return inserted.rows[0].id;
  } catch (err) {
    // A concurrent request may have inserted the same person after our SELECT.
    const retry = await db.query<PatientPersonRow>(
      `SELECT id, birth_date
       FROM patient_persons
       WHERE organization_id = $1
         AND patient_no = $2
         AND deleted_at IS NULL
       LIMIT 1`,
      [orgId, meta.patientNo]
    );
    if (retry.rows.length > 0) {
      const row = retry.rows[0];
      assertCompatibleBirthDate(row.birth_date, meta.birthDate);
      return updateExistingPerson(db, row.id, orgId, meta);
    }
    throw err;
  }
}
