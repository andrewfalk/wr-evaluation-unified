'use strict';
// electron/audit.js
// Device key management, Ed25519 signing, and EMR audit submission — Electron wiring (userData files,
// safeStorage, net.request). Decisions live in auditLogic.js (no electron dependency, unit-tested).
// Requires initAudit() to be called from app.whenReady().
const { app, net, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { enqueue, flush, checkCorrupt, handleCorrupt } = require('./auditQueue');
const { mustChangePassword, readTokenIdentity } = require('./accessTokenClaims');
const {
  REQUEST_TIMEOUT_MS,
  buildSignedAuditRequest,
  interpretHttpResponse,
  isTokenExpiryError,
  createAuditContext,
  stampEntry,
  forQueuedSend,
} = require('./auditLogic');
const {
  REGISTER_MIN_SPACING_MS,
  interpretRegisterResult,
  applyRegisterOutcome,
  emrGateDecision,
  sendingAllowed,
  shouldRegister,
} = require('./deviceState');

// ── Module state ─────────────────────────────────────────────────────────────

let _state = {
  deviceId:     null,
  privateKey:   null, // crypto.KeyObject
  publicKeyB64: null, // raw 32-byte Ed25519 public key, base64
  status:       'unregistered', // 'unregistered' | 'pending' | 'active' | 'error'
};
let _meta = null;          // wr-device.json as last read/written by this process
let _getAccessToken = () => null;
let _apiBaseUrl = '';
let _registerAttempts = [];  // registration calls of this process (ms)
let _freshProcess = true;    // no answer to a registration call yet in this process
let _deviceProblem = false;  // an audit send was refused for a device problem
let _deviceProblemSeq = 0;   // counts those refusals, so an answer to a call that started earlier does not clear a newer one
let _checkedOrgId;           // login organisation of the last answer in this process (undefined until the first)

// ── File helpers ─────────────────────────────────────────────────────────────

function metaPath() { return path.join(app.getPath('userData'), 'wr-device.json'); }
function keyPath()  { return path.join(app.getPath('userData'), 'wr-device-key.enc'); }

function loadMeta() {
  try { return JSON.parse(fs.readFileSync(metaPath(), 'utf-8')); } catch { return null; }
}

function saveMeta(meta) {
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2), 'utf-8');
}

// Saves PKCS8 DER private key encrypted by safeStorage (fail-closed: throws if unavailable).
function savePrivateKey(pkcs8Der) {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('safeStorage unavailable — cannot encrypt device private key');
  }
  const b64 = pkcs8Der.toString('base64');
  fs.writeFileSync(keyPath(), 'enc:' + safeStorage.encryptString(b64).toString('base64'), 'utf-8');
}

function loadPrivateKey() {
  if (!fs.existsSync(keyPath())) return null;
  try {
    const content = fs.readFileSync(keyPath(), 'utf-8');
    if (!content.startsWith('enc:')) return null; // reject non-encrypted key files
    const b64 = safeStorage.decryptString(Buffer.from(content.slice(4), 'base64'));
    return crypto.createPrivateKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'pkcs8' });
  } catch { return null; }
}

// ── Device initialisation ────────────────────────────────────────────────────

// Load existing device or generate a new Ed25519 key pair.
// Returns true if a new device was created.
function initDevice() {
  const meta      = loadMeta();
  const privateKey = meta ? loadPrivateKey() : null;

  if (meta?.deviceId && privateKey) {
    _meta = meta;
    _state = {
      deviceId:     meta.deviceId,
      privateKey,
      publicKeyB64: meta.publicKeyB64,
      status:       meta.status || 'pending',
    };
    return false; // existing device
  }

  const { publicKey, privateKey: pk } = crypto.generateKeyPairSync('ed25519');
  // Ed25519 SPKI DER is 44 bytes: 12-byte header + 32-byte raw key.
  const spkiDer      = publicKey.export({ type: 'spki', format: 'der' });
  const publicKeyB64 = spkiDer.slice(12).toString('base64');
  const pkcs8Der     = pk.export({ type: 'pkcs8', format: 'der' });
  const deviceId     = crypto.randomUUID();

  savePrivateKey(pkcs8Der);
  _meta = { deviceId, publicKeyB64, status: 'unregistered' };
  saveMeta(_meta);

  _state = { deviceId, privateKey: pk, publicKeyB64, status: 'unregistered' };
  return true;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

// One request, with a time limit (a request that does not finish in REQUEST_TIMEOUT_MS is aborted and fails
// like a network error) — so a registration call that never answers cannot hold _registering forever.
function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const req = net.request({ url, method: 'POST' });
    const timer = setTimeout(() => {
      try { req.abort(); } catch { /* 이미 끝남 */ }
      finish(reject, new Error('request timeout'));
    }, REQUEST_TIMEOUT_MS);
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, String(v));
    req.on('response', res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('error', err => finish(reject, err));
      res.on('end', () => {
        const result = interpretHttpResponse(res.statusCode, data);
        if (result instanceof Error) finish(reject, result);
        else finish(resolve, result);
      });
    });
    req.on('error', err => finish(reject, err));
    req.write(body);
    req.end();
  });
}

