// 어깨 서술 — 소견서·EMR 4번 칸(b6) 공용 전문 블록(안내문 + 5개 항목 + 해석 + [직력별 기여]) · EMR 6번 칸(b8) 요약
// (P2-61b, Phase 2 C7-a → 게이트 C P2-66b). 게이트 C에서 4번 칸을 소견서와 같게 맞췄다(ADR 0001 표 B의 B6 — 4번 칸만,
// 표 A 7행) — 두 출력처가 한 함수(buildShoulderFullSection)를 쓴다. 6번 칸은 50% 이상 항목 + 해석의 요약 그대로이고,
// 해석 앞 줄바꿈만 맞췄다(표 A 8행). 해석 판정은 analytics-core의 classifyBk2117Interpretation(P2-61a)이다.
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

/** 전문 블록을 쓰는 변형(소견서·4번 칸). */
type FullVariant = Exclude<NarrativeVariant, 'emrSummary'>;

/** 변형별 문구. 세 변형이 같은 값이다({labels} = 기준을 넘은 항목). */
const SHOULDER_PHRASES = {
  heading: { report: '\n<어깨(견관절)>\n', emrSection: '\n<어깨(견관절)>\n', emrSummary: '\n<어깨(견관절)>\n' },
  /** 해석 문장 앞 */
  interpretationLead: { report: '\n', emrSection: '\n', emrSummary: '\n' },
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

/** 해석 문장 줄(앞 줄바꿈 포함). */
function interpretationLine(totals: ShoulderTotal[], variant: NarrativeVariant): string {
  const { kind, exceededLabels } = classifyBk2117Interpretation(totals);
  let sentence: string;
  if (kind === 'exceeded') sentence = fillPhrase(P.interpretationExceeded[variant], { labels: exceededLabels.join(', ') });
  else if (kind === 'combinedSufficient') sentence = P.interpretationCombined[variant];
  else sentence = P.interpretationInsufficient[variant];
  return `${P.interpretationLead[variant]}${sentence}\n`;
}

/** 노출 항목 한 줄. */
function totalLine(total: ShoulderTotal): string {
  const pct = total.totalHours > 0 ? ` / ${(total.ratio * 100).toFixed(0)}%` : '';
  return `- ${total.label}: ${total.totalHours > 0 ? `${total.totalHours.toFixed(1)}시간` : '-'} (기준 ${total.limit.toLocaleString()}시간${pct}${total.exceeded ? ' [초과]' : ''})\n`;
}

// 하루 노출 시간은 결과 화면(ShoulderResultPanel의 직력별 기여 상세)과 같이 소수 둘째 자리까지, 끝의 0은 뗀다.
// 분 단위 입력이 시간으로 바뀌면 0.0666…처럼 끝없는 소수가 되므로 그대로 적지 않는다.
// 0보다 큰 값만 이 줄에 오므로, 반올림해 0이 되는 값은 "0시간/일" 대신 "0.01시간/일 미만"으로 적는다.
export function formatDailyHours(hours: number): string {
  const rounded = parseFloat(hours.toFixed(2));
  return rounded > 0 ? `${rounded}시간/일` : '0.01시간/일 미만';
}

// 소견서·EMR 4번 칸(b6) 공용 전문 블록.
// jobNumbering: 미포함 직력이 있을 때만 전달되는 jobId → 직업력 번호 맵(jobHistory.js). [직력별 기여]는 직종명이 빈
// 직력을 뺀 뒤 번호를 다시 매기므로, 맵이 있으면 [직업력] 목록과 같은 번호를 쓴다.
function buildShoulderFullSection(calc: ShoulderNarrativeCalc | undefined, variant: FullVariant, jobNumbering: JobNumbering = null): string {
  let text: string = P.heading[variant];
  if (calc?.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;
  text += '독일의 산재보험 번호 BK2117 장기간의 집중적인 기계적 부하로 인한 어깨 회전근개 병변에 사용하는 어깨 부담 평가 지침을 이용하여 평가하였음.\n\n';

  const totals = calc?.totals || [];
  totals.forEach(total => { text += totalLine(total); });
  text += interpretationLine(totals, variant);

  const jobsWithData = (calc?.jobBurdens || []).filter(job => job.jobName);
  if (jobsWithData.length > 1) {
    text += `\n[직력별 기여]\n`;
    jobsWithData.forEach((job, index) => {
      text += `- 직력${resolveJobNumber(jobNumbering, job.id, index + 1)}: ${job.jobName} (${job.periodYears > 0 ? `${job.periodYears.toFixed(1)}년` : '-'})\n`;
      (job.exposures || []).forEach(exposure => {
        if (exposure.dailyHours > 0) {
          text += `  ${exposure.label}: ${formatDailyHours(exposure.dailyHours)}, 누적 ${exposure.cumulativeHours.toFixed(1)}시간\n`;
        }
      });
    });
  }

  return text;
}

// EMR 6번 칸(b8) 요약. 50% 이상이거나 초과한 항목만 적는다.
function buildShoulderExposureSummary(calc: ShoulderNarrativeCalc | undefined): string {
  let text: string = P.heading.emrSummary;
  if (calc?.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;
  const totals = calc?.totals || [];
  totals.filter(total => total.exceeded || total.ratio >= 0.5).forEach(total => { text += totalLine(total); });
  text += interpretationLine(totals, 'emrSummary');
  return text;
}

export const shoulderNarrative: ModuleNarrative = {
  render(variant: NarrativeVariant, calc: unknown, context: NarrativeContext): string {
    const shoulderCalc = calc as ShoulderNarrativeCalc | undefined;
    if (variant === 'emrSummary') return buildShoulderExposureSummary(shoulderCalc);
    return buildShoulderFullSection(shoulderCalc, variant, context.jobNumberingByJobId ?? null);
  },
  phrases: SHOULDER_PHRASES,
};
