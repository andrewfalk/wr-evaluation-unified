import { describe, it, expect } from 'vitest';
import { getDoctorPatientCounts, UNASSIGNED_GROUP_KEY } from '../dashboardStats.js';

function patient({ assignedTop, assignedMeta, createdBy, doctorName } = {}) {
  const p = { meta: {} };
  if (assignedTop !== undefined) p.assignedDoctorUserId = assignedTop;
  if (assignedMeta !== undefined) p.meta.assignedDoctorUserId = assignedMeta;
  if (createdBy !== undefined) p.meta.createdBy = createdBy;
  if (doctorName) p.data = { shared: { doctorName } };
  return p;
}

describe('getDoctorPatientCounts', () => {
  it('그룹화 우선순위: top-level assigned > meta.assigned > meta.createdBy', () => {
    const patients = [
      patient({ assignedTop: 'A' }),
      patient({ assignedTop: 'A' }),
      patient({ assignedMeta: 'B' }),
      patient({ createdBy: 'C' }),
      patient({ assignedTop: 'A', createdBy: 'X' }), // createdBy 무시
    ];
    const { top } = getDoctorPatientCounts(patients);
    const map = Object.fromEntries(top.map(e => [e.key, e.count]));
    expect(map.A).toBe(3);
    expect(map.B).toBe(1);
    expect(map.C).toBe(1);
  });

  it('null/undefined는 __unassigned__로 묶음', () => {
    const patients = [
      patient({ assignedTop: null }),                  // 명시적 null
      patient({ assignedMeta: null, createdBy: 'X' }), // meta null (createdBy 무시)
      patient({}),                                     // 전부 없음
      patient({ assignedTop: 'A' }),
    ];
    const { top, unassigned } = getDoctorPatientCounts(patients);
    expect(unassigned).not.toBeNull();
    expect(unassigned.key).toBe(UNASSIGNED_GROUP_KEY);
    expect(unassigned.count).toBe(3);
    expect(unassigned.label).toBe('미배정/알 수 없음');
    expect(top.find(e => e.key === 'A').count).toBe(1);
  });

  it('label fallback: doctorName 있으면 사용, 없으면 ID 축약', () => {
    const patients = [
      patient({ assignedTop: 'abcdef123456789', doctorName: '김의사' }),
      patient({ assignedTop: 'xyzlongidvalue999' }),
    ];
    const { top } = getDoctorPatientCounts(patients);
    const kim = top.find(e => e.key === 'abcdef123456789');
    const xyz = top.find(e => e.key === 'xyzlongidvalue999');
    expect(kim.label).toBe('김의사');
    expect(xyz.label).toBe('xyzlongi…');
  });

  it('top 5만 반환, 내림차순', () => {
    const patients = [];
    for (let i = 1; i <= 7; i++) {
      for (let n = 0; n < i; n++) patients.push(patient({ assignedTop: `D${i}` }));
    }
    const { top } = getDoctorPatientCounts(patients);
    expect(top).toHaveLength(5);
    expect(top.map(e => e.count)).toEqual([7, 6, 5, 4, 3]);
  });
});
