// 통계 화면 두 패널(결과·레시피)이 함께 쓰는 라벨 — 문구·순서까지 같던 중복만 모았다(P2-78b).
// 키는 같고 문구가 다른 표(NULL_REASON_LABELS ↔ describeMethodReasonCode 등)는 합치면 화면 글자가 바뀌므로 각 패널 폴더에 둔다.
// METHOD_LABELS의 키 순서가 레시피 패널 방법 목록의 순서다(recipe/labels.ts의 METHOD_ORDER) — 순서를 바꾸지 않는다.

// PR3-A — StatsMethodIdSchema(shared/contracts/stats.ts)와 동일 순서·목록. 실행
// 가능 8종 + 예약된 unsupported 2종(대응검정, 계획서 §"실행 가능한 방법은 8종").
export const METHOD_LABELS: Record<string, string> = {
  welch_t: 'Welch t 검정',
  mann_whitney: 'Mann-Whitney U 검정',
  anova: '일원분산분석(Welch)',
  kruskal_wallis: 'Kruskal-Wallis 검정',
  chi_square: '카이제곱 검정',
  fisher_exact: 'Fisher 정확검정',
  pearson_correlation: 'Pearson 상관',
  spearman_correlation: 'Spearman 상관',
  paired_t: '대응 t 검정',
  wilcoxon_signed_rank: 'Wilcoxon 부호순위검정',
  // PR4-A1 — StatsMethodIdSchema와 동일 순서·목록에 맞춘다. METHOD_ORDER에 없는
  // id는 MethodPicker의 filter(Boolean)에서 조용히 사라진다 — 여기 추가하는 것
  // 자체가 카드 노출의 전제조건이다.
  ols_linear: '선형회귀(OLS)',
  binary_logistic: '이분 로지스틱 회귀',
  // PR4-B2 — StatsMethodIdSchema와 동일 순서·목록.
  l2_logistic: 'L2 정칙화 로지스틱 회귀(ridge)',
};

// 그룹(범주) 역할을 할 수 있는 변수 타입 — 결과 패널의 이변량 역할 판정, 레시피 패널의 그룹 변수 후보.
export const GROUPING_TYPES = new Set<string | undefined>(['boolean', 'ordinal', 'categorical']);
