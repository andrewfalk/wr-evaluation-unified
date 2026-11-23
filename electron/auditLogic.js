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

// 이 설치본의 기록 표식(서버가 이전 설치본의 기록과 구분한다 — server/src/devices/emrAuditRecord.ts).
const SHELL_AUDIT_MARKER = 2;

/**
 * EMR 동작을 시작할 때 잡아 두는 기록 시점 정보: 그때 로그인한 사용자(토큰의 sub — 없으면 비움)·시각·무작위 eventId.
 * 동작이 끝난 뒤의 기록·대기열·재전송까지 이 값을 쓴다(그사이 계정이 바뀌어도 시작한 사용자로 남는다).
 * deps: { now(): Date, randomUUID(): string, identity(token) }.
 */
function createAuditContext(token, deps = {}) {
  const now = deps.now ?? (() => new Date());
  const randomUUID = deps.randomUUID ?? (() => crypto.randomUUID());
  const identity = deps.identity ? deps.identity(token) : null;
  return {
    occurredAt: now().toISOString(),
    eventId: randomUUID(),
    ...(identity?.userId ? { actorUserId: identity.userId } : {}),
  };
}

/** 기록 시점 정보를 extra에 넣은 항목(기존 extra 값은 그대로 둔다). 항목 형식 {action, outcome, targetId?, extra?}는 그대로. */
function stampEntry(entry, context) {
  return {
    ...entry,
    extra: {
      ...(entry.extra ?? {}),
      occurredAt: context.occurredAt,
      eventId: context.eventId,
      ...(context.actorUserId ? { actorUserId: context.actorUserId } : {}),
      shellAudit: SHELL_AUDIT_MARKER,
    },
  };
}

function isStampedEntry(entry) {
  return entry?.extra?.shellAudit === SHELL_AUDIT_MARKER;
}

/** 대기열에서 나가는 항목: 이 설치본이 만든 항목에는 queued: true를 더하고, 이전 형식 항목은 손대지 않는다. */
function forQueuedSend(entry) {
  return isStampedEntry(entry) ? { ...entry, extra: { ...entry.extra, queued: true } } : entry;
}

module.exports = {
  SHELL_AUDIT_MARKER,
  createAuditContext,
  stampEntry,
  isStampedEntry,
  forQueuedSend,
  TOKEN_EXPIRY_CODES,
  REQUEST_TIMEOUT_MS,
  buildAuditBody,
  canonicalMessage,
  buildSignedAuditRequest,
  interpretHttpResponse,
  isTokenExpiryError,
};
