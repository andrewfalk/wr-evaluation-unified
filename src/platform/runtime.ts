// 실행 환경 판정 — REFACTORING_ROADMAP Phase 2 C1(P2-10). React 상태와 무관한 정적 사실만 다룬다
// (dataMode·apiBaseUrl·serverFeatures는 설정·세션에 따라 바뀌므로 C3-C의 PlatformProvider가 제공).
import { getBridge, type Bridge } from './bridge';

export type Host = 'web' | 'electron';
export type BuildTarget = 'standalone' | 'intranet' | 'web' | 'unknown';

export interface Runtime {
  host: Host;
  buildTarget: BuildTarget;
  /** 셸이 창 닫기·새로고침을 가로채 미저장 초안을 확인한다(인트라넷 셸 setHasUnsavedDraft). 없으면 beforeunload가 안전망. */
  hasNativeCloseGuard: boolean;
  /** 독립형 파일 저장소(fs-* IPC). */
  hasLocalFileStore: boolean;
  /** 셸이 사용자 키로 AI를 직접 부른다(독립형 analyzeAI). */
  hasDirectAi: boolean;
}

/**
 * 구 셸 폴백(현장 설치본에는 preload의 buildTarget이 없다 — E0 배포는 Phase 3): 노출된 키로 빌드 타깃을 추측한다.
 * 이 함수가 키 존재 추측의 유일한 자리다(사용자 결정 4 — 폴백 1벌 유지).
 *   fsLoadAllPatients → standalone / setAccessToken·onQuitRequested·loadLocalMigrationData → intranet /
 *   그 밖(허용 안 된 origin의 {} 포함) → unknown.
 */
export function inferBuildTargetFromKeys(bridge: Bridge): BuildTarget {
  if (bridge.fsLoadAllPatients) return 'standalone';
  if (bridge.setAccessToken || bridge.onQuitRequested || bridge.loadLocalMigrationData) return 'intranet';
  return 'unknown';
}

export function detectRuntime(bridge: Bridge | undefined = getBridge()): Runtime {
  if (!bridge) {
    return { host: 'web', buildTarget: 'web', hasNativeCloseGuard: false, hasLocalFileStore: false, hasDirectAi: false };
  }
  const declared = bridge.buildTarget;
  const buildTarget: BuildTarget = declared === 'standalone' || declared === 'intranet'
    ? declared
    : inferBuildTargetFromKeys(bridge);
  return {
    host: 'electron',
    buildTarget,
    hasNativeCloseGuard: !!bridge.setHasUnsavedDraft,
    hasLocalFileStore: !!bridge.fsLoadAllPatients,
    hasDirectAi: !!bridge.analyzeAI,
  };
}
