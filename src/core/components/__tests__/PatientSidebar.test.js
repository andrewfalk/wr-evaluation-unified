import { describe, expect, it } from 'vitest';
import { buildPatientNameWarningMap, getUnassignedBadgeInfo, buildAssignmentBannerMessage } from '../PatientSidebar.jsx';

function makePatient(id, { patientNo = 'P001', birthDate = '1980-01-01', name = 'Kim' } = {}) {
  return {
    id,
    data: {
      shared: { patientNo, birthDate, name },
      modules: {},
      activeModules: [],
    },
  };
}

describe('getUnassignedBadgeInfo', () => {
  it('returns hasWarning=false and always appends 관리자 콘솔 hint when no assignmentWarnings', () => {
    const info = getUnassignedBadgeInfo({ sync: {} });
    expect(info.hasWarning).toBe(false);
    expect(info.tooltip).toContain('관리자 콘솔에서 담당의를 배정하세요');
  });

  it('returns hasWarning=true and includes warning messages in tooltip', () => {
    const patient = {
      sync: {
        assignmentWarnings: [
          { code: 'DOCTOR_NAME_NOT_MATCHED', message: "'홍길동': 해당 이름의 의사 계정이 없어 자동 배정을 건너뜁니다." },
        ],
      },
    };
    const info = getUnassignedBadgeInfo(patient);
    expect(info.hasWarning).toBe(true);
    expect(info.tooltip).toContain('홍길동');
    expect(info.tooltip).toContain('관리자 콘솔에서 담당의를 배정하세요');
  });

  it('includes all warning messages when multiple warnings exist', () => {
    const patient = {
      sync: {
        assignmentWarnings: [
          { code: 'DOCTOR_NAME_AMBIGUOUS', message: "'김의사': 동명이인 의사가 있어 자동 배정을 건너뜁니다." },
          { code: 'DOCTOR_NAME_UNRESOLVED', message: "'김의사': 이름으로 의사 계정을 찾을 수 없어 자동 배정이 건너뛰어졌습니다." },
        ],
      },
    };
    const info = getUnassignedBadgeInfo(patient);
    expect(info.tooltip).toContain('동명이인');
    expect(info.tooltip).toContain('찾을 수 없어');
    expect(info.tooltip).toContain('관리자 콘솔에서 담당의를 배정하세요');
  });
});

describe('buildAssignmentBannerMessage', () => {
  it('returns null when count is 0', () => {
    expect(buildAssignmentBannerMessage(0, 'mine')).toBeNull();
  });

  it('includes correct count and scope=mine hint', () => {
    const msg = buildAssignmentBannerMessage(2, 'mine');
    expect(msg).toContain('2건');
    expect(msg).toContain('전체 보기로 전환하여 확인하세요');
  });

  it('includes correct count and scope=all hint', () => {
    const msg = buildAssignmentBannerMessage(1, 'all');
    expect(msg).toContain('1건');
    expect(msg).toContain('미배정 배지를 확인하세요');
  });

  it('treats undefined assignedDoctorUserId as not null (local patients excluded from banner count)', () => {
    const localPatient = { assignedDoctorUserId: undefined };
    const unassigned   = { assignedDoctorUserId: null };
    const count = [localPatient, unassigned]
      .filter(p => p.redacted !== true && p.assignedDoctorUserId === null).length;
    expect(count).toBe(1);
  });
});

describe('buildPatientNameWarningMap', () => {
  it('warns when patient number and birth date match but names differ', () => {
    const warnings = buildPatientNameWarningMap([
      makePatient('p1', { name: 'Kim' }),
      makePatient('p2', { name: 'Lee' }),
    ]);

    expect(warnings.get('p1')).toMatchObject({
      code: 'PATIENT_NAME_MISMATCH',
      incomingName: 'Kim',
      existingName: 'Lee',
    });
    expect(warnings.get('p2')).toMatchObject({
      code: 'PATIENT_NAME_MISMATCH',
      incomingName: 'Lee',
      existingName: 'Kim',
    });
  });

  it('does not warn when birth dates differ or patient number is missing', () => {
    const warnings = buildPatientNameWarningMap([
      makePatient('p1', { name: 'Kim', birthDate: '1980-01-01' }),
      makePatient('p2', { name: 'Lee', birthDate: '1981-01-01' }),
      makePatient('p3', { name: 'Park', patientNo: '' }),
    ]);

    expect(warnings.size).toBe(0);
  });
});
