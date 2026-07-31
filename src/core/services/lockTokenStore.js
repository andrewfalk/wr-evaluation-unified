// 환자 단위 편집 락(TTL lease lock)의 leaseToken을 보관하는 순수 인메모리 레지스트리.
// Patient 객체/workspace 스냅샷에는 절대 포함하지 않는다 — 새로고침해도 사라지는 게 맞다
// (usePatientLock이 재진입 시 서버와 다시 acquire/renew로 동기화한다).
const tokens = new Map(); // localPatientId -> { token, expiresAt }

export function setLockToken(patientId, token, expiresAt = null) {
  if (!patientId || !token) return;
  tokens.set(patientId, { token, expiresAt });
}

export function getLockToken(patientId) {
  return tokens.get(patientId)?.token ?? null;
}

export function clearLockToken(patientId) {
  tokens.delete(patientId);
}

// 세션 identity가 바뀔 때(로그아웃/로그인/서버 URL 변경 등) 이전 계정의 토큰이 다음 계정으로
// 넘어가지 않도록 일괄 초기화한다.
export function clearAllLockTokens() {
  tokens.clear();
}
