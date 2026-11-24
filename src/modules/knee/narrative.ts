// 무릎 서술 — 소견서 블록 · EMR b6 블록 · EMR b8 한 줄 요약(P2-60, Phase 2 C7-a).
// src/core/utils/reportGenerator.js·emrReport.js에서 문구를 바꾸지 않고 그대로 옮겼다(값이 없을 때의 `?.` 유무까지).
// 범례·참고 문단은 소견서용(2칸 들여쓰기)과 b6용 두 벌을 그대로 둔다 — 문구 통일은 게이트 C(P2-66)에서.
import type { ModuleNarrative, NarrativeVariant } from '../../core/modules/manifest';
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

// reportGenerator.js genKneeBurdenSection — 소견서 블록.
function genKneeBurdenSection(calc: KneeNarrativeCalc): string {
  const { relatedness, cumulativeBurden, jobBurdens } = calc;
  let text = `\n  < 무릎(슬관절) >\n`;
  if (calc.noEvaluableJobs) return `${text}  ${NO_EVALUABLE_JOBS_NOTE}\n`;
  const avgRelatedness = relatedness
    ? ((Number(relatedness.min) + Number(relatedness.max)) / 2).toFixed(1)
    : null;

  (jobBurdens || []).forEach(job => {
    const checked = Object.entries(AUX_LABELS)
      .filter(([key]) => job[key])
      .map(([, label]) => label);

    text += `  직종: ${job.jobName || '-'}\n`;
    text += `  일 중량물 취급량: ${job.weight || '-'}kg\n`;
    text += `  일 쪼그려 앉기 시간: ${job.squatting || '-'}분\n`;
    if (checked.length > 0) {
      text += `  보조변수: ${checked.join(', ')}\n`;
    }
    text += `  무릎 부담 정도: ${job.burden?.level || '-'}\n`;
  });

  if (relatedness) {
    text += `\n  참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
    text += `  1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
    text += `  2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
    text += `  3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
    text += `  4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
    text += `\n  [신체부담기여도] ${relatedness.min}% ~ ${relatedness.max}% (평균 ${avgRelatedness}%)\n`;
  }
  if (cumulativeBurden) {
    text += `  [누적신체부담] ${cumulativeBurden}\n`;
  }
  text += `\n  **신체부담정도, 신체부담 기여도, 누적 신체부담에 관한 자세한 사항은\n`;
  text += `  <근골격계 질환의 업무관련성 특별진찰 표준화를 위한 모델 개발\n`;
  text += `  - 무릎 관절염을 대상으로 -, 대한직업환경의학회, 2025>\n`;
  text += `  보고서를 참조하기 바람.\n`;

  return text;
}

// emrReport.js buildExposureSection의 무릎 블록 — EMR 4번 칸(b6). 직종명이 빈 직력은 뺀다.
function buildKneeExposureSection(calc: KneeNarrativeCalc | undefined): string {
  let text = '';
  const avgRelatedness = calc?.relatedness
    ? ((Number(calc.relatedness.min) + Number(calc.relatedness.max)) / 2).toFixed(1)
    : null;

  text += '\n<무릎(슬관절)>\n';
  if (calc?.noEvaluableJobs) {
    text += `${NO_EVALUABLE_JOBS_NOTE}\n`;
  } else {
    (calc?.jobBurdens || []).filter(job => job.jobName).forEach(job => {
      const checked = Object.entries(AUX_LABELS).filter(([key]) => job[key]).map(([, label]) => label);
      text += `직종: ${job.jobName || '-'}\n`;
      text += `일 중량물 취급량: ${job.weight || '-'}kg\n`;
      text += `일 쪼그려 앉기 시간: ${job.squatting || '-'}분\n`;
      if (checked.length > 0) text += `보조변수: ${checked.join(', ')}\n`;
      text += `무릎 부담 정도: ${job.burden?.level || '-'}\n\n`;
    });
    if (calc?.relatedness) {
      text += `참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
      text += `1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
      text += `2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
      text += `3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
      text += `4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
      text += `\n[신체부담기여도] ${calc.relatedness.min}% ~ ${calc.relatedness.max}% (평균 ${avgRelatedness}%)\n`;
    }
    if (calc?.cumulativeBurden) {
      text += `[누적신체부담] ${calc.cumulativeBurden}\n`;
    }
    text += `\n**신체부담정도, 신체부담 기여도, 누적 신체부담에 관한 자세한 사항은\n`;
    text += `<근골격계 질환의 업무관련성 특별진찰 표준화를 위한 모델 개발\n`;
    text += `- 무릎 관절염을 대상으로 -, 대한직업환경의학회, 2025>\n`;
    text += `보고서를 참조하기 바람.\n`;
  }
  return text;
}

// emrReport.js buildExposureSummary의 무릎 블록 — EMR 6번 칸(b8) 요약. 직종명이 빈 직력은 뺀다.
function buildKneeExposureSummary(calc: KneeNarrativeCalc | undefined): string {
  let text = '';
  const avgRelatedness = calc?.relatedness
    ? ((Number(calc.relatedness.min) + Number(calc.relatedness.max)) / 2).toFixed(1)
    : null;

  text += '\n<무릎(슬관절)>\n';
  if (calc?.noEvaluableJobs) {
    text += `${NO_EVALUABLE_JOBS_NOTE}\n`;
  } else {
    (calc?.jobBurdens || []).filter(job => job.jobName).forEach(job => {
      text += `- ${job.jobName || '-'}: 중량물 ${job.weight || '-'}kg / 쪼그려앉기 ${job.squatting || '-'}분 / 부담 정도 ${job.burden?.level || '-'}\n`;
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
  emrOrder: 10,
  render(variant: NarrativeVariant, calc: unknown): string {
    const kneeCalc = calc as KneeNarrativeCalc | undefined;
    if (variant === 'report') return genKneeBurdenSection(kneeCalc as KneeNarrativeCalc);
    if (variant === 'emrSection') return buildKneeExposureSection(kneeCalc);
    return buildKneeExposureSummary(kneeCalc);
  },
};
