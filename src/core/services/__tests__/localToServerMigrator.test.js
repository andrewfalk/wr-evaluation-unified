import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectLocalPatients,
  migrateToServer,
  runMigration,
} from '../localToServerMigrator';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../utils/storage', () => ({
  loadSavedItems: vi.fn(),
  loadAutoSave:   vi.fn(),
}));

vi.mock('../patientServerRepository.js', () => ({
  pushPatient: vi.fn(),
}));

import { loadAutoSave, loadSavedItems } from '../../utils/storage';
import { pushPatient } from '../patientServerRepository.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function makePatient(id, overrides = {}) {
  return {
    id,
    createdAt: '2024-01-01T00:00:00.000Z',
    phase: 'intake',
    data: { shared: { name: `P-${id}` }, modules: {}, activeModules: [] },
    ...overrides,
  };
}

const SESSION  = { apiBaseUrl: 'https://intranet.test' };
const SETTINGS = {};

beforeEach(() => {
  vi.resetAllMocks();
  loadSavedItems.mockResolvedValue([]);
  loadAutoSave.mockResolvedValue(null);
});

// ---------------------------------------------------------------------------
// collectLocalPatients
// ---------------------------------------------------------------------------
describe('collectLocalPatients', () => {
  it('returns empty array when storage is empty', async () => {
    expect(await collectLocalPatients()).toEqual([]);
  });

  it('returns patients from saved items', async () => {
    const p1 = makePatient('p1');
    loadSavedItems.mockResolvedValue([
      { id: 'ws1', name: 'WS', patients: [p1] },
    ]);
    const result = await collectLocalPatients();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('p1');
  });

  it('returns patients from autosave', async () => {
    const p1 = makePatient('p1');
    loadAutoSave.mockResolvedValue({ patients: [p1] });
    const result = await collectLocalPatients();
    expect(result).toHaveLength(1);
  });

  it('deduplicates patients across saved items by id', async () => {
    const p1 = makePatient('p1');
    loadSavedItems.mockResolvedValue([
      { id: 'ws1', patients: [p1] },
      { id: 'ws2', patients: [p1] },
    ]);
    const result = await collectLocalPatients();
    expect(result).toHaveLength(1);
  });

  it('autosave version takes priority over saved-item version for same id', async () => {
    const old = makePatient('p1', { phase: 'intake' });
    const fresh = makePatient('p1', { phase: 'evaluation' });
    loadSavedItems.mockResolvedValue([{ id: 'ws1', patients: [old] }]);
    loadAutoSave.mockResolvedValue({ patients: [fresh] });

    const result = await collectLocalPatients();
    expect(result).toHaveLength(1);
    expect(result[0].phase).toBe('evaluation');
  });

  it('skips redacted stubs', async () => {
    loadSavedItems.mockResolvedValue([
      { id: 'ws1', patients: [{ id: 'p1', redacted: true }] },
    ]);
    loadAutoSave.mockResolvedValue({ patients: [{ redacted: true }] });
    expect(await collectLocalPatients()).toHaveLength(0);
  });

  it('skips entries without id', async () => {
    loadSavedItems.mockResolvedValue([
      { id: 'ws1', patients: [{ phase: 'intake' }] },
    ]);
    loadAutoSave.mockResolvedValue({ patients: [{ phase: 'intake' }] });
    expect(await collectLocalPatients()).toHaveLength(0);
  });

  it('collects patients from multiple saved items without duplication', async () => {
    const p1 = makePatient('p1');
    const p2 = makePatient('p2');
    const p3 = makePatient('p3');
    loadSavedItems.mockResolvedValue([
      { id: 'ws1', patients: [p1, p2] },
      { id: 'ws2', patients: [p2, p3] },
    ]);
    const result = await collectLocalPatients();
    expect(result).toHaveLength(3);
    expect(result.map(p => p.id).sort()).toEqual(['p1', 'p2', 'p3']);
  });
});

// ---------------------------------------------------------------------------
// migrateToServer
// ---------------------------------------------------------------------------
describe('migrateToServer', () => {
  it('returns empty arrays for empty input', async () => {
    const result = await migrateToServer([], { session: SESSION, settings: SETTINGS });
    expect(result).toEqual({ migrated: [], failed: [], alreadySynced: [] });
    expect(pushPatient).not.toHaveBeenCalled();
  });

  it('skips patients that already have a serverId', async () => {
    const synced = makePatient('p1', { sync: { serverId: 'srv-1', revision: 1, syncStatus: 'synced' } });
    const result = await migrateToServer([synced], { session: SESSION });
    expect(pushPatient).not.toHaveBeenCalled();
    expect(result.alreadySynced).toHaveLength(1);
    expect(result.migrated).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('pushes patients without a serverId and returns them in migrated', async () => {
    const local = makePatient('p1');
    const synced = { ...local, sync: { serverId: 'srv-p1', revision: 1, syncStatus: 'synced' } };
    pushPatient.mockResolvedValue(synced);

    const result = await migrateToServer([local], { session: SESSION });

    expect(pushPatient).toHaveBeenCalledOnce();
    expect(pushPatient).toHaveBeenCalledWith(local, { session: SESSION, settings: undefined });
    expect(result.migrated).toHaveLength(1);
    expect(result.migrated[0].sync.serverId).toBe('srv-p1');
    expect(result.failed).toHaveLength(0);
  });

  it('records push failures in failed without throwing', async () => {
    const local = makePatient('p1');
    const err = Object.assign(new Error('Network error'), { status: 503 });
    pushPatient.mockRejectedValue(err);

    const result = await migrateToServer([local], { session: SESSION });

    expect(result.migrated).toHaveLength(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].patient.id).toBe('p1');
    expect(result.failed[0].error.status).toBe(503);
  });

  it('handles mixed success and failure across patients', async () => {
    const p1 = makePatient('p1');
    const p2 = makePatient('p2');
    const syncedP1 = { ...p1, sync: { serverId: 'srv-p1', revision: 1, syncStatus: 'synced' } };
    pushPatient
      .mockResolvedValueOnce(syncedP1)
      .mockRejectedValueOnce(Object.assign(new Error('fail'), { status: 500 }));

    const result = await migrateToServer([p1, p2], { session: SESSION });

    expect(result.migrated).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.alreadySynced).toHaveLength(0);
  });

  it('is idempotent: re-running with already-synced patients skips them', async () => {
    const synced = makePatient('p1', {
      sync: { serverId: 'srv-p1', revision: 1, syncStatus: 'synced' },
    });
    const result = await migrateToServer([synced], { session: SESSION });

    expect(pushPatient).not.toHaveBeenCalled();
    expect(result.alreadySynced).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// runMigration
// ---------------------------------------------------------------------------
describe('runMigration', () => {
  it('collects from storage and migrates in one call', async () => {
    const p1 = makePatient('p1');
    const syncedP1 = { ...p1, sync: { serverId: 'srv-1', revision: 1, syncStatus: 'synced' } };
    loadAutoSave.mockResolvedValue({ patients: [p1] });
    pushPatient.mockResolvedValue(syncedP1);

    const result = await runMigration({ session: SESSION });

    expect(pushPatient).toHaveBeenCalledOnce();
    expect(result.migrated).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.alreadySynced).toHaveLength(0);
  });

  it('returns all-empty result when storage is empty', async () => {
    const result = await runMigration({ session: SESSION });
    expect(result).toEqual({ migrated: [], failed: [], alreadySynced: [] });
  });
});
