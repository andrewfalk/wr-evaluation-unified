// §5.3 coverage inventory 검증. 이 파일은 의도적으로 .js(타입체크 대상 아님)다 —
// packages/analytics-core/tsconfig.json은 __tests__를 제외하고, 루트 tsconfig.json은
// allowJs:false라 .ts 테스트에서 src/**/*.js 팩토리 함수를 직접 import하면 타입체크가
// 깨진다. 여기서는 런타임 vitest 검증만 하면 되므로 .js로 그 문제를 피한다.
//
// §리뷰 지적(2026-09-06, 2·3라운드)에 따라 구조를 다시 짰다 — 처음엔 dependsOn과
// 수기 인벤토리를 서로만 대조해서, 둘 다 같은 가짜 경로를 넣으면 통과했다(독립적 근거가
// 없었음). 2라운드에서 knownPaths(독립 근거)를 도입했지만 batchImportConfig.applyRow만
// 실행하고 videoMappingConfig.writeField는 실행하지 않아, 영상 적용 전용 경로로만
// 생기는 필드는 여전히 놓칠 수 있었다(3라운드 지적). 지금은 "실제로 존재하는 필드"
// (knownPaths)를 인벤토리·dependsOn 어느 쪽도 참조하지 않고 네 실제 저장 경로에서만
// 독립적으로 구성한 뒤, 인벤토리·dependsOn 양쪽을 그 knownPaths와 대조한다:
//   1. 인터랙티브 UI 팩토리 기본값(createXModuleData 등)
//   2. 일괄 입력(batchImportConfig.applyRow) 실제 실행 결과 — src/core/utils/__tests__/
//      batchImportConfig.test.js와 동일한 fixture를 그대로 재사용한다
//   2b. 영상 분석 자동 적용(videoMappingConfig.writeField) 실제 실행 결과 — knee/shoulder
//      (job-scope)·cervical/spine(task-scope) 4개 모듈의 featureKeys 전부를 실제 호출
//   3. 어떤 팩토리도 만들지 않는 레거시 전용 구조(수기 샘플 — legacyNormalize.ts가
//      실제로 읽는 shape를 그대로 재현)
import { describe, it, expect, vi } from 'vitest';

vi.mock('html2pdf.js', () => ({ default: () => ({}) }));

import { FULL_COVERAGE_INVENTORY } from '../coverage/index';
import { KNEE_METADATA } from '../modules/knee/metadata';
import { SHOULDER_METADATA } from '../modules/shoulder/metadata';
import { ELBOW_METADATA } from '../modules/elbow/metadata';
import { WRIST_METADATA } from '../modules/wrist/metadata';
import { CERVICAL_METADATA } from '../modules/cervical/metadata';
import { SPINE_METADATA } from '../modules/spine/metadata';

import { createSharedData, createDiagnosis } from '../../../src/core/utils/data';
import { createKneeModuleData, createKneeJobExtras } from '../../../src/modules/knee/utils/data';
import { createShoulderModuleData, createShoulderJobExtras } from '../../../src/modules/shoulder/utils/data';
import { createElbowModuleData, createElbowJobEvaluation, createElbowDiagnosisEntry } from '../../../src/modules/elbow/utils/data';
import { createWristModuleData, createWristJobEvaluation, createWristDiagnosisEntry } from '../../../src/modules/wrist/utils/data';
import { createCervicalModuleData, createCervicalTask } from '../../../src/modules/cervical/utils/data';
import { createSpineModuleData, createTask as createSpineTask, createVibrationInterval } from '../../../src/modules/spine/utils/data';

// 6개 모듈 self-register(batchImportConfig 확보용) — 순서/부작용은 registerModule()이
// module id로 dedupe하므로 다른 테스트 파일과 동시 실행돼도 안전하다.
import '../../../src/modules/knee';
import '../../../src/modules/shoulder';
import '../../../src/modules/spine';
import '../../../src/modules/cervical';
import '../../../src/modules/elbow';
import '../../../src/modules/wrist';
import { getAllModules, getModulesWithVideoMapping } from '../../../src/core/moduleRegistry';
import { normalizeHeader, parseDate, parseSide, getCell, buildColMap, ensureDiagnosis, ensureSharedJob } from '../../../src/core/utils/batchImportHelpers';

