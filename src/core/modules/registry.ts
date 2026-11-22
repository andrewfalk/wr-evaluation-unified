// 모듈 레지스트리 — 평가 모듈 등록·조회(REFACTORING_ROADMAP Phase 2 C5, P2-49·P2-50).
//
// 옛 경로 src/core/moduleRegistry.js는 이 파일을 다시 내보내는 shim이다(옛 JS 소비처와 vi.mock 경로가 그대로 동작하도록 —
// 새 코드도 레지스트리는 shim 경로로 읽는다). 등록 순서는 운영에서는 src/modules/index.ts가 정한다. getAllModules()는 그 순서를
// 그대로 돌려준다.
//
// P2-50: 매니페스트 검사(validateManifest)에 걸리면 **throw**한다 — 등록은 앱 시작 때 결정적으로 돌고, G9 스모크가 실제 6모듈을
// 등록하므로 테스트에서 통과하면 운영에서도 통과한다. 같은 id 재등록도 throw한다. 다만 기본 인스턴스는 개발 모드
// (import.meta.env.DEV — 개발 서버와 vitest)에서 교체를 허용한다: 개발 서버의 HMR이 모듈 index.js를 다시 실행하면 같은 id로
// 다시 등록되기 때문이다. 교체 때는 자리를 그대로 두고 내용만 바꾼다(옛 Map 동작).
import { validateManifest, type ModuleManifest } from './manifest';

export interface ModuleRegistryOptions {
  /** 같은 id 재등록을 교체로 허용할지(기본 false — throw). */
  allowReplace?: boolean;
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
  const allowReplace = options.allowReplace ?? false;
  return {
    register(manifest) {
      const problems = validateManifest(manifest);
      if (problems.length > 0) {
        throw new TypeError(
          `[moduleRegistry] 모듈 '${manifestLabel(manifest)}' 매니페스트 문제 ${problems.length}건: ${problems.join(' / ')}`,
        );
      }
      if (modules.has(manifest.id) && !allowReplace) {
        throw new Error(`[moduleRegistry] 모듈 id '${manifest.id}'가 이미 등록돼 있습니다`);
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

const defaultRegistry = createModuleRegistry({ allowReplace: import.meta.env.DEV });

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
