import * as XLSX from 'xlsx';
import { formulaDB } from './formulaDB';
import { computeSpineCalc } from './calculations';
import { getEffectiveWorkPeriodText } from '../../../core/utils/workPeriod';

// shared.jobs에서 직업 정보 텍스트 추출
function getJobInfoFromShared(shared) {
  const jobs = shared.jobs || [];
  if (jobs.length === 0) return { jobName: '-', careerText: '-', workDaysPerYear: 250 };
  const jobNames = jobs.map(j => j.jobName || '(미입력)').join(', ');
  const careerTexts = jobs.map(j => getEffectiveWorkPeriodText(j)).join(' / ');
  return { jobName: jobNames, careerText: careerTexts, workDaysPerYear: jobs[0]?.workDaysPerYear || 250 };
}

function generateSpineReport(patientData, calc) {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const c = calc || computeSpineCalc(patientData);
  const { tasks, jobResults, dailyDose, lifetimeDose, comparison, workRelatedness, maxForce, weightedDailyDose } = c;

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
  t += `일일선량: ${(weightedDailyDose ? weightedDailyDose.value : dailyDose.dailyDoseKNh).toFixed(2)} kN\xB7h${weightedDailyDose ? ' (가중평균)' : ''}\n`;
  t += `누적선량: ${lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h\n`;
  t += `\n[기준 비교]\n`;
  t += `DWS2: ${comparison.dws2.percent.toFixed(0)}% (${comparison.dws2.limit} MN\xB7h)\n`;
  t += `법원기준: ${comparison.court.percent.toFixed(0)}% (${comparison.court.limit} MN\xB7h)\n`;
  t += `MDDM: ${comparison.mddm.percent.toFixed(0)}% (${comparison.mddm.limit} MN\xB7h)\n`;
  t += `\n[업무관련성] ${workRelatedness.grade} (기여도: ${workRelatedness.workContribution}%)\n`;
  t += `${workRelatedness.detail}\n`;
  t += `\n${'─'.repeat(50)}\n${shared.evaluationDate}\n${shared.hospitalName} ${shared.department}\n담당의: ${shared.doctorName}`;
  return t;
}

export const spineExportHandlers = {
  excelSingle: (patientData, calc) => {
    const shared = patientData.shared || {};
    const mod = patientData.module || {};
    const c = calc || computeSpineCalc(patientData);
    const { tasks, jobResults, dailyDose, lifetimeDose, comparison, workRelatedness, weightedDailyDose } = c;

    const hasLegacy = mod.jobName !== undefined || mod.careerYears !== undefined;
    const jobInfo = hasLegacy
      ? { jobName: mod.jobName || '-', careerText: `${mod.careerYears || 0}년 ${mod.careerMonths || 0}개월`, workDaysPerYear: mod.workDaysPerYear || 250 }
      : getJobInfoFromShared(shared);

    const wb = XLSX.utils.book_new();
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
    wsData.push(['일일선량', `${(weightedDailyDose ? weightedDailyDose.value : dailyDose.dailyDoseKNh).toFixed(2)} kN\xB7h${weightedDailyDose ? ' (가중평균)' : ''}`]);
    wsData.push(['누적선량', `${lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h`]);
    wsData.push(['DWS2 기준', `${comparison.dws2.percent.toFixed(0)}%`]);
    wsData.push(['법원 기준', `${comparison.court.percent.toFixed(0)}%`]);
    wsData.push(['업무관련성', `${workRelatedness.grade} (기여도 ${workRelatedness.workContribution}%)`]);

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 25 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 15 }];
    XLSX.utils.book_append_sheet(wb, ws, 'MDDM 평가');
    XLSX.writeFile(wb, `MDDM평가_${shared.name || '미입력'}_${new Date().toISOString().split('T')[0]}.xlsx`);
  }
};

export { generateSpineReport };
