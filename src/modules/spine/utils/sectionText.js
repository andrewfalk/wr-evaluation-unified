// 척추(요추) 섹션 텍스트 생성 — 종합소견 미리보기·EMR 내보내기 공통 소스.
// reportGenerator/exportService 양쪽에서 이 모듈을 단일 호출해 출력이 100% 일치하도록 한다.

import {
  classifySpineSeverity,
  convertTimeToSeconds,
  getSpineTaskDoses,
} from './calculations';
import { thresholds } from './thresholds';
import { SPINE_FORMULA_V513 } from './formulaVersion';

const EXCLUDED_NOTE = '(일 임계값 미만으로 누적 노출량이 0으로 계산됩니다)';

export function formatSpineNumber(value, digits = 2) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '-';
}

export function formatSpinePercent(item) {
  return Number.isFinite(item?.percent) ? item.percent.toFixed(0) : '0';
}

export function formatSpineLimit(item) {
  return Number.isFinite(item?.limit) ? item.limit.toFixed(1) : '-';
}

export function isSpineThresholdExceeded(item) {
  return Number.isFinite(item?.percent) && item.percent > 100;
}

export function getSpineThresholdStatus(item) {
  return isSpineThresholdExceeded(item) ? '초과' : '미만';
}

export function getSpineTaskTotalHours(task) {
  const totalSeconds = convertTimeToSeconds(task.timeValue, task.timeUnit) * (Number(task.frequency) || 0);
  return totalSeconds / 3600;
}

// markdown=true (기본): 텍스트 미리보기/EMR용. 앞에 `** ` 마커 포함.
// markdown=false: SpineResultPanel 등 JSX 렌더링용. plain text(접두 제거).
export function getSpineInterpretation(comparison, { markdown = true } = {}) {
  if (!comparison) return '';

  const courtLimit = formatSpineLimit(comparison.court);
  const mddmLimit = formatSpineLimit(comparison.mddm);
  const prefix = markdown ? '** ' : '';

  if (isSpineThresholdExceeded(comparison.mddm)) {
    return `${prefix}독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h)과 가장 보수적인 MDDM 최초 모델 기준(${mddmLimit} MN·h)을 모두 초과하여, 직업적 요인을 질병 발생의 주요 원인으로 강하게 추정 가능합니다.`;
  }

  if (isSpineThresholdExceeded(comparison.court)) {
    return `${prefix}독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h)을 초과하여, 직업적 요인을 질병 발생의 주요 원인으로 추정 가능합니다. 단, 해당 기준 초과가 자동으로 업무 관련성이 높다는 의미는 아니며, 상병의 종류, 중증도 및 발생에 영향을 줄 수 있는 다른 요인들을 종합적으로 검토하여 판단하게 됩니다.`;
  }

  return `${prefix}독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h)과 MDDM 최초 모델 기준(${mddmLimit} MN·h)에 모두 미달하여, MDDM 누적 노출 기준만으로는 직업적 요인을 주요 원인으로 보기 어렵습니다.`;
}

// 척추 섹션 단일 소스. reportGenerator와 exportService가 각각 호출.
// MDDM 섹션(mddmStatus로 게이트) + WBV 섹션(calc.vibration)을 함께 출력한다.
export function buildSpineSectionText(calc = {}) {
  // 정상 경로는 calc.vibration 서브객체. 구형/직접 WBV calc(top-level evalMethod:'wbv')도 방어.
  const vibration = calc?.vibration || (calc?.evalMethod === 'wbv' ? calc : {});
  return buildMddmSectionText(calc) + buildVibrationSectionText(vibration);
}

