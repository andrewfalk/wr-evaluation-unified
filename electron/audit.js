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
const { mustChangePassword } = require('./accessTokenClaims');
const {
  REGISTER_RETRY_INTERVAL_MS,
  buildSignedAuditRequest,
  interpretHttpResponse,
  isTokenExpiryError,
  withSessionMissing,
  registerStatusFromResponse,
  classifyRegisterError,
} = require('./auditLogic');

// ── Module state ─────────────────────────────────────────────────────────────

let _state = {
  deviceId:     null,
  privateKey:   null, // crypto.KeyObject
  publicKeyB64: null, // raw 32-byte Ed25519 public key, base64
  status:       'unregistered', // 'unregistered' | 'pending' | 'active' | 'error'
};
let _getAccessToken = () => null;
let _apiBaseUrl = '';
let _lastRegisterAttempt = 0;

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
  saveMeta({ deviceId, publicKeyB64, status: 'unregistered' });

  _state = { deviceId, privateKey: pk, publicKeyB64, status: 'unregistered' };
  return true;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'POST' });
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, String(v));
    req.on('response', res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        const result = interpretHttpResponse(res.statusCode, data);
        if (result instanceof Error) reject(result);
        else resolve(result);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Device registration ──────────────────────────────────────────────────────

async function tryRegister() {
  if (_state.status === 'active') return true;
  const token = _getAccessToken();
  if (!token || !_state.publicKeyB64 || !_apiBaseUrl) return false;

  // 임시 비밀번호 상태의 토큰은 서버가 /api/devices/register를 403으로 거절한다. 그 요청이 인증 앞단의 IP 제한
  // (분당 1회)을 소비하면, 비밀번호를 바꾼 직후의 첫 등록이 429를 받아 20분 재시도 대기에 들어가 EMR이 잠긴다.
  // 그래서 요청 자체를 보내지 않는다 — 비밀번호 변경 후 새 토큰으로 setAccessToken이 다시 불리면 그때 첫 등록이 나간다.
  if (mustChangePassword(token)) return false;

  const now = Date.now();
  if (now - _lastRegisterAttempt < REGISTER_RETRY_INTERVAL_MS) return false;
  _lastRegisterAttempt = now;

  try {
    const { data } = await httpPost(
      `${_apiBaseUrl}/api/devices/register`,
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      JSON.stringify({ publicKey: _state.publicKeyB64, buildTarget: 'intranet' })
    );
    const newStatus = registerStatusFromResponse(data);
    _state.status = newStatus;
    const meta = loadMeta();
    if (meta) saveMeta({ ...meta, status: newStatus });
    console.log('[audit] device registration status:', newStatus);
    return newStatus === 'active';
  } catch (err) {
    // 429: 서버에는 닿았고 장치는 이미 승인 대기·승인 상태일 수 있다 — 'error'로 내리지 않고 나중에 다시 한다.
    // 비밀번호 변경 필요(사전 검사를 빠져나간 경우): 'error'로 내리지 않는다 — 비밀번호 변경이 끝나면 풀린다.
    const kind = classifyRegisterError(err);
    if (kind === 'retry_later') {
      console.warn('[audit] tryRegister rate-limited, will retry in', REGISTER_RETRY_INTERVAL_MS / 60000, 'min:', err.message);
      return false;
    }
    if (kind === 'password_change') {
      console.warn('[audit] tryRegister deferred until the password is changed');
      return false;
    }
    console.error('[audit] tryRegister failed:', err.message);
    _state.status = 'error';
    return false;
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

// Send with automatic session-missing fallback: if the call fails because the token itself is bad
// (expired / revoked), strips the Authorization header and retries once. Any other 401 (device
// problems) propagates to the caller for enqueue.
async function doSendWithSessionFallback(entry, accessToken) {
  if (!accessToken) {
    await doSend(withSessionMissing(entry), null);
    return;
  }
  try {
    await doSend(entry, accessToken);
  } catch (err) {
    if (isTokenExpiryError(err)) {
      console.warn('[audit] HTTP 401 token expiry/revocation, retrying as session_missing');
      await doSend(withSessionMissing(entry), null);
    } else {
      throw err;
    }
  }
}

// Send an audit entry immediately if device is active; enqueue otherwise.
async function recordAudit(entry) {
  if (!_state.deviceId || !_state.privateKey) return;
  if (_state.status !== 'active') { enqueue(entry); return; }

  const token = _getAccessToken();
  try {
    await doSendWithSessionFallback(entry, token);
  } catch (err) {
    console.error('[audit] send failed, enqueuing:', err.message);
    enqueue(entry);
  }
}

// Attempt to flush the pending queue. Handles corrupt file gracefully.
// Retries device registration for pending/error/unregistered statuses so
// that admin approvals and transient network failures self-heal (within
// REGISTER_RETRY_INTERVAL_MS) without requiring an app restart.
async function flushQueue() {
  if (_state.status !== 'active') {
    await tryRegister(); // covers pending, error, unregistered
  }
  if (_state.status !== 'active') return;

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
  await flush(async entry => {
    await doSendWithSessionFallback(entry, token);
  });
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

  if (_state.status !== 'active') {
    await tryRegister();
  }

  await flushQueue();
}

module.exports = { initAudit, getDeviceStatus, tryRegister, recordAudit, flushQueue };
