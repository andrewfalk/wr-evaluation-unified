// 브라우저 저장소 키 레지스트리 — REFACTORING_ROADMAP Phase 2 C2(P2-18).
//
// **이름을 바꾸지 않는다**(계획 "로드맵과 다른 점" 4). 저장된 데이터의 키이고, wr-auth-*는 탭 간 상호배제 프로토콜이라
// 구·신 번들 탭이 섞여 있는 동안 이름이 다르면 서로를 보지 못한다("구키 읽기"로는 배제를 보장할 수 없음). 값은 예전
// 리터럴 그대로이며 src/core/storage/__tests__/keys.frozen.test.ts가 고정한다. 새 키는 여기에 추가하고 같은 테스트에 올린다.

/** localStorage(또는 sessionStorage) 데이터 키. */
export const STORAGE_KEYS = {
  /** 웹: 저장 목록(이름 붙인 스냅샷들). */
  savedItems: 'wrEvalUnifiedSavedItems',
  /** 웹: 자동저장. */
  autoSave: 'wrEvalUnifiedAutoSave',
  /** 설정(웹·독립형 동기 폴백) — 독립형 AI API 키 포함(Phase 3 M5에서 safeStorage로). */
  settings: 'wrEvalUnifiedSettings',
  /** 설치별 디바이스 ID(자동저장 격리·디바이스 등록). */
  deviceId: 'wrEvalUnifiedDeviceId',
  /** 로그인 세션(액세스 토큰은 저장하지 않음). */
  authSession: 'wrEvalUnifiedAuthSession',
  /** 사용자 직종 프리셋(로컬). */
  customPresets: 'wrEvalUnifiedCustomPresets',
  /** sessionStorage: 탭별 환자 편집 락 클라이언트 ID(점 표기 — 예전 그대로). */
  lockClientInstanceId: 'wrEvalUnified.lockClientInstanceId',
  /** 구형 앱(wr-evaluation)의 저장 목록 — 같은 도메인일 때 읽기만. */
  legacySavedItems: 'wrEvaluationSavedItems',
} as const;

/** 탭 간 인증 refresh 조정 프로토콜(authChannel) — 이름이 프로토콜의 일부다. */
export const AUTH_PROTOCOL = {
  /** navigator.locks 잠금 이름. */
  refreshLockName: 'wr-auth-refresh',
  /** localStorage CAS 폴백 잠금 키. */
  refreshLockKey: 'wr-auth-refresh-lock',
  /** localStorage refresh 결과 신호 키(상태만, 토큰 없음). */
  refreshSignalKey: 'wr-auth-refresh-sig',
  /** BroadcastChannel 이름. */
  channelName: 'wr-auth',
} as const;

export type StorageKey = (typeof STORAGE_KEYS)[keyof typeof STORAGE_KEYS];
