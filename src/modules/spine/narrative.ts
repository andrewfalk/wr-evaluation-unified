// 척추 서술(P2-62, Phase 2 C7-a) — 기존 sectionText.js(소견서·EMR 공통 소스)를 부르는 얇은 래퍼.
// 소견서와 EMR b6은 전문(buildSpineSectionText), b8은 요약(buildSpineSectionSummary). sectionText.js는 옮기거나 바꾸지 않는다.
import type { ModuleNarrative, NarrativeVariant } from '../../core/modules/manifest';
import { buildSpineSectionSummary, buildSpineSectionText } from './utils/sectionText';

type SpineSectionCalc = Parameters<typeof buildSpineSectionText>[0];

export const spineNarrative: ModuleNarrative = {
  render(variant: NarrativeVariant, calc: unknown): string {
    const spineCalc = calc as SpineSectionCalc;
    if (variant === 'emrSummary') return buildSpineSectionSummary(spineCalc);
    return buildSpineSectionText(spineCalc);
  },
};
