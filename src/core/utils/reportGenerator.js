import { getModule } from '../moduleRegistry';
import { getSideText, getStatusText, getReasonText } from '../../modules/knee/utils/calculations';
import { AUX_LABELS } from '../../modules/knee/utils/data';
import { convertTimeToSeconds } from '../../modules/spine/utils/calculations';
import { thresholds } from '../../modules/spine/utils/thresholds';
import { resolveDiagnosisModule } from './diagnosisMapping';
import { calculateAge, calculateBMI } from './common';
import { getEffectiveWorkPeriodText } from './workPeriod';

function genKneeBurdenSection(calc) {
  const { relatedness, cumulativeBurden, jobBurdens } = calc;
  let text = `\n  < 무릎(슬관절) >\n`;
  const avgRelatedness = relatedness
    ? ((Number(relatedness.min) + Number(relatedness.max)) / 2).toFixed(1)
    : null;

  (jobBurdens || []).forEach(job => {
    const checked = Object.entries(AUX_LABELS)
      .filter(([key]) => job[key])
      .map(([, label]) => label);

    text += `  직종: ${job.jobName || '-'}\n`;
    text += `  일 중량물 취급량: ${job.weight || '-'}kg\n`;
    text += `  일 쪼그려 앉기 시간: ${job.squatting || '-'}분\n`;
    if (checked.length > 0) {
      text += `  보조변수: ${checked.join(', ')}\n`;
    }
    text += `  무릎 부담 정도: ${job.burden?.level || '-'}\n`;
  });

  if (relatedness) {
    text += `\n  참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
    text += `  1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
    text += `  2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
    text += `  3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
    text += `  4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
    text += `\n  [신체부담기여도] ${relatedness.min}% ~ ${relatedness.max}% (평균 ${avgRelatedness}%)\n`;
  }
  if (cumulativeBurden) {
    text += `  [누적신체부담] ${cumulativeBurden}\n`;
  }
  text += `\n  **신체부담정도, 신체부담 기여도, 누적 신체부담에 관한 자세한 사항은\n`;
  text += `  <근골격계 질환의 업무관련성 특별진찰 표준화를 위한 모델 개발\n`;
  text += `  - 무릎 관절염을 대상으로 -, 대한직업환경의학회, 2025>\n`;
  text += `  보고서를 참조하기 바람.\n`;

  return text;
}

function getShoulderInterpretation(totals) {
  const exceeded = (totals || []).filter(t => t.exceeded);
  if (exceeded.length > 0) {
    const names = exceeded.map(t => t.label).join(', ');
    return `** ${names} 기준을 초과하여 누적 신체부담은 충분함.`;
  }
  const over75 = (totals || []).filter(t => t.ratio >= 0.75);
  const over50 = (totals || []).filter(t => t.ratio >= 0.50);
  if (over50.length >= 3 || over75.length >= 2) {
    return `** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.`;
  }
  return `** 노출 기준치에 미달하여 누적 신체부담 불충분함.`;
}

function genShoulderBurdenSection(calc) {
  const { totals, jobBurdens } = calc;
  let text = `\n< 어깨(견관절) >\n`;
  text += `독일의 산재보험 번호 BK2117 장기간의 집중적인 기계적 부하로 인한 어깨 회전근개 병변에 사용하는 어깨 부담 평가 지침을 이용하여 평가하였음.\n\n`;

  (totals || []).forEach(total => {
    const pct = total.totalHours > 0 ? `${(total.ratio * 100).toFixed(0)}%` : '';
    const exceeded = total.exceeded ? ' [초과]' : '';
    text += `- ${total.label}: ${total.totalHours > 0 ? `${total.totalHours.toFixed(1)}시간` : '-'} (기준 ${total.limit.toLocaleString()}시간${pct ? ` / ${pct}` : ''}${exceeded})\n`;
  });

  text += `\n${getShoulderInterpretation(totals)}\n`;

  const jobsWithData = (jobBurdens || []).filter(job => job.jobName);
  if (jobsWithData.length > 1) {
    text += `\n[직력별 기여]\n`;
    jobsWithData.forEach((job, index) => {
      text += `- 직력${index + 1}: ${job.jobName} (${job.periodYears > 0 ? `${job.periodYears.toFixed(1)}년` : '-'})\n`;
      (job.exposures || []).forEach(exposure => {
        if (exposure.dailyHours > 0) {
          text += `  ${exposure.label}: ${exposure.dailyHours}시간/일, 누적 ${exposure.cumulativeHours.toFixed(1)}시간\n`;
        }
      });
    });
  }

  return text;
}

function formatSpineNumber(value, digits = 2) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue.toFixed(digits) : '-';
}

function formatSpinePercent(item) {
  return Number.isFinite(item?.percent) ? item.percent.toFixed(0) : '0';
}

function formatSpineLimit(item) {
  return Number.isFinite(item?.limit) ? item.limit.toFixed(1) : '-';
}

function isSpineThresholdExceeded(item) {
  return Number.isFinite(item?.percent) && item.percent > 100;
}

function getSpineThresholdStatus(item) {
  return isSpineThresholdExceeded(item) ? '초과' : '미만';
}

function getSpineTaskDose(task) {
  const totalSeconds = convertTimeToSeconds(task.timeValue, task.timeUnit) * (Number(task.frequency) || 0);
  const force = Number(task.force) || 0;
  const singleForceThreshold = thresholds.singleForce;
  const included = force >= singleForceThreshold;
  const dailyContribution = included ? (force * Math.sqrt(totalSeconds)) / 1000 / 60 : 0;

  return {
    totalHours: totalSeconds / 3600,
    dailyContribution,
  };
}

function getSpineInterpretation(comparison) {
  if (!comparison) return '';

  const dws2Limit = formatSpineLimit(comparison.dws2);
  const courtLimit = formatSpineLimit(comparison.court);
  const mddmLimit = formatSpineLimit(comparison.mddm);

  if (isSpineThresholdExceeded(comparison.mddm)) {
    return `** 최신 DWS2 연구 기준(${dws2Limit} MN·h), 독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h), 가장 보수적인 MDDM 최초 모델 기준(${mddmLimit} MN·h)을 모두 초과하여, 직업적 요인을 질병 발생의 주요 원인으로 강하게 추정 가능합니다.`;
  }

  if (isSpineThresholdExceeded(comparison.court)) {
    return `** 최신 DWS2 연구 기준(${dws2Limit} MN·h), 보다 보수적인 독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h)을 초과하여, 직업적 요인을 질병 발생의 주요 원인으로 추정 가능합니다.`;
  }

  if (isSpineThresholdExceeded(comparison.dws2)) {
    return `** 최신 DWS2 연구 기준(${dws2Limit} MN·h)을 초과하여, 직업적 요인의 관여 가능성을 검토할 수 있습니다.`;
  }

  return `** DWS2 연구 기준(${dws2Limit} MN·h), 독일 연방 사회법원(BSG) 기준(${courtLimit} MN·h), MDDM 최초 모델 기준(${mddmLimit} MN·h)에 모두 미달하여, MDDM 누적 노출 기준만으로는 직업적 요인을 주요 원인으로 보기 어렵습니다.`;
}

function genSpineBurdenSection(calc) {
  const { tasks, dailyDose, lifetimeDose, comparison, maxForce } = calc;
  const spineTasks = tasks || [];
  let text = `\n< 허리(요추) >\n`;
  text += `독일의 산재보험 번호 BK2108. 장기간의 중량물 취급 또는 허리를 굽히기로 인해 발생한 요추간판 탈출증 에서 사용하는 척추 압박력 평가 모델(Mainz-Dortmund Dose Model, MDDM)을 이용하여 평가하였음.\n\n`;

  text += `작업별 분석\n`;
  if (spineTasks.length === 0) {
    text += `- 입력된 작업 없음\n`;
  } else {
    spineTasks.forEach((task, index) => {
      const taskDose = getSpineTaskDose(task);
      text += `작업 ${index + 1}. ${task.name || '-'}\n`;
      text += `자세 ${task.posture || '-'} · ${task.weight || '-'}kg · ${task.frequency || 0}회/일\n`;
      text += `압박력 : ${(task.force || 0).toLocaleString()} N\n`;
      text += `일일 시간: ${formatSpineNumber(taskDose.totalHours, 3)} h | 일일 기여: ${formatSpineNumber(taskDose.dailyContribution, 2)} kN·h\n`;
    });
  }

  text += `\n종합\n`;
  text += `- 최대 압박력: ${(maxForce || 0).toLocaleString()} N\n`;
  const dailyKNh = dailyDose?.dailyDoseKNh || 0;
  const mf = maxForce || 0;
  let severityLabel;
  if (dailyKNh > 4 || mf >= 6000) severityLabel = '고도';
  else if (dailyKNh > 3 || mf >= 5000) severityLabel = '중등도상';
  else if (dailyKNh >= 2 || mf >= 4000) severityLabel = '중등도하';
  else severityLabel = '경도';
  text += `- 일일 노출량: ${dailyKNh.toFixed(2)} kN·h (${severityLabel})\n`;
  text += `- **누적 노출량: ${lifetimeDose?.lifetimeDoseMNh?.toFixed(2) || '0.00'} MN·h **\n`;

  if (comparison) {
    text += `\n기준치 대비\n`;
    text += `- **DWS2(독일 척추 연구) 기준 대비 : ${formatSpinePercent(comparison.dws2)}% (${formatSpineLimit(comparison.dws2)} MN·h) : ${getSpineThresholdStatus(comparison.dws2)}\n`;
    text += `- 독일 연방 사회법원(BSG) 기준 대비 : ${formatSpinePercent(comparison.court)}% (${formatSpineLimit(comparison.court)} MN·h) : ${getSpineThresholdStatus(comparison.court)}\n`;
    text += `- MDDM 최초 모델 기준 대비 : ${formatSpinePercent(comparison.mddm)}% (${formatSpineLimit(comparison.mddm)} MN·h) : ${getSpineThresholdStatus(comparison.mddm)}\n\n`;
    text += `${getSpineInterpretation(comparison)}\n`;
  }

  return text;
}

function genElbowBurdenSection(calc) {
  let text = `\n< 팔꿈치(주관절) >\n`;

  if (calc.missingCommonFields?.length) {
    text += `- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}\n`;
  }

  const temporalFlags = calc.temporalFlagItems || [];
  if (temporalFlags.length > 0) {
    text += `- 공통 시간적 선후관계: ${temporalFlags.map(flag => flag.label).join(', ')}\n`;
  }

  (calc.jobSummaries || []).forEach((jobSummary, index) => {
    text += `- 직력${index + 1}: ${jobSummary.jobName || '-'}\n`;
    (jobSummary.diagnosisSummaries || []).forEach(summary => {
      const diag = summary.diagnosis || {};
      const riskFactorText = summary.riskFactorItems?.length > 0
        ? summary.riskFactorItems.map(flag => flag.label).join(', ')
        : '확인된 위험 요인 없음';
      text += `  - ${diag.code || ''} ${diag.name || ''} (${getSideText(diag.side)})\n`;
      if (summary.missingFields.length > 0) {
        text += `    입력 누락: ${summary.missingFields.join(', ')}\n`;
      }
      text += `    분석 정리:\n`;
      text += `      ${summary.narrative.split('\n').join('\n      ')}\n`;
      text += `      업무에 포함된 위험 요인: ${riskFactorText}\n`;
      if (summary.riskFactorSentence) {
        text += `\n      **종합평가** ${summary.riskFactorSentence}\n`;
      }
    });
  });

  return text;
}

export function generateUnifiedReport(patient) {
  const shared = patient.data.shared || {};
  const modules = patient.data.modules || {};
  const activeModules = patient.data.activeModules || [];
  const diagnoses = shared.diagnoses || [];
  const jobs = shared.jobs || [];

  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  let text = `업무관련성 통합 평가 보고서\n\n`;
  text += `이름: ${shared.name || '-'}(${shared.gender === 'male' ? '남' : shared.gender === 'female' ? '여' : '-'})\n`;
  text += `키/체중: ${shared.height || '-'}cm / ${shared.weight || '-'}kg (BMI: ${bmi || '-'})\n`;
  text += `생년월일: ${shared.birthDate || '-'}\n`;
  text += `재해일자: ${shared.injuryDate || '-'} (만 ${age || '-'}세)\n\n`;

  text += `[신청 상병]\n`;
  diagnoses.forEach((diag, index) => {
    if (diag.code || diag.name) {
      text += `#${index + 1}. ${diag.code || ''} ${diag.name || ''}${diag.side ? ` (${getSideText(diag.side)})` : ''}\n`;
    }
  });

  text += `\n[특이사항]\n${shared.specialNotes || '-'}\n`;

  text += `\n[직업력]\n`;
  jobs.forEach((job, index) => {
    text += `- 직력${index + 1}: ${job.jobName || '-'} | ${getEffectiveWorkPeriodText(job)}\n`;
  });

  text += `\n[부위별 신체부담 평가]\n`;
  for (const moduleId of activeModules) {
    const moduleManifest = getModule(moduleId);
    if (!moduleManifest?.computeCalc) continue;
    const calc = moduleManifest.computeCalc({
      shared,
      module: modules[moduleId] || {},
    });

    if (moduleId === 'knee') text += genKneeBurdenSection(calc);
    if (moduleId === 'shoulder') text += genShoulderBurdenSection(calc);
    if (moduleId === 'spine') text += genSpineBurdenSection(calc);
    if (moduleId === 'elbow') text += genElbowBurdenSection(calc);
  }

  text += `\n[업무관련성 평가 결과]\n`;
  diagnoses.forEach((diag, index) => {
    if (!(diag.code || diag.name)) return;

    const resolvedModule = resolveDiagnosisModule(diag, activeModules);
    text += `\n상병 #${index + 1}: ${diag.code || ''} ${diag.name || ''}\n`;

    if (resolvedModule?.moduleId === 'spine') {
      text += `  평가: 상병 상태(${getStatusText(diag.confirmedRight)}) / 업무관련성(${diag.assessmentRight === 'high' ? '높음' : diag.assessmentRight === 'low' ? '낮음' : '-'})\n`;
      if (diag.assessmentRight === 'low') {
        text += `  낮음 사유:\n  - ${getReasonText(diag.reasonRight, diag.reasonRightOther).split('\n').join('\n  - ')}\n`;
      }
      return;
    }

    if (diag.side === 'right' || diag.side === 'both') {
      text += `  우측: 상병 상태(${getStatusText(diag.confirmedRight)}) / 업무관련성(${diag.assessmentRight === 'high' ? '높음' : diag.assessmentRight === 'low' ? '낮음' : '-'})\n`;
      if (diag.assessmentRight === 'low') {
        text += `  낮음 사유:\n  - ${getReasonText(diag.reasonRight, diag.reasonRightOther).split('\n').join('\n  - ')}\n`;
      }
    }

    if (diag.side === 'left' || diag.side === 'both') {
      text += `  좌측: 상병 상태(${getStatusText(diag.confirmedLeft)}) / 업무관련성(${diag.assessmentLeft === 'high' ? '높음' : diag.assessmentLeft === 'low' ? '낮음' : '-'})\n`;
      if (diag.assessmentLeft === 'low') {
        text += `  낮음 사유:\n  - ${getReasonText(diag.reasonLeft, diag.reasonLeftOther).split('\n').join('\n  - ')}\n`;
      }
    }
  });

  const returnConsiderations = modules.knee?.returnConsiderations
    || modules.shoulder?.returnConsiderations
    || modules.elbow?.returnConsiderations
    || '';

  if (returnConsiderations) {
    text += `\n[복귀 관련 고려사항]\n${returnConsiderations}\n`;
  }

  text += `\n${'-'.repeat(50)}\n${shared.evaluationDate || '-'}\n${shared.hospitalName || '-'} ${shared.department || ''}\n담당의 ${shared.doctorName || '-'}`;

  return text;
}
