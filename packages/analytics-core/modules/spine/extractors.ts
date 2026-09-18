// Raw extractor — spine 대표 변수 2개(§1-1, MDDM/WBV 두 formula family). §1-1a 공통 0단계 +
// spine 전용 우선순위(모듈 비활성 → 평가상태 unknown/none → 데이터 부족 → 정상 계산)를
// 구현한다.

import type { ExtractedValue, MissingReason, MigrationResult, QualityFlag } from '../../types';
import { isPlainObject } from '../../migration/deterministicMigrate';
import { formulaDB } from './constants';
import { computeMddmCalc, resolveMddmStatus, type SpineTask, type MddmFormulaPolicy } from './mddm';
import { computeVibrationCalc, resolveVibrationStatus, type SpineVibrationInterval } from './vibration';
import type { SpineDiagnosis, SpineJobLike, SpineModuleShape } from './types';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// 실제 계산(calculateCompressiveForce/calculateDailyDose)은 이 필드들을 parseFloat이 아니라
// 곱셈에 그대로 흘려보낸다(JS의 ToNumber 강제변환) — quality-flag 검증도 실제 소비 방식과
// 같은 변환(Number())으로 해야 한다(shoulder 리뷰 3라운드에서 확립된 원칙, parseFloat과
// Number()가 다른 값을 내는 '250days' 같은 사례를 그대로 재현). 계획서 §1-1a 6라운드
// 보완이 지목한 4계열 중 압박력·일일선량 계열 숫자 필드.
const NUMERIC_TASK_FIELDS: Array<keyof SpineTask> = ['weight', 'correctionFactor', 'timeValue', 'frequency'];
const VALID_TIME_UNITS = new Set(['sec', 'min', 'hr']);

function scanTaskQuality(tasks: SpineTask[], qualityFlagSet: Set<QualityFlag>): void {
  for (const task of tasks) {
    for (const field of NUMERIC_TASK_FIELDS) {
      const raw = task[field];
      if (isBlank(raw)) continue;
      if (!Number.isFinite(Number(raw))) {
        qualityFlagSet.add('invalid');
      }
    }
    // posture는 범주형(formulaDB 키 조회)이다 — calculateCompressiveForce가 이미
    // `if (!formula) return null`로 방어하므로, extractor는 그 실패를 관찰만 한다.
    if (!isBlank(task.posture) && !formulaDB[task.posture as string]) {
      qualityFlagSet.add('invalid');
    }
    // timeUnit 미인식 값 — convertTimeToSeconds의 default 분기가 조용히 초 취급하므로
    // NaN 위험은 없지만, 미인식 단위 자체가 조용한 데이터 오염이라 invalid로 별도 기록한다.
    if (!isBlank(task.timeUnit) && !VALID_TIME_UNITS.has(String(task.timeUnit))) {
      qualityFlagSet.add('invalid');
    }
  }
}

