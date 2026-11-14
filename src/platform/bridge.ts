// window.electron(Electron preload 브리지)을 읽는 **유일한** 파일 — REFACTORING_ROADMAP Phase 2 C1(P2-10).
//
// 다른 코드는 window.electron을 직접 읽지 않고 아래 접근자를 쓴다(P2-15에서 ESLint로 금지, 구조 래칫 0).
// 규칙:
//   - 호출 시점에 읽는다(모듈 로드 시 캐시하지 않음) — 테스트·셸이 window.electron을 나중에 꽂아도 된다.
//   - 기능 접근자는 지금 화면 코드가 하던 "키 존재 검사"와 같은 의미다. 예: getFsBridge()는 예전
//     `isElectronFS = () => !!window.electron?.fsLoadAllPatients`와 같은 조건에서만 브리지를 돌려준다.
//   - 현장의 구 설치본 preload에는 buildTarget이 없고(E0 전), 인트라넷 preload는 허용 안 된 origin에서 {}를
//     노출한다 — 접근자는 키 하나하나를 optional로 다룬다(빌드 타깃 추측은 runtime.ts 한 곳).
// 키 목록·타입은 src/types/global.d.ts의 ElectronBridge(G10 골든 preload-surface.json의 합집합)가 정본이다.

export type Bridge = ElectronBridge;

type Invoke = NonNullable<ElectronBridge['fsLoadItems']>;

/** 독립형 셸의 파일 저장소 IPC. getFsBridge()가 돌려주면 아래 필수 키는 모두 있다(독립형 preload가 함께 노출). */
export interface FsBridge {
  fsLoadAllPatients: Invoke;
  fsLoadItems: Invoke;
  fsSaveItem: Invoke;
  fsDeleteItem: Invoke;
  fsSaveAllPatients: Invoke;
  fsLoadAutoSave: Invoke;
  fsSaveAutoSave: Invoke;
  fsClearAutoSave: Invoke;
  fsLoadSettings: Invoke;
  fsSaveSettings: Invoke;
  fsMigrate: Invoke;
  fsLoadCustomPresets?: Invoke;
  fsSaveCustomPresets?: Invoke;
}

export type EmrBridge = Pick<ElectronBridge, 'injectEMR' | 'extractRecord' | 'extractConsultation'>;
export type MenuBridge = Pick<ElectronBridge, 'onMenuNew' | 'onGotoModule' | 'onOpenStatistics'>;
export type LifecycleBridge = Pick<
  ElectronBridge,
  'setHasUnsavedDraft' | 'setStatsAvailable' | 'setAccessToken' | 'onQuitRequested' | 'notifyQuitLogoutDone'
>;
export type DialogBridge = Pick<ElectronBridge, 'showAlert' | 'showConfirm'>;
export interface AiBridge { analyzeAI: Invoke }
export interface MigrationBridge { loadLocalMigrationData: Invoke }
export interface LegacyImportBridge { loadLegacyData: Invoke }

/** window.electron 그대로(웹이면 undefined). 새 코드는 아래 기능 접근자를 쓴다. */
export function getBridge(): Bridge | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.electron;
}

/** Electron 셸 안인가(브리지 객체가 있는가 — 허용 안 된 origin의 {}도 true). 예전 `!!window.electron`. */
export function hasBridge(): boolean {
  return !!getBridge();
}

/** 독립형 파일 저장소. 예전 `isElectronFS()`(fsLoadAllPatients 존재)와 같은 조건. */
export function getFsBridge(): FsBridge | null {
  const bridge = getBridge();
  return bridge?.fsLoadAllPatients ? (bridge as unknown as FsBridge) : null;
}

/** EMR 연동(주입·추출). 키마다 셸 버전에 따라 없을 수 있어 호출부가 메서드를 확인한다. */
export function getEmrBridge(): EmrBridge | null {
  return getBridge() ?? null;
}

/** 셸 메뉴 이벤트 구독(새로 만들기·모듈 이동·통계). */
export function getMenuBridge(): MenuBridge | null {
  return getBridge() ?? null;
}

/** 창 수명·세션 신호(인트라넷 셸: 미저장 초안·토큰·종료 시 로그아웃, 공통: 통계 메뉴 사용 가능). */
export function getLifecycleBridge(): LifecycleBridge | null {
  return getBridge() ?? null;
}

/** 네이티브 alert/confirm. */
export function getDialogBridge(): DialogBridge | null {
  return getBridge() ?? null;
}

/** 독립형 셸의 직접 AI 호출. 예전 `window.electron?.analyzeAI` 존재 검사와 같은 조건. */
export function getAiBridge(): AiBridge | null {
  const analyzeAI = getBridge()?.analyzeAI;
  return analyzeAI ? { analyzeAI } : null;
}

/** 인트라넷 셸의 로컬 데이터 → 서버 이관 IPC. */
export function getMigrationBridge(): MigrationBridge | null {
  const loadLocalMigrationData = getBridge()?.loadLocalMigrationData;
  return typeof loadLocalMigrationData === 'function' ? { loadLocalMigrationData } : null;
}

/** 독립형 셸의 옛 앱 데이터 가져오기. */
export function getLegacyImportBridge(): LegacyImportBridge | null {
  const loadLegacyData = getBridge()?.loadLegacyData;
  return loadLegacyData ? { loadLegacyData } : null;
}
