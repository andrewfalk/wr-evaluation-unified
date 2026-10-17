import type { AiAnalysisInput } from './aiAnalysis';
import type {
  ELBOW_FLAG_KEYS,
  WRIST_FLAG_KEYS,
  CERVICAL_FLAG_KEYS,
  LOW_REASON_KEYS,
  KNEE_AUX_KEYS,
  SHOULDER_EXPOSURE_KEYS,
  AI_BURDEN_LEVELS,
  AI_MODULE_IDS,
  RECENT_TASK_CHANGE_VALUES,
  BK_BURDEN_GRADES,
  CERVICAL_BURDEN_GRADES,
  CERVICAL_EXPOSURE_TYPES,
} from './aiAnalysis';

// ---------------------------------------------------------------------------
// AI 분석 프롬프트 조립 — 전송 경계(서버·Vercel·Electron)가 검증을 통과한 구조화 입력(AiAnalysisInput)으로만 만든다.
//
// 외부 벤더 경로는 buildPrompt()만 부른다. 이 함수의 인자에는 자유 문자열이 들어올 자리가 없다(스키마가 enum·숫자뿐).
// 현행 보고서 전문(fullReport)을 덧붙이는 buildInternalPrompt()는 내부 LLM 경로에서만 쓴다 — 함수를 분리해
// 외부 경로 코드가 fullReport를 실수로 합칠 수 없게 한다.
// ---------------------------------------------------------------------------

/** 현행(StepContent.jsx) 시스템 프롬프트 + 6번(팔꿈치) 줄. 7번은 구조화 입력 전환에 맞춰 추가된 안내다. */
export const UNIFIED_AI_SYSTEM_PROMPT = `당신은 직업성 근골격계 질환 업무관련성 평가 전문 직업환경의학 전문의입니다.
무릎(슬관절) 및 척추(요추) 평가 모두에 전문성을 갖추고 있습니다.
다음 지침에 따라 분석하세요:
1. 무릎: 신체부담정도 4단계(고도/중등도상/중등도하/경도)와 신체부담기여도 공식을 정확히 적용
2. 척추: ① MDDM 공식(F = b + m·L)과 G1~G11 자세 분류, 독일 법원(BSG) 기준(남 12.5 MN·h, 여 8.5 MN·h) 적용 ② 전신진동(BK2110): 일일 Amax(8)≥0.63 m/s², 평생 누적용량 DV,RI=1400 (m/s²)² 기준 적용
3. 한국 산재보상보험법 기준을 참조하여 업무관련성을 판단
4. 분석 결과는 한국어로 작성하고, 전문 용어는 명확히 설명
5. 구체적이고 실행 가능한 의견을 제시
6. 팔꿈치: BK 유형별 노출 패턴, 시간적 선후관계, 충족된 위험요인 항목을 함께 검토합니다.
7. 입력은 식별정보를 제거한 구조화 요약입니다. 입력에 없는 사실을 만들어 내지 말고, 식별정보를 추정하거나 요구하지 마세요.`;

// ── 라벨 사전(키 → 한글). Record<키, string>이라 키 목록에 항목이 추가되면 여기서 컴파일 오류로 잡힌다. ─────────────
type Union<T extends readonly string[]> = T[number];

const MODULE_LABELS: Record<Union<typeof AI_MODULE_IDS>, string> = {
  knee: '무릎(슬관절)',
  shoulder: '어깨(견관절)',
  elbow: '팔꿈치(주관절)',
  wrist: '손목/손가락',
  spine: '척추(요추)',
  cervical: '경추(목)',
};

const BURDEN_LABELS: Record<Union<typeof AI_BURDEN_LEVELS>, string> = {
  high: '고도',
  upperModerate: '중등도상',
  lowerModerate: '중등도하',
  low: '경도',
};

export const LOW_REASON_LABELS: Record<Union<typeof LOW_REASON_KEYS>, string> = {
  unrelated: '신체부담과 관련없는 상병',
  unconfirmed: '상병 미확인',
  ageMild: '연령대비 경미',
  delayed: '업무중단 후 상당기간 경과',
  lowBurden: '누적 신체부담 낮음',
  belowThreshold: '부담 정도가 최소 문턱값을 넘지 못함',
  other: '기타',
};

