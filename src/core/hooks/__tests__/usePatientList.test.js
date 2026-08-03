import { describe, expect, it } from 'vitest';
import { filterPatients } from '../usePatientList.js';

const DEFAULT_FILTERS = {
  searchQuery: '',
  statusFilter: 'all',
  moduleFilter: 'all',
  jobFilter: '',
  registrationFrom: '',
  registrationTo: '',
  completionFrom: '',
  completionTo: '',
  sortKey: 'default',
  sortDirection: 'asc',
};

function runList(patients, filters = {}) {
  return filterPatients(patients, { ...DEFAULT_FILTERS, ...filters });
}

describe('usePatientList', () => {
  it('does not include redacted snapshot stubs in the working list', () => {
    const redacted = { id: 'deleted-1', redacted: true };
    const active = {
      id: 'active-1',
      data: { shared: { name: 'Kim', jobs: [] }, activeModules: [] },
    };

    expect(runList([redacted, active])).toEqual([active]);
  });

  it('filters active patients by module and registration date', () => {
    const knee = {
      id: 'active-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      data: { shared: { name: 'Kim', jobs: [] }, activeModules: ['knee'] },
    };
    const spine = {
      id: 'active-2',
      createdAt: '2026-05-02T00:00:00.000Z',
      data: { shared: { name: 'Lee', jobs: [] }, activeModules: ['spine'] },
    };

    const result = runList([knee, spine], {
      moduleFilter: 'spine',
      registrationFrom: '2026-05-01',
    });

    expect(result).toEqual([spine]);
  });

  it('등록일 필터는 UTC 자정 이전(KST 오전) 타임스탬프도 로컬 날짜 기준으로 매칭한다', () => {
    // 2026-08-02T23:47:00Z == 2026-08-03 08:47 KST — UTC로는 8/2지만 KST로는 8/3 등록건
    const earlyMorningKst = {
      id: 'active-1',
      createdAt: '2026-08-02T23:47:00.000Z',
      data: { shared: { name: 'Kim', jobs: [] }, activeModules: ['knee'] },
    };

    expect(runList([earlyMorningKst], { registrationFrom: '2026-08-03', registrationTo: '2026-08-03' }))
      .toEqual([earlyMorningKst]);
    expect(runList([earlyMorningKst], { registrationFrom: '2026-08-02', registrationTo: '2026-08-02' }))
      .toEqual([]);
  });

  it('searches by patient identity fields', () => {
    const patient = {
      id: 'active-1',
      data: {
        shared: {
          name: 'Kim',
          patientNo: 'WR1001',
          diagnoses: [{ name: 'Meniscus tear', code: 'S83' }],
          jobs: [{ jobName: 'Welder' }],
        },
      },
    };

    expect(runList([patient], { searchQuery: 'WR1001' })).toEqual([patient]);
    expect(runList([patient], { searchQuery: 'welder' })).toEqual([patient]);
    expect(runList([patient], { searchQuery: 'S83' })).toEqual([patient]);
  });
});
