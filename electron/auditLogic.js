'use strict';
// electron/auditLogic.js
// EMR 감사 전송의 판단 로직 — electron 모듈을 require하지 않아 vitest에서 바로 테스트한다(audit.js는 연결부).
// 서버 계약(server/src/routes/audit.ts): 서명 대상 = "<장치 ID>.<ts>.<nonce>.<키를 정렬한 본문 JSON>".
const crypto = require('crypto');

// 서버의 등록 제한은 사용자당 시간당 5회다(server/src/middleware/rateLimit.ts). 5분 주기의 재전송 타이머만으로도
// 시간당 12회가 되므로, 승인 대기 중의 재등록은 이 간격으로 띄운다.
const REGISTER_RETRY_INTERVAL_MS = 20 * 60 * 1000;

// 토큰 자체가 문제인 401(만료·폐기). 감사 경로가 장치 문제로 돌려주는 401(UNAUTHORIZED)은 여기에 넣지 않는다 —
// 토큰 없이 다시 보내는 것은 토큰 문제일 때만이다.
const TOKEN_EXPIRY_CODES = new Set(['TOKEN_INVALID', 'SESSION_REVOKED']);

/** 서버로 보내는 본문: action·outcome, 있을 때만 targetId·extra. */
function buildAuditBody(entry) {
  return {
    action:  entry.action,
    outcome: entry.outcome,
    ...(entry.targetId ? { targetId: entry.targetId } : {}),
    ...(entry.extra    ? { extra:    entry.extra    } : {}),
  };
}

/** 서명 대상 문자열(서버 audit.ts와 같은 규칙). */
function canonicalMessage(deviceId, deviceTs, deviceNonce, body) {
  const sorted = Object.fromEntries(Object.keys(body).sort().map(k => [k, body[k]]));
  return `${deviceId}.${deviceTs}.${deviceNonce}.${JSON.stringify(sorted)}`;
}

/**
 * 서명한 요청(헤더·본문 문자열). 서명·시각·nonce는 보낼 때마다 새로 만든다.
 * deps: { now(): Date, randomUUID(): string } — 테스트가 고정한다.
 */
function buildSignedAuditRequest({ entry, deviceId, privateKey, accessToken }, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const deviceTs    = now().toISOString();
  const deviceNonce = randomUUID();
  const body = buildAuditBody(entry);
  const sig = crypto.sign(null, Buffer.from(canonicalMessage(deviceId, deviceTs, deviceNonce, body), 'utf-8'), privateKey).toString('base64');
  return {
    headers: {
      'Content-Type':      'application/json',
      'X-WR-Device-Id':    deviceId,
      'X-WR-Device-Sig':   sig,
      'X-WR-Device-Ts':    deviceTs,
      'X-WR-Device-Nonce': deviceNonce,
      'X-WR-Source':       'electron-main',
      ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  };
}

/**
 * HTTP 응답 해석: 2xx·3xx JSON → { status, data }, 4xx·5xx JSON → Error(status·code), JSON이 아니면 Error('parse error').
 * 성공이면 객체를 돌려주고 실패면 Error를 돌려준다(던지지 않는다 — 호출부가 reject한다).
 */
function interpretHttpResponse(statusCode, rawBody) {
  let json;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return new Error(`parse error HTTP ${statusCode}`);
  }
  if (statusCode >= 400) {
    const msg = (typeof json?.error === 'string' ? json.error : json?.error?.message) || `HTTP ${statusCode}`;
    const err = new Error(msg);
    err.status = statusCode;
    err.code   = json?.code ?? null;
    return err;
  }
  return { status: statusCode, data: json };
}

function isTokenExpiryError(err) {
  return err?.status === 401 && TOKEN_EXPIRY_CODES.has(err.code);
}

/** 토큰 없이 다시 보낼 때의 항목(세션 없음 표시를 extra에 더한다). */
function withSessionMissing(entry) {
  return { ...entry, extra: { ...(entry.extra ?? {}), session_missing: true, actor_from_queue: true } };
}

/** 등록 응답의 상태: active만 active, 그 밖에는 pending. */
function registerStatusFromResponse(data) {
  return data?.status === 'active' ? 'active' : 'pending';
}

/** 등록 실패를 어떻게 다룰지: 429·비밀번호 변경 필요는 'retry_later'(상태 유지), 그 밖에는 'error'. */
function classifyRegisterError(err) {
  if (err?.status === 429) return 'retry_later';
  if (err?.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED') return 'password_change';
  return 'error';
}

module.exports = {
  REGISTER_RETRY_INTERVAL_MS,
  TOKEN_EXPIRY_CODES,
  buildAuditBody,
  canonicalMessage,
  buildSignedAuditRequest,
  interpretHttpResponse,
  isTokenExpiryError,
  withSessionMissing,
  registerStatusFromResponse,
  classifyRegisterError,
};
