import { describe, it, expect } from 'vitest';
import { dateOnly, resolvePatientPersonId, PatientIdentityConflictError, PatientPersonVanishedError } from '../patientPersons';
import { createFakePool } from '../../testing/fakePool';

describe('dateOnly (생년월일 비교 정규화)', () => {
  it('문자열은 앞 10자(YYYY-MM-DD)로 자른다', () => {
    expect(dateOnly('1961-02-15')).toBe('1961-02-15');
    expect(dateOnly('1961-02-15T00:00:00.000Z')).toBe('1961-02-15');
  });

  it('null/undefined/빈값 → null', () => {
    expect(dateOnly(null)).toBeNull();
    expect(dateOnly(undefined)).toBeNull();
    expect(dateOnly('')).toBeNull();
  });

  it('Date(pg DATE=로컬 자정)는 로컬 캘린더 날짜로 포맷 — TZ 무관(toISOString UTC 시프트 회귀 방지)', () => {
    // pg date 파서는 'YYYY-MM-DD'를 로컬 자정 Date(new Date(y, m-1, d))로 만든다.
    // 과거 toISOString().slice(0,10)은 KST(+9)에서 하루 밀려 1961-02-14를 냈다.
    expect(dateOnly(new Date(1961, 1, 15))).toBe('1961-02-15');
    expect(dateOnly(new Date(2024, 0, 1))).toBe('2024-01-01');   // 자정 경계
    expect(dateOnly(new Date(2024, 11, 31))).toBe('2024-12-31');
  });
});

// S7-R2: the new-person INSERT of resolvePatientPersonId is ON CONFLICT DO NOTHING. These pin its branches at
// the function level; the concurrent cases run against real PostgreSQL in patients.create.integration and
// patients.integration. The "vanished" branch (the conflicting person released between the INSERT and the
// re-read) has no deterministic interleaving on a real database, so it is pinned here.
describe('resolvePatientPersonId — new patient number (S7-R2)', () => {
  const ORG = 'org-1';
  const meta = { name: '김철수', patientNo: 'NO-1', birthDate: '1980-01-01' };
  const handlers = (insertRows: unknown[], rereadRows: unknown[]) => {
    let selects = 0;
    return createFakePool({
      handlers: [
        // The first lookup by number finds nothing; the re-read after a conflicting INSERT returns rereadRows.
        { name: 'person.byNumber', match: /SELECT id, name, birth_date\s+FROM patient_persons/, reply: () => ({ rows: selects++ === 0 ? [] : rereadRows }) },
        { name: 'person.insert', match: /INSERT INTO patient_persons/, reply: { rows: insertRows } },
        { name: 'person.update', match: /UPDATE patient_persons/, reply: { rows: [], rowCount: 1 } },
      ],
    });
  };

  it('inserts a new person (ON CONFLICT DO NOTHING on the partial unique index)', async () => {
    const fake = handlers([{ id: 'p-new' }], []);
    expect(await resolvePatientPersonId(fake.pool, ORG, meta)).toEqual({ personId: 'p-new', warnings: [] });
    expect(fake.callsTo('person.insert')[0].sql).toMatch(
      /ON CONFLICT \(organization_id, patient_no\) WHERE deleted_at IS NULL AND patient_no IS NOT NULL DO NOTHING\s+RETURNING id/,
    );
    expect(fake.callsTo('person.byNumber')).toHaveLength(1);
  });

  it('a conflict (no row) → re-reads the committed person FOR UPDATE and links to it', async () => {
    const fake = handlers([], [{ id: 'p-other', name: '김철수', birth_date: '1980-01-01' }]);
    expect(await resolvePatientPersonId(fake.pool, ORG, meta)).toEqual({ personId: 'p-other', warnings: [] });
    const reread = fake.callsTo('person.byNumber')[1];
    expect(reread.sql).toMatch(/FOR UPDATE/);
    expect(reread.params).toEqual([ORG, 'NO-1']);
  });

  it('a conflict whose person has a different birth date → PatientIdentityConflictError', async () => {
    const fake = handlers([], [{ id: 'p-other', name: '김철수', birth_date: '1990-05-05' }]);
    await expect(resolvePatientPersonId(fake.pool, ORG, meta)).rejects.toBeInstanceOf(PatientIdentityConflictError);
  });

  it('a conflict whose person is gone at the re-read → PatientPersonVanishedError (409 PATIENT_PERSON_VANISHED, retriable)', async () => {
    const fake = handlers([], []);
    await expect(resolvePatientPersonId(fake.pool, ORG, meta)).rejects.toBeInstanceOf(PatientPersonVanishedError);
    expect(fake.callsTo('person.update')).toEqual([]);
  });
});
