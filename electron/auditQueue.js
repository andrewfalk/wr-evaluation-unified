'use strict';
// electron/auditQueue.js
// Encrypted local queue for EMR audit entries that couldn't be sent immediately — Electron wiring only:
// the file lives in userData and lines are encrypted with safeStorage. Logic: auditQueueStore.js.
const { app, safeStorage } = require('electron');
const path = require('path');
const { createAuditQueueStore } = require('./auditQueueStore');

let _store = null;
function store() {
  if (!_store) {
    _store = createAuditQueueStore({
      file: path.join(app.getPath('userData'), 'audit-emr-pending.enc'),
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: (plain) => safeStorage.encryptString(plain),
      decryptString: (cipher) => safeStorage.decryptString(cipher),
    });
  }
  return _store;
}

module.exports = {
  enqueue:       (entry) => store().enqueue(entry),
  flush:         (sendFn) => store().flush(sendFn),
  checkCorrupt:  () => store().checkCorrupt(),
  handleCorrupt: () => store().handleCorrupt(),
};
