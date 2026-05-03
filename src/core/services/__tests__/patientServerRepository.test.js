import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  pullPatients,
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

// ---------------------------------------------------------------------------
// pushPatient — POST (local-only)
// ---------------------------------------------------------------------------

describe('pushPatient — POST (no serverId)', () => {
  it('sends POST with Idempotency-Key header and local id in body', async () => {
    const returned = makeServerPatient({ id: 'local-uuid' });
    requestJson.mockResolvedValue(returned);

    const patient = makeLocalPatient();
    const result = await pushPatient(patient, { session: SESSION });

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

  it('replaces existing patient matched by id, preserving local id', () => {
    const local = makeLocalPatient({ id: 'server-1', sync: { serverId: 'server-1', revision: 1, syncStatus: 'dirty', lastSyncedAt: null } });
    const sp    = makeServerPatient({ sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '2024-06-01T00:00:00Z' } });

    const result = mergeServerPatient([local], sp);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('server-1');
    expect(result[0].sync.revision).toBe(2);
    expect(result[0].sync.syncStatus).toBe('synced');
  });

  it('matches by sync.serverId and preserves distinct local id', () => {
    const local = makeLocalPatient({ id: 'local-uuid', sync: { serverId: 'server-1', revision: 1, syncStatus: 'dirty', lastSyncedAt: null } });
    const sp    = makeServerPatient({ id: 'server-1', sync: { serverId: 'server-1', revision: 2, syncStatus: 'synced', lastSyncedAt: '...' } });

    const result = mergeServerPatient([local], sp);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('local-uuid');
    expect(result[0].sync.revision).toBe(2);
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
    const local = makeLocalPatient({ id: 'local-uuid', sync: { serverId: 's1', revision: 1, syncStatus: 'dirty', lastSyncedAt: null } });
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