export const KNEE_AUX_LABELS: Record<Union<typeof KNEE_AUX_KEYS>, string> = {
  stairs: '계단오르내리기',
  kneeTwist: '무릎 비틀림',
  startStop: '출발/정지 반복',
  tightSpace: '좁은 공간',
  kneeContact: '무릎 접촉/충격',
  jumpDown: '뛰어내리기',
};

export const SHOULDER_LABELS: Record<Union<typeof SHOULDER_EXPOSURE_KEYS>, string> = {
  overhead: '오버헤드/어깨높이 이상 작업',
  repetitiveMedium: '반복동작 중간속도 (4~14회/분)',
  repetitiveFast: '반복동작 고도 (≥15회/분)',
  heavyLoad: '중량물(≥20kg) 취급 시간',
  vibration: '손-팔 진동 (≥3 m/s²)',
};

export const ELBOW_FLAG_LABELS: Record<Union<typeof ELBOW_FLAG_KEYS>, string> = {
  core_exposure_present: '핵심 노출 확인',
  core_exposure_unclear: '핵심 노출 불명확',
  daily_share_high: '일일 노출량 높음',
  daily_share_moderate: '일일 노출량 중간',
  daily_share_low: '일일 노출량 낮음',
  rest_unfavorable: '휴식 분포 불리',
  mechanical_load_dominant: '기계적 부담 우세',
  pressure_load_dominant: '압박 부담 우세',
  vibration_present: '진동 노출 존재',
  bk2101_pattern_supported: '상과병변 패턴 지지',
  bk2105_pattern_supported: '점액낭염 패턴 지지',
  bk2106_pattern_supported: '주관증후군/척골신경병변 패턴 지지',
  bk2103_pattern_supported: '골관절염/박리성 골연골염 패턴 지지',
  bk2103_transmission_amplifier_present: 'BK2103 전달 증폭 요인',
  temporal_fit_high: '시간적 선후관계 지지',
  temporal_fit_unclear: '시간적 선후관계 불명확',
  bk2101_high_freq_example: 'BK2101 고빈도 반복 예시',
};

export const WRIST_FLAG_LABELS: Record<Union<typeof WRIST_FLAG_KEYS>, string> = {
  core_exposure_present: '핵심 노출 확인',
  core_exposure_unclear: '핵심 노출 불분명',
  daily_share_high: '일일 노출량 높음',
  daily_share_moderate: '일일 노출량 중간',
  daily_share_low: '일일 노출량 낮음',
  rest_unfavorable: '휴식 분포 불리',
  mechanical_load_dominant: '기계적 부담 우세',
  pressure_load_dominant: '압박 부담 우세',
  vibration_present: '진동 노출 존재',
  bk2101_high_freq_example: 'BK2101 고빈도 반복 예시',
  bk2101_pattern_supported: 'BK2101 패턴 지지',
  bk2103_pattern_supported: 'BK2103 패턴 지지',
  bk2103_transmission_amplifier_present: 'BK2103 전달 증폭 요인',
  bk2106_pattern_supported: 'BK2106 패턴 지지',
  bk2113_pattern_supported: 'BK2113 패턴 지지',
  bk2113_combined_exposure_present: 'BK2113 복합 노출',
  temporal_fit_high: '시간적 선후관계 지지',
  temporal_fit_unclear: '시간적 선후관계 불분명',
};

export const CERVICAL_FLAG_LABELS: Record<Union<typeof CERVICAL_FLAG_KEYS>, string> = {
  heavy_load_present: '무거운 하중 기준 충족',
  carry_time_supported: '운반시간 기준 충족',
  forced_neck_posture_present: '운반 시 부자연스러운 목 자세 강제',
  cumulative_load_supported: '누적 총부하 기준 충족',
  bk2109_pattern_supported: 'BK2109형 패턴 지지',
  daily_share_high: '일일 노출량 높음',
  daily_share_moderate: '일일 노출량 중간',
  awkward_static_neck_supported: '비중립·정적 목 부하',
  mechanical_cervical_load_dominant: '기계적 경추 부담 우세',
};

