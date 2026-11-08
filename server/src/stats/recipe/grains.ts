// Analysis grains the stats workbench supports — the single list (S6 P1-35). Recipe validation and
// GET /catalog (supportedGrains) both read it; it used to be kept in sync by hand in two places.
import type { StatsAnalysisRecipe } from '@wr/contracts';

// grain 단순화(PR0-B4 개정) — case/job/disease 3개만 지원한다. job_diagnosis/task/
// cervical_task/vibration_interval은 소스코드까지 완전히 삭제됐고, person은 case와
// 실질적으로 구분되지 않아 이후 다시 삭제됐다(변수 자체는 case로 되돌려 존치).
export const SUPPORTED_GRAINS: ReadonlySet<StatsAnalysisRecipe['grain']> = new Set([
  'case',
  'job',
  'disease',
]);

// PR4-B2 — 예측 analysis grain은 case/disease만 지원한다(job 제외 — 결정 #3 §0단계
// 허용표: job-grain 원노출은 case/disease로 역방향 롤업이 안 돼 predictor 후보가 없다).
export const PREDICTION_SUPPORTED_GRAINS: ReadonlySet<StatsAnalysisRecipe['grain']> = new Set(['case', 'disease']);
