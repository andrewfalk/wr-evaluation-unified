import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import {
  buildAuditBody,
  canonicalMessage,
  buildSignedAuditRequest,
  interpretHttpResponse,
  isTokenExpiryError,
} from '../auditLogic.js';

// 서버(server/src/routes/audit.ts)가 서명을 확인하는 방식 그대로.
function serverVerifies(publicKey, headers, bodyJson) {
  const body = JSON.parse(bodyJson);
  const sorted = Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b)));
  const message = `${headers['X-WR-Device-Id']}.${headers['X-WR-Device-Ts']}.${headers['X-WR-Device-Nonce']}.${JSON.stringify(sorted)}`;
  return crypto.verify(null, Buffer.from(message), publicKey, Buffer.from(headers['X-WR-Device-Sig'], 'base64'));
}

describe('auditLogic — 서명한 감사 요청', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const fixed = { now: () => new Date('2026-11-23T01:02:03.000Z'), randomUUID: () => '11111111-2222-4333-8444-555555555555' };

  it('본문은 action·outcome, 있을 때만 targetId·extra', () => {
    expect(buildAuditBody({ action: 'emr_inject', outcome: 'success' })).toEqual({ action: 'emr_inject', outcome: 'success' });
    expect(buildAuditBody({ action: 'emr_inject', outcome: 'failure', targetId: 't', extra: { source: 'auto' } }))
      .toEqual({ action: 'emr_inject', outcome: 'failure', targetId: 't', extra: { source: 'auto' } });
    expect(buildAuditBody({ action: 'emr_inject', outcome: 'failure', targetId: '', extra: null })).toEqual({ action: 'emr_inject', outcome: 'failure' });
  });

  it('서명 대상 문자열 = "<장치 ID>.<ts>.<nonce>.<키 정렬 본문>"', () => {
    expect(canonicalMessage('dev', 'ts', 'n', { outcome: 'success', action: 'a' })).toBe('dev.ts.n.{"action":"a","outcome":"success"}');
  });

  it('헤더(장치 ID·서명·시각·nonce·출처)와 토큰이 있을 때만 Authorization — 서버 방식으로 서명이 맞는다', () => {
    const entry = { action: 'emr_extract_record', outcome: 'success', targetId: 'abc', extra: { source: 'auto' } };
    const withToken = buildSignedAuditRequest({ entry, deviceId: 'local-id', privateKey, accessToken: 'tok' }, fixed);
    expect(withToken.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-WR-Device-Id': 'local-id',
      'X-WR-Device-Ts': '2026-11-23T01:02:03.000Z',
      'X-WR-Device-Nonce': '11111111-2222-4333-8444-555555555555',
      'X-WR-Source': 'electron-main',
      Authorization: 'Bearer tok',
    });
    expect(JSON.parse(withToken.body)).toEqual(buildAuditBody(entry));
    expect(serverVerifies(publicKey, withToken.headers, withToken.body)).toBe(true);
    const noToken = buildSignedAuditRequest({ entry, deviceId: 'local-id', privateKey, accessToken: null }, fixed);
    expect(noToken.headers).not.toHaveProperty('Authorization');
  });

  it('보낼 때마다 시각·nonce를 새로 만든다(기본 의존성)', () => {
    const entry = { action: 'emr_inject', outcome: 'success' };
    const a = buildSignedAuditRequest({ entry, deviceId: 'd', privateKey, accessToken: null });
    const b = buildSignedAuditRequest({ entry, deviceId: 'd', privateKey, accessToken: null });
    expect(a.headers['X-WR-Device-Nonce']).not.toBe(b.headers['X-WR-Device-Nonce']);
  });
});

describe('auditLogic — 응답 해석', () => {
  it('2xx JSON → { status, data }', () => {
    expect(interpretHttpResponse(200, '{"ok":true}')).toEqual({ status: 200, data: { ok: true } });
    expect(interpretHttpResponse(201, '{"status":"pending"}')).toEqual({ status: 201, data: { status: 'pending' } });
  });

  it('4xx·5xx JSON → Error(status·code·메시지)', () => {
    const e = interpretHttpResponse(401, '{"code":"UNAUTHORIZED","error":"Device not recognized"}');
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ message: 'Device not recognized', status: 401, code: 'UNAUTHORIZED' });
    expect(interpretHttpResponse(400, '{"code":"INVALID_BODY","error":[{"message":"x"}]}')).toMatchObject({ message: 'HTTP 400', status: 400, code: 'INVALID_BODY' });
    expect(interpretHttpResponse(500, '{"error":{"message":"boom"}}')).toMatchObject({ message: 'boom', status: 500, code: null });
  });

  it('문자열로 바꿀 수 없는 오류 메시지도 던지지 않고 Error로 돌려준다', () => {
    const e = interpretHttpResponse(500, '{"error":{"message":{"toString":null}}}');
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({ message: 'HTTP 500', status: 500 });
  });

  it('JSON이 아니면 상태와 무관하게 parse error(status·code 없음)', () => {
    for (const status of [200, 502]) {
      const e = interpretHttpResponse(status, '<html>');
      expect(e).toBeInstanceOf(Error);
      expect(e.message).toBe(`parse error HTTP ${status}`);
      expect(e.status).toBeUndefined();
    }
  });

  it('토큰 만료·폐기 401만 토큰 문제다(장치 문제 401·다른 상태는 아님)', () => {
    const err = (status, code) => Object.assign(new Error('x'), { status, code });
    expect(isTokenExpiryError(err(401, 'TOKEN_INVALID'))).toBe(true);
    expect(isTokenExpiryError(err(401, 'SESSION_REVOKED'))).toBe(true);
    expect(isTokenExpiryError(err(401, 'UNAUTHORIZED'))).toBe(false);
    expect(isTokenExpiryError(err(403, 'TOKEN_INVALID'))).toBe(false);
    expect(isTokenExpiryError(new Error('network'))).toBe(false);
  });

});
