// 경추 서술 — 소견서·EMR 4번 칸(b6) 공용 전문 블록 · EMR 6번 칸(b8) 직력당 한 줄 요약(P2-62, Phase 2 C7-a → 게이트 C P2-66c).
// 게이트 C에서 4번 칸을 소견서 전문으로 맞췄다(ADR 0001 표 B의 B9 — 4번 칸만) — 두 출력처가 한 함수(buildCervicalFullSection)를
// 쓴다. 6번 칸은 직력당 부담 요인 한 줄 요약 그대로다. 문구는 표 A 21~24행(23행은 낱말만 — 전문은 6칸 들여쓰기, 요약은
// 2칸), 부담 지표 이름이 없으면 키(B10). 직력 번호는 세 변형 모두 jobSummaries 순번이다([직업력] 번호와 같다).
// 변형마다 달라지는 문구는 CERVICAL_PHRASES(narrative.phrases — 문구 차이 표의 원본, P2-65a)에서 꺼내 쓴다.
import type { ModuleNarrative, NarrativePhrases, NarrativeVariant } from '../../core/modules/manifest';
import { fillPhrase, OUTPUT_EMPTY_JOB_NAME } from '../../core/narrative/phrases';
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

/** 전문 블록을 쓰는 변형(소견서·4번 칸). */
type FullVariant = Exclude<NarrativeVariant, 'emrSummary'>;

/** 변형별 문구. {n} = 직력 번호, {name} = 직종명(빈 값이면 jobNameEmpty — P2-72h, 결정 5: 전에는 `-`). */
const CERVICAL_PHRASES = {
  heading: { report: '\n<경추(목)>\n', emrSection: '\n<경추(목)>\n', emrSummary: '\n<경추(목)>\n' },
  jobLine: { report: '- 직력{n}: {name}\n', emrSection: '- 직력{n}: {name}\n', emrSummary: '- 직력{n}: {name}\n' },
  jobNameEmpty: { report: OUTPUT_EMPTY_JOB_NAME, emrSection: OUTPUT_EMPTY_JOB_NAME, emrSummary: OUTPUT_EMPTY_JOB_NAME },
  /** 전문은 6칸 들여쓰기, 요약은 2칸(표 A 23행 — 낱말만 맞춤) */
  flagsLabel: { report: '      부담 요인: ', emrSection: '      부담 요인: ', emrSummary: '  부담 요인: ' },
  noFlags: { report: '확인된 부담 요인 없음', emrSection: '확인된 부담 요인 없음', emrSummary: '확인된 부담 요인 없음' },
} as const satisfies NarrativePhrases;

const P = CERVICAL_PHRASES;

/** 직력의 부담 지표 이름 목록(이름이 없으면 키 — B10). */
function flagsText(jobSummary: CervicalJobSummary, variant: NarrativeVariant): string {
  return jobSummary.flagItems?.length > 0
    ? jobSummary.flagItems.map(flag => flag.label || flag.key).join(', ')
    : P.noFlags[variant];
}

// 소견서·EMR 4번 칸(b6) 공용 전문 블록 — 직력별 입력 누락·분석 정리·부담 요인·종합평가 + 직력 2개 이상이면 최종 종합평가.
function buildCervicalFullSection(calc: CervicalNarrativeCalc | undefined, variant: FullVariant): string {
  let text: string = P.heading[variant];
  if (calc?.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  const jobSummaries = calc?.jobSummaries || [];
  jobSummaries.forEach((jobSummary, index) => {
    text += fillPhrase(P.jobLine[variant], { n: index + 1, name: jobSummary.jobName || P.jobNameEmpty[variant] });
    if (jobSummary.missingFields.length > 0) {
      text += `    입력 누락: ${jobSummary.missingFields.join(', ')}\n`;
    }
    text += '    분석 정리:\n';
    text += `      ${jobSummary.narrative.split('\n').join('\n      ')}\n`;
    text += `${P.flagsLabel[variant]}${flagsText(jobSummary, variant)}\n`;
    text += `      ** 종합평가 : ${jobSummary.conclusionText}\n`;
  });

  if (jobSummaries.length > 1 && calc?.overallConclusionText) {
    text += `\n  ** 최종 종합평가 (전체 직업 노출 합산 기준): ${calc.overallConclusionText}\n`;
  }

  return text;
}

// EMR 6번 칸(b8) 요약 — 직력당 부담 요인 한 줄.
function buildCervicalExposureSummary(calc: CervicalNarrativeCalc | undefined): string {
  let text: string = P.heading.emrSummary;
  if (calc?.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  (calc?.jobSummaries || []).forEach((jobSummary, index) => {
    text += fillPhrase(P.jobLine.emrSummary, { n: index + 1, name: jobSummary.jobName || P.jobNameEmpty.emrSummary });
    text += `${P.flagsLabel.emrSummary}${flagsText(jobSummary, 'emrSummary')}\n`;
  });

  return text;
}

export const cervicalNarrative: ModuleNarrative = {
  render(variant: NarrativeVariant, calc: unknown): string {
    const cervicalCalc = calc as CervicalNarrativeCalc | undefined;
    if (variant === 'emrSummary') return buildCervicalExposureSummary(cervicalCalc);
    return buildCervicalFullSection(cervicalCalc, variant);
  },
  phrases: CERVICAL_PHRASES,
};
