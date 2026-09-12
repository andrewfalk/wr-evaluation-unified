#!/usr/bin/env -S npx tsx
/**
 * 통계 워크벤치 검증용 가상 환자 대량 시드.
 *
 * 통계분석(상관행렬/차트 등) 검증에 표본 수가 부족하다는 요청으로 추가. patient_records/
 * patient_persons에 직접 INSERT한다 — POST /api/patients를 거치지 않지만 저장 payload
 * 형태({id, phase, createdAt, data})와 파생 컬럼은 server/src/routes/patients.ts의
 * createPatient 핸들러가 쓰는 것과 동일하게 맞춘다.
 *
 * 환자 생성 로직은 src/core/fixtures/createTestPatients.js(브라우저 "테스트 데이터 로드"
 * 버튼)를 그대로 재사용하지 않고 이 파일 안에 독립적으로 다시 구현했다 — 그 픽스처는
 * wrist 모듈 경로에서 core/utils/diagnosisMapping → @analytics-core/diagnosisMapping를
 * import하는데, 이 별칭은 vite.config.js의 resolve.alias(→ packages/analytics-core/dist)
 * 로만 존재해 tsx/Node 단독 실행에서는 절대 resolve되지 않는다(직접 확인함). 대신 knee/
 * shoulder/spine/cervical/wrist 모듈 payload의 필드 이름·타입(문자열 vs 숫자 등)은 그
 * 픽스처와 동일하게 맞춰 analytics-core 변수 추출기가 인식하는 형태를 그대로 따른다.
 *
 * 사용법(server/ 디렉터리에서):
 *   npx tsx src/cli/seedStatsTestPatients.ts --org <organizationId> [--count 300]
 *
 * DATABASE_URL 환경변수가 필요하다(server/src/db/client.ts와 동일).
 */
import { pool } from '../db/client';

// ---------------------------------------------------------------------------
// 시드 가능한 PRNG(mulberry32) — 환자 idx로 시드해 재실행 시에도 같은 조합이 나오게 한다.
// ---------------------------------------------------------------------------
type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rng: Rng, min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min;
const randFloat = (rng: Rng, min: number, max: number, decimals = 1) => {
  const v = rng() * (max - min) + min;
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
};
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[randInt(rng, 0, arr.length - 1)];
const chance = (rng: Rng, p: number) => rng() < p;
const pad2 = (n: number) => String(n).padStart(2, '0');
const toIso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (d: Date, days: number) => { const n = new Date(d); n.setDate(n.getDate() + days); return n; };
const addMonths = (d: Date, months: number) => { const n = new Date(d); n.setMonth(n.getMonth() + months); return n; };
const uuid = () => crypto.randomUUID();

