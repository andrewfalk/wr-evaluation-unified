// 측(side) 표시 문구 — 상병·평가 화면과 소견서·EMR 문장이 같이 쓴다(REFACTORING_ROADMAP Phase 2 C6, P2-51).
// 옛 복제 8벌(knee·shoulder·elbow·wrist calculations.js의 getSideText, elbow·wrist ExposureForm·ResultPanel의 getSideLabel)을
// 글자까지 같은 식 하나로 모았다. 출력이 다른 변형(일괄 내보내기 등)은 여기로 모으지 않는다 — 각자 그대로 둔다.
// 아무것도 import하지 않는다(순환 import 방지).

/** right → 우측, left → 좌측, both → 양측, 그 밖(빈 값 포함) → '-' */
export function getSideText(side: unknown): string {
  return side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-';
}
