// 환자 목록/대시보드 scope(내 담당/전체/의사별/미배정) 관련 순수 함수.
// App.jsx에서 분리 — 렌더링 없이 단위 테스트 가능하게 하기 위함.

export function getDefaultPatientScope(session) {
  return session?.mode === 'intranet' && session?.user?.role !== 'doctor'
    ? 'all'
    : 'mine';
}

// 환자 로드(동기화) 스코프를 세션에 맞게 정규화.
// - admin(인트라넷 비-doctor): 'all' / doctor-id / '__unassigned__' 허용, 'mine'만 'all'로 치환
//   (admin은 "내 환자" 개념이 없음)
// - doctor / 로컬: 'mine' / 'all' / doctor-id / '__unassigned__' 그대로 통과
// - 그 외/빈 값: 'all'
export function normalizePatientScopeForSession(session, scope) {
  const canUseMine = session?.mode !== 'intranet' || session?.user?.role === 'doctor';
  if (scope === 'all' || scope === '__unassigned__') return scope;
  if (scope === 'mine') return canUseMine ? 'mine' : 'all';
  if (typeof scope === 'string' && scope) return scope; // 특정 의사 userId (서버가 검증)
  return 'all';
}

// 현재 명부(doctorRoster) 기준 유효한 scope 값 집합.
// 'all' + (canUseMineScope면) 'mine' + 명부의 각 의사 userId + (미배정 있으면) '__unassigned__'.
export function getValidPatientScopes(doctorRoster, { canUseMineScope } = {}) {
  const doctors = Array.isArray(doctorRoster?.doctors) ? doctorRoster.doctors : [];
  const unassignedCount = Number(doctorRoster?.unassignedCount) || 0;
  return new Set([
    'all',
    ...(canUseMineScope ? ['mine'] : []),
    ...doctors.map(d => d.userId),
    ...(unassignedCount > 0 ? ['__unassigned__'] : []),
  ]);
}
