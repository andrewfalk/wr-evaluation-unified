'use strict';
// electron/audit.js
// Device key management, Ed25519 signing, and EMR audit submission.
// Requires initAudit() to be called from app.whenReady().
const { app, net, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { enqueue, flush, checkCorrupt, handleCorrupt } = require('./auditQueue');

// ── Module state ─────────────────────────────────────────────────────────────

let _state = {
  deviceId:     null,
  privateKey:   null, // crypto.KeyObject
  publicKeyB64: null, // raw 32-byte Ed25519 public key, base64
  status:       'unregistered', // 'unregistered' | 'pending' | 'active' | 'error'
};
let _getAccessToken = () => null;
let _apiBaseUrl = '';

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
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) {
            const err = new Error(json?.error?.message || `HTTP ${res.statusCode}`);
            err.status = res.statusCode;
            reject(err);
          } else {
            resolve({ status: res.statusCode, data: json });
          }
        } catch {
          reject(new Error(`parse error HTTP ${res.statusCode}`));
        }
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

  try {
    const { data } = await httpPost(
      `${_apiBaseUrl}/api/devices/register`,
      { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      JSON.stringify({ publicKey: _state.publicKeyB64, buildTarget: 'intranet' })
    );
    const newStatus = data?.status === 'active' ? 'active' : 'pending';
    _state.status = newStatus;
    const meta = loadMeta();
    if (meta) saveMeta({ ...meta, status: newStatus });
    console.log('[audit] device registration status:', newStatus);
    return newStatus === 'active';
  } catch (err) {
    console.error('[audit] tryRegister failed:', err.message);
    _state.status = 'error';
    return false;
  }
}

// ── Ed25519 signing ──────────────────────────────────────────────────────────

// Canonical message matches server audit.ts: "{deviceId}.{ts}.{nonce}.{sortedBodyJson}"
function signPayload(body, deviceTs, deviceNonce) {
  const sorted = Object.fromEntries(Object.keys(body).sort().map(k => [k, body[k]]));
  const canonical = `${_state.deviceId}.${deviceTs}.${deviceNonce}.${JSON.stringify(sorted)}`;
  return crypto.sign(null, Buffer.from(canonical, 'utf-8'), _state.privateKey).toString('base64');
}

// ── Send ─────────────────────────────────────────────────────────────────────

async function doSend(entry, accessToken) {
  const deviceTs    = new Date().toISOString();
  const deviceNonce = crypto.randomUUID();

  const body = {
    action:  entry.action,
    outcome: entry.outcome,
    ...(entry.targetId ? { targetId: entry.targetId } : {}),
    ...(entry.extra    ? { extra:    entry.extra    } : {}),
  };

  const sig = signPayload(body, deviceTs, deviceNonce);

  await httpPost(
    `${_apiBaseUrl}/api/audit/emr`,
    {
      'Content-Type':    'application/json',
      'X-WR-Device-Id':  _state.deviceId,
      'X-WR-Device-Sig': sig,
      'X-WR-Device-Ts':  deviceTs,
      'X-WR-Device-Nonce': deviceNonce,
      'X-WR-Source':     'electron-main',
      ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
    },
    JSON.stringify(body)
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

function getDeviceStatus() {
  return { status: _state.status, deviceId: _state.deviceId };
}

// Send an audit entry immediately if device is active; enqueue otherwise.
async function recordAudit(entry) {
  if (!_state.deviceId || !_state.privateKey) return;
  if (_state.status !== 'active') { enqueue(entry); return; }

  const token = _getAccessToken();
  try {
    await doSend(entry, token);
  } catch (err) {
    console.error('[audit] send failed, enqueuing:', err.message);
    enqueue(entry);
  }
}

// Attempt to flush the pending queue. Handles corrupt file gracefully.
// Also retries device registration when status is 'pending' so that admin
// approvals are picked up within the next 5-minute interval without a restart.
async function flushQueue() {
  if (_state.status === 'pending') {
    await tryRegister(); // admin may have approved since last check
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
    const enriched = { ...entry };
    if (!token) {
      enriched.extra = { ...(enriched.extra || {}), session_missing: true, actor_from_queue: true };
    }
    await doSend(enriched, token);
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
