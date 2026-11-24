// 경추 서술 — 소견서 블록 · EMR b6·b8 공용 블록(P2-62, Phase 2 C7-a).
// src/core/utils/reportGenerator.js·emrReport.js에서 문구를 바꾸지 않고 그대로 옮겼다. 소견서는 '확인된 부담 지표 없음'·
// flag.label, EMR은 '확인된 부담 요인 없음'·flag.label || flag.key로 서로 다르다(문구 통일은 게이트 C, P2-66).
// EMR b8은 b6과 같은 블록이다(이미 작업당 한 줄인 요약 형태).
// 변형마다 달라지는 문구는 CERVICAL_PHRASES(narrative.phrases — 문구 차이 표의 원본, P2-65a)에서 꺼내 쓴다.
import type { ModuleNarrative, NarrativePhrases, NarrativeVariant } from '../../core/modules/manifest';
import { fillPhrase } from '../../core/narrative/phrases';
import { NO_EVALUABLE_JOBS_NOTE } from '../../core/utils/jobHistory';

interface CervicalFlag {
  key?: string;
  label?: string;
}

/** 직력별 요약(computeCervicalCalc의 jobSummaries 원소 중 쓰는 것만). */
interface CervicalJobSummary {
  jobName?: string;
  flagItems: CervicalFlag[];
  missingFields: string[];
  narrative: string;
  conclusionText?: string;
}

/** 서술이 읽는 computeCervicalCalc 결과(필요한 필드만). */
interface CervicalNarrativeCalc {
  jobSummaries?: CervicalJobSummary[];
  overallConclusionText?: string;
  noEvaluableJobs?: boolean;
}

/** 변형별 문구. b8은 b6과 같은 블록을 쓰므로 emrSummary 값은 emrSection과 같다. {n} = 직력 번호, {name} = 직종명. */
const CERVICAL_PHRASES = {
  heading: { report: '\n< 경추(목) >\n', emrSection: '\n<경추(목)>\n', emrSummary: '\n<경추(목)>\n' },
  jobLine: { report: '- 직력{n}: {name}\n', emrSection: '- {name}\n', emrSummary: '- {name}\n' },
  flagsLabel: { report: '      확인된 목 부위 부담 지표: ', emrSection: '  부담 요인: ', emrSummary: '  부담 요인: ' },
  noFlags: { report: '확인된 부담 지표 없음', emrSection: '확인된 부담 요인 없음', emrSummary: '확인된 부담 요인 없음' },
} as const satisfies NarrativePhrases;

const P = CERVICAL_PHRASES;

// reportGenerator.js genCervicalBurdenSection — 소견서 블록.
function genCervicalBurdenSection(calc: CervicalNarrativeCalc): string {
  let text: string = P.heading.report;
  if (calc.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  (calc.jobSummaries || []).forEach((jobSummary, index) => {
    text += fillPhrase(P.jobLine.report, { n: index + 1, name: jobSummary.jobName || '-' });
    const burdenIndicatorText = jobSummary.flagItems?.length > 0
      ? jobSummary.flagItems.map(flag => flag.label).join(', ')
      : P.noFlags.report;

    if (jobSummary.missingFields.length > 0) {
      text += `    입력 누락: ${jobSummary.missingFields.join(', ')}\n`;
    }
    text += '    분석 정리:\n';
    text += `      ${jobSummary.narrative.split('\n').join('\n      ')}\n`;
    text += `${P.flagsLabel.report}${burdenIndicatorText}\n`;
    text += `      ** 종합평가 : ${jobSummary.conclusionText}\n`;
  });

  if ((calc.jobSummaries || []).length > 1 && calc.overallConclusionText) {
    text += `\n  ** 최종 종합평가 (전체 직업 노출 합산 기준): ${calc.overallConclusionText}\n`;
  }

  return text;
}

// emrReport.js buildCervicalExposureText — EMR b6·b8 공용 블록.
function buildCervicalExposureText(calc: CervicalNarrativeCalc | undefined): string {
  let text: string = P.heading.emrSection;
  if (calc?.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  (calc?.jobSummaries || []).forEach(jobSummary => {
    text += fillPhrase(P.jobLine.emrSection, { name: jobSummary.jobName || '-' });
    const burdenIndicatorText = jobSummary.flagItems?.length > 0
      ? jobSummary.flagItems.map(flag => flag.label || flag.key).join(', ')
      : P.noFlags.emrSection;
    text += `${P.flagsLabel.emrSection}${burdenIndicatorText}\n`;
  });

  return text;
}

export const cervicalNarrative: ModuleNarrative = {
  emrOrder: 50,
  render(variant: NarrativeVariant, calc: unknown): string {
    const cervicalCalc = calc as CervicalNarrativeCalc | undefined;
    if (variant === 'report') return genCervicalBurdenSection(cervicalCalc as CervicalNarrativeCalc);
    return buildCervicalExposureText(cervicalCalc);
  },
  phrases: CERVICAL_PHRASES,
};
