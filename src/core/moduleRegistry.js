// Module Registry - 평가 모듈 등록/검색
const modules = new Map();

/**
 * 영상 분석 자동 매핑 설정(선택, §8.10). 미선언 모듈은 자동 입력 대상에서 제외(수기만, 하위호환 §8.15).
 * @typedef {Object} VideoMappingConfig
 * @property {'job'|'task'|'job-diagnosis'} scope - 적용 단위(jobExtras / tasks / 진단별)
 * @property {string[]} featureKeys - 이 모듈이 소비하는 FeatureKey(자동제안 대상; candidate 제외)
 * @property {(featureKey: string, value: any) => any} [coerce] - 모듈 필드 타입으로 변환(String/number)
 * @property {(moduleData: object, ctx: object, featureKey: string, value: any) =>
 *   {moduleData: object, previousValue: any, targetPath: string}} writeField - 원자값 기입(불변)
 */

export function registerModule(manifest) {
  modules.set(manifest.id, manifest);
}

export function getModule(id) {
  return modules.get(id);
}

export function getAllModules() {
  return Array.from(modules.values());
}

/** videoMappingConfig를 선언한 모듈만 반환(자동 입력 지원 모듈). */
export function getModulesWithVideoMapping() {
  return getAllModules().filter((m) => !!m.videoMappingConfig);
}
