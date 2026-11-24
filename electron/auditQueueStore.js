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
//   그래서 전송 중에 추가된 줄은 지워지지 않는다. 대기열 파일은 잠금을 잡았을 때만 바꾼다 — 잠금을 못 잡은 추가는 항목마다
//   보조 파일(audit-emr-pending.spool-*.enc, 완성된 뒤 게시)로 남기고, 다음 회차가 잠금 아래에서 대기열 파일로 옮긴다. 잠금을
//   못 잡은 교체는 다음 회차로 미룬다. 잠금을 잡았어도 대기열 파일에 쓰지 못한 추가는 보조 파일로 남긴다. 회차 끝의 교체는
//   그때 실제로 읽은 줄에 근거해서만 하고, 읽지 못하면(파일 없음이 아닌 읽기 오류) 다음 회차로 미룬다.
// - 원본을 잘라 쓰지 않는다. 이름 바꾸기가 실패하면 원본을 그대로 두고, 이미 처리한 줄은 기억해 다음 회차에 다시 보내지 않는다
//   (프로세스가 다시 시작되면 한 번 더 나갈 수 있다 — 이 설치본의 항목은 eventId로 알아볼 수 있다). 시작할 때 남은 임시 파일은 버린다.
// - 대기열을 크기 때문에 버리지 않는다(임계를 넘으면 로그만).
const path = require('path');
const nodeFs = require('fs');
const crypto = require('crypto');

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;
const RECLAIM_GENERATIONS = 8;
const RECLAIM_LEFTOVER_MS = 60_000;
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
  // 넘겨받던 도중에 끝난 프로세스가 남긴 넘겨받기 표식도 버린다(충분히 오래된 것만).
  try {
    const reclaimBase = `${path.basename(lockFile)}.reclaim-`;
    for (const name of fs.readdirSync(dir).filter(n => n.startsWith(reclaimBase))) {
      const full = path.join(dir, name);
      try { if (now() - fs.statSync(full).mtimeMs > RECLAIM_LEFTOVER_MS) fs.unlinkSync(full); } catch { /* 다음 시작 때 다시 */ }
    }
  } catch { /* 폴더를 못 읽으면 다음 시작 때 */ }

  // ── 잠금(같은 프로필의 다른 프로세스와 추가·제거를 나눈다) ───────────────────

  function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  // 잠금 파일 내용 = "<pid>:<무작위 표식>". 잠금을 잡은 프로세스가 그 표식을 기억해, 풀 때 자기 잠금만 지운다.
  // 넘겨받기: 잠금을 잡은 프로세스가 더는 없거나(pid 확인) 잠금이 LOCK_STALE_MS보다 오래된 경우에만. 확인한 그 잠금(내용·수정
  // 시각)마다 넘겨받기 표식 파일을 원자적으로 만들고(이미 있으면 실패), 표식을 만든 프로세스만 잠금이 아직 확인한 그대로인지 다시
  // 보고 지운다. 잠금 파일을 옮기거나 되돌려 놓지 않으므로, 그사이 다른 프로세스가 만든 새 잠금을 옮기거나 지우는 일이 없다.
  // 표식은 지운 뒤 없앤다 — 늦게 온 프로세스가 같은 표식을 다시 만들어도 잠금이 이미 바뀌어 있어 아무것도 지우지 않는다.
  // 표식을 만든 프로세스가 도중에 끝나 표식이 남으면, LOCK_STALE_MS가 지난 뒤 다음 세대 표식으로 넘어간다.
  let lockToken = null;
  let seq = 0;

  function processGone(pidText) {
    const pid = Number(pidText);
    if (!Number.isInteger(pid) || pid <= 0) return true;
    if (pid === process.pid) return false;
    try { process.kill(pid, 0); return false; } catch (err) { return err.code === 'ESRCH'; }
  }

  function reclaimFileName(seen, mtimeMs, gen) {
    const key = crypto.createHash('sha256').update(`${seen}\n${mtimeMs}`).digest('hex').slice(0, 24);
    return `${lockFile}.reclaim-${key}-${gen}`;
  }

  function tryTakeOver(seen, mtimeMs) {
    for (let gen = 0; gen < RECLAIM_GENERATIONS; gen += 1) {
      const claim = reclaimFileName(seen, mtimeMs, gen);
      const published = publishFile(claim, `${process.pid}:${now()}`);
      if (published === 'created') {
        try {
          const st = fs.statSync(lockFile);
          if (st.mtimeMs === mtimeMs && fs.readFileSync(lockFile, 'utf-8') === seen) fs.unlinkSync(lockFile);
        } catch { /* 그사이 풀렸거나 지울 수 없다 — 아래에서 다시 */ }
        try { fs.unlinkSync(claim); } catch { /* 시작할 때 정리 */ }
        return;
      }
      if (published !== 'exists') return;
      // 다른 프로세스가 넘겨받는 중이다. 그 표식이 오래됐을 때만(그 프로세스가 도중에 끝남) 다음 세대로.
      let claimAge = 0;
      try { claimAge = now() - fs.statSync(claim).mtimeMs; } catch { return; }
      if (claimAge <= LOCK_STALE_MS) return;
    }
  }

  // 파일을 원자적으로 게시한다: 내용을 다 쓴 임시 파일을 그 이름에 하드 링크로 건다(이미 있으면 실패) — 잠금 파일은 처음부터
  // 표식을 담고 있어 "막 만들어진 빈 잠금"이 없다. 'created' | 'exists' | 'error'.
  function publishFile(target, content) {
    const tmp = `${lockFile}.${process.pid}-${(seq += 1)}.tmp`;
    try {
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.linkSync(tmp, target);
      return 'created';
    } catch (err) {
      return err.code === 'EEXIST' ? 'exists' : 'error';
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 이미 없음 */ }
    }
  }

  /** 잠금을 잡으면 true. LOCK_WAIT_MS 안에 못 잡으면 false — 어느 경로로 실패해도 제한 시간 안에 끝난다. */
  function acquireLock() {
    const deadline = now() + LOCK_WAIT_MS;
    const token = `${process.pid}:${Math.random().toString(36).slice(2)}${now().toString(36)}`;
    for (;;) {
      const published = publishFile(lockFile, token);
      if (published === 'created') {
        lockToken = token;
        return true;
      }
      if (published === 'exists') {
        let seen = null;
        let mtimeMs = 0;
        try {
          seen = fs.readFileSync(lockFile, 'utf-8');
          mtimeMs = fs.statSync(lockFile).mtimeMs;
        } catch { seen = null; /* 그사이 풀렸다 — 아래에서 다시 */ }
        const age = now() - mtimeMs;
        const owner = seen ? seen.split(':')[0] : '';
        // 표식이 없는 잠금(이전 형식 등)은 오래됐을 때만, 표식이 있으면 그 프로세스가 없거나 오래됐을 때 넘겨받는다.
        if (seen !== null && ((owner && processGone(owner)) || age > LOCK_STALE_MS)) tryTakeOver(seen, mtimeMs);
      }
      if (now() >= deadline) return false;
      sleepSync(10);
    }
  }

  function releaseLock() {
    try {
      if (lockToken && fs.readFileSync(lockFile, 'utf-8') === lockToken) fs.unlinkSync(lockFile);
    } catch { /* 이미 없음 */ }
    lockToken = null;
  }

  /** 잠금을 잡았을 때만 fn을 실행한다. 못 잡으면 fallback()(없으면 undefined). */
  function withLock(fn, fallback) {
    if (!acquireLock()) {
      log.warn('[auditQueue] queue lock not acquired');
      return fallback ? fallback() : undefined;
    }
    try {
      return fn();
    } finally {
      releaseLock();
    }
  }

  // 잠금을 못 잡은 추가는 항목마다 따로 게시하는 보조 파일(spool)에 쓴다: 임시 이름으로 다 쓴 뒤 이름을 바꿔 게시하므로 게시된
  // 파일은 완성돼 있고 다시 바뀌지 않는다. 다음 회차가 잠금 아래에서 게시된 파일을 대기열 파일로 옮긴다.
  const spoolBase = `${path.basename(file, '.enc')}.spool-`;
  const SPOOL_ORPHAN_MS = 60 * 1000; // 게시 전에 프로세스가 끝나 남은 임시 파일(완성된 줄이면 옮긴다)

  function spool(line) {
    const name = `${spoolBase}${process.pid}-${now()}-${(seq += 1)}`;
    const tmp = path.join(dir, `${name}.tmp`);
    fs.writeFileSync(tmp, line, 'utf-8');
    fs.renameSync(tmp, path.join(dir, `${name}.enc`));
  }

  // 잠금 아래에서: 게시된 보조 파일의 줄을 대기열 파일 끝에 옮기고 지운다.
  function mergeSpool() {
    let names;
    try { names = fs.readdirSync(dir).filter(n => n.startsWith(spoolBase)); } catch { return; }
    for (const name of names.sort()) {
      const p = path.join(dir, name);
      try {
        if (name.endsWith('.tmp')) {
          if (now() - fs.statSync(p).mtimeMs < SPOOL_ORPHAN_MS) continue; // 다른 프로세스가 쓰는 중일 수 있다
        } else if (!name.endsWith('.enc')) {
          continue;
        }
        const content = fs.readFileSync(p, 'utf-8');
        const lines = content.split('\n').filter(l => l.trim() && (!name.endsWith('.tmp') || content.endsWith('\n')));
        if (lines.length) appendLines(file, lines.join('\n') + '\n');
        fs.unlinkSync(p);
      } catch (err) {
        log.error('[auditQueue] spool merge failed:', err.message);
      }
    }
  }

  // ── 줄 ─────────────────────────────────────────────────────────────────────

  // 파일 끝이 줄바꿈이 아니면(이전 덧붙이기가 도중에 실패해 조각이 남았으면) 줄바꿈부터 쓴다 — 새 줄이 그 조각에 붙어
  // 함께 읽을 수 없게 되지 않도록(조각은 그 줄만 격리된다).
  function appendLines(target, text) {
    let prefix = '';
    try {
      const size = fs.statSync(target).size;
      if (size > 0) {
        const fd = fs.openSync(target, 'r');
        try {
          const last = Buffer.alloc(1);
          fs.readSync(fd, last, 0, 1, size - 1);
          if (last[0] !== 0x0a) prefix = '\n';
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    fs.appendFileSync(target, prefix + text, 'utf-8');
  }

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

  // 대기열 파일의 줄. 파일이 없으면(ENOENT) 빈 목록, 그 밖의 읽기 오류(접근 거부·사용 중 등)는 던진다 — 호출한 쪽이
  // 이번 회차를 미룬다. 존재 확인(existsSync)은 접근 오류도 "없음"으로 돌려주므로 쓰지 않는다.
  function readLines() {
    let content;
    try {
      content = fs.readFileSync(file, 'utf-8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return content.split('\n').filter(l => l.trim());
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
    const toSpool = () => {
      try {
        spool(line);
      } catch (err) {
        log.error('[auditQueue] enqueue (spool) failed:', err.message);
      }
    };
    // 잠금을 잡았든 못 잡았든, 대기열 파일에 쓰지 못한 기록은 보조 파일로 남는다(다음 회차가 옮긴다). 덧붙이기가 도중에
    // 끊겨 대기열 파일에 조각이 남아도 그 조각은 따로 읽혀 그 줄만 격리된다(appendLines).
    withLock(() => {
      try {
        appendLines(file, line);
      } catch (err) {
        log.warn('[auditQueue] enqueue: queue file not writable, keeping the entry in a spool file:', err.message);
        toSpool();
      }
    }, toSpool);
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
      // 이번에 실제로 읽은 줄에 근거해서만 파일을 바꾼다 — 한 줄도 없으면(파일이 없거나 비어 있음) 건드리지 않는다.
      if (lines.length === 0) return true;
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
          fs.unlinkSync(file);
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
    }, () => false); // 잠금을 못 잡으면 바꾸지 않는다(다음 회차)
  }

  function quarantine(line) {
    try {
      appendLines(quarantineFile, line + '\n');
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
        lines = withLock(() => { mergeSpool(); return readLines(); }, () => null);
      } catch (err) {
        log.error('[auditQueue] flush: read error:', err.message);
        return result;
      }
      if (lines === null) return { ...result, skipped: true }; // 잠금을 못 잡음 — 다음 회차
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
