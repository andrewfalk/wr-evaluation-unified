// 인트라넷 판정·API 기준 URL — REFACTORING_ROADMAP Phase 2 C1(P2-10). 흩어진 구현(문맥 6벌 + 세션만 판정 +
// refresh 자격)을 의미별 술어 3개로 모은다. 셋을 하나로 합치면 동작이 바뀐다(계획 "로드맵과 다른 점" 6) —
// 호출부는 지금 쓰는 의미를 고른다. 동작 기준: src/core/__tests__/intranetContext.characterization.test.js(T1·T2).

export interface SessionLike {
  mode?: string | null;
  apiBaseUrl?: string | null;
}

export interface SettingsLike {
  integrationMode?: string | null;
  apiBaseUrl?: string | null;
}

export interface DataModeContext {
  session?: SessionLike | null;
  settings?: SettingsLike | null;
}

export type DataMode = 'local' | 'intranet-pending' | 'intranet';

/** ① 인트라넷 문맥 — 세션이 인트라넷이거나 설정이 인트라넷 모드(로그인 전 포함). 예전 6벌의 식. */
export function isIntranetContext({ session, settings }: DataModeContext = {}): boolean {
  return session?.mode === 'intranet' || settings?.integrationMode === 'intranet';
}

/** ② 인트라넷 세션 — 서버 인증을 마친 세션만(설정은 보지 않음). */
export function hasIntranetSession(session?: SessionLike | null): boolean {
  return session?.mode === 'intranet';
}

/**
 * ③ 401-refresh 자격 — 모드를 밝히지 않은 세션(또는 세션 없음)은 예전 동작대로 자격 있음, 'local'만 제외.
 * httpClient 전용: 로컬 세션의 인증 실패는 refresh로 고칠 수 없고, 실패한 refresh가 onLogout → 재요청 순환을 만든다.
 */
export function isRefreshEligible(session?: SessionLike | null): boolean {
  return !session?.mode || session.mode === 'intranet';
}

/** 'intranet' = 인증된 인트라넷 세션, 'intranet-pending' = 인트라넷 설정이지만 아직 로그인 전, 'local' = 그 밖. */
export function resolveDataMode(context: DataModeContext = {}): DataMode {
  if (hasIntranetSession(context.session)) return 'intranet';
  return isIntranetContext(context) ? 'intranet-pending' : 'local';
}

/** 앞뒤 공백과 끝의 "/" 하나를 지운다(httpClient·useAppSettings·integrationStatus의 normalizeBaseUrl과 같은 식). */
export function normalizeBaseUrl(baseUrl: string | null | undefined = ''): string {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

/** API 기준 URL: session → settings → ''(정규화). */
export function resolveApiBaseUrl({ session, settings }: DataModeContext = {}): string {
  return normalizeBaseUrl(session?.apiBaseUrl || settings?.apiBaseUrl || '');
}
