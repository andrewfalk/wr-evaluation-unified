// Module Registry - 평가 모듈 등록/검색
const modules = new Map();

export function registerModule(manifest) {
  modules.set(manifest.id, manifest);
}

export function getModule(id) {
  return modules.get(id);
}

export function getAllModules() {
  return Array.from(modules.values());
}
