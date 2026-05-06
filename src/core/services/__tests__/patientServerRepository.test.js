import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pullPatients,
  fetchPatient,
  pushPatient,
  deletePatientOnServer,
  pushPendingPatients,
  mergeServerPatient,
  mergePulledPatients,
} from '../patientServerRepository.js';

vi.mock('../httpClient.js', () => ({
  requestJson: vi.fn(),
}));

import { requestJson } from '../httpClient.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SESSION = { userId: 'u1', organizationId: 'org1', accessToken: 'tok' };

function makeServerPatient(overrides = {}) {
  return {
    id:    'server-1',
    phase: 'intake',
    data:  { shared: { name: 'Kim', patientNo: 'P001' }, modules: {}, activeModules: [] },
    sync:  { serverId: 'server-1', revision: 1, syncStatus: 'synced', lastSyncedAt: '2024-01-01T00:00:00.000Z' },
    ...overrides,
  };
}

function makeLocalPatient(overrides = {}) {
  return {
    id:    'local-uuid',
    phase: 'intake',
    data:  { shared: { name: 'Kim', patientNo: 'P001' }, modules: {}, activeModules: [] },
    sync:  { serverId: null, revision: 0, syncStatus: 'local-only', lastSyncedAt: null },
    ...overrides,
  };
}

beforeEach(() => {
  requestJson.mockReset();
});

// ---------------------------------------------------------------------------
// pullPatients
// ---------------------------------------------------------------------------

describe('pullPatients', () => {
  it('returns mapped items preserving server id', async () => {
    const sp = makeServerPatient();
    requestJson.mockResolvedValue({ items: [sp], total: 1 });

    const result = await pullPatients({ session: SESSION });

    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('server-1');
    expect(result.items[0].sync.syncStatus).toBe('synced');
  });

  it('falls back total to items.length when total is absent', async () => {
    requestJson.mockResolvedValue({ items: [makeServerPatient(), makeServerPatient({ id: 'server-2' })] });
    const result = await pullPatients({ session: SESSION });
    expect(result.total).toBe(2);
  });

  it('appends non-empty query params to path', async () => {
    requestJson.mockResolvedValue({ items: [], total: 0 });

    await pullPatients({ session: SESSION, params: { q: 'Kim', limit: 50, offset: '' } });

    const [path] = requestJson.mock.calls[0];
    expect(path).toContain('q=Kim');
    expect(path).toContain('limit=50');
    expect(path).not.toContain('offset');   // empty string filtered out
  });

  it('omits query string when params is empty', async () => {
    requestJson.mockResolvedValue({ items: [], total: 0 });
    await pullPatients({ session: SESSION });
    const [path] = requestJson.mock.calls[0];
    expect(path).toBe('/api/patients');
  });
});

describe('fetchPatient', () => {
  it('loads a single patient by server id', async () => {
    requestJson.mockResolvedValue(makeServerPatient({ id: 'server-1' }));

    const result = await fetchPatient('server-1', { session: SESSION });

    const [path] = requestJson.mock.calls[0];
    expect(path).toBe('/api/patients/server-1');
    expect(result.id).toBe('server-1');
    expect(result.sync.syncStatus).toBe('synced');
  });
});

// ---------------------------------------------------------------------------
// pushPatient — POST (local-only)
// ---------------------------------------------------------------------------