// shoulder/wrist/elbow의 저/고부담 배정 — 이분형(2x2) 교차분석을 위해 각 모듈이 실제로
// 쓰인 환자 중 정확히 절반을 고부담으로 미리 셔플해서 뽑는다(아래 assignBurdenLevels).
// index의 홀짝이나 나머지 연산(예: index%2, counter++%2)은 안 쓴다 — MODULE_COMBOS
// 길이(14, 짝수)와 나머지 연산의 gcd가 공유돼 특정 조합의 index가 항상 같은 홀짝으로
// 고정되거나(예: index%14===3인 조합은 index가 항상 홀수), 두 모듈이 같은 조합에서
// 함께 쓰일 때 두 카운터가 조합 주기마다 같은 짝수만큼 늘어 위상이 고정되는 문제를
// 실측으로 확인했다(shoulder+wrist 조합 전부가 (false,none) 한 칸에만 몰림). 모듈별로
// 독립된 rng로 셔플하면 두 문제 다 사라진다.
function shuffle<T>(rng: Rng, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// moduleId가 활성화된 환자 index 중 정확히 절반을 "고부담" 집합으로 반환한다.
function assignBurdenLevels(seed: number, moduleId: string, allModules: readonly string[][]): Set<number> {
  const indices = allModules.reduce<number[]>((acc, mods, i) => {
    if (mods.includes(moduleId)) acc.push(i);
    return acc;
  }, []);
  const shuffled = shuffle(mulberry32(seed), indices);
  return new Set(shuffled.slice(0, Math.ceil(shuffled.length / 2)));
}

// ---------------------------------------------------------------------------
// 직업/부담 프리셋
// ---------------------------------------------------------------------------
const JOB_NAMES = [
  '건설 현장 배관공', '병원 행정 사무원', '학교 시설관리원', '조선소 용접공', '요양병원 간호조무사',
  '의류 봉제 작업자', '대형마트 진열 담당', '축산물 가공 작업자', '공작기계 조작원', '물류센터 상하차원',
  '고객센터 상담원', '통학버스 운전원', '설비 유지보수 기사', '검품 포장 작업자', '택배 배송 기사',
  '냉동창고 피킹 작업자', '재가요양보호사', '자동차 정비 보조원', '가구 조립 설치원', '반도체 장비 오퍼레이터',
] as const;

interface SharedJob {
  id: string;
  jobName: string;
  presetId: null;
  startDate: string;
  endDate: string;
  workPeriodOverride: string;
  workDaysPerYear: number;
}

function buildJobs(rng: Rng, injuryDate: Date, jobCount: number): SharedJob[] {
  const jobs: SharedJob[] = [];
  let end = injuryDate;
  for (let i = 0; i < jobCount; i += 1) {
    const tenureMonths = randInt(rng, 24, 240);
    const start = addMonths(end, -tenureMonths);
    jobs.unshift({
      id: uuid(),
      jobName: pick(rng, JOB_NAMES),
      presetId: null,
      startDate: toIso(start),
      endDate: toIso(end),
      workPeriodOverride: '',
      workDaysPerYear: randInt(rng, 230, 260),
    });
    end = addDays(start, -1);
  }
  return jobs;
}

// ---------------------------------------------------------------------------
// 모듈별 상병 + payload 빌더 (필드 이름/타입은 src/core/fixtures/createTestPatients.js와 동일)
// ---------------------------------------------------------------------------
type Diagnosis = Record<string, unknown>;

function buildKneeDiagnoses(rng: Rng, complete: boolean): Diagnosis[] {
  if (!complete) {
    return [
      { id: uuid(), code: 'M17.1', name: '양측성 무릎관절증', side: 'right' },
      { id: uuid(), code: 'M17.1', name: '양측성 무릎관절증', side: 'left' },
    ];
  }
  const assessmentRight = chance(rng, 0.7) ? 'high' : 'low';
  const assessmentLeft = chance(rng, 0.7) ? 'high' : 'low';
  return [
    {
      id: uuid(), code: 'M17.1', name: '양측성 무릎관절증', side: 'right',
      confirmedRight: 'confirmed', assessmentRight, klgRight: String(randInt(rng, 1, 4)),
      ...(assessmentRight === 'low' ? { reasonRight: ['lowBurden'], reasonRightOther: '' } : {}),
    },
    {
      id: uuid(), code: 'M17.1', name: '양측성 무릎관절증', side: 'left',
      confirmedLeft: 'confirmed', assessmentLeft, klgLeft: String(randInt(rng, 1, 4)),
      ...(assessmentLeft === 'low' ? { reasonLeft: ['lowBurden'], reasonLeftOther: '' } : {}),
    },
  ];
}

function buildShoulderDiagnoses(rng: Rng, complete: boolean): Diagnosis[] {
  const ellmanGrades = ['Grade 1', 'Grade 2', 'Grade 3', 'Full'] as const;
  if (!complete) {
    return [
      { id: uuid(), code: 'M75.1', name: '회전근개 파열', side: 'right' },
      { id: uuid(), code: 'M75.4', name: '어깨 충돌증후군', side: 'left' },
    ];
  }
  const assessmentRight = chance(rng, 0.7) ? 'high' : 'low';
  const assessmentLeft = chance(rng, 0.7) ? 'high' : 'low';
  return [
    {
      id: uuid(), code: 'M75.1', name: '회전근개 파열', side: 'right',
      ellmanRight: pick(rng, ellmanGrades), confirmedRight: 'confirmed', assessmentRight,
      ...(assessmentRight === 'low' ? { reasonRight: ['lowBurden'], reasonRightOther: '' } : {}),
    },
    {
      id: uuid(), code: 'M75.4', name: '어깨 충돌증후군', side: 'left',
      ellmanLeft: pick(rng, ellmanGrades), confirmedLeft: 'confirmed', assessmentLeft,
      ...(assessmentLeft === 'low' ? { reasonLeft: ['lowBurden'], reasonLeftOther: '' } : {}),
    },
  ];
}

function buildSpineDiagnosis(rng: Rng, complete: boolean): Diagnosis {
  if (!complete) return { id: uuid(), code: 'M51.1', name: '요추추간판탈출증', side: '' };
  const assessmentRight = chance(rng, 0.7) ? 'high' : 'low';
  return {
    id: uuid(), code: 'M51.1', name: '요추추간판탈출증', side: '',
    confirmedRight: 'confirmed', assessmentRight,
    ...(assessmentRight === 'low' ? { reasonRight: ['lowBurden'], reasonRightOther: '' } : {}),
  };
}

function buildCervicalDiagnosis(rng: Rng, complete: boolean): Diagnosis {
  const useM50 = chance(rng, 0.5);
  const code = useM50 ? 'M50.1' : 'M48.02';
  const name = useM50 ? '경추간판장애' : '경추 척추관 협착';
  if (!complete) return { id: uuid(), code, name, side: '' };
  const assessmentRight = chance(rng, 0.7) ? 'high' : 'low';
  return {
    id: uuid(), code, name, side: '',
    confirmedRight: 'confirmed', assessmentRight,
    ...(assessmentRight === 'low' ? { reasonRight: ['lowBurden'], reasonRightOther: '' } : {}),
  };
}

const WRIST_TEMPLATES = [
  { code: 'G56.0', name: '수근관증후군', side: 'right', bkType: 'BK2113' },
  { code: 'M65.4', name: '드퀘르벵 건초염', side: 'right', bkType: 'BK2101' },
  // 이름에 반드시 '손목'/'척골'/'guyon' 중 하나가 있어야 한다 — diagnosisMapping.ts의
  // NAME_MODULE_MAP은 spine 패턴 끝에 빈 대안(|)이 있는 기존 버그가 있어(코드 주석 참고,
  // 이 PR 범위 밖이라 고치지 않음) 위 wrist 키워드에 안 걸리는 이름은 전부 spine으로
  // 오분류된다 — 실측 확인(순수 '기용관 증후군'만 쓰면 wrist.assessment.burdenGradeMax가
  // 전부 not_entered로 나옴).
  { code: 'G56.2', name: '손목 기용관 증후군', side: 'left', bkType: 'BK2106' },
  { code: 'M65.3', name: '방아쇠수지', side: 'right', bkType: 'BK2101' },
] as const;

function buildWristDiagnosis(rng: Rng, complete: boolean) {
  const template = pick(rng, WRIST_TEMPLATES);
  const confirmedKey = template.side === 'left' ? 'confirmedLeft' : 'confirmedRight';
  const assessmentKey = template.side === 'left' ? 'assessmentLeft' : 'assessmentRight';
  const reasonKey = template.side === 'left' ? 'reasonLeft' : 'reasonRight';
  const reasonOtherKey = template.side === 'left' ? 'reasonLeftOther' : 'reasonRightOther';
  const assessment = chance(rng, 0.7) ? 'high' : 'low';
  const diagnosis: Diagnosis = {
    id: uuid(), code: template.code, name: template.name, side: template.side,
    ...(complete ? {
      [confirmedKey]: 'confirmed',
      [assessmentKey]: assessment,
      ...(assessment === 'low' ? { [reasonKey]: ['lowBurden'], [reasonOtherKey]: '' } : {}),
    } : {}),
  };
  return { diagnosis, bkType: template.bkType };
}

// ---------------------------------------------------------------------------
// 모듈별 payload 빌더
// ---------------------------------------------------------------------------
function buildKneeModule(rng: Rng, jobs: SharedJob[]) {
  return {
    jobExtras: jobs.map((job) => ({
      sharedJobId: job.id,
      weight: String(randInt(rng, 500, 3500)),
      squatting: String(randInt(rng, 5, 95)),
      evidenceSources: [],
      stairs: chance(rng, 0.5),
      kneeTwist: chance(rng, 0.5),
      startStop: chance(rng, 0.5),
      tightSpace: chance(rng, 0.3),
      kneeContact: chance(rng, 0.3),
      jumpDown: chance(rng, 0.2),
    })),
    returnConsiderations: '',
  };
}

// shoulder.exposure.anyExceeded는 5개 누적 한도(EXPOSURE_LIMITS, derived.ts) 중 하나라도
// 넘으면 true다 — 누적치는 (일일 노출시간)×(연간 근무일수)×(근속연수)라 근속기간이 길면
// 낮은 하루 노출값으로도 우연히 넘는 경우가 흔하다. "이분형(2x2) 분석"이 되려면 true/false가
// 표본에 고르게 섞여야 하므로, 절반은 5개 한도 모두에서 확실히 안전한 저노출 프로필로,
// 나머지 절반은 최소 1개는 확실히 넘는 고노출 프로필로 명시적으로 갈라 생성한다.
// highExposure는 호출부(generatePatient)가 assignBurdenLevels로 미리 셔플해 배정한
// 값을 그대로 받는다 — rng.chance(0.5)나 index 나머지 연산은 표본이 크게 치우쳤다
// (파일 상단 assignBurdenLevels 주석 참고).
function buildShoulderModule(rng: Rng, jobs: SharedJob[], highExposure: boolean) {
  return {
    jobExtras: jobs.map((job) => ({
      sharedJobId: job.id,
      overheadHours: (highExposure ? randFloat(rng, 1.4, 2.4, 1) : randFloat(rng, 0.05, 0.25, 1)).toFixed(1),
      repetitiveMediumHours: (highExposure ? randFloat(rng, 2.0, 3.5, 1) : randFloat(rng, 0.05, 0.3, 1)).toFixed(1),
      repetitiveFastHours: (highExposure ? randFloat(rng, 0.6, 1.2, 1) : randFloat(rng, 0.0, 0.1, 1)).toFixed(1),
      // 누적시간 = 일일노출×연간근무일수×근속연수(computeJobExposures, derived.ts)라
      // 근속기간(2~20년, buildJobs)이 짧으면 나머지 4개 한도(overhead 3600h 등)는 하루
      // 몇 시간씩 일해도 절대 못 넘는다 — heavyLoad(200h)만 물리적으로 도달 가능한
      // 유일한 한도라, 근속 최소치(2년)에서도 확실히 넘도록 여유를 크게 잡는다
      // (실측: count 22~35/seconds 12~20는 짧은 근속에서 200h를 못 넘겨 anyExceeded가
      // 28건 중 5건만 true로 나왔다).
      heavyLoadCount: String(highExposure ? randInt(rng, 90, 130) : randInt(rng, 0, 3)),
      heavyLoadSeconds: String(highExposure ? randInt(rng, 30, 45) : randInt(rng, 2, 4)),
      vibrationHours: (highExposure ? randFloat(rng, 1.0, 1.8, 1) : randFloat(rng, 0.0, 0.05, 1)).toFixed(1),
      evidenceSources: [],
    })),
    returnConsiderations: '',
  };
}

const SPINE_POSTURES = ['G3', 'G4', 'G5', 'G6', 'G7'] as const;
const SPINE_TASK_NAMES = ['중량 자재 운반', '부품 상자 이동', '적재물 정리', '환자 체위 변경', '상자 상하차'] as const;

function buildSpineModule(rng: Rng, jobs: SharedJob[]) {
  return {
    formulaVersion: 'v5.1.3',
    tasks: jobs.flatMap((job, jobIndex) => {
      const taskCount = randInt(rng, 1, 3);
      return Array.from({ length: taskCount }, (_v, taskIdx) => ({
        id: jobIndex * 100 + taskIdx + 1,
        sharedJobId: job.id,
        name: pick(rng, SPINE_TASK_NAMES),
        posture: pick(rng, SPINE_POSTURES),
        // MDDM 압박력(F=b+m*weight)이 thresholds.singleForce(1900N)를 넘고, 일일선량
        // (sumF²T/8h 기반)도 dailyDose 임계(v5.1.3: 남 4.0/여 3.0 kN·h)를 대체로 넘도록
        // 무게·빈도·시간을 충분히 크게 잡는다 — 너무 작으면 excluded(=lifetimeDose 0)로
        // 처리돼 spine.mddm.lifetimeDoseMNh가 not_entered로 나온다(실측 확인).
        weight: randInt(rng, 12, 35),
        frequency: randInt(rng, 25, 70),
        timeValue: randInt(rng, 6, 14),
        timeUnit: 'sec',
        correctionFactor: randFloat(rng, 1.0, 1.3, 1),
        force: 0,
      }));
    }),
    // spine.vibration.dvMax(전신진동 BK2110) 표본도 일부 확보 — 약 40%만 노출 있음으로
    // 설정한다(전부 노출시키면 비노출군과의 비교/분포 검증이 안 되고, 전부 비워두면 이
    // 카탈로그 변수 자체가 통계 표본에서 늘 0건이 된다).
    ...(chance(rng, 0.4)
      ? {
          vibrationExposureStatus: 'present',
          vibrationIntervals: jobs.map((job, jobIndex) => ({
            id: jobIndex + 1,
            sharedJobId: job.id,
            name: '진동 공구 사용',
            awMin: randFloat(rng, 0.3, 0.6, 2),
            awMax: randFloat(rng, 0.8, 1.6, 2),
            timeValue: randInt(rng, 1, 4),
            timeUnit: 'hr',
          })),
        }
      : { vibrationExposureStatus: 'none' }),
  };
}

const CERVICAL_TASK_TEMPLATES: Array<{ name: string; exposure_types: string[] }> = [
  { name: '중량물 어깨 운반', exposure_types: ['shoulder_heavy_load'] },
  { name: '상방 주시 및 목 고정 작업', exposure_types: ['awkward_static_neck_load'] },
  { name: '적재물 정리와 목 회전 확인', exposure_types: ['shoulder_heavy_load', 'awkward_static_neck_load'] },
];

function buildCervicalModule(rng: Rng, jobs: SharedJob[]) {
  return {
    tasks: jobs.flatMap((job, jobIndex) => {
      const taskCount = randInt(rng, 1, 3);
      return Array.from({ length: taskCount }, (_v, taskIdx) => {
        const template = CERVICAL_TASK_TEMPLATES[taskIdx % CERVICAL_TASK_TEMPLATES.length];
        const hasCarry = template.exposure_types.includes('shoulder_heavy_load');
        const hasStatic = template.exposure_types.includes('awkward_static_neck_load');
        return {
          id: jobIndex * 1000 + taskIdx + 1,
          sharedJobId: job.id,
          name: template.name,
          exposure_types: template.exposure_types,
          load_weight_kg: hasCarry ? String(randInt(rng, 12, 45)) : '',
          carry_hours_per_shift: hasCarry ? randFloat(rng, 0.2, 1.2, 1).toFixed(1) : '',
          forced_neck_posture: hasCarry ? (chance(rng, 0.5) ? 'yes' : 'no') : '',
          neck_nonneutral_hours_per_day: hasStatic ? randFloat(rng, 0.5, 2.5, 1).toFixed(1) : '',
          combined_flexion_rotation_posture: hasStatic ? (chance(rng, 0.5) ? 'yes' : 'no') : '',
          precision_work: hasStatic ? (chance(rng, 0.4) ? 'yes' : 'no') : '',
          notes: '',
        };
      });
    }),
    returnConsiderations: '',
  };
}

// createWristDiagnosisEntry(src/modules/wrist/utils/data.js)와 동일한 기본 필드 세트.
function emptyWristDiagnosisEntry(diagnosisId: string, bkType: string): Record<string, unknown> {
  return {
    diagnosisId, selectedBkType: bkType, bkSelectionMode: 'auto',
    main_task_name: '', direct_anatomic_link: '', exposure_types: [] as string[],
    repetition_level: '', daily_exposure_hours: '', shift_share_percent: '',
    days_per_week: '', work_pattern: '', rest_distribution: '',
    force_level: '', awkward_posture_level: '', static_holding_level: '',
    direct_pressure_level: '', vibration_exposure: '',
    bk2113_repetitive_wrist_motion: '', bk2101_cycle_seconds: '',
    bk2101_repetition_per_hour: '', bk2101_monotony: '',
    bk2101_forced_dorsal_extension: '', bk2101_prosupination: '',
    bk2106_pressure_source: [] as string[], bk2103_vibration_tool_type: [] as string[],
    bk2103_daily_vibration_hours: '', bk2103_tool_pressing: '',
    bk2103_frequent_high_force_grip: '',
  };
}

// wrist.assessment.burdenGradeMax(부담 작업 아님<경도<중등도<고도)는 riskFactorCount 기반
// 등급이다 — direct_anatomic_link='yes'+exposure_types 비어있지 않음만으로 이미
// core_exposure_present 1개가 항상 켜지므로, 나머지 필드를 전부 "웬만큼 부담있게" 채우면
// riskFactorCount가 쉽게 2 이상(=경도 이상)이 돼 '부담 작업 아님'이 표본에서 거의 사라진다.
// "이분형(부담 작업 아님 vs 나머지)" 교차분석이 되려면 두 쪽 다 있어야 하므로, 절반은
// 위험요인 플래그가 core_exposure_present 하나만 켜지는 저부담 프로필로, 절반은 여러
// 플래그가 동시에 켜지는 고부담 프로필로 명시적으로 갈라 생성한다(computeDiagnosisFlags,
// derived.ts 실측 기준).
function buildWristModule(rng: Rng, jobs: SharedJob[], diagnosisId: string, bkType: string, highBurden: boolean) {

  const branchFields: Record<string, unknown> =
    bkType === 'BK2113' ? { bk2113_repetitive_wrist_motion: highBurden ? 'yes' : 'no' }
    : bkType === 'BK2101' ? {
        // getBk2101RepetitionPerHour(derived.ts)는 bk2101_cycle_seconds가 있으면 그걸로
        // repetitionPerHour를 다시 계산해버리고 bk2101_repetition_per_hour 필드는 무시한다
        // — cycle_seconds를 burden 레벨과 무관하게 고정해두면 저부담군에서도 우연히
        // 10000/hr 임계를 넘어 bk2101_high_freq_example이 새는 걸 실측으로 확인했다.
        bk2101_cycle_seconds: (highBurden ? randFloat(rng, 0.2, 0.35, 2) : randFloat(rng, 3, 5, 2)).toFixed(2),
        bk2101_repetition_per_hour: String(highBurden ? randInt(rng, 10000, 14000) : randInt(rng, 500, 2000)),
        bk2101_monotony: highBurden ? 'yes' : 'no',
        bk2101_forced_dorsal_extension: highBurden ? 'yes' : 'no',
        bk2101_prosupination: highBurden ? 'yes' : 'no',
        static_holding_level: highBurden ? 'frequent' : 'mild',
      }
    : {
        static_holding_level: highBurden ? 'frequent' : 'mild',
        direct_pressure_level: highBurden ? 'frequent' : 'none',
        bk2106_pressure_source: highBurden ? ['tool_edge'] : [],
      };

  return {
    returnConsiderations: '',
    temporalSequence: {
      recent_task_change: chance(rng, 0.5) ? 'increased_load' : 'process_change',
      task_change_date: jobs[jobs.length - 1]?.startDate ?? '',
      symptom_onset_interval: chance(rng, 0.5) ? '3to12m' : 'within3m',
      // temporal_fit_high(리스크 요인)는 recent_task_change!=='none' && improves_with_rest
      // ==='yes'일 때 켜진다(computeTemporalFlags, derived.ts) — burdenLevel과 무관하게
      // 50%로 'yes'를 주면 저부담군에도 이 플래그가 섞여 '부담 작업 아님'이 실제보다 훨씬
      // 적게 나온다(실측 확인). 저부담군은 항상 'unclear'로 고정해 core_exposure_present
      // 하나만 켜지도록 보장한다.
      improves_with_rest: highBurden && chance(rng, 0.5) ? 'yes' : 'unclear',
    },
    jobEvaluations: jobs.map((job) => {
      const entry = highBurden
        ? {
            ...emptyWristDiagnosisEntry(diagnosisId, bkType),
            main_task_name: pick(rng, JOB_NAMES),
            direct_anatomic_link: 'yes',
            exposure_types: ['repetition', 'force', 'awkward_posture'],
            repetition_level: 'frequent',
            daily_exposure_hours: randFloat(rng, 3.0, 5.0, 1).toFixed(1),
            shift_share_percent: String(randInt(rng, 50, 75)),
            days_per_week: String(randInt(rng, 5, 6)),
            work_pattern: 'continuous',
            rest_distribution: 'insufficient',
            force_level: 'high',
            awkward_posture_level: 'frequent',
            direct_pressure_level: 'frequent',
            vibration_exposure: 'present',
            ...branchFields,
          }
        : {
            ...emptyWristDiagnosisEntry(diagnosisId, bkType),
            main_task_name: pick(rng, JOB_NAMES),
            direct_anatomic_link: 'yes',
            exposure_types: ['repetition'],
            repetition_level: 'occasional',
            daily_exposure_hours: randFloat(rng, 0.3, 0.9, 1).toFixed(1),
            shift_share_percent: String(randInt(rng, 5, 15)),
            days_per_week: String(randInt(rng, 3, 5)),
            work_pattern: 'intermittent',
            rest_distribution: 'moderate',
            force_level: 'mild',
            awkward_posture_level: 'occasional',
            direct_pressure_level: 'none',
            vibration_exposure: 'none',
            ...branchFields,
          };
      return { sharedJobId: job.id, diagnosisEntries: [entry] };
    }),
  };
}

// 팔꿈치(BK2101/2103/2105/2106) — wrist와 계산 구조가 사실상 동일한 클론이라(같은
// REQUIRED_ENTRY_FIELDS/getBranchRequiredFields/computeDiagnosisFlags 패턴, ELBOW_BRANCH_
// FIELDS만 다름) wrist와 같은 저/고부담 분리 방식을 그대로 적용한다.
// 진단명은 전부 "팔꿈치"로 시작한다 — diagnosisMapping.ts의 NAME_MODULE_MAP은 순서상
// knee→wrist→elbow→shoulder→cervical→spine으로 검사하는데, elbow 키워드 자체가 없는
// 이름을 쓰면(예: 코드만 보고 매칭될 거라 가정) wrist가 먼저 낚아채거나 spine의 빈
// 대안(|) 버그로 오분류될 위험이 있다 — wrist의 '기용관 증후군' 사례에서 실측 확인된
// 함정과 같은 종류라 미리 피한다.
const ELBOW_TEMPLATES = [
  { code: 'M77.0', name: '팔꿈치 외측 상과염', side: 'right', bkType: 'BK2101' },
  { code: 'T75.2', name: '진동성 팔꿈치 관절병증', side: 'right', bkType: 'BK2103' },
  { code: 'M70.2', name: '팔꿈치 점액낭염', side: 'left', bkType: 'BK2105' },
  { code: 'M77.9', name: '팔꿈치 주관증후군', side: 'left', bkType: 'BK2106' },
] as const;

function buildElbowDiagnosis(rng: Rng, complete: boolean) {
  const template = pick(rng, ELBOW_TEMPLATES);
  const confirmedKey = template.side === 'left' ? 'confirmedLeft' : 'confirmedRight';
  const assessmentKey = template.side === 'left' ? 'assessmentLeft' : 'assessmentRight';
  const reasonKey = template.side === 'left' ? 'reasonLeft' : 'reasonRight';
  const reasonOtherKey = template.side === 'left' ? 'reasonLeftOther' : 'reasonRightOther';
  const assessment = chance(rng, 0.7) ? 'high' : 'low';
  const diagnosis: Diagnosis = {
    id: uuid(), code: template.code, name: template.name, side: template.side,
    ...(complete ? {
      [confirmedKey]: 'confirmed',
      [assessmentKey]: assessment,
      ...(assessment === 'low' ? { [reasonKey]: ['lowBurden'], [reasonOtherKey]: '' } : {}),
    } : {}),
  };
  return { diagnosis, bkType: template.bkType };
}

// createElbowDiagnosisEntry(analytics-core/modules/elbow/legacyNormalize.ts)와 동일한 기본 필드.
function emptyElbowDiagnosisEntry(diagnosisId: string, bkType: string): Record<string, unknown> {
  return {
    diagnosisId, selectedBkType: bkType, bkSelectionMode: 'auto',
    main_task_name: '', direct_anatomic_link: '', exposure_types: [] as string[],
    repetition_level: '', daily_exposure_hours: '', shift_share_percent: '',
    days_per_week: '', work_pattern: '', rest_distribution: '',
    force_level: '', awkward_posture_level: '', static_holding_level: '',
    direct_pressure_level: '', vibration_exposure: '',
    bk2101_cycle_seconds: '', bk2101_repetition_per_hour: '', bk2101_monotony: '',
    bk2101_forced_dorsal_extension: '', bk2101_prosupination: '',
    bk2105_elbow_leaning: '', bk2105_repeated_friction_impact: '', bk2105_pressure_source: [] as string[],
    bk2106_repeated_mechanical_exposure: '', bk2106_noncorrectable_posture: '',
    bk2106_prolonged_joint_position: '', bk2106_pressure_source: [] as string[],
    bk2103_vibration_tool_type: [] as string[], bk2103_daily_vibration_hours: '',
    bk2103_handheld_or_guided: '', bk2103_tool_pressing: '', bk2103_frequent_high_force_grip: '',
  };
}

// elbow.assessment.burdenGradeMax도 wrist와 동일한 riskFactorCount 기반 등급이라 같은
// 이유로 저/고부담을 명시적으로 나눈다(위 buildWristModule 주석 참고).
function buildElbowModule(rng: Rng, jobs: SharedJob[], diagnosisId: string, bkType: string, highBurden: boolean) {

  const branchFields: Record<string, unknown> =
    bkType === 'BK2101' ? {
      // wrist와 동일한 함정(getBk2101RepetitionPerHour가 cycle_seconds를 우선한다) — 위
      // buildWristModule 주석 참고.
      bk2101_cycle_seconds: (highBurden ? randFloat(rng, 0.2, 0.35, 2) : randFloat(rng, 3, 5, 2)).toFixed(2),
      bk2101_repetition_per_hour: String(highBurden ? randInt(rng, 10000, 14000) : randInt(rng, 500, 2000)),
      bk2101_monotony: highBurden ? 'yes' : 'no',
      bk2101_forced_dorsal_extension: highBurden ? 'yes' : 'no',
      bk2101_prosupination: highBurden ? 'yes' : 'no',
      static_holding_level: highBurden ? 'frequent' : 'mild',
    }
    : bkType === 'BK2103' ? {
      vibration_exposure: highBurden ? 'present' : 'none',
      bk2103_vibration_tool_type: highBurden ? ['grinder'] : [],
      bk2103_daily_vibration_hours: highBurden ? randFloat(rng, 2, 4, 1).toFixed(1) : '0.0',
      bk2103_tool_pressing: highBurden ? 'yes' : 'no',
    }
    : bkType === 'BK2105' ? {
      bk2105_elbow_leaning: highBurden ? 'yes' : 'no',
      direct_pressure_level: highBurden ? 'frequent' : 'none',
      bk2105_pressure_source: highBurden ? ['hard_surface'] : [],
    }
    : {
      static_holding_level: highBurden ? 'frequent' : 'mild',
      direct_pressure_level: highBurden ? 'frequent' : 'none',
      bk2106_pressure_source: highBurden ? ['tool_edge'] : [],
    };

  return {
    returnConsiderations: '',
    temporalSequence: {
      recent_task_change: chance(rng, 0.5) ? 'increased_load' : 'process_change',
      task_change_date: jobs[jobs.length - 1]?.startDate ?? '',
      symptom_onset_interval: chance(rng, 0.5) ? '3to12m' : 'within3m',
      // temporal_fit_high(리스크 요인)는 recent_task_change!=='none' && improves_with_rest
      // ==='yes'일 때 켜진다(computeTemporalFlags, derived.ts) — burdenLevel과 무관하게
      // 50%로 'yes'를 주면 저부담군에도 이 플래그가 섞여 '부담 작업 아님'이 실제보다 훨씬
      // 적게 나온다(실측 확인). 저부담군은 항상 'unclear'로 고정해 core_exposure_present
      // 하나만 켜지도록 보장한다.
      improves_with_rest: highBurden && chance(rng, 0.5) ? 'yes' : 'unclear',
    },
    jobEvaluations: jobs.map((job) => {
      const entry = highBurden
        ? {
            ...emptyElbowDiagnosisEntry(diagnosisId, bkType),
            main_task_name: pick(rng, JOB_NAMES),
            direct_anatomic_link: 'yes',
            exposure_types: ['repetition', 'force', 'awkward_posture'],
            repetition_level: 'frequent',
            daily_exposure_hours: randFloat(rng, 3.0, 5.0, 1).toFixed(1),
            shift_share_percent: String(randInt(rng, 50, 75)),
            days_per_week: String(randInt(rng, 5, 6)),
            work_pattern: 'continuous',
            rest_distribution: 'insufficient',
            force_level: 'high',
            awkward_posture_level: 'frequent',
            ...branchFields,
          }
        : {
            ...emptyElbowDiagnosisEntry(diagnosisId, bkType),
            main_task_name: pick(rng, JOB_NAMES),
            direct_anatomic_link: 'yes',
            exposure_types: ['repetition'],
            repetition_level: 'occasional',
            daily_exposure_hours: randFloat(rng, 0.3, 0.9, 1).toFixed(1),
            shift_share_percent: String(randInt(rng, 5, 15)),
            days_per_week: String(randInt(rng, 3, 5)),
            work_pattern: 'intermittent',
            rest_distribution: 'moderate',
            force_level: 'mild',
            awkward_posture_level: 'occasional',
            ...branchFields,
          };
      return { sharedJobId: job.id, diagnosisEntries: [entry] };
    }),
  };
}

// ---------------------------------------------------------------------------
// 환자 1명 생성
// ---------------------------------------------------------------------------
// shoulder×wrist·shoulder×elbow 조합을 넣어 두 boolean/ordinal 변수가 같은 case에서
// 동시에 non-missing인 표본을 확보한다 — 그래야 이분형(2x2 카이제곱/Fisher) 교차분석 시
// 두 변수 모두 값이 있는 행이 남는다(한쪽만 있으면 교차표 자체가 안 만들어짐).
const MODULE_COMBOS = [
  ['knee'], ['knee', 'spine'], ['spine'], ['shoulder'], ['wrist'], ['elbow'],
  ['shoulder', 'wrist'], ['shoulder', 'elbow'], ['wrist', 'elbow'],
  ['knee', 'spine', 'cervical'], ['cervical'], ['shoulder', 'cervical'],
  ['wrist', 'spine', 'cervical'], ['elbow', 'spine'],
] as const;

interface GeneratedPatient {
  id: string;
  createdAt: string;
  phase: string;
  data: {
    shared: {
      patientNo: string;
      name: string;
      gender: string;
      height: string;
      weight: string;
      birthDate: string;
      injuryDate: string;
      hospitalName: string;
      department: string;
      doctorName: string;
      evaluationDate: string;
      medicalRecord: string;
      highBloodPressure: string;
      diabetes: string;
      visitHistory: string;
      consultReplyOrtho: string;
      consultReplyNeuro: string;
      consultReplyRehab: string;
      consultReplyOther: string;
      specialNotes: string;
      diagnoses: Diagnosis[];
      jobs: SharedJob[];
    };
    modules: Record<string, unknown>;
    activeModules: string[];
  };
}

interface BurdenFlags {
  shoulderHigh: boolean;
  wristHigh: boolean;
  elbowHigh: boolean;
}

function generatePatient(index: number, patientNo: string, burden: BurdenFlags): GeneratedPatient {
  const rng = mulberry32(1000 + index * 7919);
  const modules = [...MODULE_COMBOS[index % MODULE_COMBOS.length]];
  const isComplete = chance(rng, 0.85);

  const base = new Date(2024, 0, 1);
  const createdDate = addDays(base, randInt(rng, 0, 640));
  const injuryDate = createdDate;
  let evaluationDate = '';
  if (isComplete) evaluationDate = toIso(addDays(createdDate, randInt(rng, 10, 60)));

  const gender = chance(rng, 0.5) ? 'male' : 'female';
  const height = gender === 'male' ? randInt(rng, 163, 182) : randInt(rng, 150, 170);
  const weight = gender === 'male' ? randInt(rng, 58, 95) : randInt(rng, 45, 75);
  const age = randInt(rng, 25, 65);
  const birthYear = createdDate.getFullYear() - age;
  const birthDate = `${birthYear}-${pad2(randInt(rng, 1, 12))}-${pad2(randInt(rng, 1, 28))}`;

  const jobCount = randInt(rng, 1, 2);
  const jobs = buildJobs(rng, injuryDate, jobCount);

  const diagnoses: Diagnosis[] = [];
  const moduleData: Record<string, unknown> = {};
  let wristBkType = '';
  let wristDiagnosisId = '';

  if (modules.includes('knee')) {
    diagnoses.push(...buildKneeDiagnoses(rng, isComplete));
    moduleData.knee = buildKneeModule(rng, jobs);
  }
  if (modules.includes('shoulder')) {
    diagnoses.push(...buildShoulderDiagnoses(rng, isComplete));
    moduleData.shoulder = buildShoulderModule(rng, jobs, burden.shoulderHigh);
  }
  if (modules.includes('spine')) {
    diagnoses.push(buildSpineDiagnosis(rng, isComplete));
    moduleData.spine = buildSpineModule(rng, jobs);
  }
  if (modules.includes('cervical')) {
    diagnoses.push(buildCervicalDiagnosis(rng, isComplete));
    moduleData.cervical = buildCervicalModule(rng, jobs);
  }
  if (modules.includes('wrist')) {
    const { diagnosis, bkType } = buildWristDiagnosis(rng, isComplete);
    diagnoses.push(diagnosis);
    wristBkType = bkType;
    wristDiagnosisId = diagnosis.id as string;
    moduleData.wrist = buildWristModule(rng, jobs, wristDiagnosisId, wristBkType, burden.wristHigh);
  }
  if (modules.includes('elbow')) {
    const { diagnosis, bkType } = buildElbowDiagnosis(rng, isComplete);
    diagnoses.push(diagnosis);
    moduleData.elbow = buildElbowModule(rng, jobs, diagnosis.id as string, bkType, burden.elbowHigh);
  }
  if (diagnoses.length === 0) {
    diagnoses.push({ id: uuid(), code: 'M79.3', name: '근육통', side: '' });
  }

  const createdAtIso = `${toIso(createdDate)}T09:${pad2(index % 60)}:00.000Z`;

  return {
    id: uuid(),
    createdAt: createdAtIso,
    phase: 'evaluation',
    data: {
      shared: {
        patientNo,
        name: `테스트환자${index + 1}`,
        gender,
        height: String(height),
        weight: String(weight),
        birthDate,
        injuryDate: toIso(injuryDate),
        hospitalName: '',
        department: '',
        doctorName: '',
        evaluationDate,
        medicalRecord: '',
        highBloodPressure: chance(rng, 0.2) ? 'yes' : 'no',
        diabetes: chance(rng, 0.15) ? 'yes' : 'no',
        visitHistory: '',
        consultReplyOrtho: '',
        consultReplyNeuro: '',
        consultReplyRehab: '',
        consultReplyOther: '',
        specialNotes: '',
        diagnoses,
        jobs,
      },
      modules: moduleData,
      activeModules: modules,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI + DB 삽입
// ---------------------------------------------------------------------------
interface CliArgs { org?: string; count?: string }

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') args.org = argv[++i];
    else if (argv[i] === '--count') args.count = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const count = Number(args.count ?? 300);
  if (!Number.isFinite(count) || count <= 0) {
    console.error('ERROR: --count must be a positive number.');
    process.exitCode = 1;
    return;
  }

  if (!args.org) {
    const { rows } = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM organizations ORDER BY created_at`
    );
    console.error('ERROR: --org <organizationId> is required. Available organizations:');
    for (const row of rows) console.error(`  ${row.id}  ${row.name}`);
    process.exitCode = 1;
    return;
  }
  const orgId = args.org;

  const orgCheck = await pool.query(`SELECT id FROM organizations WHERE id = $1`, [orgId]);
  if (orgCheck.rowCount === 0) {
    console.error(`ERROR: organization ${orgId} not found.`);
    process.exitCode = 1;
    return;
  }

  const doctors = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM users
     WHERE organization_id = $1 AND role = 'doctor' AND disabled_at IS NULL
     ORDER BY created_at`,
    [orgId]
  );
  const fallbackOwner = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE organization_id = $1 AND disabled_at IS NULL ORDER BY created_at LIMIT 1`,
    [orgId]
  );

  const runId = Math.random().toString(36).slice(2, 8);
  console.log(`[seed] org=${orgId} run=${runId} 환자 ${count}명 생성 중...`);

  // 어떤 환자가 어느 모듈을 쓰는지 먼저 전부 계산한 뒤, 모듈별로 독립적인 셔플로
  // 저/고부담을 정확히 절반씩 배정한다(assignBurdenLevels 주석 참고 — generatePatient
  // 내부에서 그때그때 정하면 MODULE_COMBOS 주기와 얽혀 편향된다).
  const moduleAssignments = Array.from({ length: count }, (_v, i) => [...MODULE_COMBOS[i % MODULE_COMBOS.length]]);
  const shoulderHighSet = assignBurdenLevels(11, 'shoulder', moduleAssignments);
  const wristHighSet = assignBurdenLevels(22, 'wrist', moduleAssignments);
  const elbowHighSet = assignBurdenLevels(33, 'elbow', moduleAssignments);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let i = 0; i < count; i += 1) {
      const patientNo = `ST${runId}-${String(i + 1).padStart(4, '0')}`;
      const patient = generatePatient(i, patientNo, {
        shoulderHigh: shoulderHighSet.has(i),
        wristHigh: wristHighSet.has(i),
        elbowHigh: elbowHighSet.has(i),
      });
      const shared = patient.data.shared;
      const doctor = doctors.rowCount && doctors.rowCount > 0 ? doctors.rows[i % doctors.rows.length] : null;
      const ownerUserId = doctor?.id ?? fallbackOwner.rows[0]?.id ?? null;

      const person = await client.query<{ id: string }>(
        `INSERT INTO patient_persons (organization_id, patient_no, name, birth_date)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [orgId, patientNo, shared.name, shared.birthDate || null]
      );
      const personId = person.rows[0].id;

      const diagnosesCodes = shared.diagnoses.map((d) => d.code as string).filter(Boolean);
      const jobsNames = shared.jobs.map((j) => j.jobName).filter(Boolean);
      const storedPayload = {
        id: patient.id,
        phase: patient.phase,
        createdAt: patient.createdAt,
        data: patient.data,
      };

      await client.query(
        `INSERT INTO patient_records
           (id, organization_id, patient_person_id, owner_user_id, assigned_doctor_user_id,
            name, patient_no, birth_date, injury_date, evaluation_date,
            active_modules, diagnoses_codes, jobs_names, revision, payload,
            completion_status, server_observed_modules_complete_at, completion_source,
            completion_client_build_version, completion_client_schema_version,
            server_verified_modules_complete_at, completion_verification_engine_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,$14,
                 'draft',NULL,NULL,NULL,NULL,NULL,NULL)`,
        [
          patient.id, orgId, personId, ownerUserId, doctor?.id ?? null,
          shared.name, patientNo,
          shared.birthDate || null, shared.injuryDate || null, shared.evaluationDate || null,
          patient.data.activeModules, diagnosesCodes, jobsNames,
          JSON.stringify(storedPayload),
        ]
      );
    }

    await client.query('COMMIT');
    console.log(`[seed] patient_records ${count}건 삽입 완료 (run=${runId}).`);
    console.log('[seed] 정리하려면:');
    console.log(`  DELETE FROM patient_records WHERE patient_no LIKE 'ST${runId}-%';`);
    console.log(`  DELETE FROM patient_persons WHERE patient_no LIKE 'ST${runId}-%';`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error('[seed] error', err);
    pool.end();
    process.exit(1);
  });
