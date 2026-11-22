// 모듈 레지스트리 — 평가 모듈 등록·조회(REFACTORING_ROADMAP Phase 2 C5, P2-49).
//
// 옛 경로 src/core/moduleRegistry.js는 이 파일을 다시 내보내는 shim이다(옛 JS 소비처와 vi.mock 경로가 그대로 동작하도록 —
// 새 코드도 레지스트리는 shim 경로로 읽는다). 등록 순서는 운영에서는 src/modules/index.ts가 정한다. getAllModules()는 그 순서를
// 그대로 돌려주고, 같은 id를 다시 등록하면 자리는 그대로 두고 내용만 바꾼다(옛 Map 동작 그대로).
//
// P2-49: 매니페스트 검사(validateManifest) 결과는 **경고만** 한다 — 등록은 지금처럼 그대로 된다.
import { validateManifest, type ModuleManifest } from './manifest';

export interface ModuleRegistryOptions {
  /** 검사 문제를 알리는 곳(기본 console.warn). */
  warn?: (message: string) => void;
}

export interface ModuleRegistry {
  register(manifest: ModuleManifest): void;
  get(id: string): ModuleManifest | undefined;
  all(): ModuleManifest[];
}

function manifestLabel(manifest: unknown): string {
  if (typeof manifest === 'object' && manifest !== null && 'id' in manifest) {
    const { id } = manifest as { id: unknown };
    if (typeof id === 'string' && id) return id;
  }
  return '(id 없음)';
}

export function createModuleRegistry(options: ModuleRegistryOptions = {}): ModuleRegistry {
  const modules = new Map<string, ModuleManifest>();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  return {
    register(manifest) {
      const problems = validateManifest(manifest);
      if (problems.length > 0) {
        warn(`[moduleRegistry] 모듈 '${manifestLabel(manifest)}' 매니페스트 문제 ${problems.length}건: ${problems.join(' / ')}`);
      }
      modules.set(manifest.id, manifest);
    },
    get(id) {
      return modules.get(id);
    },
    all() {
      return Array.from(modules.values());
    },
  };
}

const defaultRegistry = createModuleRegistry();

export function registerModule(manifest: ModuleManifest): void {
  defaultRegistry.register(manifest);
}

export function getModule(id: string): ModuleManifest | undefined {
  return defaultRegistry.get(id);
}

export function getAllModules(): ModuleManifest[] {
  return defaultRegistry.all();
}

/** videoMappingConfig를 선언한 모듈만(자동 입력 지원 모듈). */
export function getModulesWithVideoMapping(): ModuleManifest[] {
  return getAllModules().filter(mod => Boolean(mod.videoMappingConfig));
}