// MDDM 섹션 텍스트. 'present'일 때만 출력. unknown(미평가)·none(노출없음)은 빈 문자열(공간 절약).
function buildMddmSectionText(calc = {}) {
  const mddmStatus = calc?.mddmStatus || 'present'; // 구형 calc(상태 없음)는 결과 출력
  if (mddmStatus !== 'present') return '';

  const {
    tasks,
    jobResults,
    dailyDose,
    lifetimeDose,
    comparison,
    maxForce,
    weightedDailyDose,
    gender,
    formulaVersion,
  } = calc || {};

  const spineTasks = tasks || [];
  let text = `\n< 허리(요추) >\n`;
  text += `독일의 산재보험 번호 BK2108. 장기간의 중량물 취급 또는 허리를 굽히기로 인해 발생한 요추간판 탈출증 에서 사용하는 척추 압박력 평가 모델(Mainz-Dortmund Dose Model, MDDM)을 이용하여 평가하였음.\n\n`;

  const renderSpineTask = (task, index, contributions) => {
    let s = `작업 ${index + 1}. ${task.name || '-'}\n`;
    s += `자세 ${task.posture || '-'} · ${task.weight || '-'}kg · ${task.frequency || 0}회/일\n`;
    s += `압박력 : ${(task.force || 0).toLocaleString()} N\n`;
    s += `일일 시간: ${formatSpineNumber(getSpineTaskTotalHours(task), 3)} h | 일일 기여: ${formatSpineNumber(contributions[index], 2)} kN·h\n`;
    return s;
  };

  text += `작업별 분석\n`;
  if (spineTasks.length === 0) {
    text += `- 입력된 작업 없음\n`;
  } else if (jobResults && jobResults.length > 1) {
    jobResults.forEach((jr, ji) => {
      const jrTasks = jr.tasks || [];
      if (jrTasks.length === 0) return;
      const contributions = getSpineTaskDoses(jrTasks, formulaVersion);
      text += `[직력${ji + 1}: ${jr.jobName || '-'}]\n`;
      jrTasks.forEach((task, index) => {
        text += renderSpineTask(task, index, contributions);
      });
      text += `\n`;
    });
  } else {
    const contributions = getSpineTaskDoses(spineTasks, formulaVersion);
    spineTasks.forEach((task, index) => {
      text += renderSpineTask(task, index, contributions);
    });
  }

  text += `\n종합\n`;
  text += `- 최대 압박력: ${(maxForce || 0).toLocaleString()} N\n`;
  const dailyKNh = weightedDailyDose?.value ?? dailyDose?.dailyDoseKNh ?? 0;
  const mf = maxForce || 0;
  const severityLabel = classifySpineSeverity(dailyKNh, mf, gender);
  const versionKey = formulaVersion === SPINE_FORMULA_V513 ? 'v513' : 'legacy';
  const dailyThresholdForGender = gender ? thresholds.dailyDose[versionKey][gender] : null;
  const weightedBelowThreshold = weightedDailyDose
    && weightedDailyDose.aboveThreshold
    && dailyThresholdForGender != null
    && dailyKNh < dailyThresholdForGender;
  const weightedNote = weightedBelowThreshold
    ? ' (단, 수행 직업 중 임계치 초과 직업이 포함, 그 기간만으로 누적량을 산출)'
    : '';
  text += `- 일일 노출량: ${dailyKNh.toFixed(2)} kN·h${weightedDailyDose ? ' (직력가중평균)' : ''} (${severityLabel})${weightedNote}\n`;

  const excludedSuffix = lifetimeDose?.excluded ? ` ${EXCLUDED_NOTE}` : '';
  text += `- **누적 노출량: ${lifetimeDose?.lifetimeDoseMNh?.toFixed(2) || '0.00'} MN·h **${excludedSuffix}\n`;

  if (comparison) {
    text += `\n기준치 대비\n`;
    text += `- 독일 법원(BSG) 기준 대비 : ${formatSpinePercent(comparison.court)}% (${formatSpineLimit(comparison.court)} MN·h) : ${getSpineThresholdStatus(comparison.court)}\n`;
    text += `- MDDM 최초 모델 기준 대비 : ${formatSpinePercent(comparison.mddm)}% (${formatSpineLimit(comparison.mddm)} MN·h) : ${getSpineThresholdStatus(comparison.mddm)}\n\n`;
    text += `${getSpineInterpretation(comparison)}\n`;
  }

  return text;
}

