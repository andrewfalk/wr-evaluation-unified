// src/modules/spine/utils/{formulaDB,thresholds,formulaVersion,time}.js에서 이동한 순수
// leaf 상수·함수. src/의 원본 파일들은 UI(자세 이미지 경로 등)와 export 코드
// (exportHandlers.js, sectionText.js)에서도 직접 import하므로 건드리지 않고 그대로 둔다 —
// 이 파일은 계산에 필요한 부분만 analytics-core 전용으로 새로 옮겨 적었다(§1-3 spine 항목).
// `images` 필드(자세 그림 경로)는 UI 전용이라 옮기지 않는다 — 계산은 b/m/category/
// applyCorrectionFactor만 읽는다(calculateCompressiveForce, mddm.ts 참고).

export interface FormulaDBEntry {
  name: string;
  category: 'lifting' | 'carrying' | 'holding';
  b: number;
  m: number;
  applyCorrectionFactor: boolean;
}

// MDDM 자세 분류 데이터베이스 (G1-G11). b/m/적용여부는 원본과 완전히 동일한 값이어야 한다 —
// 이 값이 조금이라도 다르면 계산 결과 자체가 달라진다(계산 로직 재구현 금지 원칙의 핵심 대상).
export const formulaDB: Record<string, FormulaDBEntry> = {
  G1: { name: '똑바로 → 똑바로', category: 'lifting', b: 800, m: 45, applyCorrectionFactor: true },
  G2: { name: '약간 굴곡 → 똑바로', category: 'lifting', b: 1100, m: 80, applyCorrectionFactor: true },
  G3: { name: '심한 굴곡 → 똑바로', category: 'lifting', b: 1900, m: 70, applyCorrectionFactor: true },
  G4: { name: '약간 굴곡 → 약간 굴곡', category: 'lifting', b: 1100, m: 75, applyCorrectionFactor: true },
  G5: { name: '심한 굴곡 → 약간 굴곡', category: 'lifting', b: 1900, m: 65, applyCorrectionFactor: true },
  G6: { name: '심한 굴곡 → 심한 굴곡', category: 'lifting', b: 1900, m: 60, applyCorrectionFactor: true },
  G7: { name: '몸 앞·양옆 운반', category: 'carrying', b: 800, m: 95, applyCorrectionFactor: false },
  G8: { name: '한쪽·한 손 운반', category: 'carrying', b: 800, m: 180, applyCorrectionFactor: false },
  G9: { name: '어깨·등에 멤', category: 'carrying', b: 1100, m: 60, applyCorrectionFactor: false },
  G10: { name: '몸 앞·양옆·어깨·등 들고있기', category: 'holding', b: 800, m: 45, applyCorrectionFactor: false },
  G11: { name: '한쪽·한 손 들고있기', category: 'holding', b: 800, m: 85, applyCorrectionFactor: false },
};

export const POSTURE_CODES = Object.keys(formulaDB);

// spine 일일선량 공식 버전 식별자. 값이 부재(undefined)이면 legacy 공식(v5.1.2 이전)으로 간주.
export const SPINE_FORMULA_V513 = 'v5.1.3';
export const SPINE_FORMULA_LEGACY = 'legacy';

// 전신진동(BK 2110) 공식 버전. LABEL/TITLE은 계산에 쓰이지 않는 순수 표시 문자열이지만,
// src/의 formulaVersion.js를 shim으로 완전히 교체하려면(§리뷰 지적 — 계산 단일 소스 원칙)
// 여기 함께 둬야 한다.
export const WBV_FORMULA_V1 = 'BK2110-v1';
export const WBV_FORMULA_LABEL = 'BK 2110';
export const WBV_FORMULA_TITLE = 'BK 2110 / Amax(8)+DV (2014 DGUV) — 단일 대표축 단순화, aw 범위 입력';

// MDDM 기준값
export const thresholds = {
  singleForce: 1900,
  criticalForce: 6000,
  dailyDose: {
    legacy: { male: 2.0, female: 0.5 },
    v513: { male: 4.0, female: 3.0 },
  },
  lifetimeDose: {
    mddm: { male: 25, female: 17 },
    court: { male: 12.5, female: 8.5 },
  },
};

// 전신진동(BK 2110) 기준값 — 독일 DGUV 공식 기준.
export const vibrationThresholds = {
  dailyAmax: 0.63,
  lifetimeDV: 1400,
  actionValue: 0.5,
  limitZ: 0.8,
};

// 시간 단위 변환 leaf 유틸. 원본과 동일 — 인식 못하는 단위는 조용히 초 취급한다(default 분기,
// extractor의 quality flag 스캔이 이 경우를 invalid로 별도 관찰한다).
export function convertTimeToSeconds(value: number, unit: string): number {
  switch (unit) {
    case 'min':
      return value * 60;
    case 'hr':
      return value * 3600;
    default:
      return value;
  }
}
