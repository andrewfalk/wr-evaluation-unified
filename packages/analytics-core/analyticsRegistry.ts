// 모듈 정의의 단일 진실원(계획서 §4.3). src/core/moduleRegistry.js(UI용, 기존)와 이름
// 충돌을 피하려고 analyticsRegistry로 명명했다.
//
// registerAnalyticsModule() 호출 즉시(모듈 로드 시점) 동기 검증한다 — "빌드 시 차단"을
// 별도 스크립트로 만들지 않고, 패키지가 로드되는 모든 곳(테스트·서버·브라우저 번들)에서
// 항상 검증되게 한다.

export interface AnalyticsVariableMetadataLike {
  key: string;
}

// PR0-B2 §1-2: 서버 완료판정(completion.ts)이 6개 모듈의 isComplete를 공통 시그니처로
// 호출하기 위한 계약. strict TS의 strictFunctionTypes 아래서 각 모듈 함수의 좁은 파라미터
// 타입(예: knee는 shared만, module 없음)을 그대로 registry 필드에 대입할 수 없으므로,
// 각 모듈은 이 타입을 파라미터로 직접 받고 함수 본문 안에서 필요한 필드를 좁혀 쓴다.
export interface CompletionContext {
  shared: Record<string, unknown>;
  module: Record<string, unknown>;
  activeModules: string[];
}

export interface AnalyticsModuleRegistration {
  moduleId: string;
  metadata: AnalyticsVariableMetadataLike[];
  extractors: Record<string, (...args: never[]) => unknown>;
  isComplete: (ctx: CompletionContext) => boolean;
}

const registeredKeys = new Map<string, string>(); // variable key → moduleId(디버깅용)
const registeredModules = new Map<string, AnalyticsModuleRegistration>();

export function registerAnalyticsModule(registration: AnalyticsModuleRegistration): void {
  const { moduleId, metadata, extractors } = registration;

  if (registeredModules.has(moduleId)) {
    throw new Error(`analyticsRegistry: duplicate moduleId "${moduleId}"`);
  }

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
  registeredModules.set(moduleId, registration);
}

export function getRegisteredVariableKeys(): string[] {
  return Array.from(registeredKeys.keys());
}

/** PR0-B2 §1-2: completion.ts가 모듈별 isComplete를 조회하는 데 쓴다. */
export function getAnalyticsModule(moduleId: string): AnalyticsModuleRegistration | undefined {
  return registeredModules.get(moduleId);
}

/**
 * PR0-C: catalog.ts의 getExtractorForKey()가 key → extractor 역방향 조회를 위해 내부적으로만
 * 순회한다. **메타데이터 조회 용도가 아니다** — `metadata`의 타입은 `AnalyticsVariableMetadataLike`
 * (={key})뿐이라 grain/sensitivity 등 나머지 필드가 없다. 전체 카탈로그가 필요하면 각 모듈의
 * `<X>_METADATA`(타입 완전함)를 직접 import해서 합칠 것 — catalog.ts가 그렇게 한다.
 */
export function getAllModuleRegistrations(): AnalyticsModuleRegistration[] {
  return Array.from(registeredModules.values());
}

/**
 * PR0-C: 변수 key → 그 key를 등록한 모듈의 extractor 함수. `extractor`의 타입은
 * `(...args: never[]) => unknown`이라 반환값은 물론 호출 자체도 이 타입 그대로는 불가능하다
 * (인자가 `never`에 대입되지 않아 TS2345) — 호출부(catalog.ts)가 함수 전체를 `as unknown as
 * ConcreteExtractorFn`으로 이중 캐스트해야 한다. registerAnalyticsModule()이 등록 시점에
 * key↔함수 존재를 이미 검증했으므로, 이 함수가 반환하는 값은 항상 실제 함수다.
 */
export function getExtractorForKey(
  key: string,
): { moduleId: string; extractor: (...args: never[]) => unknown } | undefined {
  const moduleId = registeredKeys.get(key);
  if (!moduleId) return undefined;
  const registration = registeredModules.get(moduleId);
  if (!registration) return undefined;
  const extractor = registration.extractors[key];
  if (typeof extractor !== 'function') return undefined;
  return { moduleId, extractor };
}

/** 테스트 전용 — 등록 상태를 초기화해 각 테스트가 격리된 registry를 갖게 한다. */
export function __resetAnalyticsRegistryForTests(): void {
  registeredKeys.clear();
  registeredModules.clear(); // 기존엔 registeredKeys만 초기화했음 — 누락되면 테스트 간 오염
}
