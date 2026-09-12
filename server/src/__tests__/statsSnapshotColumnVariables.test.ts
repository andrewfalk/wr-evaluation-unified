import { describe, it, expect } from 'vitest';
import {
  ASSIGNED_DOCTOR_KEY,
  REGISTERED_AT_KEY,
  SNAPSHOT_COLUMN_VARIABLES,
  extractSnapshotColumnValue,
} from '../statsSnapshotColumnVariables';
import type { SnapshotRow } from '../statsSnapshot';

function makeRow(overrides: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    id: 'case-1',
    patientPersonId: 'person-1',
    assignedDoctorUserId: null,
    createdAt: new Date('2024-03-15T13:45:00.000Z'),
    payload: {},
    ...overrides,
  };
}

describe('extractSnapshotColumnValue', () => {
  it('담당의 미배정(null)이면 not_entered', () => {
    const result = extractSnapshotColumnValue(ASSIGNED_DOCTOR_KEY, makeRow({ assignedDoctorUserId: null }));
    expect(result).toEqual({ value: null, missing: 'not_entered', qualityFlags: [] });
  });

  it('담당의가 배정돼 있으면 그 값을 그대로 반환한다', () => {
    const result = extractSnapshotColumnValue(ASSIGNED_DOCTOR_KEY, makeRow({ assignedDoctorUserId: 'doctor-1' }));
    expect(result).toEqual({ value: 'doctor-1', missing: null, qualityFlags: [] });
  });

  it('등록일은 createdAt을 UTC 날짜만 잘라 ISO(YYYY-MM-DD) 문자열로 반환한다', () => {
    const result = extractSnapshotColumnValue(REGISTERED_AT_KEY, makeRow({ createdAt: new Date('2024-03-15T23:59:59.000Z') }));
    expect(result).toEqual({ value: '2024-03-15', missing: null, qualityFlags: [] });
  });

  it('알려지지 않은 key는 null(호출부가 analytics-core 경로로 폴백)', () => {
    expect(extractSnapshotColumnValue('spine.mddm.lifetimeDoseMNh', makeRow())).toBeNull();
  });
});

describe('SNAPSHOT_COLUMN_VARIABLES 메타데이터', () => {
  it('담당의는 analyzable, 등록일은 filter_only다', () => {
    const doctor = SNAPSHOT_COLUMN_VARIABLES.find((v) => v.key === ASSIGNED_DOCTOR_KEY);
    const registeredAt = SNAPSHOT_COLUMN_VARIABLES.find((v) => v.key === REGISTERED_AT_KEY);
    expect(doctor?.analysisRole).toBe('analyzable');
    expect(registeredAt?.analysisRole).toBe('filter_only');
  });

  it('둘 다 grain:case다(§확정 전제 — 담당의/등록일은 사례 단위 메타데이터)', () => {
    for (const v of SNAPSHOT_COLUMN_VARIABLES) {
      expect(v.grain).toBe('case');
    }
  });
});
