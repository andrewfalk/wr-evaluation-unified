import { describe, it, expect } from 'vitest';
import {
  DiagnosisSchema,
  SharedJobSchema,
  SharedDataSchema,
  PatientSchema,
  PatientSyncConflictSchema,
  PatientSyncSchema,
  PatientMetaSchema,
} from '../patient';

const validDiagnosis = {
  id: '00000000-0000-0000-0000-000000000001',
  code: 'M17',
  name: '무릎관절증',
  side: 'right',
};

const validJob = {
  id: '00000000-0000-0000-0000-000000000002',
  jobName: '조립 작업',
  presetId: null,
  startDate: '2020-01-01',
  endDate: '2024-12-31',
  workPeriodOverride: '',
  workDaysPerYear: 250,
};

const validShared = {
  patientNo: 'P-001',
  name: '홍길동',
  gender: 'M',
  height: '170',
  weight: '70',
  birthDate: '1975-03-15',
  injuryDate: '2023-06-01',
  hospitalName: '근로복지공단 안산병원',
  department: '직업환경의학과',
  doctorName: '김호길',
  evaluationDate: '2024-01-10',
  medicalRecord: '',
  highBloodPressure: '',
  diabetes: '',
  visitHistory: '',
  consultReplyOrtho: '',
  consultReplyNeuro: '',
  consultReplyRehab: '',
  consultReplyOther: '',
  specialNotes: '',
  diagnoses: [validDiagnosis],
  jobs: [validJob],
};

const validPatient = {
  id: '00000000-0000-0000-0000-000000000003',
  createdAt: '2024-01-10T09:00:00.000Z',
  phase: 'evaluation' as const,
  data: {
    shared: validShared,
    modules: { knee: {} },
    activeModules: ['knee'],
  },
};

describe('DiagnosisSchema', () => {
  it('parses valid diagnosis', () => {
    expect(DiagnosisSchema.parse(validDiagnosis)).toMatchObject(validDiagnosis);
  });

  it('passes through unknown module-specific fields', () => {
    const withExtra = { ...validDiagnosis, confirmedRight: true, klgRight: 2 };
    const result = DiagnosisSchema.parse(withExtra);
    expect(result).toMatchObject(withExtra);
  });

  it('rejects non-UUID id', () => {
    expect(() => DiagnosisSchema.parse({ ...validDiagnosis, id: 'not-a-uuid' })).toThrow();
  });
});

describe('SharedJobSchema', () => {
  it('parses valid job', () => {
    expect(SharedJobSchema.parse(validJob)).toMatchObject(validJob);
  });

  it('uses default workDaysPerYear of 250', () => {
    const { workDaysPerYear: _, ...without } = validJob;
    const result = SharedJobSchema.parse(without);
    expect(result.workDaysPerYear).toBe(250);
  });

  it('rejects negative workDaysPerYear', () => {
    expect(() => SharedJobSchema.parse({ ...validJob, workDaysPerYear: -1 })).toThrow();
  });

  it('accepts null presetId', () => {
    expect(SharedJobSchema.parse({ ...validJob, presetId: null }).presetId).toBeNull();
  });

  it('accepts string presetId', () => {
    expect(SharedJobSchema.parse({ ...validJob, presetId: 'preset-abc' }).presetId).toBe('preset-abc');
  });
});

describe('SharedDataSchema', () => {
  it('parses valid shared data', () => {
    const result = SharedDataSchema.parse(validShared);
    expect(result.name).toBe('홍길동');
    expect(result.diagnoses).toHaveLength(1);
    expect(result.jobs).toHaveLength(1);
  });

  it('accepts empty diagnoses and jobs arrays', () => {
    const result = SharedDataSchema.parse({ ...validShared, diagnoses: [], jobs: [] });
    expect(result.diagnoses).toHaveLength(0);
    expect(result.jobs).toHaveLength(0);
  });
});

