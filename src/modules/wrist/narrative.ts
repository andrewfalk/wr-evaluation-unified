// 손목/손가락 서술 — 소견서 블록 · EMR b6 블록 · EMR b8 요약(P2-63, Phase 2 C7-a).
// src/core/utils/reportGenerator.js·emrReport.js에서 문구를 바꾸지 않고 그대로 옮겼다. 소견서의 콜론 없는
// `- 공통 시간적 선후관계 …`와 '업무관련성 위험 요인'(EMR은 '업무에 포함된 위험 요인')도 그대로다 — 문구 통일은 게이트 C(P2-66).
// 변형마다 달라지는 문구는 WRIST_PHRASES(narrative.phrases — 문구 차이 표의 원본, P2-65a)에서 꺼내 쓴다.
import type { DiagnosisSummary, WristCalcResult } from '@wr/analytics-core/modules/wrist/index';
import type { ModuleNarrative, NarrativePhrases, NarrativeVariant } from '../../core/modules/manifest';
import { getSideText } from '../../core/i18n/sideLabels';
import { fillPhrase } from '../../core/narrative/phrases';
import { NO_EVALUABLE_JOBS_NOTE } from '../../core/utils/jobHistory';
import { groupSummariesByBkType as groupWristSummaries, mergeBkGroupSummaries as mergeWristGroups } from './utils/calculations';
import { BK_TYPE_LABELS as WRIST_BK_LABELS } from './utils/data';

type WristDiagnosisOfSummary = Partial<DiagnosisSummary['diagnosis']>;

/**
 * 변형별 문구. {n} = 직력 번호, {name} = 직종명(빈 값이면 jobNameEmpty). 소견서는 줄 목록을 '\n'으로 이어 붙이므로
 * 소견서 값에는 줄 끝 '\n'이 없다(머리글·직력 줄).
 */
const WRIST_PHRASES = {
  heading: { report: '\n< 손목/손가락 >', emrSection: '\n<손목/손가락>\n', emrSummary: '\n<손목/손가락>\n' },
  temporalFlagsLead: { report: '- 공통 시간적 선후관계 ', emrSection: '- 공통 시간적 선후관계: ' },
  jobLine: { report: '- 직력{n}: {name}', emrSection: '- {name}\n', emrSummary: '\n[{name}]\n' },
  jobNameEmpty: { report: '-', emrSection: '-', emrSummary: '직업 미입력' },
  narrativeEmpty: { report: '', emrSection: '-' },
  riskFactorLabel: { report: '      업무관련성 위험 요인: ', emrSection: '      업무에 포함된 위험 요인: ' },
  conclusionLead: { report: '\n      **종합평가** ', emrSection: '\n      **종합평가** ', emrSummary: '    **종합평가** ' },
} as const satisfies NarrativePhrases;

const P = WRIST_PHRASES;

