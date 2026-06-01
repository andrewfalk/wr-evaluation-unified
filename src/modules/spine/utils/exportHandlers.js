import * as XLSX from 'xlsx';
import { formulaDB } from './formulaDB';
import { computeSpineCalc } from './calculations';
import { thresholds } from './thresholds';
import { SPINE_FORMULA_V513 } from './formulaVersion';
import { buildVibrationSectionText } from './sectionText';
import { getEffectiveWorkPeriodText } from '../../../core/utils/workPeriod';

function buildWeightedDailySuffix(weightedDailyDose, gender, formulaVersion) {
  if (!weightedDailyDose || !weightedDailyDose.aboveThreshold) return '';
  const versionKey = formulaVersion === SPINE_FORMULA_V513 ? 'v513' : 'legacy';
  const dailyThreshold = gender ? thresholds.dailyDose[versionKey][gender] : null;
  if (dailyThreshold == null || weightedDailyDose.value >= dailyThreshold) return '';
  return ' (단, 수행 직업 중 임계치 초과 직업이 포함, 그 기간만으로 누적량을 산출)';
}

// shared.jobs에서 직업 정보 텍스트 추출
function getJobInfoFromShared(shared) {
  const jobs = shared.jobs || [];
  if (jobs.length === 0) return { jobName: '-', careerText: '-', workDaysPerYear: 250 };
  const jobNames = jobs.map(j => j.jobName || '(미입력)').join(', ');
  const careerTexts = jobs.map(j => getEffectiveWorkPeriodText(j)).join(' / ');
  return { jobName: jobNames, careerText: careerTexts, workDaysPerYear: jobs[0]?.workDaysPerYear || 250 };
}

function vibStatusLabel(status) {
  if (status === 'danger') return '초과';
  if (status === 'warning') return '걸침';
  return '미만';
}