describe('pushPatient — POST (no serverId)', () => {
  it('throws 400 when patient.id is missing (Idempotency-Key guard)', async () => {
    const patient = makeLocalPatient({ id: undefined });
    await expect(pushPatient(patient, { session: SESSION }))
      .rejects.toMatchObject({ status: 400 });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('sends POST with Idempotency-Key header and local id in body', async () => {
    const returned = makeServerPatient({ id: 'local-uuid' });
    requestJson.mockResolvedValue(returned);

    const patient = makeLocalPatient();
    await pushPatient(patient, { session: SESSION });

    const [path, opts] = requestJson.mock.calls[0];
    expect(path).toBe('/api/patients');
    expect(opts.method).toBe('POST');
    expect(opts.headers['Idempotency-Key']).toBe('local-uuid');
    expect(opts.body.id).toBe('local-uuid');
    expect(opts.body.data).toEqual(patient.data);
  });

  it('preserves local id in the returned patient', async () => {
    requestJson.mockResolvedValue(makeServerPatient({ id: 'local-uuid' }));
    const result = await pushPatient(makeLocalPatient(), { session: SESSION });
    expect(result.id).toBe('local-uuid');
    expect(result.sync.syncStatus).toBe('synced');
  });

  it('preserves local meta when the server response omits it', async () => {
    requestJson.mockResolvedValue(makeServerPatient({ id: 'local-uuid' }));
    const meta = {
      organizationId: 'org1',
      ownerUserId:   'u1',
      createdBy:     'u1',
      updatedBy:     'u1',
      authMode:      'intranet',
      source:        'web',
    };

    const result = await pushPatient(makeLocalPatient({ meta }), { session: SESSION });

    expect(result.meta).toEqual(meta);
  });
});

// ---------------------------------------------------------------------------
// pushPatient — PATCH (dirty)
// ---------------------------------------------------------------------------

describe('pushPatient — PATCH (has serverId)', () => {
  it('sends PATCH to /api/patients/:serverId with If-Match header', async () => {
    requestJson.mockResolvedValue(makeServerPatient({ id: 'server-1' }));

    const patient = makeLocalPatient({
      id:   'local-uuid',
      sync: { serverId: 'server-1', revision: 3, syncStatus: 'dirty', lastSyncedAt: null },
    });
    await pushPatient(patient, { session: SESSION });

    const [path, opts] = requestJson.mock.calls[0];
    expect(path).toBe('/api/patients/server-1');
    expect(opts.method).toBe('PATCH');
    expect(opts.headers['If-Match']).toBe('3');
  });

  it('preserves local id even though server id differs', async () => {
    requestJson.mockResolvedValue(makeServerPatient({ id: 'server-1' }));

    const patient = makeLocalPatient({
      id:   'local-uuid',
      sync: { serverId: 'server-1', revision: 1, syncStatus: 'dirty', lastSyncedAt: null },
    });
    const result = await pushPatient(patient, { session: SESSION });

    expect(result.id).toBe('local-uuid');
    expect(result.sync.serverId).toBe('server-1');
  });

  it.each([
    ['undefined', undefined],
    ['null',      null],
    ['0',         0],
    ['-1',        -1],
    ['NaN',       NaN],
    ['1.5',       1.5],
  ])('throws 400 when revision is %s (If-Match guard)', async (_label, rev) => {
    const patient = makeLocalPatient({
      sync: { serverId: 'server-1', revision: rev, syncStatus: 'dirty', lastSyncedAt: null },
    });
    await expect(pushPatient(patient, { session: SESSION }))
      .rejects.toMatchObject({ status: 400 });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('rethrows 409 conflict without modification', async () => {
    const err = new Error('Conflict');
    err.status = 409;
    err.data   = { code: 'CONFLICT', currentRevision: 5 };
    requestJson.mockRejectedValue(err);

    const patient = makeLocalPatient({
      sync: { serverId: 'server-1', revision: 3, syncStatus: 'dirty', lastSyncedAt: null },
    });
    await expect(pushPatient(patient, { session: SESSION }))
      .rejects.toMatchObject({ status: 409 });
  });
});

// ---------------------------------------------------------------------------
// deletePatientOnServer
// ---------------------------------------------------------------------------

describe('deletePatientOnServer', () => {
  it('sends DELETE with revision in query param', async () => {
    requestJson.mockResolvedValue(null);

    await deletePatientOnServer('server-1', 4, { session: SESSION });

    const [path, opts] = requestJson.mock.calls[0];
    expect(path).toBe('/api/patients/server-1?revision=4');
    expect(opts.method).toBe('DELETE');
  });

  it('throws 400 when serverId is missing', async () => {
    await expect(deletePatientOnServer(null, 1, { session: SESSION }))
      .rejects.toMatchObject({ status: 400 });
    expect(requestJson).not.toHaveBeenCalled();
  });

  it.each([
    ['undefined', undefined],
    ['null',      null],
    ['0',         0],
    ['-1',        -1],
    ['NaN',       NaN],
    ['1.5',       1.5],
  ])('throws 400 when revision is %s', async (_label, rev) => {
    await expect(deletePatientOnServer('server-1', rev, { session: SESSION }))
      .rejects.toMatchObject({ status: 400 });
    expect(requestJson).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pushPendingPatients
// ---------------------------------------------------------------------------

describe('pushPendingPatients', () => {
  it('syncs local-only and dirty, skips synced and conflict', async () => {
    const patients = [
      makeLocalPatient({ id: 'p1', sync: { syncStatus: 'local-only', serverId: null,     revision: 0, lastSyncedAt: null } }),
      makeLocalPatient({ id: 'p2', sync: { syncStatus: 'dirty',      serverId: 's2',     revision: 1, lastSyncedAt: null } }),
      makeLocalPatient({ id: 'p3', sync: { syncStatus: 'synced',     serverId: 's3',     revision: 1, lastSyncedAt: '...' } }),
      makeLocalPatient({ id: 'p4', sync: { syncStatus: 'conflict',   serverId: 's4',     revision: 1, lastSyncedAt: null } }),
    ];
    requestJson
      .mockResolvedValueOnce(makeServerPatient({ id: 'p1' }))
      .mockResolvedValueOnce(makeServerPatient({ id: 'p2' }));

    const { synced, failed } = await pushPendingPatients(patients, { session: SESSION });

    expect(synced).toHaveLength(2);
    expect(failed).toHaveLength(0);
    expect(requestJson).toHaveBeenCalledTimes(2);
  });

  it('collects individual failures without throwing', async () => {
    const err = new Error('Network error');
    requestJson.mockRejectedValue(err);

    const patients = [makeLocalPatient({ id: 'p1' })];
    const { synced, failed } = await pushPendingPatients(patients, { session: SESSION });

    expect(synced).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0].patient.id).toBe('p1');
    expect(failed[0].error).toBe(err);
    expect(failed[0].kind).toBe('error');
  });

  it('marks 409 failures as conflict kind', async () => {
    const err = new Error('Conflict');
    err.status = 409;
    requestJson.mockRejectedValue(err);

    const patients = [makeLocalPatient({
      id: 'p1',
      sync: { syncStatus: 'dirty', serverId: 's1', revision: 1, lastSyncedAt: null },
    })];
    const { synced, failed } = await pushPendingPatients(patients, { session: SESSION });

    expect(synced).toHaveLength(0);
    expect(failed).toHaveLength(1);
    expect(failed[0].kind).toBe('conflict');
  });

  it('returns empty results for an all-synced list', async () => {
    const patients = [
      makeLocalPatient({ sync: { syncStatus: 'synced', serverId: 's1', revision: 1, lastSyncedAt: '...' } }),
    ];
    const { synced, failed } = await pushPendingPatients(patients, { session: SESSION });
    expect(synced).toHaveLength(0);
    expect(failed).toHaveLength(0);
    expect(requestJson).not.toHaveBeenCalled();
  });

  it('skips redacted workspace snapshot stubs', async () => {
    const patients = [
      { id: 'redacted-1', redacted: true },
      makeLocalPatient({ id: 'p1' }),
    ];
    requestJson.mockResolvedValueOnce(makeServerPatient({ id: 'p1' }));

    const { synced, failed } = await pushPendingPatients(patients, { session: SESSION });

    expect(synced).toHaveLength(1);
    expect(failed).toHaveLength(0);
    expect(requestJson).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// mergeServerPatient
// ---------------------------------------------------------------------------

describe('mergeServerPatient', () => {
  it('appends patient not present in local list', () => {
    const result = mergeServerPatient([], makeServerPatient());
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('server-1');
  });

  it('replaces synced patient matched by id, preserving local id', () => {
    const local = makeLocalPatient({ id: 'server-1', sync: { serverId: 'server-1', revision: 1, syncStatus: 'synced', lastSyncedAt: null } });
    const sp    = makeServerPatient({ sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '2024-06-01T00:00:00Z' } });

    const result = mergeServerPatient([local], sp);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('server-1');
    expect(result[0].sync.revision).toBe(2);
    expect(result[0].sync.syncStatus).toBe('synced');
  });

  it('matches synced patient by sync.serverId and preserves distinct local id', () => {
    const local = makeLocalPatient({ id: 'local-uuid', sync: { serverId: 'server-1', revision: 1, syncStatus: 'synced', lastSyncedAt: null } });
    const sp    = makeServerPatient({ id: 'server-1', sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' } });

    const result = mergeServerPatient([local], sp);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local-uuid');
    expect(result[0].sync.revision).toBe(2);
  });

  it('preserves local meta when replacing a synced patient with a server response', () => {
    const meta = {
      organizationId: 'org1',
      ownerUserId:   'u1',
      createdBy:     'u1',
      updatedBy:     'u1',
      authMode:      'intranet',
      source:        'web',
    };
    const local = makeLocalPatient({
      id:   'local-uuid',
      meta,
      sync: { serverId: 'server-1', revision: 1, syncStatus: 'synced', lastSyncedAt: null },
    });
    const sp = makeServerPatient({
      id:   'server-1',
      sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' },
    });

    const result = mergeServerPatient([local], sp);

    expect(result[0].meta).toEqual(meta);
  });

  it('preserves dirty local data and marks conflict when pulled server revision is newer', () => {
    const local = makeLocalPatient({ id: 'local-uuid', sync: { serverId: 'server-1', revision: 1, syncStatus: 'dirty', lastSyncedAt: null } });
    const dirtyData = { shared: { name: 'Local Edit', patientNo: 'P001' }, modules: {}, activeModules: [] };
    const sp = makeServerPatient({
      id: 'server-1',
      data: { shared: { name: 'Server Edit', patientNo: 'P001' }, modules: {}, activeModules: [] },
      sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' },
    });

    const result = mergeServerPatient([{ ...local, data: dirtyData }], sp);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local-uuid');
    expect(result[0].data).toEqual(dirtyData);
    expect(result[0].sync.syncStatus).toBe('conflict');
    expect(result[0].sync.conflict.serverRevision).toBe(2);
    expect(result[0].sync.conflict.serverPatient.data.shared.name).toBe('Server Edit');
  });

  it('preserves dirty local data without conflict when pulled revision is not newer', () => {
    const local = makeLocalPatient({ id: 'local-uuid', sync: { serverId: 'server-1', revision: 2, syncStatus: 'dirty', lastSyncedAt: null } });
    const sp    = makeServerPatient({ id: 'server-1', sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' } });

    const result = mergeServerPatient([local], sp);

    expect(result[0]).toBe(local);
    expect(result[0].sync.syncStatus).toBe('dirty');
  });

  it('preserves existing delete conflict intent when pull attaches the server version', () => {
    const local = makeLocalPatient({
      id: 'local-uuid',
      sync: {
        serverId: 'server-1',
        revision: 1,
        syncStatus: 'conflict',
        lastSyncedAt: null,
        conflict: { kind: 'delete', serverRevision: 2 },
      },
    });
    const sp = makeServerPatient({
      id: 'server-1',
      data: { shared: { name: 'Server Still Exists', patientNo: 'P001' }, modules: {}, activeModules: [] },
      sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' },
    });

    const result = mergeServerPatient([local], sp);

    expect(result[0].sync.syncStatus).toBe('conflict');
    expect(result[0].sync.conflict.kind).toBe('delete');
    expect(result[0].sync.conflict.serverPatient.data.shared.name).toBe('Server Still Exists');
  });

  it('does not mutate the original array', () => {
    const original = [makeLocalPatient()];
    const before   = original[0];
    mergeServerPatient(original, makeServerPatient());
    expect(original[0]).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// mergePulledPatients
// ---------------------------------------------------------------------------

describe('mergePulledPatients', () => {
  it('applies all pulled patients sequentially', () => {
    const local = makeLocalPatient({ id: 'local-uuid', sync: { serverId: 's1', revision: 1, syncStatus: 'synced', lastSyncedAt: null } });
    const sp1   = makeServerPatient({ id: 's1', sync: { serverId: 's1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' } });
    const sp2   = makeServerPatient({ id: 's2', sync: { serverId: 's2', revision: 1, syncStatus: 'synced', lastSyncedAt: '...' } });

    const result = mergePulledPatients([local], [sp1, sp2]);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('local-uuid');
    expect(result[0].sync.revision).toBe(2);
    expect(result[1].id).toBe('s2');
  });

  it('returns unchanged list for empty pull', () => {
    const local  = [makeLocalPatient()];
    const result = mergePulledPatients(local, []);
    expect(result).toEqual(local);
  });
});
