// MDDM 기준값
export const thresholds = {
  singleForce: 1900,
  criticalForce: 6000,
  dailyDose: {
    legacy: { male: 2.0, female: 0.5 },
    v513:   { male: 4.0, female: 3.0 },
  },
  lifetimeDose: {
    mddm: { male: 25, female: 17 },
    court: { male: 12.5, female: 8.5 }
  }
};

// 전신진동(BK 2110) 기준값 — 독일 DGUV 공식 기준.
export const vibrationThresholds = {
  dailyAmax: 0.63,   // m/s² — 일일 Amax(8) 게이트/기준
  lifetimeDV: 1400,  // (m/s²)² — 평생 누적용량 DV,RI
  actionValue: 0.5,  // m/s² — 일일 조치값(보조 참고)
  limitZ: 0.8,       // m/s² — z축 한계값(보조 참고)
};
