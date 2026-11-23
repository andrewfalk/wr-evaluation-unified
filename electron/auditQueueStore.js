'use strict';
// electron/auditQueueStore.js
// 보내지 못한 EMR 감사 기록의 로컬 대기열(파일 한 줄 = 따로 암호화한 JSON 항목 `enc:<base64>`). electron 모듈을
// require하지 않는다 — 파일 위치와 암호화 함수는 연결부(auditQueue.js)가 넘긴다(app.getPath·safeStorage).
//
// 재전송 회차(flush)의 규칙
// - 한 번에 한 회차(같은 프로세스 안의 재진입은 바로 끝난다). 회차당 보낼 수 있는 줄 수에 상한이 있다.
// - 각 줄의 결과는 sendFn이 분류해 돌려준다: 'ok'(지운다) · 'quarantine'(그 줄만의 문제 — 격리 파일로 옮기고 다음 줄로)
//   · 'stop'(회차를 멈추고 이 줄과 나머지를 남긴다). 복호화·해석이 안 되는 줄은 그 줄만 격리한다.
// - 회차 끝에 "파일 다시 읽기 → 처리한 줄만 빼고 임시 파일에 쓰기 → 이름 바꾸기"를 await 없는 동기 구간으로 한다. 항목 추가
//   (enqueue)도 동기라 같은 프로세스 안에서는 끼어들 수 없고, 다른 프로세스(같은 프로필의 다른 셸)와는 잠금 파일로 나눈다.
//   그래서 전송 중에 추가된 줄은 지워지지 않는다.
// - 원본을 잘라 쓰지 않는다. 이름 바꾸기가 실패하면 원본을 그대로 두고, 이미 처리한 줄은 기억해 다음 회차에 다시 보내지 않는다
//   (프로세스가 다시 시작되면 한 번 더 나갈 수 있다 — 이 설치본의 항목은 eventId로 알아볼 수 있다). 시작할 때 남은 임시 파일은 버린다.
// - 대기열을 크기 때문에 버리지 않는다(임계를 넘으면 로그만).
const path = require('path');
const nodeFs = require('fs');

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const LARGE_QUEUE_LINES = 5000;

/**
 * @param {{
 *   file: string,
 *   isEncryptionAvailable: () => boolean,
 *   encryptString: (plain: string) => Buffer,
 *   decryptString: (cipher: Buffer) => string,
 *   now?: () => number,
 *   log?: { error: Function, warn: Function },
 *   fs?: typeof import('fs'),            // 시험에서 실패를 흉내 낼 때
 * }} options
 */
