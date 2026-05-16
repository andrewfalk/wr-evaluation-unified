// migrationDataReader.js — Read-only snapshot of local patient data for the
// intranet migration IPC. Pure module: takes a dataDir, returns a snapshot.
// Never writes, never accepts paths from the renderer.
//
// patients/ is NOT scanned wholesale — fs-save-all-patients does not clean up
// stale files, so a full scan would resurrect ghost patients on the server.
// We only read patients/{id}.json for ids listed in index.json.
const fs = require('fs/promises');
const path = require('path');

// Same character class as main.js sanitizeId(). Defense-in-depth against a
// corrupted or hand-edited index.json containing values like '../autosave'.
const VALID_ID = /^[\w-]+$/;
function isValidId(id) {
  return typeof id === 'string' && VALID_ID.test(id);
}

// ENOENT and SyntaxError are treated as "no data" — they are expected on a
// fresh install or after a crashed write. Permission/IO errors (EACCES, EPERM,
// EBUSY, ...) are intentionally re-thrown so the IPC handler surfaces them
// as MigrationReadError instead of silently showing "no data to migrate".
async function readJsonSafe(filePath, fallback) {
  let txt;
  try {
    txt = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function readDirSafe(dirPath) {
  try {
    return await fs.readdir(dirPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function readSavedItems(savedDir) {
  const files = (await readDirSafe(savedDir)).filter(f => f.endsWith('.json'));
  const out = [];
  for (const file of files) {
    const item = await readJsonSafe(path.join(savedDir, file), null);
    if (item) out.push(item);
  }
  return out;
}

async function readIndexedPatients(patientsDir, indexPath) {
  const index = await readJsonSafe(indexPath, []);
  if (!Array.isArray(index)) return [];
  const out = [];
  for (const meta of index) {
    if (!meta || !isValidId(meta.id)) continue;
    const p = await readJsonSafe(path.join(patientsDir, `${meta.id}.json`), null);
    if (p) out.push(p);
  }
  return out;
}

async function readMigrationSnapshot(dataDir) {
  const savedDir = path.join(dataDir, 'saved');
  const patientsDir = path.join(dataDir, 'patients');
  const indexPath = path.join(dataDir, 'index.json');
  const autosavePath = path.join(dataDir, 'autosave.json');
  const customPresetsPath = path.join(dataDir, 'custom-presets.json');

  const [savedItems, indexedPatients, autoSave, customPresets] = await Promise.all([
    readSavedItems(savedDir),
    readIndexedPatients(patientsDir, indexPath),
    readJsonSafe(autosavePath, null),
    readJsonSafe(customPresetsPath, []),
  ]);

  return {
    savedItems,
    indexedPatients,
    autoSave,
    customPresets: Array.isArray(customPresets) ? customPresets : [],
    summary: {
      savedItemCount: savedItems.length,
      indexedPatientCount: indexedPatients.length,
      hasAutosave: !!autoSave,
    },
  };
}

module.exports = { readMigrationSnapshot };
