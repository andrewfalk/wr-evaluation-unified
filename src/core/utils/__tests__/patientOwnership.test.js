import { describe, it, expect } from 'vitest';
import { isMyPatient, getOwnerGroupKey, canEditPatient, canDeletePatient } from '../patientOwnership.js';

const ME = 'user-me';
const OTHER = 'user-other';
const session = { user: { id: ME } };
const intranetMeSession = { mode: 'intranet', user: { id: ME, role: 'doctor' } };
const intranetAdminSession = { mode: 'intranet', user: { id: 'admin-1', role: 'admin' } };
const localClinicianSession = { mode: 'local', user: { id: 'local-user', role: 'clinician' } };
const localNoUserSession = { mode: 'local' };

function patient(overrides = {}) {
  const { topLevel, meta, ...rest } = overrides;
  const p = { ...rest };
  if (topLevel && Object.prototype.hasOwnProperty.call(topLevel, 'assignedDoctorUserId')) {
    p.assignedDoctorUserId = topLevel.assignedDoctorUserId;
  }
  if (meta) p.meta = meta;
  return p;
}

describe('isMyPatient', () => {
  it('1) assigned가 내 ID (top-level) → true', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: ME }, meta: { createdBy: OTHER } });
    expect(isMyPatient(p, session)).toBe(true);
  });

  it('2) assigned가 다른 의사이면 meta.createdBy가 내 ID여도 → false (assigned 우선)', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: OTHER }, meta: { createdBy: ME } });
    expect(isMyPatient(p, session)).toBe(false);
  });

  it('3) assigned 미정의(키 없음) + meta.createdBy 내 ID → true (폴백)', () => {
    const p = patient({ meta: { createdBy: ME } });
    expect(isMyPatient(p, session)).toBe(true);
  });

  it('4) assigned 미정의 + meta.createdBy 다른 사용자 → false', () => {
    const p = patient({ meta: { createdBy: OTHER } });
    expect(isMyPatient(p, session)).toBe(false);
  });

  it('5) top-level에서 명시적 null + meta.createdBy 내 ID → false (null도 명시적 미할당)', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: null }, meta: { createdBy: ME } });
    expect(isMyPatient(p, session)).toBe(false);
  });

  it('6) top-level 키 없음 + meta.assignedDoctorUserId === null + meta.createdBy 내 ID → false', () => {
    const p = patient({ meta: { assignedDoctorUserId: null, createdBy: ME } });
    expect(isMyPatient(p, session)).toBe(false);
  });

  it('7) redacted 레코드 → false', () => {
    const p = { redacted: true, assignedDoctorUserId: ME };
    expect(isMyPatient(p, session)).toBe(false);
  });

  it('8) session.user.id 없음 → false', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: ME } });
    expect(isMyPatient(p, { user: {} })).toBe(false);
    expect(isMyPatient(p, null)).toBe(false);
  });
});

describe('getOwnerGroupKey', () => {
  it('top-level assigned 우선', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: 'A' }, meta: { createdBy: 'B' } });
    expect(getOwnerGroupKey(p)).toBe('A');
  });

  it('top-level 없으면 meta.assigned', () => {
    const p = patient({ meta: { assignedDoctorUserId: 'A', createdBy: 'B' } });
    expect(getOwnerGroupKey(p)).toBe('A');
  });

  it('assigned 둘 다 없으면 meta.createdBy', () => {
    const p = patient({ meta: { createdBy: 'B' } });
    expect(getOwnerGroupKey(p)).toBe('B');
  });

  it('top-level null도 그대로 반환 (assigned가 권위)', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: null }, meta: { createdBy: 'B' } });
    expect(getOwnerGroupKey(p)).toBeNull();
  });
});

describe('canEditPatient', () => {
  it('redacted 환자는 admin/intranet에서도 false', () => {
    const p = { redacted: true, assignedDoctorUserId: 'admin-1' };
    expect(canEditPatient(p, intranetAdminSession)).toBe(false);
  });

  it('redacted 환자는 로컬 모드에서도 false', () => {
    const p = { redacted: true };
    expect(canEditPatient(p, localClinicianSession)).toBe(false);
  });

  it('patient null/undefined → false', () => {
    expect(canEditPatient(null, localClinicianSession)).toBe(false);
    expect(canEditPatient(undefined, intranetAdminSession)).toBe(false);
  });

  it('로컬 모드 + 본인 환자 아님 → true (로컬 폴백)', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: 'someone-else' } });
    expect(canEditPatient(p, localClinicianSession)).toBe(true);
  });

  it('로컬 모드 + session.user.id 없음 → true (로컬 폴백)', () => {
    const p = patient({ meta: { createdBy: OTHER } });
    expect(canEditPatient(p, localNoUserSession)).toBe(true);
  });

  it('인트라넷 + admin → true (assigned 무관)', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: OTHER } });
    expect(canEditPatient(p, intranetAdminSession)).toBe(true);
  });

  it('인트라넷 + 담당의 → true', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: ME } });
    expect(canEditPatient(p, intranetMeSession)).toBe(true);
  });

  it('인트라넷 + 비담당의 → false', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: OTHER } });
    expect(canEditPatient(p, intranetMeSession)).toBe(false);
  });

  it('인트라넷 + assigned null + 일반 의사 → false (admin만 통과)', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: null }, meta: { createdBy: ME } });
    expect(canEditPatient(p, intranetMeSession)).toBe(false);
    expect(canEditPatient(p, intranetAdminSession)).toBe(true);
  });

  it('인트라넷 + owner이지만 assigned 다름 → false (owner 폴백 안 함)', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: OTHER }, meta: { createdBy: ME } });
    expect(canEditPatient(p, intranetMeSession)).toBe(false);
  });

  it('인트라넷 + local-only + assigned 미정의 + createdBy === me → true (신규 생성 안전망)', () => {
    const p = { meta: { createdBy: ME }, sync: { syncStatus: 'local-only' } };
    expect(canEditPatient(p, intranetMeSession)).toBe(true);
  });

  it('인트라넷 + local-only + assigned 미정의 + createdBy 다름 → false', () => {
    const p = { meta: { createdBy: OTHER }, sync: { syncStatus: 'local-only' } };
    expect(canEditPatient(p, intranetMeSession)).toBe(false);
  });

  it('인트라넷 + synced + assigned 미정의 + createdBy === me → false (local-only 안전망 적용 안 됨)', () => {
    const p = { meta: { createdBy: ME }, sync: { syncStatus: 'synced' } };
    expect(canEditPatient(p, intranetMeSession)).toBe(false);
  });

  it('canDeletePatient === canEditPatient', () => {
    const p = patient({ topLevel: { assignedDoctorUserId: ME } });
    expect(canDeletePatient(p, intranetMeSession)).toBe(canEditPatient(p, intranetMeSession));
    const p2 = patient({ topLevel: { assignedDoctorUserId: OTHER } });
    expect(canDeletePatient(p2, intranetMeSession)).toBe(canEditPatient(p2, intranetMeSession));
  });
});
