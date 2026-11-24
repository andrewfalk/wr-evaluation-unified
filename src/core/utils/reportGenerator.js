import { classifyBk2117Interpretation } from '@wr/analytics-core/modules/shoulder/index';
import { getModule } from '../moduleRegistry';
import { getSideText } from '../i18n/sideLabels';
import { buildSpineSectionText } from '../../modules/spine/utils/sectionText';
import { buildAssessmentBlocks, formatGroupedAssessment } from './assessmentGroups';
import { calculateAge, calculateBMI } from './common';
import { buildJobHistoryLines, resolveJobNumber, NO_EVALUABLE_JOBS_NOTE } from './jobHistory';
import { selectModuleNote } from './moduleNotes';
import { groupSummariesByBkType as groupElbowSummaries, mergeBkGroupSummaries as mergeElbowGroups } from '../../modules/elbow/utils/calculations';
import { BK_TYPE_LABELS as ELBOW_BK_LABELS } from '../../modules/elbow/utils/data';
import { groupSummariesByBkType as groupWristSummaries, mergeBkGroupSummaries as mergeWristGroups } from '../../modules/wrist/utils/calculations';
import { BK_TYPE_LABELS as WRIST_BK_LABELS } from '../../modules/wrist/utils/data';

// BK2117 해석 문장 — 판정은 analytics-core의 classifyBk2117Interpretation(EMR·AI 입력과 같은 규칙, P2-61a).
export function getShoulderInterpretation(totals) {
  const { kind, exceededLabels } = classifyBk2117Interpretation(totals);
  if (kind === 'exceeded') {
    const names = exceededLabels.join(', ');
    return `** ${names} 기준을 초과하여 누적 신체부담은 충분함.`;
  }
  if (kind === 'combinedSufficient') {
    return `** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.`;
  }
  return `** 노출 기준치에 미달하여 누적 신체부담 불충분함.`;
}

// jobNumbering: 미포함 직력이 있을 때만 전달되는 jobId → 직업력 번호 맵(jobHistory.js). 이 블록은 직종명이 빈
// 직력을 뺀 뒤 번호를 다시 매기므로, 맵이 있으면 [직업력] 목록과 같은 번호를 쓴다.
function genShoulderBurdenSection(calc, jobNumbering = null) {
  const { totals, jobBurdens } = calc;
  let text = `\n< 어깨(견관절) >\n`;
  if (calc.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;
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
      text += `- 직력${resolveJobNumber(jobNumbering, job.id, index + 1)}: ${job.jobName} (${job.periodYears > 0 ? `${job.periodYears.toFixed(1)}년` : '-'})\n`;
      (job.exposures || []).forEach(exposure => {
        if (exposure.dailyHours > 0) {
          text += `  ${exposure.label}: ${exposure.dailyHours}시간/일, 누적 ${exposure.cumulativeHours.toFixed(1)}시간\n`;
        }
      });
    });
  }

  return text;
}

function genSpineBurdenSection(calc) {
  return buildSpineSectionText(calc);
}

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

function genCervicalBurdenSection(calc) {
  let text = `\n< 경추(목) >\n`;
  if (calc.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  (calc.jobSummaries || []).forEach((jobSummary, index) => {
    text += `- 직력${index + 1}: ${jobSummary.jobName || '-'}\n`;
    const burdenIndicatorText = jobSummary.flagItems?.length > 0
      ? jobSummary.flagItems.map(flag => flag.label).join(', ')
      : '확인된 부담 지표 없음';

    if (jobSummary.missingFields.length > 0) {
      text += `    입력 누락: ${jobSummary.missingFields.join(', ')}\n`;
    }
    text += '    분석 정리:\n';
    text += `      ${jobSummary.narrative.split('\n').join('\n      ')}\n`;
    text += `      확인된 목 부위 부담 지표: ${burdenIndicatorText}\n`;
    text += `      ** 종합평가 : ${jobSummary.conclusionText}\n`;
  });

  if ((calc.jobSummaries || []).length > 1 && calc.overallConclusionText) {
    text += `\n  ** 최종 종합평가 (전체 직업 노출 합산 기준): ${calc.overallConclusionText}\n`;
  }

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
    if (moduleId === 'knee' && moduleManifest.narrative) {
      text += moduleManifest.narrative.render('report', calc, { jobNumberingByJobId: jobHistory.numberingByJobId });
    }
    if (moduleId === 'wrist') text += genWristBurdenSection(calc);
    if (moduleId === 'shoulder') text += genShoulderBurdenSection(calc, jobHistory.numberingByJobId);
    if (moduleId === 'spine') text += genSpineBurdenSection(calc);
    if (moduleId === 'elbow') text += genElbowBurdenSection(calc);
    if (moduleId === 'cervical') text += genCervicalBurdenSection(calc);
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
