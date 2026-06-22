import { describe, it, expect } from 'vitest';
import {
  getDoctorPatientCounts,
  getDoctorOptions,
  UNASSIGNED_GROUP_KEY,
  computeDashboardStats,
  computeAge,
  normalizeGender,
} from '../dashboardStats.js';
import { getOwnerGroupKey } from '../patientOwnership.js';

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

describe('getDoctorOptions (관리자 통계 드롭다운)', () => {
  it('등록 환자를 가진 모든 의사를 count 내림차순으로 반환 (Top 5 제한 없음)', () => {
    const patients = [];
    for (let i = 1; i <= 7; i++) {
      for (let n = 0; n < i; n++) patients.push(patient({ assignedTop: `D${i}` }));
    }
    const options = getDoctorOptions(patients);
    expect(options).toHaveLength(7);
    expect(options.map(o => o.count)).toEqual([7, 6, 5, 4, 3, 2, 1]);
  });

  it('미배정 그룹은 항상 마지막에 배치', () => {
    const patients = [
      patient({}),                    // 미배정
      patient({ assignedTop: 'A' }),
      patient({ assignedTop: 'A' }),
      patient({ assignedTop: 'B' }),
    ];
    const options = getDoctorOptions(patients);
    expect(options.map(o => o.key)).toEqual(['A', 'B', UNASSIGNED_GROUP_KEY]);
    expect(options.at(-1).label).toBe('미배정/알 수 없음');
  });

  it('미배정 환자가 없으면 미배정 옵션을 포함하지 않음', () => {
    const options = getDoctorOptions([patient({ assignedTop: 'A' })]);
    expect(options.some(o => o.key === UNASSIGNED_GROUP_KEY)).toBe(false);
  });
});

// Dashboard scopedPatients의 특정 의사/미배정 필터 로직 (scope = userId | UNASSIGNED_GROUP_KEY)
describe('관리자 scope 필터 (getOwnerGroupKey 기반)', () => {
  const filterByScope = (patients, scope) =>
    patients.filter(p => {
      const key = getOwnerGroupKey(p);
      return scope === UNASSIGNED_GROUP_KEY ? key == null : key === scope;
    });

  it('특정 의사 userId로 그 의사 환자만 필터', () => {
    const patients = [
      patient({ assignedTop: 'A' }),
      patient({ assignedMeta: 'A' }),
      patient({ assignedTop: 'B' }),
      patient({ createdBy: 'A' }),   // assigned 없음 → createdBy 폴백
    ];
    expect(filterByScope(patients, 'A')).toHaveLength(3);
    expect(filterByScope(patients, 'B')).toHaveLength(1);
  });

  it('UNASSIGNED_GROUP_KEY는 소유자 키가 null인 환자만 필터', () => {
    const patients = [
      patient({}),                        // 미배정
      patient({ assignedTop: null }),     // 명시적 null → 미배정
      patient({ assignedTop: 'A' }),
    ];
    expect(filterByScope(patients, UNASSIGNED_GROUP_KEY)).toHaveLength(2);
  });
});

