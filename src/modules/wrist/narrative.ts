// 손목/손가락 서술 — 소견서·EMR 4번 칸(b6) 공용 전문 블록 · EMR 6번 칸(b8) 요약(P2-63, Phase 2 C7-a → 게이트 C P2-66d).
// 게이트 C에서 소견서와 4번 칸을 맞췄다(ADR 0001 표 A 9~12·14행, 표 B의 B7·B8 — 4번 칸만) — 두 출력처가 한 함수
// (buildWristFullSection)를 쓰고, 분석 정리가 빈 값일 때의 표기(narrativeEmpty — 표 A 13행 유지)만 다르다. 소견서는 줄 목록
// join 대신 이어 붙이기로 바꿨다(팔꿈치와 같은 방식). 6번 칸은 요약 구조 그대로이고 직력 줄·종합평가 줄 문구만 맞췄다
// (표 A 11·12·15행). 직력 번호는 세 변형 모두 jobSummaries 순번이다([직업력] 번호와 같다).
// 변형마다 달라지는 문구는 WRIST_PHRASES(narrative.phrases — 문구 차이 표의 원본, P2-65a)에서 꺼내 쓴다.
import type { DiagnosisSummary, WristCalcResult } from '@wr/analytics-core/modules/wrist/index';
import type { ModuleNarrative, NarrativePhrases, NarrativeVariant } from '../../core/modules/manifest';
import { getSideText } from '../../core/i18n/sideLabels';
import { fillPhrase } from '../../core/narrative/phrases';
import { NO_EVALUABLE_JOBS_NOTE } from '../../core/utils/jobHistory';
import { groupSummariesByBkType as groupWristSummaries, mergeBkGroupSummaries as mergeWristGroups } from './utils/calculations';
import { BK_TYPE_LABELS as WRIST_BK_LABELS } from './utils/data';

type WristDiagnosisOfSummary = Partial<DiagnosisSummary['diagnosis']>;
type WristGroup = ReturnType<typeof groupWristSummaries>[number];

/** 전문 블록을 쓰는 변형(소견서·4번 칸). */
type FullVariant = Exclude<NarrativeVariant, 'emrSummary'>;

/** 변형별 문구. {n} = 직력 번호, {name} = 직종명(빈 값이면 jobNameEmpty). */
const WRIST_PHRASES = {
  heading: { report: '\n<손목/손가락>\n', emrSection: '\n<손목/손가락>\n', emrSummary: '\n<손목/손가락>\n' },
  temporalFlagsLead: { report: '- 공통 시간적 선후관계: ', emrSection: '- 공통 시간적 선후관계: ' },
  jobLine: { report: '- 직력{n}: {name}\n', emrSection: '- 직력{n}: {name}\n', emrSummary: '- 직력{n}: {name}\n' },
  jobNameEmpty: { report: '직업 미입력', emrSection: '직업 미입력', emrSummary: '직업 미입력' },
  narrativeEmpty: { report: '', emrSection: '-' },
  riskFactorLabel: { report: '      업무에 포함된 위험 요인: ', emrSection: '      업무에 포함된 위험 요인: ' },
  conclusionLead: { report: '\n      **종합평가** ', emrSection: '\n      **종합평가** ', emrSummary: '\n      **종합평가** ' },
} as const satisfies NarrativePhrases;

const P = WRIST_PHRASES;

/** 상병 그룹 머리 줄(`  - [BK] 코드 이름 (측) / …`). 측이 없으면 괄호를 붙이지 않는다(B7). */
function groupHeaderLine(group: WristGroup): string {
  const diagList = group.summaries
    .map(s => {
      const d: WristDiagnosisOfSummary = s.diagnosis || {};
      return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
    })
    .join(' / ');
  const bkLabel = group.bkType ? WRIST_BK_LABELS[group.bkType] || group.bkType : null;
  return `  - ${bkLabel ? `[${bkLabel}] ${diagList}` : diagList}\n`;
}

// 소견서·EMR 4번 칸(b6) 공용 전문 블록 — 직력 줄 + 상병 그룹별 입력 누락·분석 정리·위험 요인·종합평가(B8).
function buildWristFullSection(calc: WristCalcResult, variant: FullVariant): string {
  let text: string = P.heading[variant];
  if (calc?.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  if (calc?.missingCommonFields?.length) {
    text += `- 공통 시간적 선후관계 누락: ${calc.missingCommonFields.join(', ')}\n`;
  }
  const temporalFlags = calc?.temporalFlagItems || [];
  if (temporalFlags.length > 0) {
    text += `${P.temporalFlagsLead[variant]}${temporalFlags.map(flag => flag.label).join(', ')}\n`;
  }

  (calc?.jobSummaries || []).forEach((jobSummary, index) => {
    text += fillPhrase(P.jobLine[variant], { n: index + 1, name: jobSummary.jobName || P.jobNameEmpty[variant] });
    groupWristSummaries(jobSummary.diagnosisSummaries || []).forEach(group => {
      const merged = mergeWristGroups(group.summaries);
      text += groupHeaderLine(group);
      if (merged.missingFields?.length > 0) {
        text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
      }
      const riskFactorText = merged.riskFactorItems?.length > 0
        ? merged.riskFactorItems.map(flag => flag.label).join(', ')
        : '확인된 위험 요인 없음';
      text += '    분석 정리:\n';
      text += `      ${(merged.narrative || P.narrativeEmpty[variant]).split('\n').join('\n      ')}\n`;
      text += `${P.riskFactorLabel[variant]}${riskFactorText}\n`;
      if (merged.riskFactorSentence) {
        text += `${P.conclusionLead[variant]}${merged.riskFactorSentence}\n`;
      }
    });
  });

  return text;
}

// EMR 6번 칸(b8) 요약. 상병이 없는 직력은 줄을 만들지 않는다. 입력 누락·종합평가만(분석 정리·위험 요인 없음).
function buildWristExposureSummary(calc: WristCalcResult): string {
  let text: string = P.heading.emrSummary;
  if (calc?.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

  (calc?.jobSummaries || []).forEach((jobSummary, index) => {
    const groups = groupWristSummaries(jobSummary.diagnosisSummaries || []);
    if (groups.length === 0) return;
    text += fillPhrase(P.jobLine.emrSummary, { n: index + 1, name: jobSummary.jobName || P.jobNameEmpty.emrSummary });
    groups.forEach(group => {
      const merged = mergeWristGroups(group.summaries);
      text += groupHeaderLine(group);
      if (merged.missingFields?.length > 0) {
        text += `    입력 누락: ${merged.missingFields.join(', ')}\n`;
      }
      if (merged.riskFactorSentence) {
        text += `${P.conclusionLead.emrSummary}${merged.riskFactorSentence}\n`;
      }
    });
  });

  return text;
}

export const wristNarrative: ModuleNarrative = {
  render(variant: NarrativeVariant, calc: unknown): string {
    const wristCalc = calc as WristCalcResult;
    if (variant === 'emrSummary') return buildWristExposureSummary(wristCalc);
    return buildWristFullSection(wristCalc, variant);
  },
  phrases: WRIST_PHRASES,
};