const ALL_METADATA = [
  ...KNEE_METADATA, ...SHOULDER_METADATA, ...ELBOW_METADATA,
  ...WRIST_METADATA, ...CERVICAL_METADATA, ...SPINE_METADATA,
];

// ---------------------------------------------------------------------------
// 필드 펼치기 — §리뷰 지적(P2-1): 컨테이너 자체(빈 배열/빈 객체 포함)도 추적하고,
// 배열은 원소 하나(arr[0])가 아니라 전부 합친다.
// ---------------------------------------------------------------------------
function flattenFields(value, prefix, out) {
  if (Array.isArray(value)) {
    out.add(prefix);
    for (const item of value) {
      // 배열 원소가 원시값(문자열 등, 예: exposure_types: ['repetition'])이면 컨테이너
      // 경로 자체로 충분하다 — dependsOn도 'field[]'까지 더 분해하지 않는다. 원소가
      // 객체/배열일 때만(예: tasks[], jobEvaluations[]) 한 단계 더 내려간다.
      if (item && typeof item === 'object') flattenFields(item, `${prefix}[]`, out);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    out.add(prefix);
    for (const [key, sub] of Object.entries(value)) {
      flattenFields(sub, prefix ? `${prefix}.${key}` : key, out);
    }
    return out;
  }
  out.add(prefix);
  return out;
}

// 어떤 경로가 "leaf"인가 — knownPaths 안에 그 경로를 진짜 접두사로 갖는(즉 하위 필드가
// 있는) 다른 경로가 하나도 없으면 leaf다. 컨테이너 경로(예: modules.knee.jobExtras[])는
// 하위 필드(.sharedJobId 등)가 실제로 있으면 leaf가 아니라 인벤토리 분류를 개별로
// 요구하지 않는다 — 반대로 빈 배열/빈 객체(하위 필드가 전혀 없는 컨테이너)는 그 자체가
// leaf이므로 반드시 분류돼야 한다(§리뷰 지적 P2-1의 핵심 — {newArray: []}도 잡아야 함).
function computeLeafPaths(allPaths) {
  const list = [...allPaths];
  return list.filter((path) => !list.some((other) => other !== path && (other.startsWith(`${path}.`) || other.startsWith(`${path}[`))));
}

// ---------------------------------------------------------------------------
// knownPaths — 인벤토리/dependsOn을 전혀 참조하지 않는 독립적 "실제 필드 목록".
// ---------------------------------------------------------------------------
const knownPaths = new Set();

// 1. 인터랙티브 UI 팩토리 기본값
flattenFields(createSharedData(), 'shared', knownPaths);
{
  const sample = createKneeModuleData();
  sample.jobExtras = [createKneeJobExtras('job-1')];
  flattenFields(sample, 'modules.knee', knownPaths);
}
{
  const sample = createShoulderModuleData();
  sample.jobExtras = [createShoulderJobExtras('job-1')];
  flattenFields(sample, 'modules.shoulder', knownPaths);
}
// elbow/wrist는 §3(레거시 전용 구조) 아래에서 legacy alias(temporalRelation)·legacy
// 유출 필드(bk2106_tool_pressing 등)까지 합친 더 완전한 샘플로 한 번에 처리한다.
{
  const sample = createCervicalModuleData();
  sample.tasks = [createCervicalTask(0, 'job-1')];
  flattenFields(sample, 'modules.cervical', knownPaths);
}
{
  const sample = createSpineModuleData();
  sample.tasks = [createSpineTask(0, 'job-1')];
  sample.vibrationIntervals = [createVibrationInterval(0, 'job-1')];
  flattenFields(sample, 'modules.spine', knownPaths);
}

// 2. 일괄 입력(batchImportConfig.applyRow) 실제 실행 — fixture는
// src/core/utils/__tests__/batchImportConfig.test.js와 동일하다. Object.assign(entry, {...})
// 패턴(elbow/wrist/knee/shoulder/cervical/spine 전부 동일)은 헤더에 없는 열도 항상
// `getCell(...) || entry.field || fallback`으로 모든 필드 키를 재기록하므로, 소수의 헤더만
// 있어도 그 모듈이 만드는 필드 전체가 결과 객체에 나타난다 — 별도로 모든 BK 유형별 헤더를
// 채울 필요가 없다(직접 실행해 확인).
{
  const moduleConfigs = getAllModules()
    .map((mod) => ({ id: mod.id, batchImportConfig: mod.batchImportConfig }))
    .filter((mod) => mod.batchImportConfig);

  const BASE_COLUMNS = {
    name: ['이름', 'name'],
    diagCode: ['진단코드', 'code'],
    diagName: ['진단명', 'diag'],
    side: ['방향', 'side'],
    jobName: ['직종명', 'job'],
    jobStart: ['시작일', 'start'],
    jobEnd: ['종료일', 'end'],
  };

  const headerRow = [
    '이름', '진단코드', '진단명', '방향', '직종명', '시작일', '종료일',
    'klg(우)', 'ellman(좌)',
    '중량물(kg)', '쪼그려앉기',
    '오버헤드', '반복중간',
    '작업명', '자세코드',
    '경추_작업명', '경추_노출유형',
    '팔꿈치_bk유형', '팔꿈치_문제작업명',
    '손목_bk유형', '손목_문제작업명',
  ].map(normalizeHeader);

  const row = [
    '홍길동', 'M17.1', '무릎 관절증', '우측', '용접공', '2020-01-01', '2024-01-01',
    '2', '3',
    '15', '120',
    '3', '2',
    '용접작업', 'G1',
    '목작업', '어깨에 무거운 하중 운반',
    'BK2101', '망치작업',
    'BK2101', '드라이버작업',
  ];

  const colMap = buildColMap(headerRow, [
    BASE_COLUMNS,
    ...moduleConfigs.map((mod) => mod.batchImportConfig.columns || {}),
  ]);

  const stats = { newDiagnoses: 0, newJobs: 0 };
  const patient = {
    id: 'p1',
    data: { shared: { name: '', birthDate: '', injuryDate: '', diagnoses: [], jobs: [] }, modules: {}, activeModules: [] },
  };
  const diagCode = String(getCell(row, colMap.diagCode) || '').trim();
  const diagName = String(getCell(row, colMap.diagName) || '').trim();
  const side = parseSide(getCell(row, colMap.side));
  const diagnosis = ensureDiagnosis(patient, diagCode, diagName, side, stats);
  const job = ensureSharedJob(patient, row, colMap, getCell, stats);

  moduleConfigs.forEach((mod) => {
    mod.batchImportConfig.applyRow({ patient, row, diagnosis, job, colMap, getCell, rowIndex: 1 });
  });

  flattenFields(patient.data.shared, 'shared', knownPaths);
  for (const [moduleId, moduleData] of Object.entries(patient.data.modules)) {
    flattenFields(moduleData, `modules.${moduleId}`, knownPaths);
  }
}

// 2b. 영상 분석 자동 적용(videoMappingConfig.writeField) 실제 실행 — §리뷰 지적
// (2026-09-06, 3라운드): 팩토리·일괄입력만 실행하고 영상 적용 경로는 전혀 실행하지
// 않아서, 영상 적용으로만 생기는 필드가 있어도(또는 실제 targetField가 인벤토리에
// 없는 이름으로 바뀌어도) 못 잡았다. knee/shoulder(scope:'job')·cervical/spine
// (scope:'task') 4개 모듈 전부, 선언된 featureKeys 각각에 대해 실제 writeField를
// 호출해 결과 moduleData를 knownPaths에 합친다. elbow/wrist는 videoMappingConfig가
// 없다(VIDEO_FEATURE_TARGETS 주석 — "팔꿈치/손목은 flat 참고 후보로만 표시").
{
  for (const mod of getModulesWithVideoMapping()) {
    const cfg = mod.videoMappingConfig;
    let moduleData;
    let ctx;
    if (cfg.scope === 'job') {
      // job-scope(knee/shoulder): jobExtras에 해당 sharedJobId 항목이 없어도
      // jobScopeWriteField가 createExtras(ctx.sharedJobId)로 새로 만들어 기입한다.
      moduleData = mod.createModuleData();
      ctx = { sharedJobId: 'job-1' };
    } else if (cfg.scope === 'task') {
      // task-scope(cervical/spine): taskScopeWriteField는 ctx.taskId와 일치하는
      // 기존 task가 없으면 applied:false로 아무것도 안 바꾸므로, id가 일치하는 task를
      // 미리 심어둬야 실제로 기입되는 경로를 관찰할 수 있다.
      moduleData = mod.createModuleData();
      const seedTask = mod.id === 'spine'
        ? createSpineTask(0, 'job-1')
        : createCervicalTask(0, 'job-1');
      seedTask.id = 'task-1';
      moduleData.tasks = [seedTask];
      ctx = { taskId: 'task-1' };
    } else {
      throw new Error(`coverage.test.js가 모르는 videoMappingConfig.scope: ${cfg.scope}(모듈 ${mod.id}) — 새 scope 추가 시 이 테스트도 갱신할 것`);
    }

    for (const featureKey of cfg.featureKeys) {
      const coerced = cfg.coerce ? cfg.coerce(featureKey, 'sample-value') : 'sample-value';
      const result = cfg.writeField(moduleData, ctx, featureKey, coerced);
      expect(result.applied, `${mod.id}.videoMappingConfig.writeField이 featureKey '${featureKey}'에 대해 적용되지 않음(테스트 fixture가 실제 writeField 계약과 어긋남)`).toBe(true);
      flattenFields(result.moduleData, `modules.${mod.id}`, knownPaths);
    }
  }
}

// 3. 레거시 전용 구조 — 어떤 팩토리도 기본값으로 만들지 않지만 legacyNormalize.ts가
// 실제로 읽는 shape. buildLegacyEntryMap이 `{...createXDiagnosisEntry(diag), ...legacyEntry}`
// 로 만드는 진단별 flat 저장 구조를 그대로 재현한다. bk2106_tool_pressing/
// bk2106_frequent_high_force_grip은 createElbowDiagnosisEntry()가 만들지 않는 레거시
// 유출 필드지만(normalizeDiagnosisEntry, legacyNormalize.ts:251-259) 구버전 저장값이
// existingEntry로 스프레드되면 두 구조(jobEvaluations[].diagnosisEntries[]도 포함) 모두에
// 나타날 수 있다.
{
  const legacyLeakFields = { bk2106_tool_pressing: 'yes', bk2106_frequent_high_force_grip: 'yes' };

  // bkAutoSyncedFrom(data.js:313)과 _pendingPreset(job evaluation 레벨, data.js:316에서
  // 저장 직전 제거)은 어느 팩토리도 기본으로 만들지 않고 정규화 로직이 동적으로만
  // 붙였다 뗐다 하는 필드다 — 수기로 채워야 discovery된다.
  // bkAutoSyncedFrom은 jobEvaluations[].diagnosisEntries[]에서만 실제로 쓰인다
  // (entry.bkAutoSyncedFrom = donor.entry.diagnosisId, data.js:313) — 레거시
  // diagnosisEvaluations[] 쪽 샘플에는 이 필드를 넣지 않고 legacy 유출 필드만 공유한다.
  const elbowEntryBase = { ...createElbowDiagnosisEntry({ id: 'dx-1', code: '', name: '' }), ...legacyLeakFields };
  const jobEval = { ...createElbowJobEvaluation('job-1'), diagnosisEntries: [{ ...elbowEntryBase, bkAutoSyncedFrom: 'dx-0' }], _pendingPreset: null };
  // temporalRelation은 createElbowModuleData()가 만드는 현재 필드명(temporalSequence)이
  // 아니라 legacyNormalize.ts:169/data.js:193가 옛 필드명을 방어적으로 읽는 legacy alias다.
  const elbowSample = { ...createElbowModuleData(), jobEvaluations: [jobEval], temporalRelation: createElbowModuleData().temporalSequence };
  flattenFields(elbowSample, 'modules.elbow', knownPaths);

  const legacyElbow = { diagnosisEvaluations: [{ ...elbowEntryBase, linkedJobId: 'job-1' }] };
  flattenFields(legacyElbow, 'modules.elbow', knownPaths);

  const wristEntryBase = createWristDiagnosisEntry({ id: 'dx-1', code: '', name: '' });
  const wristJobEval = { ...createWristJobEvaluation('job-1'), diagnosisEntries: [{ ...wristEntryBase, bkAutoSyncedFrom: 'dx-0' }], _pendingPreset: null };
  const wristSample = { ...createWristModuleData(), jobEvaluations: [wristJobEval], temporalRelation: createWristModuleData().temporalSequence };
  flattenFields(wristSample, 'modules.wrist', knownPaths);

  const legacyWrist = { diagnosisEvaluations: [{ ...wristEntryBase, linkedJobId: 'job-1' }] };
  flattenFields(legacyWrist, 'modules.wrist', knownPaths);
}
// spine의 구형식 필드(evalMethod/careerYears/careerMonths/workDaysPerYear/jobName)는
// createSpineModuleData()가 만들지 않지만 mddm.ts/vibration.ts가 legacy 값으로 실제로
// 읽는다(§coverage inventory 재검토, 2026-09-06 — evalMethod==='wbv'는 "1차 WBV 환자"
// 레거시 마커, mddm.ts:36/vibration.ts:25).
flattenFields(
  { evalMethod: 'wbv', careerYears: 10, careerMonths: 0, workDaysPerYear: 250, jobName: '용접공' },
  'modules.spine',
  knownPaths,
);
// knee의 구형식 호환 배열(createJob(), "BatchImportModal 마이그레이션 전까지"라고 주석에
// 명시된 레거시 구조)은 dependsOn 자체가 'modules.knee.jobs[]'를 원소 필드 단위가 아니라
// 배열 전체 참조로 선언하므로, 여기서도 그 입도에 맞춰 컨테이너 경로만 수기로 추가한다
// (내부 필드까지 펼치면 인벤토리에 없는 하위 경로가 무더기로 "새 필드"처럼 잡힌다 —
// 그 구조를 완전히 분해하려면 dependsOn 자체를 먼저 세분화해야 하고, 그건 이번 범위 밖이다).
knownPaths.add('modules.knee.jobs[]');

// shared.diagnoses[]에 UI(AssessmentTab.jsx)가 사후에 동적으로 붙이는 필드 — 어떤
// 팩토리 기본값에도 없어 위 1/2 어느 경로로도 자동 발견되지 않는다(Explore agent 조사,
// 2026-09-06). knee/shoulder 전용 확장 필드(klgRight 등)까지 한 번에 합쳐 재현한다.
flattenFields(
  {
    ...createDiagnosis(),
    confirmedCode: '', confirmedName: '',
    klgRight: '', klgLeft: '', ellmanRight: '', ellmanLeft: '',
    confirmedRight: '', confirmedLeft: '', assessmentRight: '', assessmentLeft: '',
    reasonRight: [], reasonLeft: [], reasonRightOther: '', reasonLeftOther: '',
    verticalDistribution: '', concomitantSpondylosis: '',
  },
  'shared.diagnoses[]',
  knownPaths,
);
// shared.reportOptions — AssessmentStep.jsx/AssessmentTab.jsx가 지연 생성하는 필드라
// createSharedData()에는 없다(shared/contracts/patient.ts:44-58에서 검증되는 실제 필드).
knownPaths.add('shared.reportOptions');

// ---------------------------------------------------------------------------
// A. 정적 일관성 — dependsOn ⊆ inventory(included) ⊆ dependsOn (기존 검증, 유지)
// ---------------------------------------------------------------------------
describe('coverage inventory — 정적 일관성', () => {
  it('모든 항목은 included:true 이거나 excluded_with_reason(비어있지 않은 사유)이다', () => {
    for (const [path, entry] of Object.entries(FULL_COVERAGE_INVENTORY)) {
      if (entry.included) {
        expect(entry.reason, `"${path}"는 included:true인데 reason도 있음(있으면 안 됨)`).toBeUndefined();
      } else {
        expect(typeof entry.reason, `"${path}"는 excluded인데 reason이 문자열이 아님`).toBe('string');
        expect(entry.reason.trim().length, `"${path}"의 exclusion reason이 비어있음`).toBeGreaterThan(0);
      }
    }
  });

  it('7개 대표 변수의 dependsOn 경로는 전부 인벤토리에 included:true로 있다', () => {
    const missing = [];
    const notIncluded = [];
    for (const variable of ALL_METADATA) {
      for (const path of variable.dependsOn) {
        const entry = FULL_COVERAGE_INVENTORY[path];
        if (!entry) { missing.push(`${variable.key} -> ${path}`); continue; }
        if (!entry.included) notIncluded.push(`${variable.key} -> ${path}`);
      }
    }
    expect(missing, 'dependsOn 경로가 인벤토리 자체에 없음(새 dependsOn 추가 시 인벤토리도 갱신할 것)').toEqual([]);
    expect(notIncluded, 'dependsOn 경로가 인벤토리에서 excluded로 잘못 표시됨').toEqual([]);
  });

  it('included:true라고 표시된 항목은 실제로 어느 dependsOn에든 존재한다(허위 포함 주장 방지)', () => {
    const dependsOnPaths = new Set(ALL_METADATA.flatMap((v) => v.dependsOn));
    const falselyIncluded = Object.entries(FULL_COVERAGE_INVENTORY)
      .filter(([, entry]) => entry.included)
      .map(([path]) => path)
      .filter((path) => path !== 'activeModules' && !dependsOnPaths.has(path));
    expect(falselyIncluded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. 독립적 근거 대조 — §리뷰 지적(P2-3): dependsOn·인벤토리 양쪽을 knownPaths(위에서
// 구성한, 어느 쪽도 참조하지 않은 실제 필드 목록)와 각각 대조한다. 양쪽에 같은 가짜
// 경로를 넣어도 knownPaths에 없으면 여기서 잡힌다.
// ---------------------------------------------------------------------------
describe('coverage inventory — 독립적 근거 대조(knownPaths)', () => {
  it('dependsOn의 모든 경로는 실제로 존재하는 필드(knownPaths)를 가리킨다 — 존재하지 않는 경로 선언 방지', () => {
    const unknownDependsOn = [];
    for (const variable of ALL_METADATA) {
      for (const path of variable.dependsOn) {
        if (path !== 'activeModules' && !knownPaths.has(path)) unknownDependsOn.push(`${variable.key} -> ${path}`);
      }
    }
    expect(unknownDependsOn, 'dependsOn이 실제로 존재하지 않는 필드를 가리킴(오타·삭제된 필드 등)').toEqual([]);
  });

  it('인벤토리의 모든 항목은 실제로 존재하는 필드(knownPaths)를 가리킨다 — 가짜 excluded 항목 방지', () => {
    const unknownInventory = Object.keys(FULL_COVERAGE_INVENTORY).filter(
      (path) => path !== 'activeModules' && !knownPaths.has(path),
    );
    expect(unknownInventory, '인벤토리가 실제로 존재하지 않는 필드를 분류하고 있음(오타·삭제된 필드 등)').toEqual([]);
  });

  it('실제로 존재하는 leaf 필드(knownPaths 중 하위 필드가 없는 것)는 전부 인벤토리에 있다 — 새 필드 추가 시 CI가 잡는 핵심 보장', () => {
    // 컨테이너 경로(예: modules.knee.jobExtras[], 하위에 .sharedJobId 등이 실제로 있음)는
    // 그 하위 필드들이 이미 개별 분류돼 있으면 컨테이너 자체까지 별도로 분류할 필요는
    // 없다 — 다만 하위 필드가 하나도 없는 컨테이너(빈 배열/빈 객체)는 그 자체가 leaf이므로
    // 반드시 분류돼야 한다(§리뷰 지적 P2-1 — {newArray: []} 같은 경우를 놓치지 않기 위함).
    const leafPaths = computeLeafPaths(knownPaths);
    const unknown = leafPaths.filter((path) => !(path in FULL_COVERAGE_INVENTORY));
    expect(unknown, '팩토리·일괄입력·레거시 구조가 만드는 필드인데 인벤토리(coverage/*)에 없음 — included/excluded_with_reason으로 분류해서 인벤토리에 추가할 것').toEqual([]);
  });
});
