// 인트라넷 세션 판정·신원 키(계정 전환 수정 AS-7 — main의 src/platform/dataMode.ts에서 이 브랜치가 쓰는 것만 옮겼다).

export interface SessionLike {
  mode?: string | null;
  apiBaseUrl?: string | null;
}

/** 인트라넷 세션 — 서버 인증을 마친 세션만. */
export function hasIntranetSession(session?: SessionLike | null): boolean {
  return session?.mode === 'intranet';
}

/**
 * 인트라넷 세션의 신원 키 `user.id|organizationId` — 인트라넷 세션이 아니거나 user.id가 없으면 null.
 * 역할·이름·토큰은 넣지 않는다(역할이 바뀌어도 같은 사람). 요청 재시도·작업 공간 주인 판정이 같은 키를 쓴다.
 */
export function intranetIdentityOf(session?: { mode?: string | null; user?: unknown } | null): string | null {
  if (!hasIntranetSession(session)) return null;
  const user = (session?.user ?? null) as { id?: unknown; organizationId?: unknown } | null;
  const id = user?.id;
  if (id === undefined || id === null || id === '') return null;
  const organizationId = user?.organizationId;
  return `${String(id)}|${organizationId === undefined || organizationId === null ? '' : String(organizationId)}`;
}

/**
 * 서버까지 포함한 신원 키 `정규화한 apiBaseUrl#user.id|organizationId` — 인트라넷 세션이 아니면 null. 같은 사용자·조직 ID라도
 * 다른 서버(예: 운영 DB를 복사한 시험 서버)의 세션은 다른 신원으로 본다. 요청 재시도 고정과 인증 갱신 결과 적용이 쓴다.
 */
export function sessionIdentityOf(session?: { mode?: string | null; apiBaseUrl?: string | null; user?: unknown } | null): string | null {
  const identity = intranetIdentityOf(session);
  if (identity === null) return null;
  return `${normalizeBaseUrl(session?.apiBaseUrl)}#${identity}`;
}

/** 앞뒤 공백과 끝의 "/" 하나를 지운다. */
export function normalizeBaseUrl(baseUrl: string | null | undefined = ''): string {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}
