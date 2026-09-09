# r_reference_values.json 재생성용 참고 스크립트.
# 검증된 R 버전: R 4.6.1 "Happy Hop"(Docker r-base:latest) + e1071 1.7-17, 2026-09-09.
# 실행: Rscript generate_r_reference.R
#
# descriptive.py의 skewness/kurtosis는 e1071::skewness(type=2)/e1071::kurtosis(type=2)와
# 동치인 공식(scipy.stats.skew(bias=False)/kurtosis(fisher=True,bias=False))을 쓴다.
# 사분위수는 quantile(type=7)(R 기본값, numpy percentile method='linear'와 동치).
#
# r_reference_values.json은 위 R 버전으로 이 스크립트를 실제 실행한 결과와 대조 완료됐다
# (rtol=1e-6, atol=1e-9 이내 전부 일치). 다시 대조하려면 이 스크립트를 실행해 나온 JSON을
# r_reference_values.json과 비교하고, 다르면 이 스크립트가 아니라 descriptive.py 쪽을 의심할 것.

if (!requireNamespace("e1071", quietly = TRUE)) install.packages("e1071")
library(e1071)
library(jsonlite)

cases <- list(
  list(label = "n2", values = c(4.0, 10.0)),
  list(label = "n3", values = c(1.0, 2.0, 6.0)),
  list(label = "n4", values = c(2.0, 4.0, 4.0, 8.0)),
  list(label = "n8_skewed", values = c(2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0)),
  list(label = "n10_wide", values = c(12.4, 8.1, 41.0, 22.5, 3.3, 55.7, 19.9, 27.2, 6.6, 33.3))
)

summarize_case <- function(c) {
  x <- c$values
  n <- length(x)
  q <- quantile(x, probs = c(0.25, 0.5, 0.75), type = 7, names = FALSE)
  list(
    label = c$label,
    values = x,
    n = n,
    mean = mean(x),
    sd = if (n >= 2) sd(x) else NA,
    q1 = q[1], median = q[2], q3 = q[3],
    min = min(x), max = max(x),
    skewness = if (n >= 3) skewness(x, type = 2) else NA,
    kurtosis = if (n >= 4) kurtosis(x, type = 2) else NA
  )
}

results <- lapply(cases, summarize_case)
cat(toJSON(list(cases = results), auto_unbox = TRUE, digits = 16, na = "null"))