// ── Device registration (approval state) ─────────────────────────────────────
//
// When to call the registration API and what its answer does: deviceState.js. In short —
//  - right after the first token of this process, when the login organisation changes, and after an audit send
//    was refused for a device problem (never more often than the server's registration limits allow);
//  - an answer from a server that works per PC (deviceScope: 'pc') is stored as is (pc field) and from then on
//    the EMR gate opens only for that organisation's logins while the PC is active there;
//  - an older server's answer can raise the profile-wide status to active but never lowers it;
//  - a failed call changes nothing.

let _registering = false;
let _askAgain = false; // tryRegister was called while a call was in flight
let _retryTimer = null;
const QUICK_RETRY_REASONS = new Set(['first_token', 'org_changed', 'device_problem']);

function currentLogin() {
  const token = _getAccessToken();
  return token ? readTokenIdentity(token) : null;
}

function emrGate() {
  return emrGateDecision(_meta, currentLogin(), _state.status);
}

// A short retry while the first answer (or the answer for a new login organisation) is still missing.
function scheduleRetry() {
  if (_retryTimer) return;
  _retryTimer = setTimeout(() => {
    _retryTimer = null;
    tryRegister().catch(e => console.error('[audit] register retry:', e.message));
  }, REGISTER_MIN_SPACING_MS + 1000);
  if (typeof _retryTimer.unref === 'function') _retryTimer.unref();
}

async function tryRegister() {
  const token = _getAccessToken();
  if (!token || !_state.publicKeyB64 || !_apiBaseUrl) return emrGate().allowed;

  // 임시 비밀번호 상태의 토큰은 서버가 /api/devices/register를 403으로 거절한다. 그 요청이 인증 앞단의 IP 제한
  // (분당 1회)을 소비하면, 비밀번호를 바꾼 직후의 첫 등록이 429를 받아 EMR이 잠긴다.
  // 그래서 요청 자체를 보내지 않는다 — 비밀번호 변경 후 새 토큰으로 setAccessToken이 다시 불리면 그때 첫 등록이 나간다.
  if (mustChangePassword(token)) return emrGate().allowed;
  const login = readTokenIdentity(token);
  if (!login) return emrGate().allowed;
  if (_registering) {
    // A call is in flight (perhaps for another login): look again once it has answered, within the limits.
    _askAgain = true;
    return emrGate().allowed;
  }

  const now = Date.now();
  _registerAttempts = _registerAttempts.filter(t => now - t < 60 * 60 * 1000);
  const decision = shouldRegister({
    meta: _meta, login, startedFresh: _freshProcess, deviceProblem: _deviceProblem, checkedOrgId: _checkedOrgId,
    attempts: _registerAttempts,
  }, now);
  if (!decision.register) {
    if (decision.reason && QUICK_RETRY_REASONS.has(decision.reason)) scheduleRetry();
    return emrGate().allowed;
  }

  _registerAttempts.push(now);
  const problemSeqAtStart = _deviceProblemSeq;
  _registering = true;
  let result;
  try {
    const { status, data } = await httpPost(
      `${_apiBaseUrl}/api/devices/register`,
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      JSON.stringify({ publicKey: _state.publicKeyB64, buildTarget: 'intranet' })
    );
    result = { ok: true, status, data };
  } catch (err) {
    result = { ok: false, err };
  } finally {
    _registering = false;
  }

  const outcome = interpretRegisterResult(result);
  // Called again while this call was in flight, or the login changed organisation meanwhile: ask again (scheduled,
  // so the spacing between calls holds); shouldRegister decides then whether it is still needed.
  const loginNow = currentLogin();
  if (_askAgain || (loginNow && loginNow.orgId !== login.orgId)) scheduleRetry();
  _askAgain = false;
  if (outcome.kind === 'pc' || outcome.kind === 'legacy') {
    _freshProcess = false;
    _checkedOrgId = login.orgId;
    // A device refusal that came in while this call was in flight is not answered by it — ask again (within limits).
    if (_deviceProblemSeq === problemSeqAtStart) _deviceProblem = false;
    else scheduleRetry();
    const next = applyRegisterOutcome(_meta, outcome, Date.now());
    if (next !== _meta) {
      _meta = next;
      saveMeta(_meta);
    }
    if (_meta.status === 'active') _state.status = 'active';
    else if (_state.status !== 'active') _state.status = _meta.status || 'pending';
    console.log('[audit] device registration:', outcome.kind === 'pc' ? `${outcome.status} (per PC)` : outcome.status);
  } else {
    if (outcome.kind === 'retry_later') console.warn('[audit] tryRegister rate-limited, will retry later');
    else if (outcome.kind === 'password_change') console.warn('[audit] tryRegister deferred until the password is changed');
    else console.error('[audit] tryRegister failed:', result.err?.message ?? 'unexpected response');
    if (QUICK_RETRY_REASONS.has(decision.reason)) scheduleRetry();
  }
  return emrGate().allowed;
}

