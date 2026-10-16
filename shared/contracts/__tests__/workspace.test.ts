import { describe, it, expect } from 'vitest';
import {
  WorkspaceScopeSchema,
  WorkspaceItemSchema,
  GetWorkspacesResponseSchema,
  SaveWorkspaceRequestSchema,
  SaveWorkspaceResponseSchema,
  WorkspaceSaveAckSchema,
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

  it('carries per-patient lock tokens beside (not inside) the patients snapshot', () => {
    const result = SaveWorkspaceRequestSchema.parse({
      name: 'ws', patients: [validPatient], lockTokens: { [validPatient.id]: 'lease-token' },
    });
    expect(result.lockTokens).toEqual({ [validPatient.id]: 'lease-token' });
    expect(SaveWorkspaceRequestSchema.parse({ name: 'ws', patients: [] }).lockTokens).toBeUndefined();
  });
});

describe('SaveWorkspaceResponseSchema (HF1 per-patient ack)', () => {
  it('old-server / mock responses without ack fields still parse, with empty ack lists', () => {
    const result = SaveWorkspaceResponseSchema.parse({ items: [] });
    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.lockedByOther).toEqual([]);
  });

  it('parses saved / skipped / conflicts / lockedByOther', () => {
    const result = SaveWorkspaceResponseSchema.parse({
      items: [],
      saved: [{ id: 'p1', revision: 3, assignedDoctorUserId: 'doc-1' }],
      skipped: [{ id: 'p2', reason: 'not_assigned' }],
      conflicts: [{ id: 'p3', serverRevision: 7 }],
      lockedByOther: [{ id: 'p4', holder: { holderName: 'Dr. Lee', acquiredAt: 'a', expiresAt: 'b' } }],
    });
    expect(result.saved[0]).toEqual({ id: 'p1', revision: 3, assignedDoctorUserId: 'doc-1' });
    expect(result.skipped[0].reason).toBe('not_assigned');
    expect(result.conflicts[0].serverRevision).toBe(7);
    expect(result.lockedByOther[0].holder.holderName).toBe('Dr. Lee');
  });

  it('accepts a missing or null assignedDoctorUserId (old servers / unassigned patients) and lenient lock holders', () => {
    const result = WorkspaceSaveAckSchema.parse({
      saved: [{ id: 'p1', revision: 1 }, { id: 'p2', revision: 1, assignedDoctorUserId: null }],
      lockedByOther: [{ id: 'p3', holder: { holderName: null } }, { id: 'p4', holder: {} }],
    });
    expect(result.saved[0].assignedDoctorUserId).toBeUndefined();
    expect(result.saved[1].assignedDoctorUserId).toBeNull();
    expect(result.lockedByOther).toHaveLength(2);
  });

  it('rejects an unknown skip reason and a non-positive saved revision', () => {
    expect(() => WorkspaceSaveAckSchema.parse({ skipped: [{ id: 'p', reason: 'whatever' }] })).toThrow();
    expect(() => WorkspaceSaveAckSchema.parse({ saved: [{ id: 'p', revision: 0 }] })).toThrow();
  });
});