const RECENT_TASK_CHANGE_LABELS: Record<Union<typeof RECENT_TASK_CHANGE_VALUES>, string> = {
  none: '없음',
  increased_load: '작업 부하 증가',
  process_change: '작업 공정 변경',
  new_task: '새로운 작업 투입',
};

const BK_BURDEN_LABELS: Record<Union<typeof BK_BURDEN_GRADES>, string> = {
  none: '부담 작업 아님',
  mild: '경도',
  moderate: '중등도',
  high: '고도',
};

const CERVICAL_GRADE_LABELS: Record<Union<typeof CERVICAL_BURDEN_GRADES>, string> = {
  high_bk2109: 'BK2109형 경추 부담 노출이 강하게 지지됨(정량 조건·누적 총부하 기준 확인)',
  present: '경추 부담 노출은 있으나 BK2109 정량 요건 지지는 제한적',
  low: '경추 부담 노출을 뚜렷하게 지지하기 어려움',
};

const CERVICAL_EXPOSURE_LABELS: Record<Union<typeof CERVICAL_EXPOSURE_TYPES>, string> = {
  shoulder_heavy_load: '어깨에 무거운 하중 올려 운반',
  awkward_static_neck_load: '비중립·정적 목 부하',
};

const SHOULDER_INTERPRETATION_LABELS = {
  exceeded: '개별 기준 초과 항목이 있어 누적 신체부담은 충분함',
  combinedSufficient: '개별 기준 초과 항목은 없으나 복합 노출을 고려하여 누적 신체부담은 충분함',
  insufficient: '노출 기준치에 미달하여 누적 신체부담 불충분함',
} as const;

const SPINE_RELATEDNESS_LABELS = { high: '높음', medium: '불충분(다른 요건 고려)', low: '낮음' } as const;
const SPINE_STATUS_LABELS = { unknown: '미평가', none: '노출 없음', present: '평가함' } as const;
const RANGE_STATUS_LABELS = { safe: '기준 이내', warning: '기준 근접', danger: '기준 도달/초과' } as const;
const TIME_UNIT_LABELS = { sec: '초', min: '분', hr: '시간' } as const;
const SIDE_LABELS = { right: '우측', left: '좌측', both: '양측', axial: '축성(척추/경추)' } as const;

// ── 서식 도우미 ───────────────────────────────────────────────────────────
const NO_EVALUABLE_JOBS = '신체부담평가에 포함된 직력이 없어 평가하지 않음';

function fmt(value: number | null | undefined, unit = ''): string {
  if (value === null || value === undefined) return '-';
  return `${Math.round(value * 100) / 100}${unit}`;
}

function yesNo(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '-';
  return value ? '예' : '아니오';
}

function yesNoText(value: 'yes' | 'no' | null): string {
  return value === 'yes' ? '예' : value === 'no' ? '아니오' : '-';
}

const jobLabel = (jobIndex: number): string => `직력${jobIndex + 1}`;
const labels = <K extends string>(keys: readonly K[], dict: Record<K, string>): string => keys.map((k) => dict[k]).join(', ');

// ── 섹션 ─────────────────────────────────────────────────────────────────
type Modules = AiAnalysisInput['modules'];

function demographicsText(d: AiAnalysisInput['demographics']): string {
  const gender = d.gender === 'male' ? '남성' : d.gender === 'female' ? '여성' : '미입력';
  return [
    '[환자 정보]',
    `- 재해일 기준 만 나이 ${fmt(d.ageYears, '세')}, 성별 ${gender}`,
    `- 키 ${fmt(d.heightCm, 'cm')}, 체중 ${fmt(d.weightKg, 'kg')}, BMI ${fmt(d.bmi)}`,
    `- 고혈압 ${yesNo(d.hypertension)}, 당뇨 ${yesNo(d.diabetes)}`,
  ].join('\n');
}

