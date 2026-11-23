'use strict';
// electron/accessTokenClaims.js
// 액세스 토큰(JWT) payload에서 클레임을 읽는 순수 함수. 서명 검증이 아니다 — 검증은 서버가 매 요청 하므로,
// 여기서는 "이 토큰으로 서버가 요청을 받아줄지"를 미리 가늠하는 용도로만 쓴다(읽기 실패는 모두 false).
// electron 모듈에 의존하지 않아 vitest에서 바로 import해 테스트한다(audit.js는 불가).

/**
 * 임시 비밀번호 상태(mustChangePassword)인 토큰인가?
 * 서버는 이 상태의 토큰으로 /api/auth/me·/api/auth/change-password 외 모든 API를 403으로 거절한다.
 */
function mustChangePassword(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return false;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return claims?.mustChangePassword === true;
  } catch {
    return false;
  }
}

/**
 * 토큰의 사용자·기관(sub·orgId). 읽을 수 없거나 sub가 없으면 null. 기관이 없는 계정은 orgId: null.
 * 서명을 검증하지 않는다 — EMR 게이트가 "지금 로그인한 기관"을 비교하고, 감사 기록에 "동작을 시작한 사용자"를 적는 데만 쓴다
 * (서버가 그 값을 다시 확인한다).
 */
function readTokenIdentity(token) {
  try {
    const payload = String(token).split('.')[1];
    if (!payload) return null;
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (typeof claims?.sub !== 'string' || !claims.sub) return null;
    const orgId = typeof claims.orgId === 'string' ? claims.orgId : null;
    return { userId: claims.sub, orgId };
  } catch {
    return null;
  }
}

module.exports = { mustChangePassword, readTokenIdentity };