// 범위 status → 한글 라벨
function vibStatusLabel(status) {
  if (status === 'danger') return '초과';
  if (status === 'warning') return '걸침';
  return '미만';
}

// 전신진동(BK 2110) 섹션 텍스트 — buildSpineSectionText에서 calc.vibration으로 호출.
// 'present'일 때만 출력. unknown(미평가)·none(노출없음)은 빈 문자열(공간 절약).
export function buildVibrationSectionText(calc = {}) {
  const { jobResults, amax8, dv, comparison, validation, risk } = calc || {};
  const exposureStatus = calc?.exposureStatus || 'unknown';

  if (exposureStatus !== 'present') return '';

  let text = `\n< 허리(요추) - 전신진동(BK 2110) >\n`;
  text += `독일의 산재보험 번호 BK2110. 장기간의 주로 수직 방향 전신진동 노출로 인한 요추간판 질환에서 사용하는 에너지형 진동노출 모델(Amax(8), DV)을 이용하여 평가하였음. 진동가속도(aw)는 최소~최대 범위로 입력받아 하한·상한 시나리오로 산출함.\n\n`;

  if (validation?.hasInvalidIntervals) {
    text += `※ ${(validation.messages || []).join(' ')}\n\n`;
  }

  text += `작업별 분석\n`;
  const jrs = jobResults || [];
  const hasAnyInterval = jrs.some(jr => (jr.intervals || []).length > 0);
  if (!hasAnyInterval) {
    text += `- 입력된 진동작업 없음\n`;
  } else {
    jrs.forEach((jr, ji) => {
      const ivs = jr.intervals || [];
      if (ivs.length === 0) return;
      text += `[직력${ji + 1}: ${jr.jobName || '-'}]\n`;
      ivs.forEach((iv, idx) => {
        text += `진동작업 ${idx + 1}. ${iv.name || '-'}\n`;
        text += `aw ${formatSpineNumber(iv.awMin)} ~ ${formatSpineNumber(iv.awMax)} m/s² · 1일 노출시간 ${iv.timeValue || 0}${iv.timeUnit === 'hr' ? '시간' : iv.timeUnit === 'min' ? '분' : '초'}\n`;
      });
      text += `직력 Amax(8): ${formatSpineNumber(jr.amax8?.min)} ~ ${formatSpineNumber(jr.amax8?.max)} m/s² | DV: ${formatSpineNumber(jr.dv?.min, 0)} ~ ${formatSpineNumber(jr.dv?.max, 0)} (m/s²)²\n\n`;
    });
  }

  text += `\n종합\n`;
  text += `- 직업별 최대 일일 Amax(8): ${formatSpineNumber(amax8?.min)} ~ ${formatSpineNumber(amax8?.max)} m/s² (기준 0.63)\n`;
  text += `- **평생 누적용량 DV: ${formatSpineNumber(dv?.min, 0)} ~ ${formatSpineNumber(dv?.max, 0)} (m/s²)² **(기준 1400)\n`;

  if (comparison) {
    text += `\n기준치 대비\n`;
    text += `- 일일 Amax(8) 기준(0.63) 대비 : ${formatSpineNumber(comparison.daily?.percent?.min, 0)}% ~ ${formatSpineNumber(comparison.daily?.percent?.max, 0)}% : ${vibStatusLabel(comparison.daily?.status)}\n`;
    text += `- 평생 DV 기준(1400) 대비 : ${formatSpineNumber(comparison.lifetime?.percent?.min, 0)}% ~ ${formatSpineNumber(comparison.lifetime?.percent?.max, 0)}% : ${vibStatusLabel(comparison.lifetime?.status)}\n\n`;
  }

  if (risk?.description) {
    text += `** ${risk.description}\n`;
  }

  return text;
}