function diagnosesText(diagnoses: AiAnalysisInput['diagnoses']): string {
  const lines = ['[상병]'];
  if (diagnoses.length === 0) lines.push('- (입력된 상병 없음)');
  diagnoses.forEach((diag, i) => {
    const module = diag.moduleId ? MODULE_LABELS[diag.moduleId] : '모듈 미지정';
    // 척추·경추(축성) 상병은 좌우를 고르지 않는 것이 정상이라 방향을 적지 않는다(적으면 입력 누락으로 오해한다).
    const axial = diag.moduleId === 'spine' || diag.moduleId === 'cervical';
    const side = diag.side ? `, ${SIDE_LABELS[diag.side]}` : axial ? '' : ', 방향 미선택';
    lines.push(`${i + 1}. 상병코드 ${diag.code ?? '미입력'} (${module}${side})`);
    diag.units.forEach((unit) => {
      const parts = [
        unit.confirmed === 'confirmed' ? '상병 확인' : unit.confirmed === 'unconfirmed' ? '상병 미확인' : '확인 여부 미입력',
        `업무관련성 ${unit.assessment === 'high' ? '높음' : unit.assessment === 'low' ? '낮음' : '미평가'}`,
      ];
      if (unit.reasons.length > 0) parts.push(`낮음 사유: ${labels(unit.reasons, LOW_REASON_LABELS)}`);
      if (unit.klg) parts.push(`K-L 등급 ${unit.klg}`);
      if (unit.ellman) parts.push(`Ellman ${unit.ellman}`);
      lines.push(`   - ${SIDE_LABELS[unit.side]}: ${parts.join(', ')}`);
    });
    if (diag.verticalDistribution || diag.concomitantSpondylosis) {
      const confirmedText = (v: 'confirmed' | 'unconfirmed' | null) => (v === 'confirmed' ? '확인' : v === 'unconfirmed' ? '미확인' : '-');
      lines.push(`   - 수직 분포 ${confirmedText(diag.verticalDistribution)}, 동반 척추증 ${confirmedText(diag.concomitantSpondylosis)}`);
    }
  });
  return lines.join('\n');
}

function jobsText(jobs: AiAnalysisInput['jobs']): string {
  const lines = ['[직력]'];
  if (jobs.length === 0) lines.push('- (입력된 직력 없음)');
  jobs.forEach((job, i) => {
    const excluded = job.excludedFromAnalysis ? ' (신체부담평가에서 제외된 직력)' : '';
    lines.push(`- ${jobLabel(i)}: 근무기간 ${fmt(job.durationYears, '년')}, 연 근무일수 ${fmt(job.workDaysPerYear, '일')}${excluded}`);
  });
  return lines.join('\n');
}

function kneeText(m: NonNullable<Modules['knee']>): string {
  const lines = [`[${MODULE_LABELS.knee}]`];
  if (m.noEvaluableJobs) return [...lines, NO_EVALUABLE_JOBS].join('\n');
  m.jobs.forEach((job) => {
    const aux = KNEE_AUX_LABELS_LIST.filter((key) => job.aux[key]).map((key) => KNEE_AUX_LABELS[key]);
    lines.push(
      `- ${jobLabel(job.jobIndex)}: 일 중량물 취급량 ${fmt(job.weightKgPerDay, 'kg')}, 일 쪼그려 앉기 ${fmt(job.squattingMinPerDay, '분')}` +
        `${aux.length > 0 ? `, 보조변수: ${aux.join(', ')}` : ''}, 무릎 부담 정도: ${job.burdenLevel ? BURDEN_LABELS[job.burdenLevel] : '-'}`,
    );
  });
  if (m.relatedness) {
    lines.push(
      '참고) 신체부담 정도는 4단계로 구분함: 고도(퇴행성 변화를 유발 또는 가속하는 것이 확실함, definite) / 중등도상(유발 또는 가속하기에 충분함, probable) / ' +
        '중등도하(유발 또는 가속할 가능성이 있음, possible) / 경도(유발 또는 가속하기 어려움, no related)',
      `[신체부담기여도] ${fmt(m.relatedness.minPct, '%')} ~ ${fmt(m.relatedness.maxPct, '%')} (평균 ${fmt(m.relatedness.avgPct, '%')})`,
    );
  }
  lines.push(`[누적신체부담] ${m.cumulativeBurdenSufficient ? '충분함' : '불충분함'}`);
  return lines.join('\n');
}

