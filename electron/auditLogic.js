'use strict';
// electron/auditLogic.js
// EMR 감사 전송의 판단 로직(등록·승인 상태는 deviceState.js) — electron 모듈을 require하지 않아 vitest에서 바로 테스트한다(audit.js는 연결부).
// 서버 계약(server/src/routes/audit.ts): 서명 대상 = "<장치 ID>.<ts>.<nonce>.<키를 정렬한 본문 JSON>".
const crypto = require('crypto');

// 토큰 자체가 문제인 401(만료·폐기). 감사 경로가 장치 문제로 돌려주는 401(UNAUTHORIZED)은 여기에 넣지 않는다 —
// 토큰 없이 다시 보내는 것은 토큰 문제일 때만이다.
const TOKEN_EXPIRY_CODES = new Set(['TOKEN_INVALID', 'SESSION_REVOKED']);
// 서버 요청 하나의 시간 제한 — 넘기면 요청을 끊고 네트워크 오류처럼 실패한다.
const REQUEST_TIMEOUT_MS = 30 * 1000;

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
    let err;
    try {
      const msg = (typeof json?.error === 'string' ? json.error : json?.error?.message) || `HTTP ${statusCode}`;
      err = new Error(msg);
    } catch {
      err = new Error(`HTTP ${statusCode}`); // 문자열로 바꿀 수 없는 메시지
    }
    err.status = statusCode;
    err.code   = json?.code ?? null;
    err.body   = json;
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

module.exports = {
  TOKEN_EXPIRY_CODES,
  REQUEST_TIMEOUT_MS,
  buildAuditBody,
  canonicalMessage,
  buildSignedAuditRequest,
  interpretHttpResponse,
  isTokenExpiryError,
  withSessionMissing,
};
