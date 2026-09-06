// PR0-B2: 압박력 공식 값(b/m/category/applyCorrectionFactor)은 packages/analytics-core/
// modules/spine로 이관됐다(계산 단일 소스 원칙, §리뷰 지적). `images`(자세 그림 경로)는
// 계산에 관여하지 않는 UI 전용 데이터라 analytics-core로 옮기지 않았다 — 여기서 계산값
// 위에 병합해 기존 소비자(TaskEditor.jsx 등의 `formulaDB[code].images`)를 그대로 지원한다.
import { formulaDB as CORE_FORMULA_DB, POSTURE_CODES } from '@analytics-core/modules/spine/index';

const IMAGES = {
  G1: { from: './images/G1_From.png', to: './images/G1_To.png' },
  G2: { from: './images/G2_From.png', to: './images/G2_to.png' },
  G3: { from: './images/G3_from.png', to: './images/G3_to.png' },
  G4: { from: './images/G4_from.png', to: './images/G4_to.png' },
  G5: { from: './images/G5_from.png', to: './images/G5_to.png' },
  G6: { from: './images/G6_from.png', to: './images/G6_to.png' },
  G7: { single: './images/G7.png' },
  G8: { single: './images/G8.png' },
  G9: { single: './images/G9.png' },
  G10: { single: './images/G10.png' },
  G11: { single: './images/G11.png' },
};

export const formulaDB = Object.fromEntries(
  Object.entries(CORE_FORMULA_DB).map(([code, entry]) => [code, { ...entry, images: IMAGES[code] }]),
);

export { POSTURE_CODES };