// Object.keys 순서에 기대지 않고 라벨 사전의 선언 순서를 고정 목록으로 쓴다.
const KNEE_AUX_LABELS_LIST = Object.keys(KNEE_AUX_LABELS) as Array<Union<typeof KNEE_AUX_KEYS>>;
const SHOULDER_KEYS_LIST = Object.keys(SHOULDER_LABELS) as Array<Union<typeof SHOULDER_EXPOSURE_KEYS>>;

function shoulderText(m: NonNullable<Modules['shoulder']>): string {
  const lines = [`[${MODULE_LABELS.shoulder}] 독일 BK2117(어깨 회전근개 병변) 어깨 부담 평가 지침 기준`];
  if (m.noEvaluableJobs) return [...lines, NO_EVALUABLE_JOBS].join('\n');
  if (m.totals) {
    SHOULDER_KEYS_LIST.forEach((key) => {
      const total = m.totals![key];
      const pct = total.hours > 0 ? ` / ${Math.round(total.ratio * 100)}%` : '';
      lines.push(`- ${SHOULDER_LABELS[key]}: 누적 ${fmt(total.hours, '시간')} (기준 ${fmt(total.limitHours, '시간')}${pct})${total.exceeded ? ' [초과]' : ''}`);
    });
  }
  if (m.interpretation) lines.push(`** ${SHOULDER_INTERPRETATION_LABELS[m.interpretation]}`);
  if (m.jobs.length > 1) {
    lines.push('[직력별 기여]');
    m.jobs.forEach((job) => {
      lines.push(`- ${jobLabel(job.jobIndex)} (${fmt(job.periodYears, '년')})`);
      SHOULDER_KEYS_LIST.forEach((key) => {
        const exposure = job.exposures[key];
        if (exposure.dailyHours && exposure.dailyHours > 0) {
          lines.push(`  ${SHOULDER_LABELS[key]}: ${fmt(exposure.dailyHours, '시간')}/일, 누적 ${fmt(exposure.cumulativeHours, '시간')}`);
        }
      });
    });
  }
  return lines.join('\n');
}

type BkModule = NonNullable<Modules['elbow']> | NonNullable<Modules['wrist']>;

/** 팔꿈치·손목 공통(플래그 라벨 사전만 다르다). */
function bkText(title: string, m: BkModule, flagLabels: Record<string, string>): string {
  const lines = [`[${title}]`];
  if (m.noEvaluableJobs) return [...lines, NO_EVALUABLE_JOBS].join('\n');
  const t = m.temporal;
  const temporal = [
    `최근 작업변화 ${t.recentTaskChange ? RECENT_TASK_CHANGE_LABELS[t.recentTaskChange] : '-'}`,
    `휴가/업무중단 시 호전 ${yesNoText(t.improvesWithRest)}`,
  ];
  if (t.flags.length > 0) temporal.push(labels(t.flags, flagLabels));
  if (t.hasMissingCommonFields) temporal.push('공통 입력 일부 누락');
  lines.push(`- 공통 시간적 선후관계: ${temporal.join(', ')}`);
  m.jobs.forEach((job) => {
    lines.push(`- ${jobLabel(job.jobIndex)}`);
    job.groups.forEach((group) => {
      const refs = group.diagnosisRefs.length > 0 ? ` (상병 ${group.diagnosisRefs.map((r) => r + 1).join(', ')})` : '';
      const factors = group.riskFactorKeys.length > 0 ? ` [${labels(group.riskFactorKeys, flagLabels)}]` : '';
      lines.push(
        `  · ${group.bkType ?? 'BK 유형 미선택'}${refs}: 위험요인 ${group.riskFactorCount}개${factors} → 부담 등급 ${BK_BURDEN_LABELS[group.burdenGrade]}` +
          `${group.hasMissingFields ? ' (입력 일부 누락)' : ''}`,
      );
    });
  });
  return lines.join('\n');
}

