# r_reference_values_bivariate.json 생성 스크립트.
# 검증된 R 버전: R 4.6.1 "Happy Hop"(Docker r-base:latest) + effsize(버전은 스크립트
# 실행 로그에 기록), 2026-09-11.
# 실행: Rscript generate_r_reference_bivariate.R
#
# test_bivariate.py가 쓰는 케이스와 정확히 같은 입력을 그대로 옮겨, bivariate.py의
# 설계 표(§검정별 세부 스펙, pr3-swift-waterfall.md)가 명시한 "정확한 R 대조 옵션"으로
# 실행한다. p값·통계량만 대조하는 항목(mann_whitney/fisher_exact)과 값 자체를 대조하는
# 항목(welch_t/anova/kruskal_wallis/chi_square/pearson/spearman)을 설계표 그대로 구분한다.

if (!requireNamespace("effsize", quietly = TRUE)) install.packages("effsize", repos = "https://cloud.r-project.org")
if (!requireNamespace("jsonlite", quietly = TRUE)) install.packages("jsonlite", repos = "https://cloud.r-project.org")
library(effsize)
library(jsonlite)

result <- list()

# --- welch_t: statistic/p 대조 (test_welch_t_matches_scipy_statistic_and_pvalue) ---
x1 <- c(4.0, 5.0, 6.0, 5.0, 7.0, 6.0)
x2 <- c(8.0, 9.0, 7.0, 10.0, 9.0, 8.0, 11.0)
tt <- t.test(x2, x1, var.equal = FALSE)
result$welch_t_basic <- list(
  statistic = unname(tt$statistic),
  p_value = tt$p.value,
  df = unname(tt$parameter),
  mean_difference = unname(tt$estimate[1] - tt$estimate[2])
)

# --- welch_t: hedges g + CI 대조 (test_welch_t_hedges_g_ci_matches_effsize_reference) ---
g1 <- 0:9
g2 <- 1:10
cd <- cohen.d(g2, g1, hedges.correction = TRUE, noncentral = FALSE)
result$welch_t_hedges_g <- list(
  estimate = unname(cd$estimate),
  ci_lower = unname(cd$conf.int[1]),
  ci_upper = unname(cd$conf.int[2])
)

# --- mann_whitney: p값만 대조 (test_mann_whitney_matches_scipy) ---
m1 <- c(1.0, 2.0, 3.0, 4.0, 5.0)
m2 <- c(6.0, 7.0, 8.0, 9.0, 10.0)
wt <- wilcox.test(m2, m1, exact = FALSE, correct = TRUE)
result$mann_whitney <- list(p_value = wt$p.value)

# --- anova(Welch): 3그룹 F/p 대조 (test_welch_anova_three_groups_eta_squared_bounds) ---
a_values <- c(1.0, 2.0, 3.0, 10.0, 11.0, 12.0, 20.0, 22.0, 24.0)
a_group <- factor(c(rep("g1", 3), rep("g2", 3), rep("g3", 3)))
ow <- oneway.test(a_values ~ a_group, var.equal = FALSE)
result$anova_welch_three_groups <- list(
  statistic = unname(ow$statistic),
  p_value = ow$p.value,
  df1 = unname(ow$parameter[1]),
  df2 = unname(ow$parameter[2])
)

# --- kruskal_wallis: H/p 대조 (test_kruskal_wallis_matches_scipy) ---
k1 <- c(1.0, 2.0, 3.0)
k2 <- c(4.0, 5.0, 6.0)
k3 <- c(7.0, 8.0, 9.0)
kt <- kruskal.test(list(k1, k2, k3))
result$kruskal_wallis <- list(statistic = unname(kt$statistic), p_value = kt$p.value)

# --- chi_square: 2x2 (test_chi_square_matches_scipy_and_cramers_v_uses_uncorrected_chi2) ---
# table = [[50,30],[20,60]] (row-major, Python 그대로) -> byrow=TRUE로 그대로 옮김.
tbl1 <- matrix(c(50, 30, 20, 60), nrow = 2, byrow = TRUE)
chisq1 <- chisq.test(tbl1, correct = TRUE)
result$chi_square_50_30_20_60 <- list(
  statistic = unname(chisq1$statistic),
  p_value = chisq1$p.value,
  df = unname(chisq1$parameter)
)

# --- chi_square: low expected count 반례 (test_chi_square_low_expected_count_flag) ---
tbl2 <- matrix(c(1, 19, 19, 61), nrow = 2, byrow = TRUE)
chisq2 <- chisq.test(tbl2, correct = TRUE)
result$chi_square_1_19_19_61 <- list(
  statistic = unname(chisq2$statistic),
  p_value = chisq2$p.value,
  df = unname(chisq2$parameter),
  expected = as.vector(t(chisq2$expected))
)

# --- fisher_exact: p값만 대조, OR은 정의가 달라 별도 손계산 (test_fisher_exact_odds_ratio_hand_computed) ---
tblF1 <- matrix(c(10, 5, 3, 12), nrow = 2, byrow = TRUE)
ft1 <- fisher.test(tblF1)
result$fisher_exact_10_5_3_12 <- list(p_value = ft1$p.value)

# --- fisher_exact: 0-셀 Haldane-Anscombe (test_fisher_exact_zero_cell_applies_haldane_anscombe) ---
tblF2 <- matrix(c(0, 10, 10, 10), nrow = 2, byrow = TRUE)
ft2 <- fisher.test(tblF2)
result$fisher_exact_0_10_10_10 <- list(p_value = ft2$p.value)

# --- pearson_correlation (test_pearson_correlation_matches_scipy_r_and_ci_hand_computed) ---
px <- c(1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0)
py <- c(2.1, 3.9, 6.2, 7.8, 10.1, 11.9, 14.2, 15.8, 18.1, 19.9)
pc <- cor.test(px, py, method = "pearson")
result$pearson_correlation <- list(
  r = unname(pc$estimate),
  p_value = pc$p.value,
  ci_lower = pc$conf.int[1],
  ci_upper = pc$conf.int[2]
)

# --- spearman_correlation (test_spearman_correlation_matches_scipy_and_bonett_wright_ci) ---
sx <- c(1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0)
sy <- c(2.0, 1.0, 4.0, 3.0, 6.0, 5.0, 8.0, 7.0, 10.0, 9.0)
sc <- cor.test(sx, sy, method = "spearman", exact = FALSE)
result$spearman_correlation <- list(
  rho = unname(sc$estimate),
  p_value = sc$p.value
)

result$`_meta` <- list(
  r_version = R.version.string,
  effsize_version = as.character(packageVersion("effsize"))
)

cat(toJSON(result, auto_unbox = TRUE, digits = 16, na = "null"))
