// 어깨 서술 — 소견서 블록과 [직력별 기여] · EMR b6 블록 · EMR b8 요약(P2-61b, Phase 2 C7-a).
// src/core/utils/reportGenerator.js·emrReport.js에서 문구를 바꾸지 않고 그대로 옮겼다(반올림하지 않은 하루 시간,
// 값이 없을 때의 `?.` 유무까지). 해석 판정은 analytics-core의 classifyBk2117Interpretation(P2-61a)이다.
// 변형마다 달라지는 문구는 SHOULDER_PHRASES(narrative.phrases — 문구 차이 표의 원본, P2-65a)에서 꺼내 쓴다.
import { classifyBk2117Interpretation } from '@wr/analytics-core/modules/shoulder/index';
import type { ModuleNarrative, NarrativeContext, NarrativePhrases, NarrativeVariant } from '../../core/modules/manifest';
import { fillPhrase } from '../../core/narrative/phrases';
import { NO_EVALUABLE_JOBS_NOTE, resolveJobNumber } from '../../core/utils/jobHistory';

/** 노출 항목별 합계(computeShoulderCalc의 totals 원소 중 쓰는 것만). */
interface ShoulderTotal {
  label: string;
  totalHours: number;
  limit: number;
  ratio: number;
  exceeded: boolean;
}

/** 직력별 노출(computeShoulderCalc의 jobBurdens 원소 중 쓰는 것만). */
interface ShoulderJobBurden {
  id?: string;
  jobName?: string;
  periodYears: number;
  exposures?: Array<{ label: string; dailyHours: number; cumulativeHours: number }>;
}

/** 서술이 읽는 computeShoulderCalc 결과(필요한 필드만). */
interface ShoulderNarrativeCalc {
  totals?: ShoulderTotal[];
  jobBurdens?: ShoulderJobBurden[];
  noEvaluableJobs?: boolean;
}

type JobNumbering = NarrativeContext['jobNumberingByJobId'];

/** 변형별 문구. 해석 문장 세 가지는 지금 세 변형이 같다({labels} = 기준을 넘은 항목). */
const SHOULDER_PHRASES = {
  heading: { report: '\n< 어깨(견관절) >\n', emrSection: '\n<어깨(견관절)>\n', emrSummary: '\n<어깨(견관절)>\n' },
  /** 해석 문장 앞 */
  interpretationLead: { report: '\n', emrSection: '\n', emrSummary: '' },
  interpretationExceeded: {
    report: '** {labels} 기준을 초과하여 누적 신체부담은 충분함.',
    emrSection: '** {labels} 기준을 초과하여 누적 신체부담은 충분함.',
    emrSummary: '** {labels} 기준을 초과하여 누적 신체부담은 충분함.',
  },
  interpretationCombined: {
    report: '** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.',
    emrSection: '** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.',
    emrSummary: '** 개별 기준 초과 항목은 없으나, 복합 노출을 고려하여 누적 신체부담은 충분함.',
  },
  interpretationInsufficient: {
    report: '** 노출 기준치에 미달하여 누적 신체부담 불충분함.',
    emrSection: '** 노출 기준치에 미달하여 누적 신체부담 불충분함.',
    emrSummary: '** 노출 기준치에 미달하여 누적 신체부담 불충분함.',
  },
} as const satisfies NarrativePhrases;

const P = SHOULDER_PHRASES;

// reportGenerator.js getShoulderInterpretation — 소견서의 해석 문장.
function getShoulderInterpretation(totals: ShoulderTotal[] | undefined): string {
  const { kind, exceededLabels } = classifyBk2117Interpretation(totals);
  if (kind === 'exceeded') {
    const names = exceededLabels.join(', ');
    return fillPhrase(P.interpretationExceeded.report, { labels: names });
  }
  if (kind === 'combinedSufficient') {
    return P.interpretationCombined.report;
  }
  return P.interpretationInsufficient.report;
}

