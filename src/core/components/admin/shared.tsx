// 관리자 콘솔 탭들이 함께 쓰는 조각(비밀번호 규칙·시각 서식·상태·역할 배지)과 타입 — P2-82a에서 AdminConsoleModal.tsx의 선언을 본문 그대로 옮겼다.

// 서버 응답·세션 타입은 이 화면이 읽는 필드만 적는다(런타임 검증 없음 — 서버 호출 함수(services/adminRepository)는 unknown을 돌려주고 탭이 단언으로 받는다).
export type AdminSession = {
  mode?: string | null;
  apiBaseUrl?: string | null;
  user?: { id?: string | null; organizationId?: string | null; [field: string]: unknown } | null;
  [field: string]: unknown;
} | null | undefined;

export interface TabProps {
  session: AdminSession;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Mirrors server checkPasswordPolicy in auth/passwordPolicy.ts
export function validatePassword(pw: string): string | null {
  if (!pw || pw.length < 10) return '비밀번호는 10자 이상이어야 합니다.';
  if (!/[a-zA-Z가-힣]/.test(pw)) return '비밀번호에 문자(영문 또는 한글)가 포함되어야 합니다.';
  if (!/\d/.test(pw)) return '비밀번호에 숫자가 포함되어야 합니다.';
  if (!/[^a-zA-Z0-9가-힣]/.test(pw)) return '비밀번호에 특수문자가 포함되어야 합니다.';
  return null;
}

export function fmt(value: string | null | undefined): string {
  if (!value) return '-';
  try { return new Date(value).toLocaleString('ko-KR'); } catch { return String(value); }
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, [string, string]> = { active: ['connected', '활성'], pending: ['checking', '대기'], revoked: ['fallback', '취소됨'] };
  const [tone, label] = map[status] ?? ['local', status];
  return <span className={`admin-badge admin-badge--${tone}`}>{label}</span>;
}

export function RoleBadge({ role }: { role: string }) {
  const label = ({ admin: '관리자', doctor: '의사', nurse: '간호사', staff: '직원' } as Record<string, string>)[role] ?? role;
  return <span className={`admin-badge admin-badge--role admin-badge--role-${role}`}>{label}</span>;
}

// 행별 처리 중 표시(처리 중인 id 묶음) — 여러 행을 함께 처리할 때 한 행이 끝나거나 시작해도 다른 행의 잠금이 풀리지 않게.
export function withId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  return new Set(ids).add(id);
}

export function withoutId(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  next.delete(id);
  return next;
}

export interface UserRow {
  id: string;
  loginId: string;
  name: string;
  role: string;
  disabled?: boolean;
  mustChangePassword?: boolean;
  createdAt?: string | null;
  lastLoginAt?: string | null;
}

export interface UsersResponse {
  users: UserRow[];
}