describe('PatientSchema', () => {
  it('parses valid patient', () => {
    const result = PatientSchema.parse(validPatient);
    expect(result.id).toBe(validPatient.id);
    expect(result.phase).toBe('evaluation');
    expect(result.data.activeModules).toContain('knee');
  });

  it('parses intake phase', () => {
    const result = PatientSchema.parse({ ...validPatient, phase: 'intake' });
    expect(result.phase).toBe('intake');
  });

  it('rejects invalid phase', () => {
    expect(() => PatientSchema.parse({ ...validPatient, phase: 'unknown' })).toThrow();
  });

  it('rejects non-UUID patient id', () => {
    expect(() => PatientSchema.parse({ ...validPatient, id: 'bad-id' })).toThrow();
  });

  it('accepts optional sync metadata matching app DEFAULT_PATIENT_SYNC', () => {
    const withSync = {
      ...validPatient,
      sync: { serverId: null, revision: 0, syncStatus: 'local-only' as const, lastSyncedAt: null },
    };
    const result = PatientSchema.parse(withSync);
    expect(result.sync?.serverId).toBeNull();
    expect(result.sync?.syncStatus).toBe('local-only');
  });

  it('accepts sync with serverId set (intranet synced state)', () => {
    const withSync = {
      ...validPatient,
      sync: { serverId: 'srv-abc', revision: 3, syncStatus: 'synced' as const, lastSyncedAt: '2024-01-10T09:00:00.000Z' },
    };
    const result = PatientSchema.parse(withSync);
    expect(result.sync?.serverId).toBe('srv-abc');
    expect(result.sync?.revision).toBe(3);
  });

  it('rejects invalid syncStatus', () => {
    expect(() => PatientSchema.parse({
      ...validPatient,
      sync: { serverId: null, revision: 0, syncStatus: 'unknown', lastSyncedAt: null },
    })).toThrow();
  });

  it('parses patient without sync field', () => {
    const result = PatientSchema.parse(validPatient);
    expect(result.sync).toBeUndefined();
  });

  it('accepts optional meta matching app createPatientMeta()', () => {
    const withMeta = {
      ...validPatient,
      meta: {
        organizationId: 'org-1',
        ownerUserId: 'user-1',
        createdBy: 'user-1',
        updatedBy: 'user-1',
        authMode: 'intranet',
        source: 'electron',
      },
    };
    const result = PatientSchema.parse(withMeta);
    expect(result.meta?.organizationId).toBe('org-1');
    expect(result.meta?.authMode).toBe('intranet');
  });

  it('accepts meta with null owner fields (local mode)', () => {
    const withMeta = {
      ...validPatient,
      meta: {
        organizationId: null,
        ownerUserId: null,
        createdBy: null,
        updatedBy: null,
        authMode: 'local',
        source: 'web',
      },
    };
    expect(PatientSchema.parse(withMeta).meta?.ownerUserId).toBeNull();
  });

  it('parses patient without meta field', () => {
    expect(PatientSchema.parse(validPatient).meta).toBeUndefined();
  });
});

describe('PatientSyncSchema', () => {
  it('parses default sync state', () => {
    const result = PatientSyncSchema.parse({ serverId: null, revision: 0, syncStatus: 'local-only', lastSyncedAt: null });
    expect(result.syncStatus).toBe('local-only');
  });

  it('preserves conflict metadata for unresolved server/local conflicts', () => {
    const conflict = {
      kind: 'pull',
      serverPatient: { id: validPatient.id, phase: validPatient.phase },
      serverRevision: 2,
    };
    const result = PatientSyncSchema.parse({
      serverId: 'srv-1',
      revision: 1,
      syncStatus: 'conflict',
      lastSyncedAt: null,
      conflict,
    });
    expect(result.conflict).toEqual(conflict);
  });

  it('rejects missing revision', () => {
    expect(() => PatientSyncSchema.parse({ serverId: null, syncStatus: 'local-only', lastSyncedAt: null })).toThrow();
  });
});

describe('PatientSyncConflictSchema', () => {
  it('accepts pull conflict metadata with an optional server patient snapshot', () => {
    const result = PatientSyncConflictSchema.parse({
      kind: 'pull',
      serverPatient: { id: validPatient.id },
      serverRevision: 3,
      extra: 'kept',
    });
    expect(result.kind).toBe('pull');
    expect(result.extra).toBe('kept');
  });
});

describe('PatientMetaSchema', () => {
  it('parses full meta', () => {
    const result = PatientMetaSchema.parse({
      organizationId: 'org-1', ownerUserId: 'user-1', createdBy: 'user-1',
      updatedBy: null, authMode: 'local', source: 'web',
    });
    expect(result.source).toBe('web');
  });
});
