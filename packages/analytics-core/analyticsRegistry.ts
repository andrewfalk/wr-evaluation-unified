// 모듈 정의의 단일 진실원(계획서 §4.3). src/core/moduleRegistry.js(UI용, 기존)와 이름
// 충돌을 피하려고 analyticsRegistry로 명명했다.
//
// registerAnalyticsModule() 호출 즉시(모듈 로드 시점) 동기 검증한다 — "빌드 시 차단"을
// 별도 스크립트로 만들지 않고, 패키지가 로드되는 모든 곳(테스트·서버·브라우저 번들)에서
// 항상 검증되게 한다.

export interface AnalyticsVariableMetadataLike {
  key: string;
}

export interface AnalyticsModuleRegistration {
  moduleId: string;
  metadata: AnalyticsVariableMetadataLike[];
  extractors: Record<string, (...args: never[]) => unknown>;
}

const registeredKeys = new Map<string, string>(); // variable key → moduleId(디버깅용)

export function registerAnalyticsModule(registration: AnalyticsModuleRegistration): void {
  const { moduleId, metadata, extractors } = registration;

  const seenInThisCall = new Set<string>();
  for (const entry of metadata) {
    if (registeredKeys.has(entry.key)) {
      throw new Error(
        `analyticsRegistry: duplicate variable key "${entry.key}" (module "${moduleId}", already registered by "${registeredKeys.get(entry.key)}")`,
      );
    }
    if (seenInThisCall.has(entry.key)) {
      // 같은 registerAnalyticsModule() 호출의 metadata 배열 안에서 key가 중복되는
      // 경우 — 전역 registeredKeys에는 아직 하나도 안 들어간 상태라 위 검사만으로는
      // 못 잡는다(리뷰로 발견됨). 별도 Set으로 이번 호출 내부 중복도 함께 막는다.
      throw new Error(
        `analyticsRegistry: duplicate variable key "${entry.key}" within the same registerAnalyticsModule() call (module "${moduleId}")`,
      );
    }
    seenInThisCall.add(entry.key);
    if (typeof extractors[entry.key] !== 'function') {
      throw new Error(
        `analyticsRegistry: metadata key "${entry.key}" has no matching extractor (module "${moduleId}")`,
      );
    }
  }

  const metadataKeys = seenInThisCall;
  for (const extractorKey of Object.keys(extractors)) {
    if (!metadataKeys.has(extractorKey)) {
      throw new Error(
        `analyticsRegistry: extractor "${extractorKey}" has no matching metadata entry (module "${moduleId}")`,
      );
    }
  }

  for (const entry of metadata) {
    registeredKeys.set(entry.key, moduleId);
  }
}

export function getRegisteredVariableKeys(): string[] {
  return Array.from(registeredKeys.keys());
}

/** 테스트 전용 — 등록 상태를 초기화해 각 테스트가 격리된 registry를 갖게 한다. */
export function __resetAnalyticsRegistryForTests(): void {
  registeredKeys.clear();
}
