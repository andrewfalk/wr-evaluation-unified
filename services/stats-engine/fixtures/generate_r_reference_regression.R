# r_reference_values_regression.json 생성 스크립트.
# 검증된 R 버전: R 4.6.1 "Happy Hop"(Docker r-base:latest) + sandwich + lmtest,
# 2026-09-21.
# 실행: Rscript generate_r_reference_regression.R
#
# test_regression.py의 4개 R 대조 픽스처(OLS+HC3/OLS+CR1/로지스틱+HC3/로지스틱+CR1)와
# 정확히 같은 입력을 그대로 옮겨, 계획서(pr4-a-lexical-reddy.md) §3 "추론 분포와
# 자유도" 표가 명시한 정확한 호출로 실행한다:
#   OLS+HC3       coeftest(fit, vcovHC(fit,type="HC3"), df = N-P)
#   OLS+CR1       coeftest(fit, vcovCL(fit,cluster=~id,type="HC1",cadjust=TRUE), df = G-1)
#   로지스틱+HC3   coeftest(fit, vcovHC(fit,type="HC3"), df = Inf)
#   로지스틱+CR1   coeftest(fit, vcovCL(fit,cluster=~id,type="HC1",cadjust=TRUE), df = G-1)
# R 기본값(vcovCL의 기본 type)을 그대로 쓰지 않는다 — lm엔 HC1, 그 외엔 HC0가
# 기본이라 Python의 c=G/(G-1)*(N-1)/(N-P) 보정과 맞지 않는다(계획 §3).

if (!requireNamespace("sandwich", quietly = TRUE)) install.packages("sandwich", repos = "https://cloud.r-project.org")
if (!requireNamespace("lmtest", quietly = TRUE)) install.packages("lmtest", repos = "https://cloud.r-project.org")
if (!requireNamespace("jsonlite", quietly = TRUE)) install.packages("jsonlite", repos = "https://cloud.r-project.org")
library(sandwich)
library(lmtest)
library(jsonlite)

result <- list()

# --- Dataset A: OLS + HC3, n=24 ---
x1_a <- c(-2.3, -2.1, -1.9, -1.7, -1.5, -1.3, -1.1, -0.9, -0.7, -0.5, -0.3, -0.1, 0.1, 0.3, 0.5, 0.7, 0.9, 1.1, 1.3, 1.5, 1.7, 1.9, 2.1, 2.3)
y_a  <- c(-2.56, -1.89, -1.22, -0.55, 0.12, 0.79, 1.46, -0.46, 0.21, 0.88, 1.55, 2.22, 2.89, 3.56, 1.64, 2.31, 2.98, 3.65, 4.32, 4.99, 5.66, 3.74, 4.41, 5.08)
fit_a <- lm(y_a ~ x1_a)
ct_a <- coeftest(fit_a, vcov = vcovHC(fit_a, type = "HC3"), df = length(y_a) - 2)
result$ols_hc3 <- list(
  intercept_estimate = unname(coef(fit_a)[1]), intercept_se = unname(ct_a[1, 2]),
  intercept_p = unname(ct_a[1, 4]),
  x1_estimate = unname(coef(fit_a)[2]), x1_se = unname(ct_a[2, 2]),
  x1_statistic = unname(ct_a[2, 3]), x1_p = unname(ct_a[2, 4])
)

# --- Dataset B: OLS + CR1, n=48, 12 clusters of 4 ---
x1_b <- c(-3.3, -2.3, -1.3, -0.3, -3, -2, -1, 0, -2.7, -1.7, -0.7, 0.3, -2.4, -1.4, -0.4, 0.6, -2.1, -1.1, -0.1, 0.9, -1.8, -0.8, 0.2, 1.2, -1.5, -0.5, 0.5, 1.5, -1.2, -0.2, 0.8, 1.8, -0.9, 0.1, 1.1, 2.1, -0.6, 0.4, 1.4, 2.4, -0.3, 0.7, 1.7, 2.7, 0, 1, 2, 3)
y_b  <- c(-7.8, -5.35, -2.9, -1.8, -5.95, -3.5, -2.4, 0.05, -4.1, -3, -0.55, 1.9, -3.6, -1.15, 1.3, 2.4, -1.75, 0.7, 1.8, 4.25, -3.9, -2.8, -0.35, 2.1, -3.4, -0.95, 1.5, 2.6, -1.55, 0.9, 2, 4.45, 0.3, 1.4, 3.85, 6.3, 0.8, 3.25, 5.7, 6.8, -1.35, 1.1, 2.2, 4.65, 0.5, 1.6, 4.05, 6.5)
cluster_b <- factor(rep(0:11, each = 4))
fit_b <- lm(y_b ~ x1_b)
ct_b <- coeftest(fit_b, vcov = vcovCL(fit_b, cluster = cluster_b, type = "HC1", cadjust = TRUE), df = 12 - 1)
result$ols_cr1 <- list(
  intercept_estimate = unname(coef(fit_b)[1]), intercept_se = unname(ct_b[1, 2]),
  x1_estimate = unname(coef(fit_b)[2]), x1_se = unname(ct_b[2, 2]),
  x1_statistic = unname(ct_b[2, 3]), x1_p = unname(ct_b[2, 4])
)

