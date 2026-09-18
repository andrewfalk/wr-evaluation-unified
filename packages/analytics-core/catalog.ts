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
import './modules/patient/index';

import { KNEE_METADATA } from './modules/knee/metadata';
import { SHOULDER_METADATA } from './modules/shoulder/metadata';
import { ELBOW_METADATA } from './modules/elbow/metadata';
import { WRIST_METADATA } from './modules/wrist/metadata';
import { CERVICAL_METADATA } from './modules/cervical/metadata';
import { SPINE_METADATA } from './modules/spine/metadata';
import { JOB_METADATA } from './modules/job/metadata';
import { DIAGNOSIS_METADATA } from './modules/diagnosis/metadata';
import { PATIENT_METADATA } from './modules/patient/metadata';

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
    ...PATIENT_METADATA,
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
  if (metadata && metadata.grain !== 'case') {
    throw new Error(
      `computeVariableValue: "${key}"는 grain "${metadata.grain}"(반복 grain)이라 스칼라 API로 호출할 수 없다 — computeRepeatedVariableValue를 쓸 것`,
    );
  }
  const fn = found.extractor as unknown as ConcreteExtractorFn;
  return fn(migrationResult, opts);
}

/** computeVariableValue의 반복 grain 대응 — grain이 'case'면 반대로 거부한다. */
export function computeRepeatedVariableValue(
  key: string,
  migrationResult: MigrationResult<AnalysisPatient>,
  opts?: Record<string, unknown>,
): RepeatedObservation<unknown>[] | undefined {
  const found = getExtractorForKey(key);
  if (!found) return undefined;
  const metadata = getVariableMetadata(key);
  if (metadata && metadata.grain === 'case') {
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
// PR0-B4 Slice 1 — 21개→36개(spine 잔여 필드 15종: case grain 7 + task grain 4 + vibration_
// interval grain 4). 매핑표(coverage/PR0-B4-field-mapping.md §4)·fixture(coverage/
// pr0B4FieldMapping.ts) 참고.
// PR0-B4 Slice 2~6 — 36개→71개. Slice 2: job 잔여 3(§1). Slice 3: shoulder jobExtras
// 6(§3). Slice 4: knee jobExtras 8(§2, DEFERRED 6개 포함). Slice 5: 신규 patient
// pseudo-module 8(§1). Slice 6: diagnosis 잔여 10(§1, code/name/assessment.status +
// lowReason 옵션 7개).
// 8차 검토(Slice 2~6 리뷰) 결함 수정 — 키 개수는 그대로지만 기존 등록 키의 추출 결과값이
// 바뀌어 캐시된 실행 다이제스트 무효화가 필요하다: (1) 축성(척추/경추) 진단의
// assessment.status/lowReason.*가 side='unspecified'라는 이유만으로 무조건 결측 처리되던
// 버그 수정, (2) lowReason 다중선택 배열 판정을 §계약 순서(undefined→structural_missing,
// 비배열/원소손상→invalid, 정상배열(빈배열포함)→false)로 재정렬, (3) knee.job.weight/
// squatting·shoulder.job.* 숫자 추출에 typeof 사전검증 추가(배열·부분숫자문자열·음수 차단).
// 9차 검토(위 수정에 대한 재검토) 잔여 결함 2건 수정 — 역시 결과값 변경: (4) 축성 판정
// 라우팅(resolveAssessmentSide)이 activeModules=[]로 고정돼 있어, UI의 "활성 모듈이
// 1개뿐일 때 코드/명 미매칭 진단을 그 모듈로 fallback"하는 실제 저장 규칙을 놓치던 버그
// 수정(부위군 분류 변수 extractDiagnosisIdentityModuleGroup은 의도적으로 계속 activeModules=[]
// 유지 — 별개 정책), (5) knee.job.weight/squatting·shoulder.job.*의 빈 값 판정이
// isBlank(String(x) 강제변환)를 typeof 검사보다 먼저 호출해 []·[null]도 "빈 값"으로
// 오인하던 버그 수정(null/undefined/공백 문자열만 빈 값으로 좁힘).
// PR0-B4 Slice 7 — 71개→80개. 신설 cervical_task grain(spine의 기존 task grain과 완전
// 분리) 9개: name·exposureType 2종(다중선택 옵션 2개뿐)·게이트된 6개(loadWeightKg/
// carryHoursPerShift/forcedNeckPosture는 exposure_types에 shoulder_heavy_load 포함 시만,
// neckNonneutralHoursPerDay/combinedFlexionRotationPosture/precisionWork는
// awkward_static_neck_load 포함 시만 — 그 외엔 not_applicable). types.ts/shared/contracts/
// stats.ts의 grain 유니온, grainEntities.ts의 enumerateCervicalTaskEntities,
// statsDatasetBuilder.ts/statsRecipeValidation.ts/routes/stats.ts 3곳 배선 완료.
// PR0-B4 Slice 8a/8b — 80개→116개. Slice 8a: elbow/wrist temporal 4개씩(병합 결과
// temporalSequence?? temporalRelation 기준 case grain, temporalSequence/temporalRelation
// 각각은 변수화하지 않음). Slice 8b: job_diagnosis grain 활성화(기존 미지원 grain, 타입/
// 스키마는 PR0-B3부터 존재) — grainEntities.ts의 enumerateJobDiagnosisEntities가
// normalizeElbowModuleData/normalizeWristModuleData의 cross join(jobEvaluations[].
// diagnosisEntries[])을 그대로 재사용해 elbow+wrist 공유 모집단을 만든다. BK유형과 무관한
// 공통 필드 14개씩(selectedBkType·mainTaskName·directAnatomicLink·exposureType 3종·
// repetitionLevel·forceLevel·awkwardPostureLevel·workPattern·restDistribution·
// dailyExposureHours·shiftSharePercent·daysPerWeek) 등록, BK 분기 전용 필드는 Slice 8c로
// 보류. statsDatasetBuilder.ts/statsRecipeValidation.ts/routes/stats.ts에 job_diagnosis
// 배선 완료(ALL_GRAINS에는 PR0-B3부터 이미 있었음 — SUPPORTED_GRAINS_SET만 추가).
// 9차 검토(Slice 8a/8b 리뷰) 결함 수정 — 키 개수는 그대로지만 추출 결과값이 바뀌어
// 캐시된 실행 다이제스트 무효화가 필요하다: enumerateJobDiagnosisEntities가 ':' 포함
// id로 첫 직력을 배제하기 전에(즉 정규화 호출 이전에) 배제해버려, buildLegacyEntryMap의
// firstJobId 폴백이 실제로는 두 번째 직력을 가리키게 되고 linkedJobId 없는 레거시
// 노출값이 그 직력으로 잘못 옮겨 붙던 버그 수정 — dedup은 정규화 호출 전에, ':' 배제는
// 정규화 이후 엔터티 생성 시점으로 이동(행 생성과 기존 값의 직력 귀속을 분리).
// 10차 검토(위 수정에 대한 재검토) 잔여 결함 수정 — 9차 수정은 ':' 포함 id만 옮겼을 뿐,
// 숫자·빈 문자열·undefined id를 가진 첫 직력은 여전히 정규화 호출 *전에* dedup 필터에서
// 제거돼 같은 버그(레거시 값이 다음 직력으로 옮겨 붙음)가 재현됐다 — 유효한 문자열 id를
// 가진 job만 dedup하고 그 외는 원본 위치 그대로 정규화에 전달하도록 수정.
// 11차 검토(위 수정에 대한 재검토) 잔여 결함 수정 — 10차 수정이 첫 직력을 정규화까지
// 그대로 통과시키면서, buildLegacyEntryMap의 `${sharedJobId}:${diagnosisId}` 문자열
// 템플릿 키가 숫자 123과 문자열 '123'을 같은 문자열로 합쳐버리는 새로운 충돌이 드러남
// (숫자 첫 직력의 레거시 값이 무관한 문자열 '123' 직력으로 유출). firstJobId가
// 존재하지만(truthy) 안전하게 쓸 수 없는 값(숫자·':' 포함 등)이면, linkedJobId 없는
// (이 폴백에 의존하는) 레거시 항목을 정규화 호출 전에 제거하도록 수정
// (stripUnroutableLegacyEntries) — linkedJobId가 명시된 항목은 보존.
// 12차 검토(위 수정에 대한 재검토) 잔여 결함 수정 — 11차 수정은 firstJobId가 위험할
// 때만 linkedJobId 없는 항목을 걸렀을 뿐, linkedJobId가 명시돼 있어도 그 값 자체의
// 타입은 검사하지 않았고 diagnosisId는 아예 검사 대상이 아니었다 — 숫자 linkedJobId/
// diagnosisId가 문자열 '123'/'7' 같은 무관한 직력·진단과 충돌 가능. firstJobId 위험
// 여부와 무관하게 매 레거시 항목마다 실제 연결 대상 job id(linkedJobId 우선, 없으면
// firstJobId)와 diagnosisId를 각각 usable 문자열인지 검사하도록 일반화(
// sanitizeLegacyDiagnosisEvaluations로 개명) — 손상되면 첫 직력으로 재위임하지 않고
// 그 항목 자체를 제외, 유효한 문자열 참조는 그대로 우선순위 유지.
// 13차 검토(위 수정에 대한 재검토) 잔여 결함 수정 — `record.linkedJobId || firstJobId`
// (12차 수정)는 0·false처럼 "값은 있지만 falsy인" 손상 타입도 "진짜 미입력"과 똑같이
// 취급해 firstJobId(정상값)로 조용히 재위임했다. undefined/null/빈 문자열(진짜 미입력)
// 과 0·false·숫자 등(명시적이지만 손상된 타입)을 truthy 여부가 아니라 별도 판정
// (isBlankLinkedReference)으로 구분 — 후자는 firstJobId 유효성과 무관하게 무조건 제외.
//
// Slice 8c 구현후 리뷰 지적 수정 — bk2105/2106_pressure_source·bk2103_vibration_tool_type
// 다중선택 필드는 normalizeDiagnosisEntry(legacyNormalize.ts)의 ARRAY_ONLY_FIELDS 보정이
// 손상값(비배열·null)을 조용히 []로 바꿔버려 extractor가 §다중선택 배열 계약대로 invalid를
// 매기지 못했다(정상 미선택과 손상값이 똑같이 false로 집계됨) — 정규화가 남기는
// `_corruptedArrayFields` 마커로 손상 여부를 보존해 extractor가 다시 invalid를 매기도록
// 수정(elbow/wrist 동일). 키 집합은 그대로지만 이 필드들의 출력값이 바뀌므로 버전을
// 올린다.
//
// 위 수정에 대한 재검토 지적 — _corruptedArrayFields를 donor 점수·복사 대상(BK_GROUP_
// META_FIELDS)에서 뺀 것까지는 맞았지만, 그 결과 도너의 손상된 필드값([]로 보정된 값)을
// 복사받은 entry가 inferred_link만 붙고 invalid 없이 정상 미선택으로 집계됐다("복사한다고
// 값의 신뢰성이 회복되지 않는다"). donor-copy 루프에서 필드별로 도너의 손상 여부를 함께
// 전달하도록 수정 — 손상 필드를 물려받으면 손상 표시도 같이 옮기고, 정상 필드로 덮어쓰면
// 수신자의 이전 손상 표시를 지운다.
//
// grain 단순화 + 공통변수 브로드캐스트(PR0-B4 개정) — 7개 grain(person/case/diagnosis_side/
// job/job_diagnosis/task/cervical_task/vibration_interval)을 4개(person/case/job/disease)로
// 축소. job_diagnosis(87)/task(6)/cervical_task(9)/vibration_interval(6) 총 108개 변수를
// 소스코드까지 완전 삭제, diagnosis_side→disease로 rename(15개, 행 단위는 "상병×측" 그대로
// 불변), patient 모듈 6개(gender/heightCm/weightKg/birthDate/highBloodPressure/diabetes)를
// case→person으로 재배치, 신규 patient.identity.bmi(person) 추가, spine.case.{careerYears,
// careerMonths,evalMethod} 3개 삭제. 카탈로그 65개(person 7/case 24/job 19/disease 15) +
// 서버 전용 meta 2개(통합 카탈로그 67개). person/case↔job/disease 방향(그리고 person↔case
// 상호간)으로 브로드캐스트 안전 변수(quasi_identifier·high_cardinality 제외) 선택 허용 —
// statsRecipeValidation.ts/statsDatasetBuilder.ts/CatalogPanel.jsx/RecipePanel.jsx가
// analytics-core/common.ts의 isGrainCompatible을 공유.
//
// person grain 삭제(PR0-B4 후속, v20 대비) — v20에서 활성화했던 person grain을 다시
// 삭제하고 최종 3개(case/job/disease)로 확정. person은 case와 행 구성이 완전히 동일했고
// (buildDataset이 같은 함수로 라우팅) 브로드캐스트가 양방향이라 case 변수도 그대로
// 보였다 — person을 골라도 case를 고른 것과 계산 결과가 완전히 같았고 유일한 차이는
// 브로드캐스트 제외 3개 변수를 person에서 못 쓴다는 것뿐이라, 실익이 없다고 판단해
// 제거했다. person 소속이던 7개 변수(gender/heightCm/weightKg/birthDate/
// highBloodPressure/diabetes/bmi)는 삭제하지 않고 case로 되돌렸다(변수 자체는 유효,
// grain 소속만 원상복구) — 카탈로그 65개(case 31/job 19/disease 15)는 그대로, 통합
// 카탈로그 67개도 그대로. 브로드캐스트는 이제 case→job/disease 단방향뿐이다.
export const CATALOG_VERSION = 'v21-person-grain-removed';
