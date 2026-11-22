// Module Registry - 평가 모듈 등록/검색
//
// 옛 경로 shim(REFACTORING_ROADMAP Phase 2 C5, P2-49) — 실제 구현은 ./modules/registry.ts, 매니페스트 모양·검사는
// ./modules/manifest.ts. 소비처 39곳과 테스트의 vi.mock('…/moduleRegistry') 4곳이 이 경로를 쓰므로 경로는 그대로 두고,
// 옛 JS 소비처의 타입검사가 지금과 같도록 **느슨한 서명**(any)을 붙여 다시 내보낸다. P2-100에서 없앤다.
import * as registry from './modules/registry';

/** @param {any} manifest */
export function registerModule(manifest) {
  registry.registerModule(manifest);
}

/**
 * @param {string} id
 * @returns {any}
 */
export function getModule(id) {
  return registry.getModule(id);
}

/** @returns {any[]} */
export function getAllModules() {
  return registry.getAllModules();
}

/** videoMappingConfig를 선언한 모듈만 반환(자동 입력 지원 모듈). @returns {any[]} */
export function getModulesWithVideoMapping() {
  return registry.getModulesWithVideoMapping();
}
