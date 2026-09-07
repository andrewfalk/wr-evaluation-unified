// PR0-C: 서버 전용 self-contained entry — completion.ts와 동형 패턴(6개 모듈을 side-effect
// import해서 이 번들 안에서 전부 등록시킨다, tsup splitting:false라 entry별로 registry
// 복사본이 분리돼 있기 때문). 클라이언트는 여전히 모듈별 서브패스로만 접근한다 — 이
// 파일을 통해 접근하지 않는다(PR0-B2가 확립한 "클라이언트는 서브패스, 서버는 전용 entry"
// 원칙, completion.ts와 같은 결정 — 되돌리지 않는다).
import './modules/knee/index';
import './modules/shoulder/index';
import './modules/elbow/index';
import './modules/wrist/index';
import './modules/cervical/index';
import './modules/spine/index';

import { KNEE_METADATA } from './modules/knee/metadata';
import { SHOULDER_METADATA } from './modules/shoulder/metadata';
import { ELBOW_METADATA } from './modules/elbow/metadata';
import { WRIST_METADATA } from './modules/wrist/metadata';
import { CERVICAL_METADATA } from './modules/cervical/metadata';
import { SPINE_METADATA } from './modules/spine/metadata';

import { getExtractorForKey } from './analyticsRegistry';
import type { AnalyticsVariableMetadata, ExtractedValue, MigrationResult } from './types';
import type { AnalysisPatient } from './migration/deterministicMigrate';

// 카탈로그 조립은 registry가 아니라 각 모듈의 <X>_METADATA(타입 완전함)를 직접 이어붙인다 —
// registry(analyticsRegistry.ts)의 metadata 필드 타입은 AnalyticsVariableMetadataLike(={key})
// 뿐이라 grain/sensitivity/dependsOn 등 나머지 필드가 사라진다.
export function getFullVariableCatalog(): AnalyticsVariableMetadata[] {
  return [
    ...KNEE_METADATA,
    ...SHOULDER_METADATA,
    ...ELBOW_METADATA,
    ...WRIST_METADATA,
    ...CERVICAL_METADATA,
    ...SPINE_METADATA,
  ];
}

type ConcreteExtractorFn = (
  mr: MigrationResult<AnalysisPatient>,
  opts?: Record<string, unknown>,
) => ExtractedValue<unknown>;

/**
 * key로 등록된 extractor를 찾아 호출한다. registry의 `extractors` 타입은
 * `(...args: never[]) => unknown`이라 반환값만 캐스트해서는 호출 자체가 컴파일되지 않는다
 * (migrationResult가 never에 대입 불가, TS2345) — 함수 자체를 `as unknown as
 * ConcreteExtractorFn`으로 이중 캐스트해야 호출 가능하다. registerAnalyticsModule()이 등록
 * 시점에 key↔함수 존재를 이미 검증하므로, 이 캐스트는 "존재하지 않는 함수를 부르는" 위험은
 * 없고 시그니처 형태만 단언한다(실제 파라미터 개수·형태까지 보장하진 않음 — 그건
 * __tests__/catalog.test.ts가 카탈로그 7개 키 전부를 순회하며 실측으로 검증한다).
 */
export function computeVariableValue(
  key: string,
  migrationResult: MigrationResult<AnalysisPatient>,
  opts?: Record<string, unknown>,
): ExtractedValue<unknown> | undefined {
  const found = getExtractorForKey(key);
  if (!found) return undefined;
  const fn = found.extractor as unknown as ConcreteExtractorFn;
  return fn(migrationResult, opts);
}

// PR0-C run manifest(§1.2)의 catalogVersion/extractorVersion이 둘 다 이 값을 재사용한다 —
// 카탈로그 정의와 extractor 구현이 현재 1:1로 묶인 단일 단위이기 때문(completion.ts의
// COMPLETION_ENGINE_VERSION과 같은 "수동 올림" 관례). 카탈로그·extractor 로직이 바뀌면
// 이 값을 올린다.
export const CATALOG_VERSION = 'v1';
