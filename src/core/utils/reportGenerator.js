import { getModule } from '../moduleRegistry';
import { getSideText } from '../i18n/sideLabels';
import { buildAssessmentBlocks, formatGroupedAssessment } from './assessmentGroups';
import { calculateAge, calculateBMI } from './common';
import { buildJobHistoryLines, NO_EVALUABLE_JOBS_NOTE } from './jobHistory';
import { selectModuleNote } from './moduleNotes';
import { groupSummariesByBkType as groupElbowSummaries, mergeBkGroupSummaries as mergeElbowGroups } from '../../modules/elbow/utils/calculations';
import { BK_TYPE_LABELS as ELBOW_BK_LABELS } from '../../modules/elbow/utils/data';
import { groupSummariesByBkType as groupWristSummaries, mergeBkGroupSummaries as mergeWristGroups } from '../../modules/wrist/utils/calculations';
import { BK_TYPE_LABELS as WRIST_BK_LABELS } from '../../modules/wrist/utils/data';

function genElbowBurdenSection(calc) {
  let text = `\n< 팔꿈치(주관절) >\n`;
  if (calc.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  if (calc.missingCommonFields?.length) {
    text += `- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}\n`;
  }

  const temporalFlags = calc.temporalFlagItems || [];
  if (temporalFlags.length > 0) {
    text += `- 공통 시간적 선후관계: ${temporalFlags.map(flag => flag.label).join(', ')}\n`;
  }

  (calc.jobSummaries || []).forEach((jobSummary, index) => {
    text += `- 직력${index + 1}: ${jobSummary.jobName || '-'}\n`;
    const groups = groupElbowSummaries(jobSummary.diagnosisSummaries || []);
    groups.forEach(group => {
      const merged = mergeElbowGroups(group.summaries);
      const diagList = group.summaries
        .map(s => {
          const d = s.diagnosis || {};
          return `${d.code || ''} ${d.name || ''} (${getSideText(d.side)})`.trim();
        })
        .join(' / ');
      const bkLabel = group.bkType ? ELBOW_BK_LABELS[group.bkType] || group.bkType : null;
      const header = bkLabel ? `[${bkLabel}] ${diagList}` : diagList;
      text += `  - ${header}\n`;
      if (merged.missingFields?.length > 0) {
        text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
      }
      const riskFactorText = merged.riskFactorItems?.length > 0
        ? merged.riskFactorItems.map(flag => flag.label).join(', ')
        : '확인된 위험 요인 없음';
      text += `    분석 정리:\n`;
      text += `      ${(merged.narrative || '').split('\n').join('\n      ')}\n`;
      text += `      업무에 포함된 위험 요인: ${riskFactorText}\n`;
      if (merged.riskFactorSentence) {
        text += `\n      **종합평가** ${merged.riskFactorSentence}\n`;
      }
    });
  });

  return text;
}

function genWristBurdenSection(calc) {
  const wristLines = ['\n< 손목/손가락 >'];
  if (calc.noEvaluableJobs) return `${wristLines[0]}\n${NO_EVALUABLE_JOBS_NOTE}\n`;

  if (calc.missingCommonFields?.length) {
    wristLines.push(`- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}`);
  }

  const wristTemporalFlags = calc.temporalFlagItems || [];
  if (wristTemporalFlags.length > 0) {
    wristLines.push(`- 공통 시간적 선후관계 ${wristTemporalFlags.map(flag => flag.label).join(', ')}`);
  }

  (calc.jobSummaries || []).forEach((jobSummary, index) => {
    wristLines.push(`- 직력${index + 1}: ${jobSummary.jobName || '-'}`);
    const groups = groupWristSummaries(jobSummary.diagnosisSummaries || []);
    groups.forEach(group => {
      const merged = mergeWristGroups(group.summaries);
      const diagList = group.summaries
        .map(s => {
          const d = s.diagnosis || {};
          return `${d.code || ''} ${d.name || ''} (${getSideText(d.side)})`.trim();
        })
        .join(' / ');
      const bkLabel = group.bkType ? WRIST_BK_LABELS[group.bkType] || group.bkType : null;
      const header = bkLabel ? `[${bkLabel}] ${diagList}` : diagList;
      wristLines.push(`  - ${header}`);
      if (merged.missingFields?.length > 0) {
        wristLines.push(`    입력 누락: ${merged.missingFields.join(', ')}`);
      }
      const riskFactorText = merged.riskFactorItems?.length > 0
        ? merged.riskFactorItems.map(flag => flag.label).join(', ')
        : '확인된 위험 요인 없음';
      wristLines.push('    분석 정리:');
      wristLines.push(`      ${(merged.narrative || '').split('\n').join('\n      ')}`);
      wristLines.push(`      업무관련성 위험 요인: ${riskFactorText}`);
      if (merged.riskFactorSentence) {
        wristLines.push(`\n      **종합평가** ${merged.riskFactorSentence}`);
      }
    });
  });

  return `${wristLines.join('\n')}\n`;
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

  const jobHistory = buildJobHistoryLines(jobs);
  text += `\n[직업력]\n`;
  text += jobHistory.text;

  text += `\n[부위별 신체부담 평가]\n`;
  for (const moduleId of activeModules) {
    const moduleManifest = getModule(moduleId);
    if (!moduleManifest?.computeCalc) continue;
    const calc = moduleManifest.computeCalc({
      shared,
      module: modules[moduleId] || {},
    });

    // P2-60 ~ P2-63: 옮긴 모듈은 매니페스트 narrative가 블록을 만든다(서술 없는 모듈은 건너뛴다).
    if (['knee', 'shoulder', 'spine', 'cervical'].includes(moduleId) && moduleManifest.narrative) {
      text += moduleManifest.narrative.render('report', calc, { jobNumberingByJobId: jobHistory.numberingByJobId });
    }
    if (moduleId === 'wrist') text += genWristBurdenSection(calc);
    if (moduleId === 'elbow') text += genElbowBurdenSection(calc);
  }

  text += `\n[업무관련성 평가 결과]\n`;
  if (shared.reportOptions?.groupAssessmentResults) {
    text += `\n${formatGroupedAssessment(diagnoses, activeModules)}\n`;
  } else {
    text += buildAssessmentBlocks(diagnoses, activeModules, { reasonIndent: '  ' })
      .map(block => `\n${block}\n`)
      .join('');
  }

  const returnConsiderations = selectModuleNote(modules, activeModules);

  if (returnConsiderations) {
    text += `\n[특이 사항 메모]\n${returnConsiderations}\n`;
  }

  text += `\n${'-'.repeat(50)}\n${shared.evaluationDate || '-'}\n${shared.hospitalName || '-'} ${shared.department || ''}\n담당의 ${shared.doctorName || '-'}`;

  return text;
}