export function extractSpineMddmLifetimeDoseMNh(
  migrationResult: MigrationResult<AnalysisPatient>,
  opts?: { formulaPolicy?: MddmFormulaPolicy },
): ExtractedValue<number> {
  const { payload } = migrationResult;

  // 순서 1(공통 0단계): 모듈 비활성 또는 data.modules.spine이 plain object가 아님.
  const activeModules = payload.data.activeModules ?? [];
  const spineModule = (payload.data.modules as Record<string, unknown> | undefined)?.spine;
  if (!activeModules.includes('spine') || !isPlainObject(spineModule)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as SpineJobLike[];
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const diagnoses = rawDiagnoses.filter(isPlainObject) as unknown as SpineDiagnosis[];
  const rawTasks = Array.isArray((spineModule as { tasks?: unknown }).tasks) ? (spineModule as { tasks?: unknown[] }).tasks! : [];
  const tasks = rawTasks.filter(isPlainObject) as unknown as SpineTask[];

  const sanitizedShared = { ...shared, jobs, diagnoses };
  const sanitizedModule = { ...(spineModule as Record<string, unknown>), tasks } as SpineModuleShape;

  // 순서 2: mddmStatus 3상태 해석.
  const mddmStatus = resolveMddmStatus(sanitizedModule);
  if (mddmStatus === 'unknown') {
    return { value: null, missing: 'not_assessed', qualityFlags: [] };
  }
  if (mddmStatus === 'none') {
    return { value: null, missing: 'not_applicable', qualityFlags: [] };
  }

  const result = computeMddmCalc(
    { shared: sanitizedShared, module: sanitizedModule },
    { formulaPolicy: opts?.formulaPolicy },
  );

  // 순서 3: present인데 job/task 정보가 부족해 lifetimeDose가 제외됨.
  if (result.lifetimeDose.excluded) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 3(계속): mddm.ts의 job-branch 선택 조건은 `!hasLegacyFields && jobs.length > 0`이다
  // — 즉 hasLegacyFields가 true면 jobs가 있어도 무조건 legacy 분기로 간다. legacy 분기가
  // 실제로 무엇을 쓰는지는 hasLegacyFields 값에 따라 갈린다(§리뷰 지적 — "필드가
  // undefined가 아니다"와 "그 필드가 실제로 소비된다"는 다르다):
  //   - hasLegacyFields=true: `mod.careerYears || 0`/`mod.careerMonths || 0`을 그대로 쓴다.
  //     둘 다 blank(undefined/null/'')면 여기서 조용히 0이 된다. `''`나 `null`도 `undefined`가
  //     아니므로 단순 `!== undefined` 검사로는 이 blank를 못 잡는다 — isBlank로 검사해야 한다.
  //   - hasLegacyFields=false: getCareerFromSharedJobs(shared)가 실행되는데(이 분기에
  //     도달했다는 건 jobs.length===0이라는 뜻 — hasLegacyFields=false인데 jobs가 있으면
  //     usesJobBranch가 true가 되어 이 if를 안 타므로), jobs=[]인 이상 항상 totalYears가
  //     0이 된다. 이때 mod.careerMonths만 단독으로 입력돼 있어도(careerYears/workDaysPerYear가
  //     둘 다 없으면 hasLegacyFields 자체가 false다) 계산기는 그 값을 전혀 읽지 않는
  //     죽은 필드다 — extractor도 그 값의 존재를 "측정 가능"으로 오인하면 안 된다.
  // job-branch를 타는 경우(!hasLegacyFields && jobs.length>0)는 아래 순서3b의 per-job
  // periodYears 검증이 이미 담당한다.
  const hasLegacyFields = sanitizedModule.careerYears !== undefined || sanitizedModule.workDaysPerYear !== undefined;
  const usesJobBranch = !hasLegacyFields && jobs.length > 0;
  const hasRealCareerDuration =
    hasLegacyFields && (!isBlank(sanitizedModule.careerYears) || !isBlank(sanitizedModule.careerMonths));
  if (!usesJobBranch && !hasRealCareerDuration && result.dailyDose.includedCount > 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 3b(공통 0단계 숫자 파싱): task 4계열 숫자 필드 + posture/timeUnit 범주형 검증.
  const qualityFlagSet = new Set<QualityFlag>();
  scanTaskQuality(tasks, qualityFlagSet);

  // 평생선량 계열(§1-1a 6라운드 보완 세 번째 계열) — job별 근속기간/연간근무일수가 NaN이면
  // (startDate/endDate 파싱 불가) 그 job의 lifetimeDose가 조용히 NaN이 될 수 있다(shoulder/
  // cervical에서 반복 확인된 getEffectiveWorkPeriod 함정과 동일). 실제로 그 job의 선량이
  // 산입된 경우(includedCount>0)에만 의미가 있다.
  if (result.jobResults.length > 0) {
    for (const jobResult of result.jobResults) {
      if (jobResult.dailyDose.includedCount === 0) continue;
      if (!(jobResult.periodYears > 0)) {
        qualityFlagSet.add('invalid');
      }
      if (!Number.isFinite(Number(jobResult.workDaysPerYear))) {
        qualityFlagSet.add('invalid');
      }
    }
  } else if (result.dailyDose.includedCount > 0) {
    // legacy 분기(구형식 careerYears/careerMonths/workDaysPerYear, 또는 job 자체가 없어
    // getCareerFromSharedJobs로 합산) — mddm.ts가 개별 job 단위로 노출하지 않으므로
    // 최종 합계(totalYears)의 유한성으로 대신 관찰한다.
    if (!Number.isFinite(result.lifetimeDose.totalYears ?? NaN)) {
      qualityFlagSet.add('invalid');
    }
  }

  // 최종 안전장치 — 위 스캔이 놓친 경로가 있어도 NaN/Infinity를 그대로 내보내지 않는다
  // (계획서 §1-1a 7라운드의 최종 NaN/Infinity 가드 패턴).
  if (!Number.isFinite(result.lifetimeDose.lifetimeDoseMNh)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }

  return { value: result.lifetimeDose.lifetimeDoseMNh, missing: null, qualityFlags: Array.from(qualityFlagSet) };
}

export function extractSpineVibrationDvMax(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<number> {
  const { payload } = migrationResult;

  const activeModules = payload.data.activeModules ?? [];
  const spineModule = (payload.data.modules as Record<string, unknown> | undefined)?.spine;
  if (!activeModules.includes('spine') || !isPlainObject(spineModule)) {
    const missing: MissingReason = 'structural_missing';
    return { value: null, missing, qualityFlags: [] };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawJobs = Array.isArray(shared.jobs) ? shared.jobs : [];
  const jobs = rawJobs.filter(isPlainObject) as unknown as SpineJobLike[];
  const rawIntervals = Array.isArray((spineModule as { vibrationIntervals?: unknown }).vibrationIntervals)
    ? (spineModule as { vibrationIntervals?: unknown[] }).vibrationIntervals!
    : [];
  const intervals = rawIntervals.filter(isPlainObject) as unknown as SpineVibrationInterval[];

  const sanitizedShared = { ...shared, jobs };
  const sanitizedModule = { ...(spineModule as Record<string, unknown>), vibrationIntervals: intervals } as SpineModuleShape;

  // 순서 2: vibrationExposureStatus 3상태 해석.
  const status = resolveVibrationStatus(sanitizedModule);
  if (status === 'unknown') {
    return { value: null, missing: 'not_assessed', qualityFlags: [] };
  }
  if (status === 'none') {
    return { value: null, missing: 'not_applicable', qualityFlags: [] };
  }

  const result = computeVibrationCalc({ shared: sanitizedShared, module: sanitizedModule });

  // 순서 3: present인데 유효 구간이 0개 — validIntervals가 실제로 계산에 쓰인 구간이다.
  // 직력(shared.jobs)이 아예 없으면 groupIntervalsByJob(vibration.ts)이 구간을 어느
  // job에도 배정하지 못해 jobResults가 비고 dv가 "정상적으로" 0·0으로 계산된다 — 구간은
  // 있는데 분모(직력)가 없어서 측정이 안 되는 상태를 "노출 없음(0)"과 구분해야 한다
  // (§리뷰 지적 — cervical의 workDaysPerYear 누락과 같은 패턴).
  if (jobs.length === 0 || result.intervals.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  // 순서 4: present인데 유효하지 않은 구간이 섞여 있음(유효 구간은 1개 이상 있음) — 값은
  // 유효 구간만으로 계산하되(원본 동작 그대로) invalid qualityFlag를 추가한다.
  const qualityFlagSet = new Set<QualityFlag>();
  if (result.validation.hasInvalidIntervals) {
    qualityFlagSet.add('invalid');
  }

  // job별 근속기간/연간근무일수 NaN 방지(shoulder/cervical/MDDM과 동일 함정) — 실제로 그
  // job의 구간이 dv에 기여한 경우에만 의미가 있다.
  for (const jobResult of result.jobResults) {
    if (jobResult.intervals.length === 0) continue;
    if (!(jobResult.periodYears > 0)) {
      qualityFlagSet.add('invalid');
    }
    if (!Number.isFinite(Number(jobResult.workDaysPerYear))) {
      qualityFlagSet.add('invalid');
    }
  }

  if (!Number.isFinite(result.dv.max)) {
    return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  }

  return { value: result.dv.max, missing: null, qualityFlags: Array.from(qualityFlagSet) };
}

function parseStrictNumber(x: unknown): number | null {
  if (typeof x !== 'number' && typeof x !== 'string') return null;
  if (typeof x === 'string' && x.trim() === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

// PR0-B3 Part B — verticalDistribution/concomitantSpondylosis는 case grain 값인데 저장
// 위치는 diagnosis 행이다(§리뷰 함정, coverage/shared.ts 주석과 동일 — normalizeSpineAssessmentFields
// 가 "첫 spine 진단에 모아두는" 정책으로 UI 상에서는 보통 최대 1곳에만 값이 있지만, 그
// 정책은 클라이언트 useEffect라 이 snapshot을 읽는 시점에 항상 적용돼 있다고 보장할 수
// 없다(배치입력·가져오기·정규화 실행 전 저장 등). 그래서 이 case의 spine 진단 전체를
// 취합하고, 값이 갈리면 conflicting_common_field 플래그 + 결정적 대표값(계획 §5.5 ④
// 규칙 — 값이 갈리면 정렬 후 첫 값을 대표값으로 선택. 원본 배열 순서 기반 선택은 진단
// 삭제·재배치로 대표값이 바뀌는 문제가 3차 리뷰에서 재현됐다)을 반환한다. 특정 diagnosis
// 행 하나만 읽지 않는다.
//
// 4차 리뷰 P2 — String(raw)로 먼저 강제변환한 뒤 비교하면 ['confirmed'] 같은 배열이
// Array.toString() 강제변환으로 문자열 'confirmed'와 구별되지 않고 정상값으로 승격된다
// (K-L Grade에서 이미 확립한 "strict 타입 검사 후 정규화 값만 계산에 쓴다" 원칙과 같은
// 결함 계열). 원본 값 자체에 대해 엄격한(===) 비교만 하고, 정렬은 그 비교를 통과한
// 문자열에만 적용한다.
type ConfirmedFieldStatus = 'blank' | true | false | 'invalid';
function classifyConfirmedField(raw: unknown): ConfirmedFieldStatus {
  if (isBlank(raw)) return 'blank';
  if (raw === 'confirmed') return true;
  if (raw === 'unconfirmed') return false;
  return 'invalid';
}

// resolveDiagnosisModule()(diagnosisMapping.ts)이 name 매칭에 쓰던 요추 정규식의 끝 빈
// 대안(|) 버그는 PR0-B3 Part C(2026-09-12)에서 수정됐다(사용자 확인 후 반영, diagnosisMapping.ts
// 헤더 참고). 이 로컬 함수는 그 버그가 남아있던 3차 리뷰 시점에 만든 좁은 우회
// (isReliablySpineDiagnosis)로, 버그 수정 후에도 이미 검증된 동작(명시적 moduleId 우선
// → 정확한 ICD 코드 → 상병명 패턴, 경추 우선 분기 보존)을 그대로 유지한다 — 공유 함수를
// 이 자리에서 다시 호출하도록 바꾸는 리팩터는 별도로 검증할 이유가 없어 하지 않는다.
//
// 4차 리뷰 P1 — M47/M48/M54는 척추·경추 모듈이 공유하는 코드다. getDiagnosisModuleHint()
// (diagnosisMapping.ts:98-102)는 이 세 코드에 대해 상병명에 "경추/목/cervical"이 있으면
// 요추보다 경추를 우선 판정하는 별도 분기를 ICD_MODULE_MAP 순회보다 먼저 둔다 — 그
// 규칙 자체는 버그가 아니라 diagnosisMapping.ts의 정상 동작인데, 앞선 우회에서 통째로
// 빠져 경추 진단(예: M47.2 "cervical")이 척추로 잘못 집계됐다. 여기서도 동일한 순서로
// 보존한다: 경추 우선 분기 → M4802(경추 전용, ICD_MODULE_MAP 명시) → spine 코드/이름.
const CERVICAL_AMBIGUOUS_CODE_PATTERN = /^(M48|M47|M54)/;
const CERVICAL_NAME_PATTERN = /(경추|목|cervical)/i;
const CERVICAL_ONLY_CODE_PATTERN = /^M4802/;
const RELIABLE_SPINE_CODE_PATTERN = /^(M51|M54|M47|M4806|M53)/;
const RELIABLE_SPINE_NAME_PATTERN = /요추|허리|허리통증|요통|lumbar|요추간판|요추협착|요추 협착/i;
function isReliablySpineDiagnosis(dx: SpineDiagnosis): boolean {
  if (dx.moduleId === '__none__') return false;
  if (typeof dx.moduleId === 'string' && dx.moduleId !== '') return dx.moduleId === 'spine';
  const code = String(dx.code ?? '').trim().toUpperCase().replace(/[.\s]/g, '');
  const name = String(dx.name ?? '');
  if (CERVICAL_AMBIGUOUS_CODE_PATTERN.test(code) && CERVICAL_NAME_PATTERN.test(name)) return false;
  if (CERVICAL_ONLY_CODE_PATTERN.test(code)) return false;
  if (RELIABLE_SPINE_CODE_PATTERN.test(code)) return true;
  return RELIABLE_SPINE_NAME_PATTERN.test(name);
}

function extractSpineDiagnosisCommonAssessmentField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: 'verticalDistribution' | 'concomitantSpondylosis',
): ExtractedValue<boolean> {
  const { payload } = migrationResult;
  const activeModules = payload.data.activeModules ?? [];
  if (!activeModules.includes('spine')) {
    return { value: null, missing: 'structural_missing', qualityFlags: [] };
  }

  const shared = (payload.data.shared as Record<string, unknown>) ?? {};
  const rawDiagnoses = Array.isArray(shared.diagnoses) ? shared.diagnoses : [];
  const spineDiagnoses = rawDiagnoses
    .filter(isPlainObject)
    .filter((d) => isReliablySpineDiagnosis(d as SpineDiagnosis)) as Array<Record<string, unknown>>;

  if (spineDiagnoses.length === 0) {
    return { value: null, missing: 'not_applicable', qualityFlags: [] };
  }

  const statuses = spineDiagnoses.map((d) => classifyConfirmedField(d[field])).filter((s) => s !== 'blank') as Array<
    boolean | 'invalid'
  >;
  if (statuses.length === 0) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }

  const qualityFlags: QualityFlag[] = [];
  if (statuses.includes('invalid')) qualityFlags.push('invalid');

  const validStatuses = statuses.filter((s): s is boolean => s !== 'invalid');
  if (new Set(validStatuses).size > 1) qualityFlags.push('conflicting_common_field');

  if (validStatuses.length === 0) {
    // 이 case의 spine 진단 전체가 값은 있으나(공백 아님) 전부 파싱 불가 — 계산할 대상이 없다.
    return { value: null, missing: 'not_entered', qualityFlags };
  }

  // 정렬 후 첫 값 — 원본 배열 순서(진단 삭제·재배치에 따라 바뀜)에 의존하지 않는다.
  // 이미 엄격 비교로 검증된 boolean만 정렬 대상이라(원본 raw 값을 다시 강제변환하지
  // 않는다), invalid 값이 대표값 선택에 끼어들 수 없다.
  const sortedValid = validStatuses.map((s) => (s ? 'confirmed' : 'unconfirmed')).sort();
  return { value: sortedValid[0] === 'confirmed', missing: null, qualityFlags };
}

export function extractSpineDiagnosisVerticalDistribution(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<boolean> {
  return extractSpineDiagnosisCommonAssessmentField(migrationResult, 'verticalDistribution');
}

export function extractSpineDiagnosisConcomitantSpondylosis(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<boolean> {
  return extractSpineDiagnosisCommonAssessmentField(migrationResult, 'concomitantSpondylosis');
}


// ── PR0-B4 Slice 1 — coverage 잔여 필드(매핑표 §4). 전부 raw 필드 그대로 노출한다(파생
// 계산 없음) — 기존 lifetimeDoseMNh/dvMax의 dependsOn에는 이미 있었지만 독립 변수로는
// 없던 필드들. 공통 원칙: 모듈 비활성 → structural_missing, blank → not_entered, 타입
// 불일치·미지원 값 → not_entered + invalid(K-L Grade/Ellman과 동일하게 "값이 있는데
// 못 쓴다"는 못 쓴 값 자체를 보존하지 않고 결측+플래그로 처리 — 잘못된 값이 정상 범주와
// 섞여 빈도표를 오염시키지 않게 한다).

function getActiveSpineModule(migrationResult: MigrationResult<AnalysisPatient>): SpineModuleShape | null {
  const { payload } = migrationResult;
  const activeModules = payload.data.activeModules ?? [];
  const spineModule = (payload.data.modules as Record<string, unknown> | undefined)?.spine;
  if (!activeModules.includes('spine') || !isPlainObject(spineModule)) return null;
  return spineModule as SpineModuleShape;
}

function extractSpineCaseStringField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: 'mddmStatus' | 'vibrationExposureStatus' | 'formulaVersion' | 'evalMethod',
): ExtractedValue<string> {
  const spineModule = getActiveSpineModule(migrationResult);
  if (!spineModule) return { value: null, missing: 'structural_missing', qualityFlags: [] };

  const raw = spineModule[field];
  if (isBlank(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  if (typeof raw !== 'string') return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  return { value: raw, missing: null, qualityFlags: [] };
}

export function extractSpineCaseMddmStatus(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<string> {
  return extractSpineCaseStringField(migrationResult, 'mddmStatus');
}

export function extractSpineCaseVibrationExposureStatus(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<string> {
  return extractSpineCaseStringField(migrationResult, 'vibrationExposureStatus');
}

export function extractSpineCaseFormulaVersion(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<string> {
  return extractSpineCaseStringField(migrationResult, 'formulaVersion');
}

// careerYears/careerMonths/workDaysPerYear(case 자체) — scanTaskQuality와 동일하게 양수
// 강제 없이 유한성만 검증한다(구형식 legacy 호환 필드, 기존 계산도 finite 여부만 본다).
function extractSpineCaseNumericField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: 'careerYears' | 'careerMonths' | 'workDaysPerYear',
): ExtractedValue<number> {
  const spineModule = getActiveSpineModule(migrationResult);
  if (!spineModule) return { value: null, missing: 'structural_missing', qualityFlags: [] };

  const raw = spineModule[field];
  if (isBlank(raw)) return { value: null, missing: 'not_entered', qualityFlags: [] };
  const n = parseStrictNumber(raw);
  if (n === null) return { value: null, missing: 'not_entered', qualityFlags: ['invalid'] };
  return { value: n, missing: null, qualityFlags: [] };
}

export function extractSpineCaseWorkDaysPerYear(migrationResult: MigrationResult<AnalysisPatient>): ExtractedValue<number> {
  return extractSpineCaseNumericField(migrationResult, 'workDaysPerYear');
}
