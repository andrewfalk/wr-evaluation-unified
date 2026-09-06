// PR0-B2 §5.5: 서버가 클라이언트 신고(server_observed_modules_complete_at, PR0-A)에
// 의존하지 않고 6개 모듈의 완료 여부를 직접 판정한다 — server_verified_modules_complete_at.
// src/core/utils/patientCompletion.js의 isPatientComplete()와 동일한 의미론(활성 모듈
// 전부의 isComplete()가 참)을 서버에서 재현한다.
//
// 이 파일을 import하면 6개 모듈이 side-effect로 전부 analyticsRegistry에 등록된다.
// 서버는 이 파일 하나만 import한다(완료판정 외 다른 export는 필요 없음) — 다른 곳에서
// import된 각 모듈 index.ts는 이 파일과 별개의 tsup 번들이라 서로 상태를 공유하지 않는다
// (splitting:false — 각 entry가 완전히 독립된 번들).
import './modules/knee/index';
import './modules/shoulder/index';
import './modules/elbow/index';
import './modules/wrist/index';
import './modules/cervical/index';
import './modules/spine/index';

import { getAnalyticsModule } from './analyticsRegistry';

/** isComplete가 실제로 요구하는 최소 payload 형태 — CompletionContext와 달리 module은
 * 6개 모듈 전체의 맵이다(각 모듈 호출 시 그 모듈 항목만 골라 CompletionContext로 좁힌다). */
export interface VerifiablePatientData {
  shared: Record<string, unknown>;
  modules: Record<string, unknown>;
  activeModules: string[];
}

export interface ModuleCompletionResult {
  moduleId: string;
  complete: boolean;
  /** true면 이 moduleId가 analyticsRegistry에 없거나(미등록·오타), 그 모듈의 데이터가
   * 구조적으로 유효하지 않거나(undefined/null/배열/원시값 — 아래 방어 참고), isComplete
   * 실행 자체가 예외를 던졌다는 뜻 — complete는 이 경우 항상 false로 강제된다. */
  errored: boolean;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export function verifyModuleCompletion(patientData: VerifiablePatientData, moduleId: string): ModuleCompletionResult {
  const registration = getAnalyticsModule(moduleId);
  if (!registration) {
    return { moduleId, complete: false, errored: true };
  }
  // §리뷰 지적(P1): 모듈 데이터가 없거나(undefined) 손상됐으면(null/배열/문자열 등)
  // isComplete를 아예 호출하지 않고 여기서 차단한다. 이전에는 이 경우 `{}`로 대체해서
  // isComplete를 그대로 호출했는데, 무릎처럼 isComplete가 module 파라미터를 전혀 읽지
  // 않는 모듈에서는 shared 쪽에 완료된 진단만 있으면 module 데이터가 통째로 없거나
  // 깨져 있어도 true를 반환했다 — 모듈 데이터 무결성과 무관하게 완료로 오판하는 구멍.
  const moduleData = patientData.modules[moduleId];
  if (!isRecord(moduleData)) {
    return { moduleId, complete: false, errored: true };
  }
  try {
    const complete = registration.isComplete({
      shared: patientData.shared,
      module: moduleData,
      activeModules: patientData.activeModules,
    });
    return { moduleId, complete, errored: false };
  } catch {
    // isComplete 자체가 방어적이지 않을 수 있다(예: 예상치 못한 타입의 필드) — 완료판정
    // 실행이 서버 요청 자체를 500으로 죽이면 안 되므로 여기서 흡수하고 errored로 보고한다.
    return { moduleId, complete: false, errored: true };
  }
}

export interface VerifyAllModulesResult {
  allComplete: boolean;
  results: ModuleCompletionResult[];
  /** 미등록이거나 isComplete가 예외를 던진 moduleId — 진단·모니터링용. */
  errorModuleIds: string[];
  /** 정상 실행됐지만 complete=false인 moduleId — 진단·모니터링용. */
  failedModuleIds: string[];
}

/**
 * patientData.activeModules 전체가 완료 상태인지 판정한다. 빈 activeModules는
 * isPatientComplete()와 동일하게 미완료(allComplete=false)로 취급한다.
 */
export function verifyAllModulesComplete(patientData: VerifiablePatientData): VerifyAllModulesResult {
  const moduleIds = Array.isArray(patientData.activeModules) ? patientData.activeModules : [];
  if (moduleIds.length === 0) {
    return { allComplete: false, results: [], errorModuleIds: [], failedModuleIds: [] };
  }

  const results = moduleIds.map((moduleId) => verifyModuleCompletion(patientData, moduleId));
  const errorModuleIds = results.filter((r) => r.errored).map((r) => r.moduleId);
  const failedModuleIds = results.filter((r) => !r.errored && !r.complete).map((r) => r.moduleId);
  const allComplete = results.every((r) => r.complete);

  return { allComplete, results, errorModuleIds, failedModuleIds };
}

// DB에 stamp되는 값 — verifyAllModulesComplete/isComplete 판정 로직 자체가 나중에
// 바뀌면(버그 수정, 완료 기준 변경 등) 과거에 "검증됨"으로 찍힌 행이 실제로는 새 기준으로
// 재검증하면 다른 결과가 나올 수 있다. 그 사실을 추적할 수 있도록 판정 시점의 로직 버전을
// 함께 기록한다 — 로직을 바꿀 때마다 이 값을 올린다.
export const COMPLETION_ENGINE_VERSION = 'v1';