// reportGenerator.js genShoulderBurdenSection — 소견서 블록.
// jobNumbering: 미포함 직력이 있을 때만 전달되는 jobId → 직업력 번호 맵(jobHistory.js). 이 블록은 직종명이 빈
// 직력을 뺀 뒤 번호를 다시 매기므로, 맵이 있으면 [직업력] 목록과 같은 번호를 쓴다.
function genShoulderBurdenSection(calc: ShoulderNarrativeCalc, jobNumbering: JobNumbering = null): string {
  const { totals, jobBurdens } = calc;
  let text: string = P.heading.report;
  if (calc.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;
  text += `독일의 산재보험 번호 BK2117 장기간의 집중적인 기계적 부하로 인한 어깨 회전근개 병변에 사용하는 어깨 부담 평가 지침을 이용하여 평가하였음.\n\n`;

  (totals || []).forEach(total => {
    const pct = total.totalHours > 0 ? `${(total.ratio * 100).toFixed(0)}%` : '';
    const exceeded = total.exceeded ? ' [초과]' : '';
    text += `- ${total.label}: ${total.totalHours > 0 ? `${total.totalHours.toFixed(1)}시간` : '-'} (기준 ${total.limit.toLocaleString()}시간${pct ? ` / ${pct}` : ''}${exceeded})\n`;
  });

  text += `${P.interpretationLead.report}${getShoulderInterpretation(totals)}\n`;

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

// emrReport.js buildExposureSection의 어깨 블록 — EMR 4번 칸(b6).
function buildShoulderExposureSection(calc: ShoulderNarrativeCalc | undefined): string {
  let text = '';
  text += P.heading.emrSection;
  if (calc?.noEvaluableJobs) {
    text += `${NO_EVALUABLE_JOBS_NOTE}\n`;
  } else {
    text += '독일의 산재보험 번호 BK2117 장기간의 집중적인 기계적 부하로 인한 어깨 회전근개 병변에 사용하는 어깨 부담 평가 지침을 이용하여 평가하였음.\n\n';
    const shoulderTotals = calc?.totals || [];
    shoulderTotals.forEach(total => {
      const pct = total.totalHours > 0 ? ` / ${(total.ratio * 100).toFixed(0)}%` : '';
      text += `- ${total.label}: ${total.totalHours > 0 ? `${total.totalHours.toFixed(1)}시간` : '-'} (기준 ${total.limit.toLocaleString()}시간${pct}${total.exceeded ? ' [초과]' : ''})\n`;
    });
    const { kind, exceededLabels } = classifyBk2117Interpretation(shoulderTotals);
    if (kind === 'exceeded') {
      text += `${P.interpretationLead.emrSection}${fillPhrase(P.interpretationExceeded.emrSection, { labels: exceededLabels.join(', ') })}\n`;
    } else if (kind === 'combinedSufficient') {
      text += `${P.interpretationLead.emrSection}${P.interpretationCombined.emrSection}\n`;
    } else {
      text += `${P.interpretationLead.emrSection}${P.interpretationInsufficient.emrSection}\n`;
    }
  }
  return text;
}

// emrReport.js buildExposureSummary의 어깨 블록 — EMR 6번 칸(b8) 요약. 50% 이상이거나 초과한 항목만 적는다.
function buildShoulderExposureSummary(calc: ShoulderNarrativeCalc | undefined): string {
  let text = '';
  text += P.heading.emrSummary;
  if (calc?.noEvaluableJobs) {
    text += `${NO_EVALUABLE_JOBS_NOTE}\n`;
  } else {
    const shoulderTotals = calc?.totals || [];
    shoulderTotals.filter(total => total.exceeded || total.ratio >= 0.5).forEach(total => {
      const pct = total.totalHours > 0 ? ` / ${(total.ratio * 100).toFixed(0)}%` : '';
      text += `- ${total.label}: ${total.totalHours > 0 ? `${total.totalHours.toFixed(1)}시간` : '-'} (기준 ${total.limit.toLocaleString()}시간${pct}${total.exceeded ? ' [초과]' : ''})\n`;
    });
    const { kind, exceededLabels } = classifyBk2117Interpretation(shoulderTotals);
    if (kind === 'exceeded') {
      text += `${P.interpretationLead.emrSummary}${fillPhrase(P.interpretationExceeded.emrSummary, { labels: exceededLabels.join(', ') })}\n`;
    } else if (kind === 'combinedSufficient') {
      text += `${P.interpretationLead.emrSummary}${P.interpretationCombined.emrSummary}\n`;
    } else {
      text += `${P.interpretationLead.emrSummary}${P.interpretationInsufficient.emrSummary}\n`;
    }
  }
  return text;
}

export const shoulderNarrative: ModuleNarrative = {
  emrOrder: 20,
  render(variant: NarrativeVariant, calc: unknown, context: NarrativeContext): string {
    const shoulderCalc = calc as ShoulderNarrativeCalc | undefined;
    if (variant === 'report') return genShoulderBurdenSection(shoulderCalc as ShoulderNarrativeCalc, context.jobNumberingByJobId ?? null);
    if (variant === 'emrSection') return buildShoulderExposureSection(shoulderCalc);
    return buildShoulderExposureSummary(shoulderCalc);
  },
  phrases: SHOULDER_PHRASES,
};