function cervicalText(m: NonNullable<Modules['cervical']>): string {
  const lines = [`[${MODULE_LABELS.cervical}]`];
  if (m.noEvaluableJobs) return [...lines, NO_EVALUABLE_JOBS].join('\n');
  if (m.overallBurdenGrade) {
    lines.push(`- 종합: ${CERVICAL_GRADE_LABELS[m.overallBurdenGrade]} (누적 총부하 ${fmt(m.overallCumulativeKgHours, 'kg·h')})`);
  }
  m.jobs.forEach((job) => {
    const flags = job.flagKeys.length > 0 ? `, 충족 항목: ${labels(job.flagKeys, CERVICAL_FLAG_LABELS)}` : '';
    lines.push(
      `- ${jobLabel(job.jobIndex)}: ${CERVICAL_GRADE_LABELS[job.burdenGrade]}${flags}, 누적 부하 ${fmt(job.cumulativeKgHours, 'kg·h')}, ` +
        `대표 작업시간 ${fmt(job.representativeHours, '시간')}, 비중립 목 부하 합계 ${fmt(job.totalAwkwardHours, '시간')}, 노출기간 ${fmt(job.yearsExposed, '년')}, ` +
        `작업 ${job.completedTaskCount}/${job.taskCount}개 입력 완료${job.hasBk2109CoreTask ? ', BK2109 핵심 조건 충족 작업 있음' : ''}`,
    );
    job.tasks.forEach((task) => {
      lines.push(
        `  · 노출유형 ${task.exposureTypes.length > 0 ? labels(task.exposureTypes, CERVICAL_EXPOSURE_LABELS) : '-'}, 하중 ${fmt(task.loadWeightKg, 'kg')}, ` +
          `운반 ${fmt(task.carryHoursPerShift, '시간')}/교대, 비중립 목 ${fmt(task.neckNonNeutralHoursPerDay, '시간')}/일, ` +
          `운반 중 목 자세 강제 ${yesNoText(task.forcedNeckPosture)}, 굴곡+회전 자세 ${yesNoText(task.combinedFlexionRotation)}, 정밀 작업 ${yesNoText(task.precisionWork)}`,
      );
    });
  });
  return lines.join('\n');
}