function generateSpineReport(patientData, calc) {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const c = calc || computeSpineCalc(patientData);
  const { tasks, jobResults, dailyDose, lifetimeDose, comparison, workRelatedness, maxForce, weightedDailyDose, gender, formulaVersion } = c;

  // 구형식 호환
  const hasLegacy = mod.jobName !== undefined || mod.careerYears !== undefined;
  const jobInfo = hasLegacy
    ? { jobName: mod.jobName || '-', careerText: `${mod.careerYears || 0}년 ${mod.careerMonths || 0}개월`, workDaysPerYear: mod.workDaysPerYear || 250 }
    : getJobInfoFromShared(shared);

  let t = `MDDM 요추 압박력 평가 보고서\n\n`;
  t += `이름: ${shared.name} (${shared.gender === 'male' ? '남' : '여'})\n`;
  t += `키/몸무게: ${shared.height || '-'}cm / ${shared.weight || '-'}kg\n`;
  t += `생년월일: ${shared.birthDate || '-'}\n\n`;
  t += `[직업 정보]\n`;
  t += `직업: ${jobInfo.jobName}\n`;
  t += `직업력: ${jobInfo.careerText}\n`;
  t += `연간 근무일: ${jobInfo.workDaysPerYear}일\n\n`;

  // 직업별 작업 목록 및 결과
  if (jobResults && jobResults.length > 1) {
    jobResults.forEach((jr, i) => {
      t += `[직력${i + 1}: ${jr.jobName} (${jr.periodYears.toFixed(1)}년)]\n`;
      jr.tasks.forEach((task, ti) => {
        const formula = formulaDB[task.posture];
        t += `  ${ti + 1}. ${task.name}: ${task.posture}(${formula?.name}) | ${task.weight}kg | ${task.frequency}회/일 | ${task.force.toLocaleString()}N\n`;
      });
      t += `  일일선량: ${jr.dailyDose.dailyDoseKNh.toFixed(2)} kN\xB7h\n`;
      t += `  누적선량: ${jr.lifetimeDose.excluded ? '일일선량 미달' : `${jr.lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h`}\n\n`;
    });
  } else {
    t += `[작업 목록]\n`;
    tasks.forEach((task, i) => {
      const formula = formulaDB[task.posture];
      t += `${i + 1}. ${task.name}: ${task.posture}(${formula?.name}) | ${task.weight}kg | ${task.frequency}회/일 | ${task.force.toLocaleString()}N\n`;
    });
    t += `\n`;
  }

  t += `[평가 결과]\n`;
  t += `최대 압박력: ${maxForce.toLocaleString()} N\n`;
  t += `일일선량: ${(weightedDailyDose ? weightedDailyDose.value : dailyDose.dailyDoseKNh).toFixed(2)} kN\xB7h${weightedDailyDose ? ' (가중평균)' : ''}${buildWeightedDailySuffix(weightedDailyDose, gender, formulaVersion)}\n`;
  t += `누적선량: ${lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h${lifetimeDose.excluded ? ' (일 임계값 미만으로 누적 노출량이 0으로 계산됩니다)' : ''}\n`;
  t += `\n[기준 비교]\n`;
  t += `독일 법원(BSG): ${comparison.court.percent.toFixed(0)}% (${comparison.court.limit} MN\xB7h)\n`;
  t += `MDDM: ${comparison.mddm.percent.toFixed(0)}% (${comparison.mddm.limit} MN\xB7h)\n`;
  t += `\n[업무관련성] ${workRelatedness.grade} (기여도: ${workRelatedness.workContribution}%)\n`;
  t += `${workRelatedness.detail}\n`;
  // 전신진동 섹션 append (exposureStatus unknown이면 빈 문자열)
  t += buildVibrationSectionText(c.vibration || {});
  t += `\n${'─'.repeat(50)}\n${shared.evaluationDate}\n${shared.hospitalName} ${shared.department}\n담당의: ${shared.doctorName}`;
  return t;
}

// 워크북에 '전신진동 평가' 시트를 추가. 'present'일 때만 추가(unknown·none은 시트 생략).
function appendVibrationSheet(wb, vibration, shared) {
  const status = vibration?.exposureStatus || 'unknown';
  if (status !== 'present') return;

  const jobInfo = getJobInfoFromShared(shared);
  const { jobResults, amax8, dv, comparison, validation, risk } = vibration;
  const wsData = [
    ['전신진동(BK 2110) 평가', ''],
    ['직업', jobInfo.jobName],
    ['직업력', jobInfo.careerText],
    ['', ''],
  ];

  if (validation?.hasInvalidIntervals) {
    wsData.push(['※ 경고', (validation.messages || []).join(' ')]);
    wsData.push(['', '']);
  }

  (jobResults || []).forEach((jr, i) => {
    const ivs = jr.intervals || [];
    if (ivs.length === 0) return;
    wsData.push([`직력${i + 1}: ${jr.jobName} (${jr.periodYears.toFixed(1)}년)`, '']);
    wsData.push(['진동작업명', 'aw 하한', 'aw 상한', '1일 노출시간']);
    ivs.forEach(iv => {
      const unit = iv.timeUnit === 'hr' ? '시간' : iv.timeUnit === 'min' ? '분' : '초';
      wsData.push([iv.name, iv.awMin, iv.awMax, `${iv.timeValue}${unit}`]);
    });
    wsData.push(['직력 Amax(8)', `${jr.amax8.min.toFixed(2)}~${jr.amax8.max.toFixed(2)} m/s²`]);
    wsData.push(['직력 DV', `${jr.dv.min.toFixed(0)}~${jr.dv.max.toFixed(0)} (m/s²)²`]);
    wsData.push(['', '']);
  });

  wsData.push(['평가 결과', '']);
  wsData.push(['직업별 최대 일일 Amax(8)', `${amax8.min.toFixed(2)}~${amax8.max.toFixed(2)} m/s² (기준 0.63)`]);
  wsData.push(['평생 누적용량 DV', `${dv.min.toFixed(0)}~${dv.max.toFixed(0)} (m/s²)² (기준 1400)`]);
  wsData.push(['일일 기준(0.63) 대비', `${comparison.daily.percent.min.toFixed(0)}~${comparison.daily.percent.max.toFixed(0)}% (${vibStatusLabel(comparison.daily.status)})`]);
  wsData.push(['평생 기준(1400) 대비', `${comparison.lifetime.percent.min.toFixed(0)}~${comparison.lifetime.percent.max.toFixed(0)}% (${vibStatusLabel(comparison.lifetime.status)})`]);
  wsData.push(['평가', risk.description]);

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 25 }, { wch: 14 }, { wch: 14 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, '전신진동 평가');
}

