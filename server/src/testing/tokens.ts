// 서버 테스트용 액세스 토큰·CSRF 도우미 (REFACTORING_ROADMAP P0-11).
// 기존 테스트 여러 파일이 같은 고정 UUID·`CSRF_TOKEN = 'ok'`·sha256 해시·generateAccessToken 래퍼를
// 각자 복사해 두고 있다 — 새 테스트는 이것을 쓴다.
//
// 토큰 서명은 `config.auth.accessTokenSecret`을 쓴다. 테스트 파일이 config를 vi.mock 하면 그 값,
// 아니면 vitest.config.ts의 env(ACCESS_TOKEN_SECRET)로 만든 값 — 서명과 검증이 같은 config를 보므로
// 어느 쪽이든 일치한다.

import { generateAccessToken } from '../auth/tokens';
import { hashToken } from '../auth/tokenHash';
import { CSRF_HEADER } from '../auth/csrf';

export const TEST_USER_ID    = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const TEST_ORG_ID     = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const TEST_SESSION_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
export const TEST_CSRF_TOKEN = 'ok';
export const TEST_CSRF_HASH  = hashToken(TEST_CSRF_TOKEN);

export interface TestTokenOptions {
  userId?: string;
  sessionId?: string;
  /** null이면 조직 없는 사용자. */
  orgId?: string | null;
  role?: string;
  name?: string;
  mustChangePassword?: boolean;
  /** 토큰에 해시로 실리는 CSRF 토큰 원문. authHeaders()에 같은 값을 넘겨야 CSRF가 통과한다. */
  csrfToken?: string;
}

export function makeAccessToken(options: TestTokenOptions = {}): string {
  return generateAccessToken({
    sub:                options.userId ?? TEST_USER_ID,
    sessionId:          options.sessionId ?? TEST_SESSION_ID,
    orgId:              options.orgId === undefined ? TEST_ORG_ID : options.orgId,
    role:               options.role ?? 'doctor',
    name:               options.name ?? 'Dr. Kim',
    mustChangePassword: options.mustChangePassword ?? false,
    csrfHash:           hashToken(options.csrfToken ?? TEST_CSRF_TOKEN),
  }).token;
}

/** supertest `.set(authHeaders(token))`용. 변경 요청(POST/PUT/PATCH/DELETE)은 CSRF 헤더까지 필요하다. */
export function authHeaders(token: string, csrfToken: string = TEST_CSRF_TOKEN): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    [CSRF_HEADER]: csrfToken,
  };
}
