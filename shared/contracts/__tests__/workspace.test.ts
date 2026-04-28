import { describe, it, expect } from 'vitest';
import {
  WorkspaceScopeSchema,
  WorkspaceItemSchema,
  GetWorkspacesResponseSchema,
  SaveWorkspaceRequestSchema,
} from '../workspace';

const validScope = {
  scopeKey: 'org-1:user-1',
  userId: 'user-1',
  organizationId: 'org-1',
  authMode: 'local-db',
};

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
      diagnoses: [],
      jobs: [],
    },
    modules: {},
    activeModules: [],
  },
};

const validItem = {
  id: 'ws-001',
  name: '2024년 1분기 평가',
  count: 3,
  savedAt: '2024-01-10T09:00:00.000Z',
  patients: [validPatient],
};

describe('WorkspaceScopeSchema', () => {
  it('parses valid scope', () => {
    expect(WorkspaceScopeSchema.parse(validScope)).toMatchObject(validScope);
  });

  it('rejects missing field', () => {
    const { scopeKey: _, ...without } = validScope;
    expect(() => WorkspaceScopeSchema.parse(without)).toThrow();
  });
});

describe('WorkspaceItemSchema', () => {
  it('parses valid item', () => {
    const result = WorkspaceItemSchema.parse(validItem);
    expect(result.name).toBe('2024년 1분기 평가');
    expect(result.count).toBe(3);
    expect(result.patients).toHaveLength(1);
  });

  it('rejects negative count', () => {
    expect(() => WorkspaceItemSchema.parse({ ...validItem, count: -1 })).toThrow();
  });

  it('accepts zero count', () => {
    expect(WorkspaceItemSchema.parse({ ...validItem, count: 0, patients: [] }).count).toBe(0);
  });
});

describe('GetWorkspacesResponseSchema', () => {
  it('parses response without optional fields', () => {
    const result = GetWorkspacesResponseSchema.parse({ items: [validItem] });
    expect(result.items).toHaveLength(1);
    expect(result.mock).toBeUndefined();
    expect(result.scope).toBeUndefined();
  });

  it('parses response with mock and scope', () => {
    const result = GetWorkspacesResponseSchema.parse({
      items: [],
      mock: true,
      scope: validScope,
    });
    expect(result.mock).toBe(true);
    expect(result.scope?.scopeKey).toBe('org-1:user-1');
  });

  it('accepts empty items array', () => {
    expect(GetWorkspacesResponseSchema.parse({ items: [] }).items).toHaveLength(0);
  });
});

describe('SaveWorkspaceRequestSchema', () => {
  it('parses valid request', () => {
    const result = SaveWorkspaceRequestSchema.parse({ name: '내 워크스페이스', patients: [validPatient] });
    expect(result.name).toBe('내 워크스페이스');
  });

  it('rejects empty name', () => {
    expect(() => SaveWorkspaceRequestSchema.parse({ name: '', patients: [] })).toThrow();
  });

  it('accepts empty patients array', () => {
    expect(SaveWorkspaceRequestSchema.parse({ name: '빈 워크스페이스', patients: [] }).patients).toHaveLength(0);
  });
});