function createAuditQueueStore(options) {
  const { file, isEncryptionAvailable, encryptString, decryptString } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? console;
  const fs = options.fs ?? nodeFs;
  const dir = path.dirname(file);
  const tempFile = `${file}.tmp`;
  const lockFile = `${file}.lock`;
  const quarantineFile = path.join(dir, 'audit-emr-quarantine.enc');

  let flushing = false;
  // 보냈거나 격리했지만 파일에서 아직 빼지 못한 줄(이름 바꾸기 실패) — 다음 회차에 건너뛴다.
  const doneButNotRemoved = new Map(); // line → 남은 개수
  let warnedLarge = false;

  // 시작할 때 남아 있는 임시 파일은 버린다(원본이 기준).
  try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { /* 다음 시작 때 다시 */ }

  // ── 잠금(같은 프로필의 다른 프로세스와 추가·제거를 나눈다) ───────────────────

  function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  /** 잠금을 잡으면 true. 오래된 잠금(LOCK_STALE_MS)은 넘겨받는다. LOCK_WAIT_MS 안에 못 잡으면 false. */
  function acquireLock() {
    const deadline = now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        const fd = fs.openSync(lockFile, 'wx');
        try { fs.writeSync(fd, `${process.pid} ${now()}`); } finally { fs.closeSync(fd); }
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') return false;
        try {
          if (now() - fs.statSync(lockFile).mtimeMs > LOCK_STALE_MS) { fs.unlinkSync(lockFile); continue; }
        } catch { continue; } // 그사이 풀렸다
        if (now() >= deadline) return false;
        sleepSync(10);
      }
    }
  }

  function releaseLock() {
    try { fs.unlinkSync(lockFile); } catch { /* 이미 없음 */ }
  }

  function withLock(fn) {
    const locked = acquireLock();
    if (!locked) log.warn('[auditQueue] queue lock not acquired — continuing without it');
    try {
      return fn();
    } finally {
      if (locked) releaseLock();
    }
  }

  // ── 줄 ─────────────────────────────────────────────────────────────────────

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

  function readLines() {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim());
  }

  function enqueue(entry) {
    if (!isEncryptionAvailable()) {
      log.error('[auditQueue] safeStorage unavailable — entry dropped (fail-closed):', entry.action);
      return;
    }
    let line;
    try {
      line = encryptLine(JSON.stringify(entry)) + '\n';
    } catch (err) {
      log.error('[auditQueue] enqueue failed:', err.message);
      return;
    }
    withLock(() => {
      try {
        fs.appendFileSync(file, line, 'utf-8');
      } catch (err) {
        log.error('[auditQueue] enqueue failed:', err.message);
      }
    });
  }

  function pendingCount() {
    try { return readLines().length; } catch { return 0; }
  }

  // ── 회차 끝: 처리한 줄만 빼고 바꿔 쓴다(동기 구간) ────────────────────────────

  /** processed: 지울 줄(보냄·격리) 목록(같은 줄이 여러 번이면 그 횟수만큼). 성공하면 true. */
  function removeProcessed(processed) {
    if (processed.length === 0) return true;
    return withLock(() => {
      let lines;
      try {
        lines = readLines();
      } catch (err) {
        log.error('[auditQueue] flush: re-read failed:', err.message);
        return false;
      }
      const toRemove = new Map();
      for (const l of processed) toRemove.set(l, (toRemove.get(l) ?? 0) + 1);
      const keep = [];
      for (const l of lines) {
        const n = toRemove.get(l) ?? 0;
        if (n > 0) toRemove.set(l, n - 1);
        else keep.push(l);
      }
      try {
        if (keep.length === 0) {
          if (fs.existsSync(file)) fs.unlinkSync(file);
        } else {
          fs.writeFileSync(tempFile, keep.join('\n') + '\n', 'utf-8');
          fs.renameSync(tempFile, file);
        }
        return true;
      } catch (err) {
        log.error('[auditQueue] flush: replace failed, original kept:', err.message);
        try { if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile); } catch { /* 다음 시작 때 버린다 */ }
        return false;
      }
    });
  }

  function quarantine(line) {
    try {
      fs.appendFileSync(quarantineFile, line + '\n', 'utf-8');
      return true;
    } catch (err) {
      log.error('[auditQueue] quarantine write failed:', err.message);
      return false;
    }
  }

  /** 보내지 않고 바로 격리할 항목(즉시 전송이 그 항목만의 문제로 거부된 경우). */
  function quarantineEntry(entry) {
    if (!isEncryptionAvailable()) return false;
    try {
      return quarantine(encryptLine(JSON.stringify(entry)));
    } catch (err) {
      log.error('[auditQueue] quarantine failed:', err.message);
      return false;
    }
  }

  function takeDone(line) {
    const n = doneButNotRemoved.get(line) ?? 0;
    if (n === 0) return false;
    if (n === 1) doneButNotRemoved.delete(line); else doneButNotRemoved.set(line, n - 1);
    return true;
  }

  /**
   * 한 회차. sendFn(entry) → 'ok' | 'quarantine' | 'stop'(던지면 'stop'). options: { maxPerRound, gapMs, sleep }.
   * @returns {Promise<{ skipped?: true, sent: number, quarantined: { corrupt: number, rejected: number }, stopped: boolean, remaining: number }>}
   */
  async function flush(sendFn, opts = {}) {
    const result = { sent: 0, quarantined: { corrupt: 0, rejected: 0 }, stopped: false, remaining: 0 };
    if (flushing) return { ...result, skipped: true };
    flushing = true;
    try {
      const maxPerRound = opts.maxPerRound ?? Infinity;
      const gapMs = opts.gapMs ?? 0;
      const sleep = opts.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));

      let lines;
      try {
        lines = withLock(() => readLines());
      } catch (err) {
        log.error('[auditQueue] flush: read error:', err.message);
        return result;
      }
      if (lines.length > LARGE_QUEUE_LINES && !warnedLarge) {
        warnedLarge = true;
        log.warn('[auditQueue] large queue:', lines.length, 'lines');
      }

      const processed = [];
      // 이전 회차에 처리했지만 아직 파일에서 빼지 못한 줄은 보내지 않고 이번에 다시 뺀다.
      const pending = [];
      for (const line of lines) {
        if (takeDone(line)) processed.push(line);
        else pending.push(line);
      }

      let attempts = 0;
      for (const line of pending) {
        if (attempts >= maxPerRound) break;
        let entry;
        try {
          entry = JSON.parse(decryptLine(line));
        } catch {
          if (quarantine(line)) {
            processed.push(line);
            result.quarantined.corrupt += 1;
          }
          continue;
        }
        if (attempts > 0 && gapMs > 0) await sleep(gapMs);
        attempts += 1;
        let outcome;
        try {
          outcome = await sendFn(entry);
        } catch {
          outcome = 'stop';
        }
        if (outcome === 'ok') {
          processed.push(line);
          result.sent += 1;
        } else if (outcome === 'quarantine') {
          if (quarantine(line)) {
            processed.push(line);
            result.quarantined.rejected += 1;
          }
        } else {
          result.stopped = true;
          break;
        }
      }

      if (!removeProcessed(processed)) {
        for (const l of processed) doneButNotRemoved.set(l, (doneButNotRemoved.get(l) ?? 0) + 1);
      }
      result.remaining = Math.max(0, pendingCount() - [...doneButNotRemoved.values()].reduce((a, b) => a + b, 0));
      return result;
    } finally {
      flushing = false;
    }
  }

  return { enqueue, quarantineEntry, flush, pendingCount, quarantineFileName: path.basename(quarantineFile) };
}

module.exports = { createAuditQueueStore, LOCK_STALE_MS };
