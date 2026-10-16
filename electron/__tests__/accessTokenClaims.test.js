import { describe, expect, it } from 'vitest';
import { mustChangePassword } from '../accessTokenClaims.js';

// 서명은 검증하지 않으므로 header.payload.signature 모양만 맞추면 된다.
const jwt = claims => `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

describe('mustChangePassword (access token claim)', () => {
  it('임시 비밀번호 상태의 토큰은 true', () => {
    expect(mustChangePassword(jwt({ sub: 'u1', mustChangePassword: true }))).toBe(true);
  });

  it('변경이 끝난 토큰(false)이거나 클레임이 없으면 false', () => {
    expect(mustChangePassword(jwt({ sub: 'u1', mustChangePassword: false }))).toBe(false);
    expect(mustChangePassword(jwt({ sub: 'u1' }))).toBe(false);
  });

  it('엄격하게 불리언 true만 인정한다 — 문자열 "true"·1은 false', () => {
    expect(mustChangePassword(jwt({ mustChangePassword: 'true' }))).toBe(false);
    expect(mustChangePassword(jwt({ mustChangePassword: 1 }))).toBe(false);
  });

  it.each([
    ['빈 문자열', ''],
    ['null', null],
    ['undefined', undefined],
    ['점이 없는 문자열', 'abc'],
    ['payload 없음', 'a..c'],
    ['JSON이 아닌 payload', 'a.bm90LWpzb24.c'],
    ['잘린 토큰', 'a.'],
  ])('읽을 수 없는 토큰은 던지지 않고 false — %s', (_name, token) => {
    expect(mustChangePassword(token)).toBe(false);
  });
});
