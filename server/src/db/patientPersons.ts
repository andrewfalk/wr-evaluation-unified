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
): Promise<ResolvePatientPersonResult> {
  if (!meta.patientNo) {
    if (existingPersonId) {
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

  const existing = await db.query<PatientPersonRow>(
    `SELECT id, name, birth_date
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
    const retry = await db.query<PatientPersonRow>(
      `SELECT id, name, birth_date
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
      const warnings = buildNameMismatchWarning(row, meta);
      const personId = await updateExistingPerson(db, row.id, orgId, meta);
      return { personId, warnings };
    }
    throw err;
  }
}