// reportGenerator.js genWristBurdenSection — 소견서 블록.
function genWristBurdenSection(calc: WristCalcResult): string {
  const wristLines: string[] = [P.heading.report];
  if (calc.noEvaluableJobs) return `${wristLines[0]}\n${NO_EVALUABLE_JOBS_NOTE}\n`;

  if (calc.missingCommonFields?.length) {
    wristLines.push(`- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}`);
  }

  const wristTemporalFlags = calc.temporalFlagItems || [];
  if (wristTemporalFlags.length > 0) {
    wristLines.push(`${P.temporalFlagsLead.report}${wristTemporalFlags.map(flag => flag.label).join(', ')}`);
  }

  (calc.jobSummaries || []).forEach((jobSummary, index) => {
    wristLines.push(fillPhrase(P.jobLine.report, { n: index + 1, name: jobSummary.jobName || P.jobNameEmpty.report }));
    const groups = groupWristSummaries(jobSummary.diagnosisSummaries || []);
    groups.forEach(group => {
      const merged = mergeWristGroups(group.summaries);
      const diagList = group.summaries
        .map(s => {
          const d: WristDiagnosisOfSummary = s.diagnosis || {};
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
      wristLines.push(`      ${(merged.narrative || P.narrativeEmpty.report).split('\n').join('\n      ')}`);
      wristLines.push(`${P.riskFactorLabel.report}${riskFactorText}`);
      if (merged.riskFactorSentence) {
        wristLines.push(`${P.conclusionLead.report}${merged.riskFactorSentence}`);
      }
    });
  });

  return `${wristLines.join('\n')}\n`;
}

// emrReport.js buildExposureSection의 손목 블록 — EMR 4번 칸(b6).
function buildWristExposureSection(calc: WristCalcResult): string {
  let text = '';
  text += P.heading.emrSection;
  if (calc?.noEvaluableJobs) {
    text += `${NO_EVALUABLE_JOBS_NOTE}\n`;
  } else {
    if (calc?.missingCommonFields?.length) {
      text += `- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}\n`;
    }
    if (calc?.temporalFlagItems?.length > 0) {
      text += `${P.temporalFlagsLead.emrSection}${calc.temporalFlagItems.map(flag => flag.label).join(', ')}\n`;
    }
    (calc?.jobSummaries || []).forEach(jobSummary => {
      text += fillPhrase(P.jobLine.emrSection, { name: jobSummary.jobName || P.jobNameEmpty.emrSection });
      const wristGroups = groupWristSummaries(jobSummary.diagnosisSummaries || []);
      wristGroups.forEach(group => {
        const merged = mergeWristGroups(group.summaries);
        const diagList = group.summaries
          .map(s => {
            const d: WristDiagnosisOfSummary = s.diagnosis || {};
            return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
          })
          .join(' / ');
        const bkLabel = group.bkType ? WRIST_BK_LABELS[group.bkType] || group.bkType : null;
        const header = bkLabel ? `[${bkLabel}] ${diagList}` : diagList;
        text += `  - ${header}\n`;
        if (merged.missingFields?.length > 0) {
          text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
        }
        const riskFactorText = merged.riskFactorItems?.length > 0
          ? merged.riskFactorItems.map(flag => flag.label).join(', ')
          : '확인된 위험 요인 없음';
        text += `    분석 정리:\n`;
        text += `      ${(merged.narrative || P.narrativeEmpty.emrSection).split('\n').join('\n      ')}\n`;
        text += `${P.riskFactorLabel.emrSection}${riskFactorText}\n`;
        if (merged.riskFactorSentence) {
          text += `${P.conclusionLead.emrSection}${merged.riskFactorSentence}\n`;
        }
      });
    });
  }
  return text;
}

// emrReport.js buildExposureSummary의 손목 블록 — EMR 6번 칸(b8) 요약. 상병이 없는 직력은 줄을 만들지 않는다.
function buildWristExposureSummary(calc: WristCalcResult): string {
  let text = '';
  text += P.heading.emrSummary;
  if (calc?.noEvaluableJobs) {
    text += `${NO_EVALUABLE_JOBS_NOTE}\n`;
  } else {
    (calc?.jobSummaries || []).forEach(jobSummary => {
      const wristGroups = groupWristSummaries(jobSummary.diagnosisSummaries || []);
      if (wristGroups.length === 0) return;
      text += fillPhrase(P.jobLine.emrSummary, { name: jobSummary.jobName || P.jobNameEmpty.emrSummary });
      wristGroups.forEach(group => {
        const merged = mergeWristGroups(group.summaries);
        const diagList = group.summaries
          .map(s => {
            const d: WristDiagnosisOfSummary = s.diagnosis || {};
            return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
          })
          .join(' / ');
        const bkLabel = group.bkType ? WRIST_BK_LABELS[group.bkType] || group.bkType : null;
        const header = bkLabel ? `[${bkLabel}] ${diagList}` : diagList;
        text += `  - ${header}\n`;
        if (merged.missingFields?.length > 0) {
          text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
        }
        if (merged.riskFactorSentence) {
          text += `${P.conclusionLead.emrSummary}${merged.riskFactorSentence}\n`;
        }
      });
    });
  }
  return text;
}

export const wristNarrative: ModuleNarrative = {
  render(variant: NarrativeVariant, calc: unknown): string {
    const wristCalc = calc as WristCalcResult;
    if (variant === 'report') return genWristBurdenSection(wristCalc);
    if (variant === 'emrSection') return buildWristExposureSection(wristCalc);
    return buildWristExposureSummary(wristCalc);
  },
  phrases: WRIST_PHRASES,
};
