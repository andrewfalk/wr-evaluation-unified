// paths.js — Single source of truth for the local data directory layout.
// Both the standalone fs-* IPC handlers and the intranet migration reader
// derive their paths from these helpers, so the directory structure is
// described in exactly one place.
const path = require('path');

function getWrEvalDataDir(app) {
  return path.join(app.getPath('userData'), 'wr-eval-data');
}

function getDataPaths(app) {
  const dataDir = getWrEvalDataDir(app);
  return {
    dataDir,
    patientsDir: path.join(dataDir, 'patients'),
    savedDir: path.join(dataDir, 'saved'),
    indexPath: path.join(dataDir, 'index.json'),
    autosavePath: path.join(dataDir, 'autosave.json'),
    settingsPath: path.join(dataDir, 'settings.json'),
    customPresetsPath: path.join(dataDir, 'custom-presets.json'),
  };
}

module.exports = { getWrEvalDataDir, getDataPaths };
