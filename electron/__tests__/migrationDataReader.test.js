import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsModule from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const fs = fsModule.default ?? fsModule;

import { readMigrationSnapshot } from '../migrationDataReader.js';

let tmpDir;

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data), 'utf-8');
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wr-migration-reader-'));
});

afterEach(async () => {
  if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('readMigrationSnapshot', () => {
  it('returns empty fields when the dataDir does not exist', async () => {
    const missing = path.join(tmpDir, 'no-such-dir');
    const snap = await readMigrationSnapshot(missing);
    expect(snap.savedItems).toEqual([]);
    expect(snap.indexedPatients).toEqual([]);
    expect(snap.autoSave).toBeNull();
    expect(snap.summary).toEqual({
      savedItemCount: 0,
      indexedPatientCount: 0,
      hasAutosave: false,
    });
  });

  it('reads saved/*.json files', async () => {
    await writeJson(path.join(tmpDir, 'saved', 'ws1.json'), { id: 'ws1', patients: [{ id: 'p1' }] });
    await writeJson(path.join(tmpDir, 'saved', 'ws2.json'), { id: 'ws2', patients: [] });

    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.savedItems).toHaveLength(2);
    expect(snap.savedItems.map(i => i.id).sort()).toEqual(['ws1', 'ws2']);
  });

  it('reads autosave.json when present, null when absent', async () => {
    const snap1 = await readMigrationSnapshot(tmpDir);
    expect(snap1.autoSave).toBeNull();

    await writeJson(path.join(tmpDir, 'autosave.json'), { patients: [{ id: 'p1' }] });
    const snap2 = await readMigrationSnapshot(tmpDir);
    expect(snap2.autoSave).toEqual({ patients: [{ id: 'p1' }] });
    expect(snap2.summary.hasAutosave).toBe(true);
  });

  it('reads only indexed patient files (ghost defense)', async () => {
    // index.json declares p1 and p2 as the canonical set
    await writeJson(path.join(tmpDir, 'index.json'), [
      { id: 'p1', name: 'Alice' },
      { id: 'p2', name: 'Bob' },
    ]);
    await writeJson(path.join(tmpDir, 'patients', 'p1.json'), { id: 'p1' });
    await writeJson(path.join(tmpDir, 'patients', 'p2.json'), { id: 'p2' });
    // Ghost file: lingering on disk after deletion, NOT in index.json
    await writeJson(path.join(tmpDir, 'patients', 'ghost.json'), { id: 'ghost' });

    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.indexedPatients).toHaveLength(2);
    expect(snap.indexedPatients.map(p => p.id).sort()).toEqual(['p1', 'p2']);
    // ghost.json must not appear
    expect(snap.indexedPatients.some(p => p.id === 'ghost')).toBe(false);
  });

  it('skips index entries whose patient file is missing', async () => {
    await writeJson(path.join(tmpDir, 'index.json'), [
      { id: 'p1' }, { id: 'p2' }, { id: 'p3-missing' },
    ]);
    await writeJson(path.join(tmpDir, 'patients', 'p1.json'), { id: 'p1' });
    await writeJson(path.join(tmpDir, 'patients', 'p2.json'), { id: 'p2' });

    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.indexedPatients).toHaveLength(2);
  });

  it('returns empty indexedPatients when index.json is missing', async () => {
    await writeJson(path.join(tmpDir, 'patients', 'p1.json'), { id: 'p1' });
    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.indexedPatients).toEqual([]);
  });

  it('survives a corrupt JSON file in saved/', async () => {
    await writeJson(path.join(tmpDir, 'saved', 'good.json'), { id: 'good' });
    await fs.mkdir(path.join(tmpDir, 'saved'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'saved', 'broken.json'), '{ not valid json', 'utf-8');

    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.savedItems).toHaveLength(1);
    expect(snap.savedItems[0].id).toBe('good');
  });

  it('survives a corrupt index.json by treating it as empty', async () => {
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'index.json'), 'not json', 'utf-8');
    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.indexedPatients).toEqual([]);
  });

  it('skips non-.json files in saved/', async () => {
    await writeJson(path.join(tmpDir, 'saved', 'a.json'), { id: 'a' });
    await fs.mkdir(path.join(tmpDir, 'saved'), { recursive: true });
    await fs.writeFile(path.join(tmpDir, 'saved', 'README.txt'), 'noise', 'utf-8');

    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.savedItems.map(i => i.id)).toEqual(['a']);
  });

  it('rejects ids that would escape patientsDir (path traversal defense)', async () => {
    // If sanitization fails, the reader could be tricked into reading a sibling
    // file outside patients/. Place a decoy at the parent and verify it never
    // ends up in indexedPatients.
    await writeJson(path.join(tmpDir, 'escape.json'), { id: 'escape', leaked: true });
    await writeJson(path.join(tmpDir, 'index.json'), [
      { id: '../escape' },
      { id: '..\\escape' },
      { id: '/etc/passwd' },
      { id: 'good' },
    ]);
    await writeJson(path.join(tmpDir, 'patients', 'good.json'), { id: 'good' });

    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.indexedPatients.map(p => p.id)).toEqual(['good']);
    expect(snap.indexedPatients.some(p => p.leaked)).toBe(false);
  });

  it('skips index entries with non-string or empty ids', async () => {
    await writeJson(path.join(tmpDir, 'index.json'), [
      { id: '' },
      { id: null },
      { id: 123 },
      { /* no id */ },
      { id: 'p1' },
    ]);
    await writeJson(path.join(tmpDir, 'patients', 'p1.json'), { id: 'p1' });
    const snap = await readMigrationSnapshot(tmpDir);
    expect(snap.indexedPatients.map(p => p.id)).toEqual(['p1']);
  });

  it('surfaces permission errors instead of swallowing them', async () => {
    // Set up a normally-readable dataDir then make readFile throw EACCES on the
    // first call. The snapshot must reject — silently returning empty results
    // would mask permission problems behind a "no data" UI.
    await writeJson(path.join(tmpDir, 'index.json'), [{ id: 'p1' }]);
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const spy = vi.spyOn(fs, 'readFile').mockRejectedValueOnce(eacces);

    await expect(readMigrationSnapshot(tmpDir)).rejects.toMatchObject({ code: 'EACCES' });
    spy.mockRestore();
  });

  it('surfaces EACCES on readdir (saved/) instead of treating as empty', async () => {
    await writeJson(path.join(tmpDir, 'saved', 'a.json'), { id: 'a' });
    const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    const spy = vi.spyOn(fs, 'readdir').mockRejectedValueOnce(eacces);

    await expect(readMigrationSnapshot(tmpDir)).rejects.toMatchObject({ code: 'EACCES' });
    spy.mockRestore();
  });
});
