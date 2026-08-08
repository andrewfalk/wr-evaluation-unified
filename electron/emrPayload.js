// emrPayload.js — Pure helper for separating the audit-log `_source` marker
// from the actual EMR field payload before it reaches disk (tmp JSON) or
// EmrHelper.exe. Extracted so it's unit-testable without ipcMain/fs mocks
// (see migrationGate.js precedent).

const VALID_SOURCES = new Set(['auto', 'edited']);

function splitInjectPayload(fieldData) {
  if (!fieldData || typeof fieldData !== 'object') {
    return { emrFields: fieldData, source: undefined };
  }
  const { _source, ...emrFields } = fieldData;
  if (_source === undefined) return { emrFields, source: undefined };
  return { emrFields, source: VALID_SOURCES.has(_source) ? _source : 'auto' };
}

module.exports = { splitInjectPayload };