export const spineExportHandlers = {
  excelSingle: (patientData, calc) => {
    const shared = patientData.shared || {};
    const mod = patientData.module || {};
    const c = calc || computeSpineCalc(patientData);
    // 정상 경로(computeSpineCalc)는 mddmStatus를 항상 포함. 구형/직접 WBV calc 방어:
    // top-level이 WBV calc면 MDDM 시트를 만들지 않는다.
    const mddmStatus = c.mddmStatus || (c.evalMethod === 'wbv' ? 'unknown' : 'present');

    const wb = XLSX.utils.book_new();

    // MDDM 시트 — present일 때만. unknown·none은 생략(공간 절약).
    if (mddmStatus === 'present') {
      appendMddmSheet(wb, c, shared, mod);
    }

    // 전신진동 시트 — present일 때만 (appendVibrationSheet 내부에서 게이트).
    appendVibrationSheet(wb, c.vibration, shared);

    // 둘 다 미표시면 안내 시트 1장
    if (wb.SheetNames.length === 0) {
      const ws = XLSX.utils.aoa_to_sheet([['척추 평가', '해당 없음 / 미평가']]);
      XLSX.utils.book_append_sheet(wb, ws, '척추 평가');
    }

    XLSX.writeFile(wb, `MDDM평가_${shared.name || '미입력'}_${new Date().toISOString().split('T')[0]}.xlsx`);
  }
};

// MDDM 결과 시트를 워크북에 추가 (mddmStatus 'present'에서만 호출).
function appendMddmSheet(wb, c, shared, mod) {
  const { tasks, jobResults, dailyDose, lifetimeDose, comparison, workRelatedness, weightedDailyDose, gender, formulaVersion } = c;

  const hasLegacy = mod.jobName !== undefined || mod.careerYears !== undefined;
  const jobInfo = hasLegacy
    ? { jobName: mod.jobName || '-', careerText: `${mod.careerYears || 0}년 ${mod.careerMonths || 0}개월`, workDaysPerYear: mod.workDaysPerYear || 250 }
    : getJobInfoFromShared(shared);

  const wsData = [
    ['MDDM 요추 압박력 평가', ''],
    ['항목', '내용'],
    ['이름', shared.name || ''],
    ['성별', shared.gender === 'male' ? '남' : '여'],
    ['키/몸무게', `${shared.height || '-'}cm / ${shared.weight || '-'}kg`],
    ['직업', jobInfo.jobName],
    ['직업력', jobInfo.careerText],
    ['연간 근무일', `${jobInfo.workDaysPerYear}일`],
    ['', ''],
  ];

  // 직업별 작업 목록
  if (jobResults && jobResults.length > 1) {
    jobResults.forEach((jr, i) => {
      wsData.push([`직력${i + 1}: ${jr.jobName} (${jr.periodYears.toFixed(1)}년)`, '']);
      wsData.push(['작업명', '자세', '중량(kg)', '횟수/일', '압박력(N)']);
      jr.tasks.forEach(t => {
        wsData.push([t.name, t.posture, t.weight, t.frequency, t.force]);
      });
      wsData.push(['일일선량', `${jr.dailyDose.dailyDoseKNh.toFixed(2)} kN\xB7h`]);
      wsData.push(['누적선량', jr.lifetimeDose.excluded ? '일일선량 미달' : `${jr.lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h`]);
      wsData.push(['', '']);
    });
  } else {
    wsData.push(['작업 목록', '']);
    wsData.push(['작업명', '자세', '중량(kg)', '횟수/일', '압박력(N)']);
    tasks.forEach(t => {
      wsData.push([t.name, t.posture, t.weight, t.frequency, t.force]);
    });
    wsData.push(['', '']);
  }

  wsData.push(['평가 결과', '']);
  wsData.push(['일일선량', `${(weightedDailyDose ? weightedDailyDose.value : dailyDose.dailyDoseKNh).toFixed(2)} kN\xB7h${weightedDailyDose ? ' (가중평균)' : ''}${buildWeightedDailySuffix(weightedDailyDose, gender, formulaVersion)}`]);
  wsData.push(['누적선량', `${lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h${lifetimeDose.excluded ? ' (일 임계값 미만으로 누적 노출량이 0으로 계산됩니다)' : ''}`]);
  wsData.push(['독일 법원(BSG) 기준', `${comparison.court.percent.toFixed(0)}%`]);
  wsData.push(['MDDM 기준', `${comparison.mddm.percent.toFixed(0)}%`]);
  wsData.push(['업무관련성', `${workRelatedness.grade} (기여도 ${workRelatedness.workContribution}%)`]);

  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 25 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws, 'MDDM 평가');
}

export { generateSpineReport };
