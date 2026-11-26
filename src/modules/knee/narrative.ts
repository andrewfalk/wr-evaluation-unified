// 무릎 서술 — 소견서·EMR 4번 칸(b6) 공용 전문 블록 · EMR 6번 칸(b8) 한 줄 요약(P2-60, Phase 2 C7-a → 게이트 C P2-66b).
// 게이트 C에서 소견서를 4번 칸 모양으로 맞췄다(ADR 0001 표 A 1·2·6행, 표 B의 B4) — 두 출력처가 한 함수(buildKneeFullSection)를
// 쓴다. 6번 칸은 직력당 한 줄 요약 그대로다(B5, 짧은 라벨 표 A 3~5행 유지).
// 변형마다 달라지는 문구는 KNEE_PHRASES(narrative.phrases — 문구 차이 표의 원본, P2-65a)에서 꺼내 쓴다.
import type { ModuleNarrative, NarrativePhrases, NarrativeVariant } from '../../core/modules/manifest';
import { NO_EVALUABLE_JOBS_NOTE } from '../../core/utils/jobHistory';
import { AUX_LABELS } from './utils/data';

/** 서술이 읽는 직력별 무릎 부담(computeKneeCalc의 jobBurdens 원소 중 쓰는 것만). 보조변수 키는 AUX_LABELS의 키다. */
interface KneeJobBurden {
  jobName?: string;
  weight?: string | number;
  squatting?: string | number;
  burden?: { level?: string } | null;
  [auxKey: string]: unknown;
}

/** 서술이 읽는 computeKneeCalc 결과(필요한 필드만). */
interface KneeNarrativeCalc {
  relatedness?: { min: number | string; max: number | string } | null;
  cumulativeBurden?: string | null;
  jobBurdens?: KneeJobBurden[];
  noEvaluableJobs?: boolean;
}

/** 전문 블록을 쓰는 변형(소견서·4번 칸). */
type FullVariant = Exclude<NarrativeVariant, 'emrSummary'>;

/** 변형별 문구. 소견서와 b6은 줄마다 쓰고(같은 값), b8은 직력당 한 줄 요약이다. */
const KNEE_PHRASES = {
  heading: { report: '\n<무릎(슬관절)>\n', emrSection: '\n<무릎(슬관절)>\n', emrSummary: '\n<무릎(슬관절)>\n' },
  /** 직종·범례·참고 문단·평가 대상 없음 줄 앞 들여쓰기 */
  indent: { report: '', emrSection: '' },
  weightLabel: { report: '일 중량물 취급량: ', emrSection: '일 중량물 취급량: ', emrSummary: '중량물 ' },
  squattingLabel: { report: '일 쪼그려 앉기 시간: ', emrSection: '일 쪼그려 앉기 시간: ', emrSummary: '쪼그려앉기 ' },
  burdenLabel: { report: '무릎 부담 정도: ', emrSection: '무릎 부담 정도: ', emrSummary: '부담 정도 ' },
  /** 직력 블록 뒤에 붙는 빈 줄(참고 문단 앞 빈 줄 역할도 한다) */
  jobGap: { report: '\n', emrSection: '\n' },
} as const satisfies NarrativePhrases;

const P = KNEE_PHRASES;

function averageRelatedness(calc: KneeNarrativeCalc | undefined): string | null {
  return calc?.relatedness
    ? ((Number(calc.relatedness.min) + Number(calc.relatedness.max)) / 2).toFixed(1)
    : null;
}

// 소견서·EMR 4번 칸(b6) 공용 전문 블록. 직종명이 빈 직력은 뺀다(B4).
function buildKneeFullSection(calc: KneeNarrativeCalc | undefined, variant: FullVariant): string {
  const indent = P.indent[variant];
  let text: string = P.heading[variant];
  if (calc?.noEvaluableJobs) return `${text}${indent}${NO_EVALUABLE_JOBS_NOTE}\n`;
  const avgRelatedness = averageRelatedness(calc);

  (calc?.jobBurdens || []).filter(job => job.jobName).forEach(job => {
    const checked = Object.entries(AUX_LABELS).filter(([key]) => job[key]).map(([, label]) => label);
    text += `${indent}직종: ${job.jobName}\n`;
    text += `${indent}${P.weightLabel[variant]}${job.weight || '-'}kg\n`;
    text += `${indent}${P.squattingLabel[variant]}${job.squatting || '-'}분\n`;
    if (checked.length > 0) text += `${indent}보조변수: ${checked.join(', ')}\n`;
    text += `${indent}${P.burdenLabel[variant]}${job.burden?.level || '-'}\n${P.jobGap[variant]}`;
  });

  if (calc?.relatedness) {
    text += `${indent}참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
    text += `${indent}1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
    text += `${indent}2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
    text += `${indent}3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
    text += `${indent}4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
    text += `\n${indent}[신체부담기여도] ${calc.relatedness.min}% ~ ${calc.relatedness.max}% (평균 ${avgRelatedness}%)\n`;
  }
  if (calc?.cumulativeBurden) {
    text += `${indent}[누적신체부담] ${calc.cumulativeBurden}\n`;
  }
  text += `\n${indent}**신체부담정도, 신체부담 기여도, 누적 신체부담에 관한 자세한 사항은\n`;
  text += `${indent}<근골격계 질환의 업무관련성 특별진찰 표준화를 위한 모델 개발\n`;
  text += `${indent}- 무릎 관절염을 대상으로 -, 대한직업환경의학회, 2025>\n`;
  text += `${indent}보고서를 참조하기 바람.\n`;

  return text;
}

// EMR 6번 칸(b8) 요약. 직종명이 빈 직력은 뺀다.
function buildKneeExposureSummary(calc: KneeNarrativeCalc | undefined): string {
  let text = '';
  const avgRelatedness = averageRelatedness(calc);

  text += P.heading.emrSummary;
  if (calc?.noEvaluableJobs) {
    text += `${NO_EVALUABLE_JOBS_NOTE}\n`;
  } else {
    (calc?.jobBurdens || []).filter(job => job.jobName).forEach(job => {
      text += `- ${job.jobName || '-'}: ${P.weightLabel.emrSummary}${job.weight || '-'}kg / ${P.squattingLabel.emrSummary}${job.squatting || '-'}분 / ${P.burdenLabel.emrSummary}${job.burden?.level || '-'}\n`;
    });
    if (calc?.relatedness) {
      text += `[신체부담기여도] ${calc.relatedness.min}% ~ ${calc.relatedness.max}% (평균 ${avgRelatedness}%)\n`;
    }
    if (calc?.cumulativeBurden) {
      text += `[누적신체부담] ${calc.cumulativeBurden}\n`;
    }
  }
  return text;
}

export const kneeNarrative: ModuleNarrative = {
  render(variant: NarrativeVariant, calc: unknown): string {
    const kneeCalc = calc as KneeNarrativeCalc | undefined;
    if (variant === 'emrSummary') return buildKneeExposureSummary(kneeCalc);
    return buildKneeFullSection(kneeCalc, variant);
  },
  phrases: KNEE_PHRASES,
};
