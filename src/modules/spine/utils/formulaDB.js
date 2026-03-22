// MDDM 자세 분류 데이터베이스 (G1-G11)
export const formulaDB = {
  G1: { name: '똑바로 → 똑바로', category: 'lifting', b: 800, m: 45, applyCorrectionFactor: true, images: { from: '/images/G1_From.png', to: '/images/G1_To.png' } },
  G2: { name: '약간 굴곡 → 똑바로', category: 'lifting', b: 1100, m: 80, applyCorrectionFactor: true, images: { from: '/images/G2_From.png', to: '/images/G2_to.png' } },
  G3: { name: '심한 굴곡 → 똑바로', category: 'lifting', b: 1900, m: 70, applyCorrectionFactor: true, images: { from: '/images/G3_from.png', to: '/images/G3_to.png' } },
  G4: { name: '약간 굴곡 → 약간 굴곡', category: 'lifting', b: 1100, m: 75, applyCorrectionFactor: true, images: { from: '/images/G4_from.png', to: '/images/G4_to.png' } },
  G5: { name: '심한 굴곡 → 약간 굴곡', category: 'lifting', b: 1900, m: 65, applyCorrectionFactor: true, images: { from: '/images/G5_from.png', to: '/images/G5_to.png' } },
  G6: { name: '심한 굴곡 → 심한 굴곡', category: 'lifting', b: 1900, m: 60, applyCorrectionFactor: true, images: { from: '/images/G6_from.png', to: '/images/G6_to.png' } },
  G7: { name: '몸 앞·양옆 운반', category: 'carrying', b: 800, m: 95, applyCorrectionFactor: false, images: { single: '/images/G7.png' } },
  G8: { name: '한쪽·한 손 운반', category: 'carrying', b: 800, m: 180, applyCorrectionFactor: false, images: { single: '/images/G8.png' } },
  G9: { name: '어깨·등에 멤', category: 'carrying', b: 1100, m: 60, applyCorrectionFactor: false, images: { single: '/images/G9.png' } },
  G10: { name: '몸 앞·양옆·어깨·등 들고있기', category: 'holding', b: 800, m: 45, applyCorrectionFactor: false, images: { single: '/images/G10.png' } },
  G11: { name: '한쪽·한 손 들고있기', category: 'holding', b: 800, m: 85, applyCorrectionFactor: false, images: { single: '/images/G11.png' } }
};

export const POSTURE_CODES = Object.keys(formulaDB);
