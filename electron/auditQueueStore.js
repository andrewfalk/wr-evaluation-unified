'use strict';
// electron/auditQueueStore.js
// 보내지 못한 EMR 감사 기록의 로컬 대기열(파일 한 줄 = 따로 암호화한 JSON 항목 `enc:<base64>`). electron 모듈을
// require하지 않는다 — 파일 위치와 암호화 함수는 연결부(auditQueue.js)가 넘긴다(app.getPath·safeStorage).
const path = require('path');
const fs = require('fs');

/**
 * @param {{
 *   file: string,                                  대기열 파일 경로
 *   isEncryptionAvailable: () => boolean,
 *   encryptString: (plain: string) => Buffer,
 *   decryptString: (cipher: Buffer) => string,
 *   now?: () => number,
 *   log?: { error: (...a: unknown[]) => void },
 * }} options
 */
function createAuditQueueStore(options) {
  const { file, isEncryptionAvailable, encryptString, decryptString } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? console;

  // 실패하면 평문으로 쓰지 않고 버린다(fail-closed). Windows(EMR 대상)에서는 항상 쓸 수 있다.
  function encryptLine(plaintext) {
    return 'enc:' + encryptString(plaintext).toString('base64');
  }

  function decryptLine(line) {
    if (line.startsWith('enc:')) {
      return decryptString(Buffer.from(line.slice(4), 'base64'));
    }
    throw new Error('unknown line format — expected enc: prefix');
  }

  function enqueue(entry) {
    if (!isEncryptionAvailable()) {
      log.error('[auditQueue] safeStorage unavailable — entry dropped (fail-closed):', entry.action);
      return;
    }
    try {
      fs.appendFileSync(file, encryptLine(JSON.stringify(entry)) + '\n', 'utf-8');
    } catch (err) {
      log.error('[auditQueue] enqueue failed:', err.message);
    }
  }

  // 파일이 있고 한 줄이라도 복호화·해석에 실패하면 true.
  function checkCorrupt() {
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

  // 손상된 대기열 파일의 이름을 바꾸고 새 이름(basename)을 돌려준다.
  function handleCorrupt() {
    const corruptName = `audit-emr-pending-corrupt-${now()}.bin`;
    const corruptFile = path.join(path.dirname(file), corruptName);
    try {
      if (fs.existsSync(file)) fs.renameSync(file, corruptFile);
    } catch (err) {
      log.error('[auditQueue] handleCorrupt rename failed:', err.message);
    }
    return corruptName;
  }

  // 대기열의 모든 항목을 sendFn으로 보낸다. 성공한 항목만 지운다. sendFn은 실패하면 throw(reject)해야 한다.
  async function flush(sendFn) {
    if (!fs.existsSync(file)) return;

    let lines;
    try {
      lines = fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
    } catch (err) {
      log.error('[auditQueue] flush: read error:', err.message);
      return;
    }

    if (!lines.length) {
      try { fs.unlinkSync(file); } catch { /* 이미 없음 */ }
      return;
    }

    const remaining = [];
    for (const line of lines) {
      let entry;
      try {
        entry = JSON.parse(decryptLine(line));
      } catch {
        remaining.push(line); // 복호화·해석 실패 → 남긴다(호출부가 먼저 checkCorrupt)
        continue;
      }
      try {
        await sendFn(entry);
      } catch {
        remaining.push(line);
      }
    }

    if (!remaining.length) {
      try { fs.unlinkSync(file); } catch { /* 이미 없음 */ }
    } else {
      try { fs.writeFileSync(file, remaining.join('\n') + '\n', 'utf-8'); } catch { /* 다음 회차에 다시 */ }
    }
  }

  return { enqueue, flush, checkCorrupt, handleCorrupt };
}

module.exports = { createAuditQueueStore };