function rapPatient({ id, updatedAt, savedAt, createdAt, syncLastSyncedAt } = {}) {
  return {
    id,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(savedAt !== undefined ? { _savedAt: savedAt } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(syncLastSyncedAt !== undefined ? { sync: { lastSyncedAt: syncLastSyncedAt } } : {}),
    data: { shared: {}, activeModules: [] },
  };
}

describe('computeDashboardStats recentActivity ordering', () => {
  it('정렬은 updatedAt 우선', () => {
    const patients = [
      rapPatient({ id: 'a', updatedAt: '2025-01-01T00:00:00Z', createdAt: '2024-01-01T00:00:00Z' }),
      rapPatient({ id: 'b', updatedAt: '2025-06-01T00:00:00Z', createdAt: '2023-01-01T00:00:00Z' }),
      rapPatient({ id: 'c', updatedAt: '2025-03-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' }),
    ];
    const { recentActivity } = computeDashboardStats(patients);
    expect(recentActivity.map(r => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('updatedAt 없으면 _savedAt → createdAt 폴백', () => {
    const patients = [
      rapPatient({ id: 'a', createdAt: '2025-01-01T00:00:00Z' }),
      rapPatient({ id: 'b', savedAt: '2025-06-01T00:00:00Z' }),
      rapPatient({ id: 'c', createdAt: '2025-03-01T00:00:00Z' }),
    ];
    const { recentActivity } = computeDashboardStats(patients);
    expect(recentActivity.map(r => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('sync.lastSyncedAt은 정렬에 영향을 주지 않음', () => {
    const patients = [
      rapPatient({ id: 'old-but-just-synced', createdAt: '2020-01-01T00:00:00Z', syncLastSyncedAt: '2025-12-31T23:59:59Z' }),
      rapPatient({ id: 'recently-edited',     updatedAt: '2025-06-01T00:00:00Z' }),
    ];
    const { recentActivity } = computeDashboardStats(patients);
    expect(recentActivity[0].id).toBe('recently-edited');
  });

  it('invalid timestamp은 0으로 처리되어 가장 뒤로', () => {
    const patients = [
      rapPatient({ id: 'invalid', updatedAt: 'not-a-date' }),
      rapPatient({ id: 'valid',   updatedAt: '2025-01-01T00:00:00Z' }),
    ];
    const { recentActivity } = computeDashboardStats(patients);
    expect(recentActivity[0].id).toBe('valid');
  });
});

function demographicPatient({ gender, birthDate, jobName, diagCode } = {}) {
  return {
    data: {
      shared: {
        gender,
        birthDate,
        evaluationDate: '2025-01-01',
        jobs: jobName ? [{ jobName }] : [],
        diagnoses: diagCode ? [{ code: diagCode, name: diagCode + ' name' }] : [],
      },
      activeModules: [],
    },
  };
}

describe('normalizeGender', () => {
  it('남/여 한글, M/F, male/female, 빈값 모두 처리', () => {
    expect(normalizeGender('남')).toBe('male');
    expect(normalizeGender('남자')).toBe('male');
    expect(normalizeGender('M')).toBe('male');
    expect(normalizeGender('male')).toBe('male');
    expect(normalizeGender('여')).toBe('female');
    expect(normalizeGender('F')).toBe('female');
    expect(normalizeGender('FEMALE')).toBe('female');
    expect(normalizeGender('')).toBe('unknown');
    expect(normalizeGender(null)).toBe('unknown');
    expect(normalizeGender('기타')).toBe('unknown');
  });
});

describe('computeAge', () => {
  it('YYYY-MM-DD 정상 파싱', () => {
    expect(computeAge('1980-01-01', '2025-01-01')).toBe(45);
  });
  it('YYYYMMDD 형식도 처리 (formatBirthDate 정규화)', () => {
    expect(computeAge('19800101', '2025-01-01')).toBe(45);
  });
  it('생일 안 지났으면 한 살 적게', () => {
    expect(computeAge('1980-06-15', '2025-01-01')).toBe(44);
  });
  it('invalid birthDate는 null', () => {
    expect(computeAge('', '2025-01-01')).toBe(null);
    expect(computeAge('not-a-date', '2025-01-01')).toBe(null);
    expect(computeAge(null, '2025-01-01')).toBe(null);
  });
  it('invalid ref는 today로 fallback', () => {
    const age = computeAge('1990-01-01', 'not-a-date');
    expect(age).toBeGreaterThan(30);
    expect(age).toBeLessThan(60);
  });
  it('비현실값은 null', () => {
    expect(computeAge('1800-01-01', '2025-01-01')).toBe(null);
    expect(computeAge('2050-01-01', '2025-01-01')).toBe(null);
  });
});

describe('computeDashboardStats — 성별·연령·직종·상병 by-gender', () => {
  it('genderBreakdown: 남/여/미상 카운트', () => {
    const patients = [
      demographicPatient({ gender: '남' }),
      demographicPatient({ gender: '남' }),
      demographicPatient({ gender: '여' }),
      demographicPatient({ gender: '' }),
    ];
    const { genderBreakdown } = computeDashboardStats(patients);
    expect(genderBreakdown).toEqual({ male: 2, female: 1, unknown: 1 });
  });

  it('ageGroupDistribution: 35세는 30대↓, 45세는 40대, 55세는 50대, 65세는 60대, 75세는 70대↑', () => {
    const patients = [
      demographicPatient({ gender: '남', birthDate: '1990-01-01' }), // 35
      demographicPatient({ gender: '여', birthDate: '1980-01-01' }), // 45
      demographicPatient({ gender: '남', birthDate: '1970-01-01' }), // 55
      demographicPatient({ gender: '여', birthDate: '1960-01-01' }), // 65
      demographicPatient({ gender: '남', birthDate: '1950-01-01' }), // 75
    ];
    const { ageGroupDistribution } = computeDashboardStats(patients);
    expect(ageGroupDistribution.all).toEqual({
      '30대↓': 1, '40대': 1, '50대': 1, '60대': 1, '70대↑': 1,
    });
    expect(ageGroupDistribution.male).toEqual({
      '30대↓': 1, '40대': 0, '50대': 1, '60대': 0, '70대↑': 1,
    });
    expect(ageGroupDistribution.female).toEqual({
      '30대↓': 0, '40대': 1, '50대': 0, '60대': 1, '70대↑': 0,
    });
  });

  it('avgAgeByGender: 전체/남/여 평균', () => {
    const patients = [
      demographicPatient({ gender: '남', birthDate: '1990-01-01' }), // 35
      demographicPatient({ gender: '남', birthDate: '1980-01-01' }), // 45
      demographicPatient({ gender: '여', birthDate: '1970-01-01' }), // 55
    ];
    const { avgAgeByGender } = computeDashboardStats(patients);
    expect(avgAgeByGender.all).toBe(45);
    expect(avgAgeByGender.male).toBe(40);
    expect(avgAgeByGender.female).toBe(55);
  });

  it('avgAgeByGender: 데이터 없으면 null', () => {
    const { avgAgeByGender } = computeDashboardStats([demographicPatient({ gender: '남' })]);
    expect(avgAgeByGender.all).toBe(null);
    expect(avgAgeByGender.female).toBe(null);
  });

  it('topJobsByGender: 대표 직종(jobs[0]) 기준, 성별 분리', () => {
    const patients = [
      demographicPatient({ gender: '남', jobName: '사무직' }),
      demographicPatient({ gender: '남', jobName: '사무직' }),
      demographicPatient({ gender: '여', jobName: '간호사' }),
      demographicPatient({ gender: '여', jobName: '간호사' }),
      demographicPatient({ gender: '여', jobName: '간호사' }),
      demographicPatient({ gender: '', jobName: '기타' }),
    ];
    const { topJobsByGender } = computeDashboardStats(patients);
    expect(topJobsByGender.all[0]).toMatchObject({ key: '간호사', count: 3 });
    expect(topJobsByGender.all[1]).toMatchObject({ key: '사무직', count: 2 });
    expect(topJobsByGender.male).toEqual([{ key: '사무직', count: 2 }]);
    expect(topJobsByGender.female).toEqual([{ key: '간호사', count: 3 }]);
  });

  it('topDiagnosesByGender: code 기준, 한 환자 같은 code 중복 카운트 없음', () => {
    const dup = demographicPatient({ gender: '남', diagCode: 'M54.5' });
    dup.data.shared.diagnoses.push({ code: 'M54.5', name: 'duplicate' });
    const patients = [
      dup,
      demographicPatient({ gender: '남', diagCode: 'M54.5' }),
      demographicPatient({ gender: '여', diagCode: 'M17.0' }),
    ];
    const { topDiagnosesByGender } = computeDashboardStats(patients);
    expect(topDiagnosesByGender.all.find(d => d.key === 'M54.5').count).toBe(2);
    expect(topDiagnosesByGender.male.find(d => d.key === 'M54.5').count).toBe(2);
    expect(topDiagnosesByGender.female.find(d => d.key === 'M17.0').count).toBe(1);
  });
});
