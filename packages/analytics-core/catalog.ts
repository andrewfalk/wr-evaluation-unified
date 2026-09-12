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
import './modules/job/index';
import './modules/diagnosis/index';

import { KNEE_METADATA } from './modules/knee/metadata';
import { SHOULDER_METADATA } from './modules/shoulder/metadata';
import { ELBOW_METADATA } from './modules/elbow/metadata';
import { WRIST_METADATA } from './modules/wrist/metadata';
import { CERVICAL_METADATA } from './modules/cervical/metadata';
import { SPINE_METADATA } from './modules/spine/metadata';
import { JOB_METADATA } from './modules/job/metadata';
import { DIAGNOSIS_METADATA } from './modules/diagnosis/metadata';

import { getExtractorForKey } from './analyticsRegistry';
import type { AnalyticsVariableMetadata, ExtractedValue, MigrationResult, RepeatedObservation } from './types';
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
    ...JOB_METADATA,
    ...DIAGNOSIS_METADATA,
  ];
}

type ConcreteExtractorFn = (
  mr: MigrationResult<AnalysisPatient>,
  opts?: Record<string, unknown>,
) => ExtractedValue<unknown>;

type ConcreteRepeatedExtractorFn = (
  mr: MigrationResult<AnalysisPatient>,
  opts?: Record<string, unknown>,
) => RepeatedObservation<unknown>[];

// PR0-B3 Part A — grain별 스칼라/반복 API 오용을 조기에 잡기 위한 lookup. 카탈로그 자체가
// 작아(수십~수백 개) 매 호출마다 재조립해도 비용이 미미하다 — Map을 모듈 전역에 캐시하면
// getFullVariableCatalog()가 side-effect import 순서에 따라 아직 완전하지 않은 시점에
// 캐시가 굳어버릴 위험이 있어 피한다.
function getVariableMetadataMap(): Map<string, AnalyticsVariableMetadata> {
  return new Map(getFullVariableCatalog().map((v) => [v.key, v]));
}

export function getVariableMetadata(key: string): AnalyticsVariableMetadata | undefined {
  return getVariableMetadataMap().get(key);
}

/**
 * key로 등록된 extractor를 찾아 호출한다. registry의 `extractors` 타입은
 * `(...args: never[]) => unknown`이라 반환값만 캐스트해서는 호출 자체가 컴파일되지 않는다
 * (migrationResult가 never에 대입 불가, TS2345) — 함수 자체를 `as unknown as
 * ConcreteExtractorFn`으로 이중 캐스트해야 호출 가능하다. registerAnalyticsModule()이 등록
 * 시점에 key↔함수 존재를 이미 검증하므로, 이 캐스트는 "존재하지 않는 함수를 부르는" 위험은
 * 없고 시그니처 형태만 단언한다(실제 파라미터 개수·형태까지 보장하진 않음 — 그건
 * __tests__/catalog.test.ts가 카탈로그 case grain 키 전부를 순회하며 실측으로 검증한다).
 *
 * PR0-B3 Part A — 반복 grain(diagnosis_side/job/job_diagnosis/task/vibration_interval) 키를
 * 이 함수로 호출하면 그 extractor는 실제로 배열(RepeatedObservation[])을 반환하는데 이
 * 함수는 스칼라 shape을 가정한다 — 조용한 오동작을 막기 위해 grain을 먼저 확인해 명확히
 * throw한다(computeRepeatedVariableValue를 쓰라고 안내).
 */
export function computeVariableValue(
  key: string,
  migrationResult: MigrationResult<AnalysisPatient>,
  opts?: Record<string, unknown>,
): ExtractedValue<unknown> | undefined {
  const found = getExtractorForKey(key);
  if (!found) return undefined;
  const metadata = getVariableMetadata(key);
  if (metadata && metadata.grain !== 'case' && metadata.grain !== 'person') {
    throw new Error(
      `computeVariableValue: "${key}"는 grain "${metadata.grain}"(반복 grain)이라 스칼라 API로 호출할 수 없다 — computeRepeatedVariableValue를 쓸 것`,
    );
  }
  const fn = found.extractor as unknown as ConcreteExtractorFn;
  return fn(migrationResult, opts);
}

/** computeVariableValue의 반복 grain 대응 — grain이 'case'/'person'이면 반대로 거부한다. */
export function computeRepeatedVariableValue(
  key: string,
  migrationResult: MigrationResult<AnalysisPatient>,
  opts?: Record<string, unknown>,
): RepeatedObservation<unknown>[] | undefined {
  const found = getExtractorForKey(key);
  if (!found) return undefined;
  const metadata = getVariableMetadata(key);
  if (metadata && (metadata.grain === 'case' || metadata.grain === 'person')) {
    throw new Error(
      `computeRepeatedVariableValue: "${key}"는 grain "${metadata.grain}"(스칼라 grain)이라 반복 API로 호출할 수 없다 — computeVariableValue를 쓸 것`,
    );
  }
  const fn = found.extractor as unknown as ConcreteRepeatedExtractorFn;
  return fn(migrationResult, opts);
}

// PR0-C run manifest(§1.2)의 catalogVersion/extractorVersion이 둘 다 이 값을 재사용한다 —
// 카탈로그 정의와 extractor 구현이 현재 1:1로 묶인 단일 단위이기 때문(completion.ts의
// COMPLETION_ENGINE_VERSION과 같은 "수동 올림" 관례). 카탈로그·extractor 로직이 바뀌면
// 이 값을 올린다.
// PR0-B3 Part A — 7개→9개(반복 관측치 계약 신설: vibration_interval grain 변수 2개)로
// 카탈로그·extractor 계약 자체가 바뀌어 v2로 올린다(statsExecutionDigest.ts의 캐시 키에도
// 이 값이 들어가므로, 안 올리면 옛 카탈로그 기준 캐시 결과가 그대로 재사용된다).
// PR0-B3 Part B — 9개→15개(diagnosis_side grain 신설: K-L Grade/Ellman Class/확정상병상태/
// 신청≠확정 여부 4종 + case grain 2종: 척추 수직분포/동반 척추증)로 다시 올린다.
// PR0-B3 Part C-1 — 15개→18개(job grain 신설: 직종명(정규화)·근속기간 2종 + case grain
// 1종: 대표 직종명(근속 최장) roll-up 최초 구현)로 다시 올린다.
// PR0-B3 Part C-2 — 18개→21개(task grain 신설: MDDM 작업 중량물·빈도 2종 + diagnosis_side
// grain 1종: 신청상병 부위군, diagnosisMapping.ts 정규식 버그 수정 후 처음 파생 가능해짐).
// server 전용 SNAPSHOT_COLUMN_VARIABLES(담당의·등록일)는 이 상수가 커버하지 않는다 —
// server/src/statsSnapshotColumnVariables.ts의 SERVER_CATALOG_EXTENSION_VERSION이 별도로
// 관리하고, 둘을 합성한 문자열을 GET /catalog·statsRunManifest.ts·statsExecutionDigest.ts
// 세 곳에 함께 쓴다(계획 "통합 카탈로그" 절 — server/src/statsCatalogVersion.ts 참고).
export const CATALOG_VERSION = 'v5-task-grain-diagnosis-module-group';
