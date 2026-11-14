// 인증 부트스트랩 요청 — REFACTORING_ROADMAP Phase 2 C2(P2-17). 예전 AuthContext·useAuthSync의 raw fetch 3곳을 옮겼다.
//
// 이 요청들은 401-refresh 인터셉터를 **타면 안 된다**(refresh 자신이거나, 인터셉터가 연결되기 전의 부팅 확인) —
// requestEnvelope(refresh·CSRF 재시도 없음)를 쓰고, 요청 모양(메서드·credentials·헤더·본문 없음)과 실패 문구는 예전 그대로다.
import { requestEnvelope } from './client';
import type { ResponseEnvelope } from './apiClient';

/**
 * 부팅 시 저장된 인트라넷 세션 확인: POST /api/auth/csrf(헤더·본문 없이, refresh 쿠키로 확인). 실패해도 던지지 않고 봉투를
 * 돌려준다 — 호출부(AuthContext)가 !ok면 로컬 세션으로 되돌린다. 네트워크 오류는 그대로 던진다.
 */
export function verifyStoredSession(baseUrl: string): Promise<ResponseEnvelope> {
  return requestEnvelope('/api/auth/csrf', { baseUrl, method: 'POST', credentials: 'include' });
}

/** CSRF 쿠키 재발급 + 새 accessToken: POST /api/auth/csrf. 실패하면 Error('CSRF renewal failed'). */
export async function renewCsrf(baseUrl: string): Promise<unknown> {
  const result = await requestEnvelope('/api/auth/csrf', {
    baseUrl, method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
  });
  if (!result.ok) throw new Error('CSRF renewal failed');
  // 예전에는 성공 본문을 response.json()으로 읽어, JSON이 아니면 그 자리에서 던졌다 — 같은 지점에서 실패시킨다.
  if (result.data === null) throw new Error('CSRF renewal returned no JSON body');
  return result.data;
}

/** 액세스 토큰 refresh: POST /api/auth/refresh(X-CSRF-Token). 실패하면 Error('Refresh failed'). */
export async function refreshAccessToken(baseUrl: string, csrfToken: string): Promise<unknown> {
  const result = await requestEnvelope('/api/auth/refresh', {
    baseUrl,
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
  });
  if (!result.ok) throw new Error('Refresh failed');
  if (result.data === null) throw new Error('Refresh returned no JSON body');
  return result.data;
}
