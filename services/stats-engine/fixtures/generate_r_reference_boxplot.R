# r_reference_values_boxplot.json 생성 스크립트.
# 검증된 R 버전: R 4.6.1(Docker r-base:latest) — base R만 사용(패키지 설치 불필요,
# boxplot.py 계획서 §3 — boxplot.stats()/fivenum()의 Tukey hinges 대신
# quantile(x, type=7)(numpy percentile method="linear"과 동치) + 수동 Tukey
# 1.5×IQR 규칙으로 재현한다. R 기본 boxplot()의 시각적 결과와 다를 수 있음을
# 의도적으로 받아들인 선택(표-차트 Q1/Q3 일관성 우선).
# 실행: Rscript generate_r_reference_boxplot.R

if (!requireNamespace("jsonlite", quietly = TRUE)) install.packages("jsonlite", repos = "https://cloud.r-project.org")
library(jsonlite)

compute_boxplot <- function(x) {
  q <- quantile(x, c(0.25, 0.75), type = 7, names = FALSE)
  q1 <- q[1]; q3 <- q[2]
  iqr <- q3 - q1
  lower_fence <- q1 - 1.5 * iqr
  upper_fence <- q3 + 1.5 * iqr
  inside <- x[x >= lower_fence & x <= upper_fence]
  outliers <- x[x < lower_fence | x > upper_fence]
  list(
    q1 = unname(q1), q3 = unname(q3),
    lower_whisker = if (length(inside) > 0) min(inside) else unname(q1),
    upper_whisker = if (length(inside) > 0) max(inside) else unname(q3),
    lower_fence = unname(lower_fence), upper_fence = unname(upper_fence),
    outlier_count = length(outliers),
    outlier_values = as.numeric(sort(outliers))
  )
}

result <- list()

# test_no_outliers_when_all_within_fence
result$no_outliers <- compute_boxplot(c(1, 2, 3, 4, 5))

# test_pr3b_disclosure_counterexample_reproduced — 계획서 §1 반례.
result$disclosure_counterexample <- compute_boxplot(c(rep(0, 50), rep(1, 26), rep(2.49, 23), 2.51))

# test_lower_and_upper_outliers_both_detected
result$lower_and_upper_outliers <- compute_boxplot(c(-100, 10:19, 200))

# test_whisker_is_actual_observed_value_not_fence_boundary
result$whisker_actual_value <- compute_boxplot(c(1:9, 100))

result$`_meta` <- list(r_version = R.version.string)

cat(toJSON(result, auto_unbox = TRUE, digits = 16, na = "null"))
