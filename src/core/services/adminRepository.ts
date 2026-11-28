// 관리자 콘솔의 서버 호출(REFACTORING_ROADMAP Phase 2 C9 P2-83a) — 탭 화면(src/core/components/admin/*Tab.tsx)에 있던 25곳을
// 함수로 모았다. 경로·메서드·본문·signal은 화면에 있던 그대로이고, 요청은 표준 클라이언트(src/core/api/client의 requestJson)로
// 보낸다(예전 호환 shim과 같은 요청 — 헤더·401 refresh 재시도·오류 모양). 응답은 검증하지 않고 unknown으로 돌려준다 —
// 탭이 자기가 읽는 필드만 적은 지역 타입으로 받는다. 사용자 목록(fetchAdminUsers)은 세 탭이 각자 부른다.
import { requestJson } from '../api/client';
import type { SessionLike } from '../api/apiClient';

/** 탭이 가진 요청 맥락 — 기준 주소(resolveApiBaseUrl)와 로그인 세션. */
export interface AdminApiContext {
  baseUrl: string;
  session: SessionLike;
}

// ── 감사 로그 ──
export function fetchAuditLog({ baseUrl, session }: AdminApiContext, params: URLSearchParams): Promise<unknown> {
  return requestJson(`/api/admin/audit?${params}`, { baseUrl, session });
}

// ── 디바이스 ──
export function fetchDevices({ baseUrl, session }: AdminApiContext): Promise<unknown> {
  return requestJson('/api/admin/devices', { baseUrl, session });
}

/** action: 'approve' | 'revoke' */
export function postDeviceAction({ baseUrl, session }: AdminApiContext, deviceId: string, action: string): Promise<unknown> {
  return requestJson(`/api/admin/devices/${deviceId}/${action}`, { baseUrl, method: 'POST', session });
}

// ── 사용자 ──
export function fetchAdminUsers({ baseUrl, session }: AdminApiContext): Promise<unknown> {
  return requestJson('/api/admin/users', { baseUrl, session });
}

export function createAdminUser({ baseUrl, session }: AdminApiContext, form: unknown): Promise<unknown> {
  return requestJson('/api/admin/users', { baseUrl, method: 'POST', body: form, session });
}

/** action: 'enable' | 'disable' */
export function postUserStatus({ baseUrl, session }: AdminApiContext, userId: string, action: string): Promise<unknown> {
  return requestJson(`/api/admin/users/${userId}/${action}`, {
    baseUrl, method: 'POST', session,
  });
}

export function resetUserPassword({ baseUrl, session }: AdminApiContext, userId: string, password: string): Promise<unknown> {
  return requestJson(`/api/admin/users/${userId}/reset-password`, {
    baseUrl, method: 'POST', body: { password }, session,
  });
}

// ── 가입 요청 ──
export function fetchSignupRequests({ baseUrl, session }: AdminApiContext, params: URLSearchParams): Promise<unknown> {
  return requestJson(`/api/admin/signup-requests?${params}`, { baseUrl, session });
}

export function approveSignupRequest({ baseUrl, session }: AdminApiContext, id: string): Promise<unknown> {
  return requestJson(`/api/admin/signup-requests/${id}/approve`, {
    baseUrl, session, method: 'POST',
  });
}

export function rejectSignupRequest({ baseUrl, session }: AdminApiContext, id: string): Promise<unknown> {
  return requestJson(`/api/admin/signup-requests/${id}/reject`, {
    baseUrl, session, method: 'POST',
  });
}

// ── 환자 배정 ──
/** 전체 환자 목록 한 쪽(scope=all). qParam은 `&q=…` 또는 빈 글자 — 화면이 만든 그대로 붙인다. */
export function fetchPatientsPage(
  { baseUrl, session }: AdminApiContext, limit: number, offset: number, qParam: string, signal: AbortSignal,
): Promise<unknown> {
  return requestJson(
    `/api/patients?scope=all&limit=${limit}&offset=${offset}${qParam}`,
    { baseUrl, session, signal },
  );
}

export function assignPatient({ baseUrl, session }: AdminApiContext, patientId: string, assignedUserId: string | null): Promise<unknown> {
  return requestJson(`/api/patients/${patientId}/assignment`, {
    baseUrl, session, method: 'POST', body: { assignedUserId },
  });
}

// ── 운영 상태 ──
export function fetchBackupStatus({ baseUrl, session }: AdminApiContext): Promise<unknown> {
  return requestJson('/api/admin/ops/backup-status', { baseUrl, session });
}

export function ackBackupAlert({ baseUrl, session }: AdminApiContext, runId: string): Promise<unknown> {
  return requestJson(`/api/admin/ops/backup-alerts/${runId}/ack`, { baseUrl, session, method: 'POST' });
}

export function resolveBackupAlert({ baseUrl, session }: AdminApiContext, runId: string): Promise<unknown> {
  return requestJson(`/api/admin/ops/backup-alerts/${runId}/resolve`, { baseUrl, session, method: 'POST' });
}

// ── 추론 디바이스 ──
export function fetchOrgSettings({ baseUrl, session }: AdminApiContext): Promise<unknown> {
  return requestJson('/api/admin/org-settings', { baseUrl, session });
}

export function patchOrgSettings({ baseUrl, session }: AdminApiContext, inferenceDevice: string | null): Promise<unknown> {
  return requestJson('/api/admin/org-settings', {
    baseUrl, method: 'PATCH', body: { inferenceDevice }, session,
  });
}

// ── 프리셋 공유 ──
export function fetchAdminPresets({ baseUrl, session }: AdminApiContext): Promise<unknown> {
  return requestJson('/api/admin/presets', { baseUrl, session });
}

export function postPresetVisibility({ baseUrl, session }: AdminApiContext, ids: string[], visibility: string): Promise<unknown> {
  return requestJson('/api/admin/presets/visibility', {
    baseUrl, method: 'POST', session, body: { ids, visibility },
  });
}

// ── 통계 권한 ──
export function fetchCapabilityCatalog({ baseUrl, session }: AdminApiContext): Promise<unknown> {
  return requestJson('/api/capabilities/catalog', { baseUrl, session });
}

export function fetchCapabilityGrants({ baseUrl, session }: AdminApiContext): Promise<unknown> {
  return requestJson('/api/capabilities/grants', { baseUrl, session });
}

export function createCapabilityGrant({ baseUrl, session }: AdminApiContext, body: unknown): Promise<unknown> {
  return requestJson('/api/capabilities/grants', {
    baseUrl, method: 'POST', session,
    body,
  });
}

export function revokeCapabilityGrant({ baseUrl, session }: AdminApiContext, grantId: string): Promise<unknown> {
  return requestJson(`/api/capabilities/grants/${grantId}/revoke`, { baseUrl, method: 'POST', session });
}