// An audit send was refused because of the device (not the token): ask for the PC's state again.
function noteSendError(err) {
  if (err?.status === 401 && !isTokenExpiryError(err)) {
    _deviceProblem = true;
    _deviceProblemSeq += 1;
    tryRegister().catch(e => console.error('[audit] register after device refusal:', e.message));
  }
}

// ── Send ─────────────────────────────────────────────────────────────────────

async function doSend(entry, accessToken) {
  const { headers, body } = buildSignedAuditRequest({
    entry, deviceId: _state.deviceId, privateKey: _state.privateKey, accessToken,
  });
  await httpPost(`${_apiBaseUrl}/api/audit/emr`, headers, body);
}

// ── Public API ───────────────────────────────────────────────────────────────

function getDeviceStatus() {
  return { status: _state.status, deviceId: _state.deviceId };
}

/** EMR gate for main.js: { allowed, reason } — reason 'ok' | 'pending' | 'revoked' | 'other_org' | 'org_unconfirmed' | 'unregistered'. */
function getEmrGate() {
  return emrGate();
}

function canSend() {
  return sendingAllowed(_meta, _state.status);
}

// Send with a tokenless retry: if the call fails because the token itself is bad (expired / revoked), the
// Authorization header is dropped and the same entry is sent once more (the server records who sent it from
// the PC and the entry's own actor). Any other 401 (device problems) propagates to the caller for enqueue.
async function doSendWithSessionFallback(entry, accessToken) {
  if (!accessToken) {
    await doSend(entry, null);
    return;
  }
  try {
    await doSend(entry, accessToken);
  } catch (err) {
    if (isTokenExpiryError(err)) {
      console.warn('[audit] HTTP 401 token expiry/revocation, retrying without the token');
      await doSend(entry, null);
    } else {
      throw err;
    }
  }
}

/**
 * Record-time information for an EMR action — call it when the action starts (before the helper runs) and pass
 * it to recordAudit when the action ends: who was logged in then, when, and a random event id.
 */
function captureAuditContext() {
  return createAuditContext(_getAccessToken(), { identity: readTokenIdentity });
}

// Send an audit entry immediately if device is active; enqueue otherwise. `context` = captureAuditContext() taken
// when the EMR action started (taken now when absent). The stamped entry is what is sent, queued and resent.
async function recordAudit(entry, context) {
  if (!_state.deviceId || !_state.privateKey) return;
  const stamped = stampEntry(entry, context ?? captureAuditContext());
  if (!canSend()) { enqueue(stamped); return; }

  const token = _getAccessToken();
  try {
    await doSendWithSessionFallback(stamped, token);
  } catch (err) {
    console.error('[audit] send failed, enqueuing:', err.message);
    enqueue(stamped);
    noteSendError(err);
  }
}

// Attempt to flush the pending queue. Handles corrupt file gracefully.
// Asks for the device state first when it is due (approvals of a pending PC and transient failures heal
// without an app restart — see tryRegister).
async function flushQueue() {
  await tryRegister();
  if (!canSend()) return;

  if (checkCorrupt()) {
    const name = handleCorrupt();
    console.error('[audit] corrupt queue file renamed:', name);
    await recordAudit({
      action:  'audit_queue_corrupt',
      outcome: 'failure',
      extra:   { corruptFile: name },
    }).catch(() => {});
    return;
  }

  const token = _getAccessToken();
  let refused = null;
  await flush(async entry => {
    try {
      await doSendWithSessionFallback(forQueuedSend(entry), token);
    } catch (err) {
      if (!refused && err?.status === 401 && !isTokenExpiryError(err)) refused = err;
      throw err;
    }
  });
  if (refused) noteSendError(refused);
}

// Called once from app.whenReady() after main window is created.
async function initAudit({ getAccessToken, apiBaseUrl }) {
  _getAccessToken = getAccessToken || (() => null);
  _apiBaseUrl     = (apiBaseUrl || '').replace(/\/$/, '');

  if (!safeStorage.isEncryptionAvailable()) {
    console.error('[audit] safeStorage unavailable — audit module disabled (fail-closed)');
    _state.status = 'error';
    return;
  }

  initDevice();
  await flushQueue(); // asks for the device state first (tryRegister)
}

module.exports = { initAudit, getDeviceStatus, getEmrGate, tryRegister, captureAuditContext, recordAudit, flushQueue };
