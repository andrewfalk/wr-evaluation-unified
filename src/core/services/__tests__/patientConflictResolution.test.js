import { describe, expect, it } from 'vitest';
import { resolvePatientConflictInList } from '../patientConflictResolution.js';

function makePatient(overrides = {}) {
  return {
    id: 'local-1',
    phase: 'intake',
    data: { shared: { name: 'Local', patientNo: 'P001' }, modules: {}, activeModules: [] },
    sync: {
      serverId: 'server-1',
      revision: 1,
      syncStatus: 'conflict',
      lastSyncedAt: null,
      conflict: { kind: 'pull', serverRevision: 2 },
    },
    meta: { source: 'web' },
    ...overrides,
  };
}

function makeServerPatient(overrides = {}) {
  return {
    id: 'server-1',
    phase: 'intake',
    data: { shared: { name: 'Server', patientNo: 'P001' }, modules: {}, activeModules: [] },
    sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' },
    ...overrides,
  };
}

describe('resolvePatientConflictInList', () => {
  it('keeps local data as dirty at the latest server revision', () => {
    const local = makePatient();
    const server = makeServerPatient();

    const result = resolvePatientConflictInList([local], local.id, 'use-local', { serverPatient: server });

    expect(result).toHaveLength(1);
    expect(result[0].data.shared.name).toBe('Local');
    expect(result[0].sync.syncStatus).toBe('dirty');
    expect(result[0].sync.revision).toBe(2);
    expect(result[0].sync.conflict).toBeUndefined();
  });

  it('uses server data while preserving the local id and meta', () => {
    const local = makePatient();
    const server = makeServerPatient();

    const result = resolvePatientConflictInList([local], local.id, 'use-server', { serverPatient: server });

    expect(result[0].id).toBe('local-1');
    expect(result[0].data.shared.name).toBe('Server');
    expect(result[0].meta).toEqual(local.meta);
    expect(result[0].sync.syncStatus).toBe('synced');
  });

  it('applies merged data as dirty at the latest revision', () => {
    const local = makePatient();
    const server = makeServerPatient();
    const mergedData = { shared: { name: 'Merged', patientNo: 'P001' }, modules: {}, activeModules: [] };

    const result = resolvePatientConflictInList([local], local.id, 'merge', {
      serverPatient: server,
      mergedData,
    });

    expect(result[0].data).toEqual(mergedData);
    expect(result[0].sync.syncStatus).toBe('dirty');
    expect(result[0].sync.revision).toBe(2);
  });

  it('removes a delete conflict when the local delete intent wins', () => {
    const local = makePatient({
      sync: {
        serverId: 'server-1',
        revision: 1,
        syncStatus: 'conflict',
        lastSyncedAt: null,
        conflict: { kind: 'delete', serverRevision: 2 },
      },
    });

    const result = resolvePatientConflictInList([local], local.id, 'use-local');

    expect(result).toHaveLength(0);
  });

  it('restores a remote-deleted local edit as a new local-only patient', () => {
    const local = makePatient({
      sync: {
        serverId: 'server-1',
        revision: 2,
        syncStatus: 'conflict',
        lastSyncedAt: null,
        conflict: { kind: 'remote-delete', serverRevision: null },
      },
    });

    const result = resolvePatientConflictInList([local], local.id, 'use-local', { newId: 'new-local' });

    expect(result[0].id).toBe('new-local');
    expect(result[0].sync.serverId).toBeNull();
    expect(result[0].sync.syncStatus).toBe('local-only');
  });
});