function spineText(m: NonNullable<Modules['spine']>, gender: AiAnalysisInput['demographics']['gender']): string {
  const lines = [`[${MODULE_LABELS.spine}]`];
  if (m.noEvaluableJobs) return [...lines, NO_EVALUABLE_JOBS].join('\n');
  if (gender === null) lines.push('(성별이 입력되지 않아 성별별 기준값이 정확하지 않을 수 있음)');

  lines.push(`① MDDM(누적 부하) 평가: ${SPINE_STATUS_LABELS[m.mddmStatus]}`);
  const mddm = m.mddm;
  if (mddm && m.mddmStatus === 'present') {
    lines.push(
      `- 계산식 ${mddm.formulaVersion}, 일일 용량 ${fmt(mddm.dailyDoseKNh, ' kN·h')}, 평생 누적 용량 ${fmt(mddm.lifetimeDoseMNh, ' MN·h')} (총 ${fmt(mddm.totalYears, '년')})` +
        `${mddm.weightedDailyDoseKNh !== null ? `, 가중 일일 용량 ${fmt(mddm.weightedDailyDoseKNh, ' kN·h')}` : ''}`,
    );
    if (mddm.excluded) lines.push('- 일일 용량이 하한 기준에 못 미쳐 평생 누적 용량 계산에서 제외됨');
    lines.push(
      `- MDDM 기준 ${fmt(mddm.comparison.mddm.limit, ' MN·h')} 대비 ${fmt(mddm.comparison.mddm.percent, '%')} (${RANGE_STATUS_LABELS[mddm.comparison.mddm.status]})`,
      `- 독일 법원(BSG) 기준 ${fmt(mddm.comparison.court.limit, ' MN·h')} 대비 ${fmt(mddm.comparison.court.percent, '%')} (${RANGE_STATUS_LABELS[mddm.comparison.court.status]})`,
      `- 업무관련성 ${SPINE_RELATEDNESS_LABELS[mddm.workRelatedness.level]} (업무 기여 ${fmt(mddm.workRelatedness.workContributionPct, '%')}, 개인 요인 ${fmt(mddm.workRelatedness.personalContributionPct, '%')}), 신체부담 정도 ${BURDEN_LABELS[mddm.severity]}`,
    );
    mddm.jobs.forEach((job) => {
      lines.push(
        `- ${jobLabel(job.jobIndex)} (${fmt(job.periodYears, '년')}, 연 ${fmt(job.workDaysPerYear, '일')}): 일일 ${fmt(job.dailyDoseKNh, ' kN·h')}, 평생 ${fmt(job.lifetimeDoseMNh, ' MN·h')}`,
      );
      job.tasks.forEach((task) => {
        const unit = task.timeUnit ? TIME_UNIT_LABELS[task.timeUnit] : '';
        lines.push(
          `  · 자세 ${task.posture ?? '-'}, 중량 ${fmt(task.weightKg, 'kg')}, 빈도 ${fmt(task.frequencyPerDay, '회')}/일, 시간 ${fmt(task.timeValue, unit)}, ` +
            `보정계수 ${fmt(task.correctionFactor)}, 추정 힘 ${fmt(task.forceN, 'N')}${task.included ? '' : ' (일일 용량 계산 제외)'}`,
        );
      });
    });
  }

  const vib = m.vibration;
  if (vib) {
    lines.push(`② 전신진동(BK2110) 평가: ${SPINE_STATUS_LABELS[vib.exposureStatus]}`);
    if (vib.exposureStatus === 'present') {
      lines.push(`- 일일 Amax(8) ${fmt(vib.amax8Min)}~${fmt(vib.amax8Max)} m/s², 평생 누적 DV ${fmt(vib.dvMin)}~${fmt(vib.dvMax)} (m/s²)²`);
      if (vib.daily) lines.push(`- 일일 기준 대비 ${fmt(vib.daily.percentMin, '%')}~${fmt(vib.daily.percentMax, '%')} (${RANGE_STATUS_LABELS[vib.daily.status]})`);
      if (vib.lifetime) lines.push(`- 평생 기준 대비 ${fmt(vib.lifetime.percentMin, '%')}~${fmt(vib.lifetime.percentMax, '%')} (${RANGE_STATUS_LABELS[vib.lifetime.status]})`);
      if (vib.hasInvalidIntervals) lines.push('- 일부 진동 구간 입력이 올바르지 않음');
      vib.jobs.forEach((job) => {
        lines.push(`- ${jobLabel(job.jobIndex)} (${fmt(job.periodYears, '년')}, 연 ${fmt(job.workDaysPerYear, '일')})`);
        job.intervals.forEach((iv) => {
          const unit = iv.timeUnit ? TIME_UNIT_LABELS[iv.timeUnit] : '';
          lines.push(`  · aw ${fmt(iv.awMin)}~${fmt(iv.awMax)} m/s², 노출 ${fmt(iv.timeValue, unit)}`);
        });
      });
    }
  }
  return lines.join('\n');
}

// ── 조립 ─────────────────────────────────────────────────────────────────
/** 외부·내부 공통 프롬프트. 입력은 검증을 통과한 구조화 값뿐이다. */
export function buildPrompt(input: AiAnalysisInput): string {
  const m = input.modules;
  const sections = [
    '다음은 직업성 근골격계 질환 업무관련성 평가 요약입니다(식별정보 제거본). 아래 내용을 바탕으로 업무관련성 의견을 작성해 주세요.',
    demographicsText(input.demographics),
    diagnosesText(input.diagnoses),
    jobsText(input.jobs),
    m.knee && kneeText(m.knee),
    m.shoulder && shoulderText(m.shoulder),
    m.elbow && bkText(MODULE_LABELS.elbow, m.elbow, ELBOW_FLAG_LABELS),
    m.wrist && bkText(MODULE_LABELS.wrist, m.wrist, WRIST_FLAG_LABELS),
    m.spine && spineText(m.spine, input.demographics.gender),
    m.cervical && cervicalText(m.cervical),
  ];
  return sections.filter((s): s is string => Boolean(s)).join('\n\n');
}

/** 내부 LLM 전용: 구조화 입력에 현행 보고서 전문을 덧붙인다. 외부 경로에서는 호출하지 않는다. */
export function buildInternalPrompt(input: AiAnalysisInput, fullReport?: string): string {
  const base = buildPrompt(input);
  return fullReport ? `${base}\n\n[전체 보고서]\n${fullReport}` : base;
}
