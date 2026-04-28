import { describe, it, expect } from 'vitest';
import {
  AutosaveDataSchema,
  GetAutosaveResponseSchema,
  PutAutosaveRequestSchema,
  PutAutosaveResponseSchema,
  DeleteAutosaveResponseSchema,
} from '../autosave';

const validPatient = {
  id: '00000000-0000-0000-0000-000000000001',
  createdAt: '2024-01-10T09:00:00.000Z',
  phase: 'evaluation' as const,
  data: {
    shared: {
      patientNo: 'P-001',
      name: '홍길동',
      gender: 'M',
      height: '170',
      weight: '70',
      birthDate: '1975-03-15',
      injuryDate: '2023-06-01',
      hospitalName: '병원',
      department: '직업환경의학과',
      doctorName: '김의사',
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
      diagnoses: [],
      jobs: [],
    },
    modules: {},
    activeModules: [],
  },
};

const validScope = {
  scopeKey: 'org-1:user-1',
  userId: 'user-1',
  organizationId: 'org-1',
  authMode: 'local-db',
};

describe('AutosaveDataSchema', () => {
  it('parses valid autosave data', () => {
    const result = AutosaveDataSchema.parse({ savedAt: '2024-01-10T09:00:00.000Z', patients: [validPatient] });
    expect(result.savedAt).toBe('2024-01-10T09:00:00.000Z');
    expect(result.patients).toHaveLength(1);
  });

  it('accepts empty patients array', () => {
    const result = AutosaveDataSchema.parse({ savedAt: '2024-01-10T09:00:00.000Z', patients: [] });
    expect(result.patients).toHaveLength(0);
  });
});

describe('GetAutosaveResponseSchema', () => {
  it('parses null (no autosave)', () => {
    expect(GetAutosaveResponseSchema.parse(null)).toBeNull();
  });

  it('parses autosave data without optional fields', () => {
    const result = GetAutosaveResponseSchema.parse({
      savedAt: '2024-01-10T09:00:00.000Z',
      patients: [validPatient],
    });
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.savedAt).toBe('2024-01-10T09:00:00.000Z');
      expect(result.mock).toBeUndefined();
      expect(result.scope).toBeUndefined();
    }
  });

  it('parses autosave data with mock and scope', () => {
    const result = GetAutosaveResponseSchema.parse({
      savedAt: '2024-01-10T09:00:00.000Z',
      patients: [],
      mock: true,
      scope: validScope,
    });
    expect(result).not.toBeNull();
    if (result !== null) {
      expect(result.mock).toBe(true);
      expect(result.scope?.userId).toBe('user-1');
    }
  });
});

describe('PutAutosaveRequestSchema', () => {
  it('parses valid put request', () => {
    const result = PutAutosaveRequestSchema.parse({ patients: [validPatient] });
    expect(result.patients).toHaveLength(1);
  });

  it('accepts empty patients array', () => {
    expect(PutAutosaveRequestSchema.parse({ patients: [] }).patients).toHaveLength(0);
  });
});

describe('PutAutosaveResponseSchema', () => {
  it('parses valid response', () => {
    const result = PutAutosaveResponseSchema.parse({ ok: true, savedAt: '2024-01-10T09:00:00.000Z' });
    expect(result.ok).toBe(true);
    expect(result.savedAt).toBe('2024-01-10T09:00:00.000Z');
  });

  it('rejects ok: false', () => {
    expect(() => PutAutosaveResponseSchema.parse({ ok: false, savedAt: '2024-01-10T09:00:00.000Z' })).toThrow();
  });

  it('parses response with mock and scope', () => {
    const result = PutAutosaveResponseSchema.parse({
      ok: true,
      savedAt: '2024-01-10T09:00:00.000Z',
      mock: true,
      scope: validScope,
    });
    expect(result.mock).toBe(true);
  });
});

describe('DeleteAutosaveResponseSchema', () => {
  it('parses valid response', () => {
    expect(DeleteAutosaveResponseSchema.parse({ ok: true }).ok).toBe(true);
  });

  it('rejects ok: false', () => {
    expect(() => DeleteAutosaveResponseSchema.parse({ ok: false })).toThrow();
  });
});
