// 서술 문구 표의 도우미(Phase 2 C7-a P2-65a). 모듈 서술(src/modules/<id>/narrative.ts)이 변형마다 달라지는 문구를
// narrative.phrases[항목][변형] 표에 두고 꺼내 쓴다 — 그 표가 문구 차이 표(src/core/narrative/diffTable.ts)의 원본이다.

/**
 * 문구 틀의 {이름} 자리를 값으로 채운다. 틀을 한 번만 훑으므로 채운 값 안의 `{…}`는 다시 바꾸지 않는다.
 * values에 없는 자리는 그대로 둔다.
 */
export function fillPhrase(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match));
}

/**
 * 출력(소견서·EMR)에서 빈 직종명 대신 쓰는 낱말(REFACTORING_ROADMAP Phase 2 C8, P2-72h — 사용자 결정 5, 2026-11-27).
 * [직업력] 줄·경추·팔꿈치·손목 서술·척추 섹션이 이 한 곳을 쓴다. 화면 낱말은 `(미입력)`(src/core/utils/jobLabels.ts)으로 따로다.
 * 무릎·어깨 블록은 직종명이 빈 직력을 출력에서 빼므로 이 낱말이 나오지 않는다.
 */
export const OUTPUT_EMPTY_JOB_NAME = '직업 미입력';
