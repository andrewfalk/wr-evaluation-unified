import { describe, expect, it, vi } from 'vitest';
import {
  buildLoadFailureMessage,
  getLoadablePatientsFromSnapshot,
} from '../useWorkspacePersistence.js';

vi.mock('../../services/workspaceRepository', () => ({
  clearAutoSavedWorkspace: vi.fn(),
  deleteWorkspaceSnapshot: vi.fn(),
  hasDuplicateWorkspaceName: vi.fn(),
  loadAutoSavedWorkspace: vi.fn(),
  loadSavedWorkspaces: vi.fn(),
  migrateWorkspaceStorage: vi.fn(),
  saveAutoSavedWorkspace: vi.fn(),
  saveWorkspaceSnapshot: vi.fn(),
}));

function makePatient(id) {
  return {
    id,
    data: {
      shared: { name: id },
      activeModules: [],
    },
  };
}

describe('workspace patient loading', () => {
  it('excludes redacted patient stubs and reports failed/total counts', () => {
    const result = getLoadablePatientsFromSnapshot([
      makePatient('p1'),
      { id: 'deleted-1', redacted: true },
      makePatient('p2'),
    ]);

    expect(result.patients.map(patient => patient.id)).toEqual(['p1', 'p2']);
    expect(result.failedCount).toBe(1);
    expect(result.totalCount).toBe(3);
  });

  it('builds the deleted-patient load warning with failed and total counts', () => {
    expect(buildLoadFailureMessage({ failedCount: 2, totalCount: 5 })).toBe(
      '불러오기한 환자 목록에 삭제된 환자가 포함되어 있어 작업 목록에서 제외했습니다. (실패 2건 / 총 5건)'
    );
    expect(buildLoadFailureMessage({ failedCount: 0, totalCount: 5 })).toBe('');
  });
});
