'use strict';
// electron/auditQueue.js
// Encrypted local queue for EMR audit entries that couldn't be sent immediately.
// Each line is an independently-encrypted JSON entry (enc:<base64> or raw:<base64>).
// Processed FIFO; corrupt file is renamed and a fresh queue is started.
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

function queueFile() {
  return path.join(app.getPath('userData'), 'audit-emr-pending.enc');
}

// ── Encryption helpers ───────────────────────────────────────────────────────
// Fail-closed: if safeStorage is unavailable, entries are dropped rather than
// written as plaintext. On Windows (the EMR target platform), safeStorage is
// always available, so this guard is belt-and-suspenders.

function encryptLine(plaintext) {
  return 'enc:' + safeStorage.encryptString(plaintext).toString('base64');
}

function decryptLine(line) {
  if (line.startsWith('enc:')) {
    return safeStorage.decryptString(Buffer.from(line.slice(4), 'base64'));
  }
  throw new Error('unknown line format — expected enc: prefix');
}

// ── Public API ───────────────────────────────────────────────────────────────

function enqueue(entry) {
  if (!safeStorage.isEncryptionAvailable()) {
    console.error('[auditQueue] safeStorage unavailable — entry dropped (fail-closed):', entry.action);
    return;
  }
  try {
    fs.appendFileSync(queueFile(), encryptLine(JSON.stringify(entry)) + '\n', 'utf-8');
  } catch (err) {
    console.error('[auditQueue] enqueue failed:', err.message);
  }
}

// Returns true if the queue file exists and ANY line fails to decrypt/parse.
function checkCorrupt() {
  const file = queueFile();
  if (!fs.existsSync(file)) return false;
  try {
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      JSON.parse(decryptLine(line));
    }
    return false;
  } catch {
    return true;
  }
}

// Rename corrupt queue file, return the basename of the renamed file.
function handleCorrupt() {
  const file = queueFile();
  const ts = Date.now();
  const corruptName = `audit-emr-pending-corrupt-${ts}.bin`;
  const corruptFile = path.join(app.getPath('userData'), corruptName);
  try {
    if (fs.existsSync(file)) fs.renameSync(file, corruptFile);
  } catch (err) {
    console.error('[auditQueue] handleCorrupt rename failed:', err.message);
  }
  return corruptName;
}

// Try to send every queued entry via sendFn. Remove successfully sent entries.
// sendFn(entry) must throw on failure (rejected promise counts as failure).
async function flush(sendFn) {
  const file = queueFile();
  if (!fs.existsSync(file)) return;

  let lines;
  try {
    lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
  } catch (err) {
    console.error('[auditQueue] flush: read error:', err.message);
    return;
  }

  if (!lines.length) {
    try { fs.unlinkSync(file); } catch {}
    return;
  }

  const remaining = [];
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(decryptLine(line));
    } catch {
      remaining.push(line); // decrypt/parse failure → keep (caller should checkCorrupt first)
      continue;
    }
    try {
      await sendFn(entry);
    } catch {
      remaining.push(line);
    }
  }

  if (!remaining.length) {
    try { fs.unlinkSync(file); } catch {}
  } else {
    try { fs.writeFileSync(file, remaining.join('\n') + '\n', 'utf-8'); } catch {}
  }
}

module.exports = { enqueue, flush, checkCorrupt, handleCorrupt };
