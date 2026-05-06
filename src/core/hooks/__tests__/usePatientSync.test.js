import { describe, expect, it } from 'vitest';
import { reconcilePulledPatients } from '../usePatientSync.js';

function makePatient(overrides = {}) {
  return {
    id: 'local-1',
    phase: 'intake',
    data: { shared: { name: 'Kim', patientNo: 'P001' }, modules: {}, activeModules: [] },
    sync: { serverId: 'server-1', revision: 1, syncStatus: 'synced', lastSyncedAt: null },
    ...overrides,
  };
}

describe('reconcilePulledPatients', () => {
  it('removes synced server-backed patients absent from the pull result', () => {
    const local = makePatient();

    const result = reconcilePulledPatients([local], []);

    expect(result).toHaveLength(0);
  });

  it('keeps local-only patients absent from the pull result', () => {
    const local = makePatient({
      id: 'local-only',
      sync: { serverId: null, revision: 0, syncStatus: 'local-only', lastSyncedAt: null },
    });

    const result = reconcilePulledPatients([local], []);

    expect(result).toEqual([local]);
  });

  it('marks dirty server-backed patients absent from the pull result as remote-delete conflicts', () => {
    const local = makePatient({
      sync: { serverId: 'server-1', revision: 2, syncStatus: 'dirty', lastSyncedAt: null },
    });

    const result = reconcilePulledPatients([local], []);

    expect(result).toHaveLength(1);
    expect(result[0].sync.syncStatus).toBe('conflict');
    expect(result[0].sync.conflict.kind).toBe('remote-delete');
  });

  it('merges patients still present in the pull result', () => {
    const local = makePatient({
      sync: { serverId: 'server-1', revision: 1, syncStatus: 'synced', lastSyncedAt: null },
    });
    const pulled = makePatient({
      id: 'server-1',
      data: { shared: { name: 'Server Edit', patientNo: 'P001' }, modules: {}, activeModules: [] },
      sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' },
    });

    const result = reconcilePulledPatients([local], [pulled]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local-1');
    expect(result[0].data.shared.name).toBe('Server Edit');
    expect(result[0].sync.revision).toBe(2);
  });
});
