// 서술 문구 표의 도우미(Phase 2 C7-a P2-65a). 모듈 서술(src/modules/<id>/narrative.ts)이 변형마다 달라지는 문구를
// narrative.phrases[항목][변형] 표에 두고 꺼내 쓴다 — 그 표가 문구 차이 표(src/core/narrative/diffTable.ts)의 원본이다.

/**
 * 문구 틀의 {이름} 자리를 값으로 채운다. 틀을 한 번만 훑으므로 채운 값 안의 `{…}`는 다시 바꾸지 않는다.
 * values에 없는 자리는 그대로 둔다.
 */
export function fillPhrase(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match));
}
