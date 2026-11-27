// 팔꿈치·손목 공용 서술 빌더(REFACTORING_ROADMAP Phase 2 C8, P2-70c) — 소견서·EMR 4번 칸(b6) 공용 전문 블록 · EMR 6번 칸(b8) 요약.
// 두 모듈의 narrative.ts는 머리 문자열 한 줄만 다른 같은 코드였다(게이트 C P2-66d에서 두 출력처를 한 함수로 맞춘 그대로).
// 모듈마다 다른 것은 config로 받는다: 머리 문자열, BK 유형 라벨, 상병 요약 묶기·합치기 함수(모듈 계산의 것).
//   · 두 출력처가 한 함수(buildFullSection)를 쓰고, 분석 정리가 빈 값일 때의 표기(narrativeEmpty — ADR 0001 표 A 유지)만 다르다.
//   · 6번 칸은 요약 구조 그대로이고 직력 줄·종합평가 줄 문구만 맞췄다. 직력 번호는 세 변형 모두 jobSummaries 순번이다
//     ([직업력] 번호와 같다).
// 변형마다 달라지는 문구는 phrases(narrative.phrases — 문구 차이 표의 원본, P2-65a)에서 꺼내 쓴다.
import type { ModuleNarrative, NarrativePhrases, NarrativeVariant } from '../../../core/modules/manifest';
import { getSideText } from '../../../core/i18n/sideLabels';
import { fillPhrase, OUTPUT_EMPTY_JOB_NAME } from '../../../core/narrative/phrases';
import { NO_EVALUABLE_JOBS_NOTE } from '../../../core/utils/jobHistory';

/** 서술이 읽는 상병 요약(모듈 계산의 DiagnosisSummary·합친 그룹 요약)의 모양. */
export interface UpperLimbNarrativeSummary {
  diagnosis?: { code?: string; name?: string; side?: string };
  missingFields: string[];
  riskFactorItems: Array<{ label: string }>;
  narrative: string;
  riskFactorSentence: string;
}

/** 서술이 읽는 계산 결과의 모양. */
export interface UpperLimbNarrativeCalc<S extends UpperLimbNarrativeSummary> {
  noEvaluableJobs: boolean;
  missingCommonFields: string[];
  temporalFlagItems: Array<{ label: string }>;
  jobSummaries: Array<{ jobName: string; diagnosisSummaries: S[] }>;
}

export interface UpperLimbNarrativeConfig<S extends UpperLimbNarrativeSummary> {
  /** 블록 머리(세 변형 같다), 예: '\n<팔꿈치(주관절)>\n'. */
  heading: string;
  bkLabels: Record<string, string>;
  groupSummaries(summaries: S[]): Array<{ bkType: string; summaries: S[] }>;
  mergeGroups(summaries: S[]): S;
}

/** 전문 블록을 쓰는 변형(소견서·4번 칸). */
type FullVariant = Exclude<NarrativeVariant, 'emrSummary'>;

/** 변형별 문구. {n} = 직력 번호, {name} = 직종명(빈 값이면 jobNameEmpty). heading만 모듈마다 다르다. */
function upperLimbPhrases(heading: string) {
  return {
    heading: { report: heading, emrSection: heading, emrSummary: heading },
    temporalFlagsLead: { report: '- 공통 시간적 선후관계: ', emrSection: '- 공통 시간적 선후관계: ' },
    jobLine: { report: '- 직력{n}: {name}\n', emrSection: '- 직력{n}: {name}\n', emrSummary: '- 직력{n}: {name}\n' },
    jobNameEmpty: { report: OUTPUT_EMPTY_JOB_NAME, emrSection: OUTPUT_EMPTY_JOB_NAME, emrSummary: OUTPUT_EMPTY_JOB_NAME },
    narrativeEmpty: { report: '', emrSection: '-' },
    riskFactorLabel: { report: '      업무에 포함된 위험 요인: ', emrSection: '      업무에 포함된 위험 요인: ' },
    conclusionLead: { report: '\n      **종합평가** ', emrSection: '\n      **종합평가** ', emrSummary: '\n      **종합평가** ' },
  } as const satisfies NarrativePhrases;
}

export function createUpperLimbNarrative<S extends UpperLimbNarrativeSummary>(config: UpperLimbNarrativeConfig<S>): ModuleNarrative {
  const P = upperLimbPhrases(config.heading);
  type Group = ReturnType<typeof config.groupSummaries>[number];

  /** 상병 그룹 머리 줄(`  - [BK] 코드 이름 (측) / …`). 측이 없으면 괄호를 붙이지 않는다(B7). */
  function groupHeaderLine(group: Group): string {
    const diagList = group.summaries
      .map(s => {
        const d: NonNullable<UpperLimbNarrativeSummary['diagnosis']> = s.diagnosis || {};
        return `${d.code || ''} ${d.name || ''}${d.side ? ` (${getSideText(d.side)})` : ''}`.trim();
      })
      .join(' / ');
    const bkLabel = group.bkType ? config.bkLabels[group.bkType] || group.bkType : null;
    return `  - ${bkLabel ? `[${bkLabel}] ${diagList}` : diagList}\n`;
  }

  // 소견서·EMR 4번 칸(b6) 공용 전문 블록 — 직력 줄 + 상병 그룹별 입력 누락·분석 정리·위험 요인·종합평가(B8).
  function buildFullSection(calc: UpperLimbNarrativeCalc<S>, variant: FullVariant): string {
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
      config.groupSummaries(jobSummary.diagnosisSummaries || []).forEach(group => {
        const merged = config.mergeGroups(group.summaries);
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
  function buildExposureSummary(calc: UpperLimbNarrativeCalc<S>): string {
    let text: string = P.heading.emrSummary;
    if (calc?.noEvaluableJobs) return `${text}${NO_EVALUABLE_JOBS_NOTE}\n`;

    (calc?.jobSummaries || []).forEach((jobSummary, index) => {
      const groups = config.groupSummaries(jobSummary.diagnosisSummaries || []);
      if (groups.length === 0) return;
      text += fillPhrase(P.jobLine.emrSummary, { n: index + 1, name: jobSummary.jobName || P.jobNameEmpty.emrSummary });
      groups.forEach(group => {
        const merged = config.mergeGroups(group.summaries);
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

  return {
    render(variant: NarrativeVariant, calc: unknown): string {
      const moduleCalc = calc as UpperLimbNarrativeCalc<S>;
      if (variant === 'emrSummary') return buildExposureSummary(moduleCalc);
      return buildFullSection(moduleCalc, variant);
    },
    phrases: P,
  };
}
