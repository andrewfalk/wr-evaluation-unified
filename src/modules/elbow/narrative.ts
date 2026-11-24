// 팔꿈치 서술 — 소견서 블록 · EMR b6 블록 · EMR b8 요약(P2-63, Phase 2 C7-a).
// src/core/utils/reportGenerator.js·emrReport.js에서 문구를 바꾸지 않고 그대로 옮겼다. 출력처마다 다른 곳(측이 빈 상병의
// `(-)` 표시 유무, narrative 빈 값 `''`/`'-'`, 직력 머리 형식)도 그대로다 — 문구 통일은 게이트 C(P2-66).
// 변형마다 달라지는 문구는 ELBOW_PHRASES(narrative.phrases — 문구 차이 표의 원본, P2-65a)에서 꺼내 쓴다.
import type { DiagnosisSummary, ElbowCalcResult } from '@wr/analytics-core/modules/elbow/index';
import type { ModuleNarrative, NarrativePhrases, NarrativeVariant } from '../../core/modules/manifest';
import { getSideText } from '../../core/i18n/sideLabels';
import { fillPhrase } from '../../core/narrative/phrases';
import { NO_EVALUABLE_JOBS_NOTE } from '../../core/utils/jobHistory';
import { groupSummariesByBkType as groupElbowSummaries, mergeBkGroupSummaries as mergeElbowGroups } from './utils/calculations';
import { BK_TYPE_LABELS as ELBOW_BK_LABELS } from './utils/data';

type ElbowDiagnosisOfSummary = Partial<DiagnosisSummary['diagnosis']>;

/** 변형별 문구. {n} = 직력 번호, {name} = 직종명(빈 값이면 jobNameEmpty). */
const ELBOW_PHRASES = {
  heading: { report: '\n< 팔꿈치(주관절) >\n', emrSection: '\n<팔꿈치(주관절)>\n', emrSummary: '\n<팔꿈치(주관절)>\n' },
  temporalFlagsLead: { report: '- 공통 시간적 선후관계: ', emrSection: '- 공통 시간적 선후관계: ' },
  jobLine: { report: '- 직력{n}: {name}\n', emrSection: '- {name}\n', emrSummary: '\n[{name}]\n' },
  jobNameEmpty: { report: '-', emrSection: '-', emrSummary: '직업 미입력' },
  narrativeEmpty: { report: '', emrSection: '-' },
  riskFactorLabel: { report: '      업무에 포함된 위험 요인: ', emrSection: '      업무에 포함된 위험 요인: ' },
  conclusionLead: { report: '\n      **종합평가** ', emrSection: '\n      **종합평가** ', emrSummary: '    **종합평가** ' },
} as const satisfies NarrativePhrases;

const P = ELBOW_PHRASES;

// reportGenerator.js genElbowBurdenSection — 소견서 블록.
function genElbowBurdenSection(calc: ElbowCalcResult): string {
  let text: string = P.heading.report;
  if (calc.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  if (calc.missingCommonFields?.length) {
    text += `- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}\n`;
  }

  const temporalFlags = calc.temporalFlagItems || [];
  if (temporalFlags.length > 0) {
    text += `${P.temporalFlagsLead.report}${temporalFlags.map(flag => flag.label).join(', ')}\n`;
  }

  (calc.jobSummaries || []).forEach((jobSummary, index) => {
    text += fillPhrase(P.jobLine.report, { n: index + 1, name: jobSummary.jobName || P.jobNameEmpty.report });
    const groups = groupElbowSummaries(jobSummary.diagnosisSummaries || []);
    groups.forEach(group => {
      const merged = mergeElbowGroups(group.summaries);
      const diagList = group.summaries
        .map(s => {
          const d: ElbowDiagnosisOfSummary = s.diagnosis || {};
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
      text += `      ${(merged.narrative || P.narrativeEmpty.report).split('\n').join('\n      ')}\n`;
      text += `${P.riskFactorLabel.report}${riskFactorText}\n`;
      if (merged.riskFactorSentence) {
        text += `${P.conclusionLead.report}${merged.riskFactorSentence}\n`;
      }
    });
  });

  return text;
}

// emrReport.js buildExposureSection의 팔꿈치 블록 — EMR 4번 칸(b6).
function buildElbowExposureSection(calc: ElbowCalcResult): string {
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
      const elbowGroups = groupElbowSummaries(jobSummary.diagnosisSummaries || []);
      elbowGroups.forEach(group => {
        const merged = mergeElbowGroups(group.summaries);
        const diagList = group.summaries
          .map(s => {
            const d: ElbowDiagnosisOfSummary = s.diagnosis || {};
            return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
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

// emrReport.js buildExposureSummary의 팔꿈치 블록 — EMR 6번 칸(b8) 요약. 상병이 없는 직력은 줄을 만들지 않는다.
function buildElbowExposureSummary(calc: ElbowCalcResult): string {
  let text = '';
  text += P.heading.emrSummary;
  if (calc?.noEvaluableJobs) {
    text += `${NO_EVALUABLE_JOBS_NOTE}\n`;
  } else {
    (calc?.jobSummaries || []).forEach(jobSummary => {
      const elbowGroups = groupElbowSummaries(jobSummary.diagnosisSummaries || []);
      if (elbowGroups.length === 0) return;
      text += fillPhrase(P.jobLine.emrSummary, { name: jobSummary.jobName || P.jobNameEmpty.emrSummary });
      elbowGroups.forEach(group => {
        const merged = mergeElbowGroups(group.summaries);
        const diagList = group.summaries
          .map(s => {
            const d: ElbowDiagnosisOfSummary = s.diagnosis || {};
            return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
          })
          .join(' / ');
        const bkLabel = group.bkType ? ELBOW_BK_LABELS[group.bkType] || group.bkType : null;
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

export const elbowNarrative: ModuleNarrative = {
  emrOrder: 40,
  render(variant: NarrativeVariant, calc: unknown): string {
    const elbowCalc = calc as ElbowCalcResult;
    if (variant === 'report') return genElbowBurdenSection(elbowCalc);
    if (variant === 'emrSection') return buildElbowExposureSection(elbowCalc);
    return buildElbowExposureSummary(elbowCalc);
  },
  phrases: ELBOW_PHRASES,
};
