import { describe, it, expect } from 'vitest';
import {
  AiAnalysisInputSchema,
  AiAnalysisRequestSchema,
  AiAnalysisExternalRequestSchema,
  ELBOW_FLAG_KEYS,
  WRIST_FLAG_KEYS,
  CERVICAL_FLAG_KEYS,
  KNEE_AUX_KEYS,
  SHOULDER_EXPOSURE_KEYS,
  LOW_REASON_KEYS,
  type AiAnalysisInput,
} from '../aiAnalysis';
import {
  buildPrompt,
  buildInternalPrompt,
  UNIFIED_AI_SYSTEM_PROMPT,
  ELBOW_FLAG_LABELS,
  WRIST_FLAG_LABELS,
  CERVICAL_FLAG_LABELS,
  KNEE_AUX_LABELS,
  SHOULDER_LABELS,
  LOW_REASON_LABELS,
} from '../aiPrompt';

// 모든 모듈을 채운 유효 입력. 테스트마다 structuredClone으로 복사해 쓴다.
function fullInput(): AiAnalysisInput {
  const unit = (side: 'right' | 'left' | 'axial', over: object = {}) => ({
    side, confirmed: 'confirmed' as const, assessment: 'high' as const, reasons: [], klg: null, ellman: null, ...over,
  });
  const diag = (code: string, moduleId: AiAnalysisInput['diagnoses'][number]['moduleId'], side: 'right' | 'left' | 'both' | null, units: object[], over: object = {}) => ({
    code, moduleId, side, units, verticalDistribution: null, concomitantSpondylosis: null, ...over,
  });
  return {
    schemaVersion: 1,
    demographics: { ageYears: 52, gender: 'male', heightCm: 170, weightKg: 72, bmi: 24.9, hypertension: true, diabetes: false },
    diagnoses: [
      diag('M17.1', 'knee', 'both', [unit('right', { klg: '3' }), unit('left', { assessment: 'low', reasons: ['ageMild', 'lowBurden'], klg: '1' })]),
      diag('M51.1', 'spine', null, [unit('axial')], { verticalDistribution: 'confirmed', concomitantSpondylosis: 'unconfirmed' }),
      diag('M75.1', 'shoulder', 'right', [unit('right', { ellman: 'Grade 2' })]),
      diag('M77.1', 'elbow', 'right', [unit('right')]),
      diag('G56.0', 'wrist', 'left', [unit('left')]),
      diag('M50.1', 'cervical', null, [unit('axial')]),
    ] as AiAnalysisInput['diagnoses'],
    jobs: [
      { durationYears: 12.5, workDaysPerYear: 250, excludedFromAnalysis: false },
      { durationYears: 3, workDaysPerYear: null, excludedFromAnalysis: true },
    ],
    modules: {
      knee: {
        noEvaluableJobs: false,
        relatedness: { minPct: 35, maxPct: 55, avgPct: 45 },
        cumulativeBurdenSufficient: true,
        jobs: [{
          jobIndex: 0, weightKgPerDay: 2500, squattingMinPerDay: 130,
          aux: { stairs: true, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
          burdenLevel: 'upperModerate',
        }],
      },
      shoulder: {
        noEvaluableJobs: false,
        totals: {
          overhead: { hours: 4100, limitHours: 3600, ratio: 1.14, exceeded: true },
          repetitiveMedium: { hours: 9000, limitHours: 38000, ratio: 0.24, exceeded: false },
          repetitiveFast: { hours: 0, limitHours: 9400, ratio: 0, exceeded: false },
          heavyLoad: { hours: 120, limitHours: 200, ratio: 0.6, exceeded: false },
          vibration: { hours: 0, limitHours: 5300, ratio: 0, exceeded: false },
        },
        interpretation: 'exceeded',
        jobs: [
          { jobIndex: 0, periodYears: 12.5, exposures: {
            overhead: { dailyHours: 1.5, cumulativeHours: 4100 }, repetitiveMedium: { dailyHours: 0, cumulativeHours: 0 },
            repetitiveFast: { dailyHours: 0, cumulativeHours: 0 }, heavyLoad: { dailyHours: 0.2, cumulativeHours: 120 },
            vibration: { dailyHours: null, cumulativeHours: null },
          } },
          { jobIndex: 1, periodYears: 3, exposures: {
            overhead: { dailyHours: 0, cumulativeHours: 0 }, repetitiveMedium: { dailyHours: 0, cumulativeHours: 0 },
            repetitiveFast: { dailyHours: 0, cumulativeHours: 0 }, heavyLoad: { dailyHours: 0, cumulativeHours: 0 },
            vibration: { dailyHours: 0, cumulativeHours: 0 },
          } },
        ],
      },
      elbow: {
        noEvaluableJobs: false,
        temporal: { recentTaskChange: 'increased_load', improvesWithRest: 'yes', flags: ['temporal_fit_high'], hasMissingCommonFields: false },
        jobs: [{ jobIndex: 0, groups: [{
          bkType: 'BK2101', diagnosisRefs: [3], riskFactorCount: 3, burdenGrade: 'moderate', hasMissingFields: false,
          riskFactorKeys: ['core_exposure_present', 'daily_share_high', 'bk2101_pattern_supported'],
        }] }],
      },
      wrist: {
        noEvaluableJobs: false,
        temporal: { recentTaskChange: null, improvesWithRest: 'no', flags: [], hasMissingCommonFields: true },
        jobs: [{ jobIndex: 0, groups: [{
          bkType: 'BK2113', diagnosisRefs: [4], riskFactorCount: 1, burdenGrade: 'none', hasMissingFields: true,
          riskFactorKeys: ['vibration_present'],
        }] }],
      },
      spine: {
        noEvaluableJobs: false,
        mddmStatus: 'present',
        mddm: {
          formulaVersion: 'v5.1.3', dailyDoseKNh: 6.2, lifetimeDoseMNh: 14.7, totalYears: 12.5, excluded: false, weightedDailyDoseKNh: null,
          comparison: {
            mddm: { limit: 25, percent: 58.8, status: 'safe' },
            court: { limit: 12.5, percent: 117.6, status: 'danger' },
          },
          workRelatedness: { level: 'high', workContributionPct: 100, personalContributionPct: 0 },
          severity: 'upperModerate',
          jobs: [{
            jobIndex: 0, periodYears: 12.5, workDaysPerYear: 250, dailyDoseKNh: 6.2, lifetimeDoseMNh: 14.7,
            tasks: [{ posture: 'G3', weightKg: 25, frequencyPerDay: 100, timeValue: 5, timeUnit: 'sec', correctionFactor: 1.2, forceN: 3200, included: true }],
          }],
        },
        vibration: {
          exposureStatus: 'present', amax8Min: 0.4, amax8Max: 0.7, dvMin: 900, dvMax: 1500,
          daily: { percentMin: 63, percentMax: 111, status: 'warning' },
          lifetime: { percentMin: 64, percentMax: 107, status: 'warning' },
          hasInvalidIntervals: false,
          jobs: [{ jobIndex: 0, periodYears: 12.5, workDaysPerYear: 250, intervals: [{ awMin: 0.5, awMax: 0.8, timeValue: 4, timeUnit: 'hr' }] }],
        },
      },
      cervical: {
        noEvaluableJobs: false,
        overallBurdenGrade: 'present',
        overallCumulativeKgHours: 12000,
        jobs: [{
          jobIndex: 0, burdenGrade: 'present', flagKeys: ['awkward_static_neck_supported', 'daily_share_high'], riskFactorCount: 2,
          cumulativeKgHours: 12000, representativeHours: 3, totalAwkwardHours: 9000, yearsExposed: 12.5, taskCount: 2, completedTaskCount: 1,
          hasBk2109CoreTask: false,
          tasks: [{
            exposureTypes: ['awkward_static_neck_load'], loadWeightKg: null, carryHoursPerShift: null, neckNonNeutralHoursPerDay: 3,
            forcedNeckPosture: null, combinedFlexionRotation: 'yes', precisionWork: 'no',
          }],
        }],
      },
    },
  };
}

const MINIMAL: AiAnalysisInput = {
  schemaVersion: 1,
  demographics: { ageYears: null, gender: null, heightCm: null, weightKg: null, bmi: null, hypertension: null, diabetes: null },
  diagnoses: [],
  jobs: [],
  modules: {},
};

type Path = Array<string | number>;
function mutate(path: Path, apply: (node: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(fullInput()) as unknown as Record<string, unknown>;
  let node: any = copy;
  for (const key of path) node = node[key];
  apply(node);
  return copy;
}
const withExtraKey = (path: Path, key: string) => mutate(path, (node) => { node[key] = '홍길동'; });
const withValue = (path: Path, key: string, value: unknown) => mutate(path, (node) => { node[key] = value; });

describe('AiAnalysisInputSchema — 유효 입력', () => {
  it('모든 모듈을 채운 입력을 통과시킨다', () => {
    expect(AiAnalysisInputSchema.safeParse(fullInput()).success).toBe(true);
  });

  it('빈 입력(모듈·상병·직력 없음, 값 전부 null)도 통과시킨다', () => {
    expect(AiAnalysisInputSchema.safeParse(MINIMAL).success).toBe(true);
  });

  it('상병 코드는 ICD 형식만 받는다', () => {
    for (const code of ['M17.1', 'S83.5', 'M75', 'G56.00']) {
      expect(AiAnalysisInputSchema.safeParse(withValue(['diagnoses', 0], 'code', code)).success, code).toBe(true);
    }
  });
});

describe('AiAnalysisInputSchema — 식별정보·자유문이 들어올 자리가 없다', () => {
  it.each<[string, Path, string]>([
    ['최상위 name', [], 'name'],
    ['최상위 prompt', [], 'prompt'],
    ['최상위 systemPrompt', [], 'systemPrompt'],
    ['최상위 birthDate', [], 'birthDate'],
    ['최상위 patientNo', [], 'patientNo'],
    ['최상위 hospitalName', [], 'hospitalName'],
    ['최상위 doctorName', [], 'doctorName'],
    ['최상위 specialNotes', [], 'specialNotes'],
    ['demographics.name', ['demographics'], 'name'],
    ['상병 name(상병명)', ['diagnoses', 0], 'name'],
    ['상병 평가 단위 reasonOther(자유 사유)', ['diagnoses', 0, 'units', 0], 'reasonOther'],
    ['직력 jobName(직종명)', ['jobs', 0], 'jobName'],
    ['modules 알 수 없는 모듈', ['modules'], 'hip'],
    ['무릎 직력 jobName', ['modules', 'knee', 'jobs', 0], 'jobName'],
    ['어깨 직력 jobName', ['modules', 'shoulder', 'jobs', 0], 'jobName'],
    ['팔꿈치 그룹 narrative', ['modules', 'elbow', 'jobs', 0, 'groups', 0], 'narrative'],
    ['손목 시간적 선후관계 taskChangeDate', ['modules', 'wrist', 'temporal'], 'taskChangeDate'],
    ['척추 task name', ['modules', 'spine', 'mddm', 'jobs', 0, 'tasks', 0], 'name'],
    ['척추 진동 구간 name', ['modules', 'spine', 'vibration', 'jobs', 0, 'intervals', 0], 'name'],
    ['경추 task notes', ['modules', 'cervical', 'jobs', 0, 'tasks', 0], 'notes'],
  ])('%s → 거부', (_name, path, key) => {
    expect(AiAnalysisInputSchema.safeParse(withExtraKey(path, key)).success).toBe(false);
  });

  it('스키마의 모든 문자열 값은 열거형·형식 제한이 있다 — 어느 문자열 칸에 자유문을 넣어도 거부된다', () => {
    // 픽스처의 문자열 리프(배열 원소 포함)를 전부 찾아 하나씩 '홍길동'으로 바꾼다. 새 문자열 필드가 생기면 이 테스트가 잡는다.
    const leaves: Path[] = [];
    const walk = (node: unknown, path: Path) => {
      if (typeof node === 'string') leaves.push(path);
      else if (Array.isArray(node)) node.forEach((child, i) => walk(child, [...path, i]));
      else if (node && typeof node === 'object') Object.entries(node).forEach(([key, child]) => walk(child, [...path, key]));
    };
    walk(fullInput(), []);
    expect(leaves.length).toBeGreaterThan(40);
    for (const path of leaves) {
      const last = path[path.length - 1];
      const parent = path.slice(0, -1);
      const result = AiAnalysisInputSchema.safeParse(mutate(parent, (node) => { node[last as string] = '홍길동'; }));
      expect(result.success, path.join('.')).toBe(false);
    }
  });

  it('상병 코드 칸에 자유문(이름 등)을 넣어도 통과하지 못한다', () => {
    for (const code of ['홍길동', 'M17.1 홍길동', 'm17.1', 'M17', '', 'M17.123', '홍길동 환자 M17.1']) {
      const result = AiAnalysisInputSchema.safeParse(withValue(['diagnoses', 0], 'code', code));
      expect(result.success, JSON.stringify(code)).toBe(code === 'M17');
    }
  });
});

describe('AiAnalysisInputSchema — 값 검증', () => {
  it.each<[string, Path, string, unknown]>([
    ['숫자 자리에 문자열', ['demographics'], 'heightCm', '170'],
    ['NaN', ['demographics'], 'heightCm', NaN],
    ['Infinity', ['demographics'], 'weightKg', Infinity],
    ['절댓값 상한(1e9) 초과', ['demographics'], 'bmi', 1e10],
    ['나이 상한 초과', ['demographics'], 'ageYears', 121],
    ['나이 소수', ['demographics'], 'ageYears', 52.5],
    ['성별 열거형 외', ['demographics'], 'gender', 'other'],
    ['모듈 id 열거형 외', ['diagnoses', 0], 'moduleId', 'hip'],
    ['측 열거형 외', ['diagnoses', 0], 'side', 'center'],
    ['K-L 열거형 외', ['diagnoses', 0, 'units', 0], 'klg', '5'],
    ['낮음 사유 열거형 외', ['diagnoses', 0, 'units', 1], 'reasons', ['자유 사유']],
    ['jobIndex 음수', ['modules', 'knee', 'jobs', 0], 'jobIndex', -1],
    ['무릎 부담 등급 열거형 외', ['modules', 'knee', 'jobs', 0], 'burdenLevel', '고도'],
    ['팔꿈치 BK 유형에 손목 전용 값', ['modules', 'elbow', 'jobs', 0, 'groups', 0], 'bkType', 'BK2113'],
    ['손목 BK 유형에 팔꿈치 전용 값', ['modules', 'wrist', 'jobs', 0, 'groups', 0], 'bkType', 'BK2105'],
    ['팔꿈치 위험요인 키에 경추 전용 키', ['modules', 'elbow', 'jobs', 0, 'groups', 0], 'riskFactorKeys', ['heavy_load_present']],
    ['경추 플래그 키에 임의 문자열', ['modules', 'cervical', 'jobs', 0], 'flagKeys', ['custom']],
    ['척추 자세 코드 열거형 외', ['modules', 'spine', 'mddm', 'jobs', 0, 'tasks', 0], 'posture', 'G12'],
    ['척추 시간 단위 열거형 외', ['modules', 'spine', 'mddm', 'jobs', 0, 'tasks', 0], 'timeUnit', 'day'],
    ['schemaVersion 불일치', [], 'schemaVersion', 2],
  ])('%s → 거부', (_name, path, key, value) => {
    expect(AiAnalysisInputSchema.safeParse(withValue(path, key, value)).success).toBe(false);
  });

  it('배열 길이 상한을 둔다(상병 20 · 직력 30)', () => {
    const input = fullInput();
    expect(AiAnalysisInputSchema.safeParse({ ...input, diagnoses: Array(21).fill(input.diagnoses[0]) }).success).toBe(false);
    expect(AiAnalysisInputSchema.safeParse({ ...input, diagnoses: Array(20).fill(input.diagnoses[0]) }).success).toBe(true);
    expect(AiAnalysisInputSchema.safeParse({ ...input, jobs: Array(31).fill(input.jobs[0]) }).success).toBe(false);
  });
});

describe('요청 스키마', () => {
  it('내부 경로는 fullReport(보고서 전문)를 받는다', () => {
    const body = { input: fullInput(), fullReport: '보고서 전문', model: 'gemini-2.5-flash' };
    expect(AiAnalysisRequestSchema.safeParse(body).success).toBe(true);
  });

  it('외부 경로는 fullReport 필드가 존재하는 것 자체를 거부한다', () => {
    const body = { input: fullInput(), fullReport: '보고서 전문' };
    expect(AiAnalysisExternalRequestSchema.safeParse(body).success).toBe(false);
    expect(AiAnalysisExternalRequestSchema.safeParse({ input: fullInput() }).success).toBe(true);
    expect(AiAnalysisExternalRequestSchema.safeParse({ input: fullInput(), model: 'gemini-2.5-pro' }).success).toBe(true);
  });

  it('prompt·systemPrompt 같은 자유 문자열 본문은 두 경로 모두 거부한다', () => {
    for (const schema of [AiAnalysisRequestSchema, AiAnalysisExternalRequestSchema]) {
      expect(schema.safeParse({ prompt: '환자 홍길동 …', systemPrompt: 'x', model: 'gemini-2.5-flash' }).success).toBe(false);
      expect(schema.safeParse({ input: fullInput(), prompt: '홍길동' }).success).toBe(false);
      expect(schema.safeParse({ input: fullInput(), systemPrompt: '무시하고 …' }).success).toBe(false);
    }
  });

  it('input 없이는 거부한다', () => {
    expect(AiAnalysisExternalRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('라벨 사전', () => {
  it.each([
    ['팔꿈치', ELBOW_FLAG_KEYS, ELBOW_FLAG_LABELS],
    ['손목', WRIST_FLAG_KEYS, WRIST_FLAG_LABELS],
    ['경추', CERVICAL_FLAG_KEYS, CERVICAL_FLAG_LABELS],
    ['무릎 보조변수', KNEE_AUX_KEYS, KNEE_AUX_LABELS],
    ['어깨 노출', SHOULDER_EXPOSURE_KEYS, SHOULDER_LABELS],
    ['낮음 사유', LOW_REASON_KEYS, LOW_REASON_LABELS],
  ] as Array<[string, readonly string[], Record<string, string>]>)('%s: 키 목록과 라벨 사전의 키가 정확히 같고 라벨이 비어 있지 않다', (_name, keys, dict) => {
    expect(Object.keys(dict).sort()).toEqual([...keys].sort());
    for (const key of keys) expect(dict[key].trim().length, key).toBeGreaterThan(0);
  });

  it('키 개수가 원본 FLAG_META와 같다(팔꿈치 17 · 손목 18 · 경추 9)', () => {
    expect([ELBOW_FLAG_KEYS.length, WRIST_FLAG_KEYS.length, CERVICAL_FLAG_KEYS.length]).toEqual([17, 18, 9]);
  });
});

describe('buildPrompt', () => {
  const prompt = buildPrompt(fullInput());

  it('섹션이 환자 정보 → 상병 → 직력 → 모듈 순으로 나온다', () => {
    const order = ['[환자 정보]', '[상병]', '[직력]', '[무릎(슬관절)]', '[어깨(견관절)]', '[팔꿈치(주관절)]', '[손목/손가락]', '[척추(요추)]', '[경추(목)]'];
    const positions = order.map((heading) => prompt.indexOf(heading));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('환자 정보·상병·직력을 코드·숫자·라벨로 렌더링한다', () => {
    expect(prompt).toContain('재해일 기준 만 나이 52세, 성별 남성');
    expect(prompt).toContain('키 170cm, 체중 72kg, BMI 24.9');
    expect(prompt).toContain('고혈압 예, 당뇨 아니오');
    expect(prompt).toContain('1. 상병코드 M17.1 (무릎(슬관절), 양측)');
    expect(prompt).toContain('- 우측: 상병 확인, 업무관련성 높음, K-L 등급 3');
    expect(prompt).toContain('- 좌측: 상병 확인, 업무관련성 낮음, 낮음 사유: 연령대비 경미, 누적 신체부담 낮음, K-L 등급 1');
    expect(prompt).toContain('- 축성(척추/경추): 상병 확인, 업무관련성 높음');
    expect(prompt).toContain('수직 분포 확인, 동반 척추증 미확인');
    expect(prompt).toContain('Ellman Grade 2');
    expect(prompt).toContain('- 직력1: 근무기간 12.5년, 연 근무일수 250일');
    expect(prompt).toContain('- 직력2: 근무기간 3년, 연 근무일수 - (신체부담평가에서 제외된 직력)');
  });

  it('무릎: 보조변수·부담 정도·기여도·누적 신체부담', () => {
    expect(prompt).toContain('- 직력1: 일 중량물 취급량 2500kg, 일 쪼그려 앉기 130분, 보조변수: 계단오르내리기, 출발/정지 반복, 무릎 부담 정도: 중등도상');
    expect(prompt).toContain('[신체부담기여도] 35% ~ 55% (평균 45%)');
    expect(prompt).toContain('[누적신체부담] 충분함');
  });

  it('어깨: 기준 초과 표시와 해석, 직력이 둘 이상이면 직력별 기여', () => {
    expect(prompt).toContain('- 오버헤드/어깨높이 이상 작업: 누적 4100시간 (기준 3600시간 / 114%) [초과]');
    expect(prompt).toContain('** 개별 기준 초과 항목이 있어 누적 신체부담은 충분함');
    expect(prompt).toContain('[직력별 기여]');
    expect(prompt).toContain('오버헤드/어깨높이 이상 작업: 1.5시간/일, 누적 4100시간');
  });

  it('팔꿈치·손목: 시간적 선후관계, BK 유형별 위험요인과 부담 등급', () => {
    expect(prompt).toContain('- 공통 시간적 선후관계: 최근 작업변화 작업 부하 증가, 휴가/업무중단 시 호전 예, 시간적 선후관계 지지');
    expect(prompt).toContain('· BK2101 (상병 4): 위험요인 3개 [핵심 노출 확인, 일일 노출량 높음, 상과병변 패턴 지지] → 부담 등급 중등도');
    expect(prompt).toContain('· BK2113 (상병 5): 위험요인 1개 [진동 노출 존재] → 부담 등급 부담 작업 아님 (입력 일부 누락)');
    expect(prompt).toContain('공통 입력 일부 누락');
  });

  it('척추: MDDM 비교·업무관련성·자세별 작업, 전신진동', () => {
    expect(prompt).toContain('① MDDM(누적 부하) 평가: 평가함');
    expect(prompt).toContain('독일 법원(BSG) 기준 12.5 MN·h 대비 117.6% (기준 도달/초과)');
    expect(prompt).toContain('업무관련성 높음 (업무 기여 100%, 개인 요인 0%), 신체부담 정도 중등도상');
    expect(prompt).toContain('· 자세 G3, 중량 25kg, 빈도 100회/일, 시간 5초, 보정계수 1.2, 추정 힘 3200N');
    expect(prompt).toContain('② 전신진동(BK2110) 평가: 평가함');
    expect(prompt).toContain('일일 Amax(8) 0.4~0.7 m/s², 평생 누적 DV 900~1500 (m/s²)²');
  });

  it('경추: 종합 등급·직력별 충족 항목·작업', () => {
    expect(prompt).toContain('- 종합: 경추 부담 노출은 있으나 BK2109 정량 요건 지지는 제한적 (누적 총부하 12000kg·h)');
    expect(prompt).toContain('충족 항목: 비중립·정적 목 부하, 일일 노출량 높음');
    expect(prompt).toContain('작업 1/2개 입력 완료');
    expect(prompt).toContain('운반 중 목 자세 강제 -, 굴곡+회전 자세 예, 정밀 작업 아니오');
  });

  it('척추·경추(축성) 상병은 방향을 적지 않고, 그 외 방향 미선택은 표시한다', () => {
    expect(prompt).toContain('2. 상병코드 M51.1 (척추(요추))');
    expect(prompt).toContain('6. 상병코드 M50.1 (경추(목))');
    const input = fullInput();
    input.diagnoses[0].side = null;
    input.diagnoses[0].units = [];
    expect(buildPrompt(input)).toContain('1. 상병코드 M17.1 (무릎(슬관절), 방향 미선택)');
  });

  it('입력이 같으면 출력도 같다(결정적)', () => {
    expect(buildPrompt(fullInput())).toBe(prompt);
  });

  it('값이 비어도(null) 렌더링이 깨지지 않고 "-"로 표시한다', () => {
    const text = buildPrompt(MINIMAL);
    expect(text).toContain('재해일 기준 만 나이 -, 성별 미입력');
    expect(text).toContain('- (입력된 상병 없음)');
    expect(text).toContain('- (입력된 직력 없음)');
    expect(text).not.toMatch(/undefined|NaN|null/);
  });

  it('신체부담평가 가능한 직력이 없으면 그 모듈은 평가하지 않는다고 적는다', () => {
    const input = fullInput();
    input.modules.knee!.noEvaluableJobs = true;
    input.modules.spine!.noEvaluableJobs = true;
    const text = buildPrompt(input);
    expect(text).toContain('[무릎(슬관절)]\n신체부담평가에 포함된 직력이 없어 평가하지 않음');
    expect(text).toContain('[척추(요추)]\n신체부담평가에 포함된 직력이 없어 평가하지 않음');
    expect(text).not.toContain('[신체부담기여도]');
  });

  it('척추: 성별 미입력 안내와 "평생 누적 계산 제외" 문구', () => {
    const input = fullInput();
    input.demographics.gender = null;
    input.modules.spine!.mddm!.excluded = true;
    const text = buildPrompt(input);
    expect(text).toContain('성별이 입력되지 않아 성별별 기준값이 정확하지 않을 수 있음');
    expect(text).toContain('일일 용량이 하한 기준에 못 미쳐 평생 누적 용량 계산에서 제외됨');
  });

  it('척추: MDDM 미평가·진동 노출 없음이면 세부 값은 나오지 않는다', () => {
    const input = fullInput();
    input.modules.spine = { noEvaluableJobs: false, mddmStatus: 'none', vibration: {
      exposureStatus: 'none', amax8Min: null, amax8Max: null, dvMin: null, dvMax: null, daily: null, lifetime: null, hasInvalidIntervals: false, jobs: [],
    } };
    const text = buildPrompt(input);
    expect(text).toContain('① MDDM(누적 부하) 평가: 노출 없음');
    expect(text).toContain('② 전신진동(BK2110) 평가: 노출 없음');
    expect(text).not.toContain('일일 Amax(8)');
  });
});

describe('buildInternalPrompt', () => {
  const input = fullInput();

  it('fullReport가 없으면 외부 프롬프트와 같다', () => {
    expect(buildInternalPrompt(input)).toBe(buildPrompt(input));
    expect(buildInternalPrompt(input, '')).toBe(buildPrompt(input));
  });

  it('fullReport를 [전체 보고서] 절로 덧붙인다', () => {
    const text = buildInternalPrompt(input, '보고서 본문 ABC');
    expect(text.startsWith(buildPrompt(input))).toBe(true);
    expect(text.endsWith('\n\n[전체 보고서]\n보고서 본문 ABC')).toBe(true);
  });

  it('외부 프롬프트(buildPrompt)에는 보고서 절이 없다', () => {
    expect(buildPrompt(input)).not.toContain('[전체 보고서]');
  });
});

describe('UNIFIED_AI_SYSTEM_PROMPT', () => {
  it('현행 지침 1~5와 팔꿈치 줄을 유지하고, 식별정보 추정 금지 안내를 더한다', () => {
    expect(UNIFIED_AI_SYSTEM_PROMPT).toContain('직업성 근골격계 질환 업무관련성 평가 전문 직업환경의학 전문의');
    expect(UNIFIED_AI_SYSTEM_PROMPT).toContain('독일 법원(BSG) 기준(남 12.5 MN·h, 여 8.5 MN·h)');
    expect(UNIFIED_AI_SYSTEM_PROMPT).toContain('6. 팔꿈치:');
    expect(UNIFIED_AI_SYSTEM_PROMPT).toContain('7. 입력은 식별정보를 제거한 구조화 요약입니다');
  });
});