# --- Dataset C: Logistic + HC3, n=60 ---
x1_c <- c(-3, -2.8983, -2.7966, -2.6949, -2.5932, -2.4915, -2.3898, -2.2881, -2.1864, -2.0847, -1.9831, -1.8814, -1.7797, -1.678, -1.5763, -1.4746, -1.3729, -1.2712, -1.1695, -1.0678, -0.9661, -0.8644, -0.7627, -0.661, -0.5593, -0.4576, -0.3559, -0.2542, -0.1525, -0.0508, 0.0508, 0.1525, 0.2542, 0.3559, 0.4576, 0.5593, 0.661, 0.7627, 0.8644, 0.9661, 1.0678, 1.1695, 1.2712, 1.3729, 1.4746, 1.5763, 1.678, 1.7797, 1.8814, 1.9831, 2.0847, 2.1864, 2.2881, 2.3898, 2.4915, 2.5932, 2.6949, 2.7966, 2.8983, 3)
y_c <- c(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)
fit_c <- glm(y_c ~ x1_c, family = binomial())
ct_c <- coeftest(fit_c, vcov = vcovHC(fit_c, type = "HC3"), df = Inf)
result$logistic_hc3 <- list(
  intercept_estimate = unname(coef(fit_c)[1]), intercept_se = unname(ct_c[1, 2]),
  x1_estimate = unname(coef(fit_c)[2]), x1_se = unname(ct_c[2, 2]),
  x1_statistic = unname(ct_c[2, 3]), x1_p = unname(ct_c[2, 4]),
  logLik = as.numeric(logLik(fit_c)), aic = AIC(fit_c)
)

# --- Dataset D: Logistic + CR1, n=80, 20 clusters of 4 ---
x1_d <- c(-2.55, -1.85, -1.15, -0.45, -2.4, -1.7, -1, -0.3, -2.25, -1.55, -0.85, -0.15, -2.1, -1.4, -0.7, -0, -1.95, -1.25, -0.55, 0.15, -1.8, -1.1, -0.4, 0.3, -1.65, -0.95, -0.25, 0.45, -1.5, -0.8, -0.1, 0.6, -1.35, -0.65, 0.05, 0.75, -1.2, -0.5, 0.2, 0.9, -1.05, -0.35, 0.35, 1.05, -0.9, -0.2, 0.5, 1.2, -0.75, -0.05, 0.65, 1.35, -0.6, 0.1, 0.8, 1.5, -0.45, 0.25, 0.95, 1.65, -0.3, 0.4, 1.1, 1.8, -0.15, 0.55, 1.25, 1.95, 0, 0.7, 1.4, 2.1, 0.15, 0.85, 1.55, 2.25, 0.3, 1, 1.7, 2.4)
y_d <- c(0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 0, 1, 1)
cluster_d <- factor(rep(0:19, each = 4))
fit_d <- glm(y_d ~ x1_d, family = binomial())
ct_d <- coeftest(fit_d, vcov = vcovCL(fit_d, cluster = cluster_d, type = "HC1", cadjust = TRUE), df = 20 - 1)
result$logistic_cr1 <- list(
  intercept_estimate = unname(coef(fit_d)[1]), intercept_se = unname(ct_d[1, 2]),
  x1_estimate = unname(coef(fit_d)[2]), x1_se = unname(ct_d[2, 2]),
  x1_statistic = unname(ct_d[2, 3]), x1_p = unname(ct_d[2, 4]),
  logLik = as.numeric(logLik(fit_d)), aic = AIC(fit_d)
)

write(toJSON(result, auto_unbox = TRUE, digits = 15), file = "r_reference_values_regression.json")
cat("wrote r_reference_values_regression.json\n")
cat("R version:", R.version.string, "\n")
cat("sandwich version:", as.character(packageVersion("sandwich")), "\n")
cat("lmtest version:", as.character(packageVersion("lmtest")), "\n")
