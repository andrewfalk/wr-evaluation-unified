// MDDM 기준값
export const thresholds = {
  singleForce: 1900,
  criticalForce: 6000,
  dailyDose: {
    legacy: { male: 2.0, female: 0.5 },
    v513:   { male: 5.5, female: 3.5 },
  },
  lifetimeDose: {
    mddm: { male: 25, female: 17 },
    court: { male: 12.5, female: 8.5 },
    dws2: { male: 7.0, female: 3.0 }
  }
};
