# r_reference_values_prediction.json 생성 스크립트 — PR4-B2 계획서 §4단계
# "R 골든값" 절. 검증된 R 버전: R 4.6.1 "Happy Hop"(Docker r-base:latest) +
# glmnet + pROC, 2026-09-24(0단계 항목 3에서 확인).
#
# glmnet(alpha=0, 고정 λ 3개, standardize=FALSE, control=list(thresh=1e-14))로
# ridge_logistic_fit(prediction.py)과 정확히 같은 파라미터화(패널티가 절편
# 제외 (λ/2)‖β₋₀‖², 목적함수가 평균 음의 로그가능도)인지 대조한다.
# 실행: Rscript generate_r_reference_prediction.R

if (!requireNamespace("glmnet", quietly = TRUE)) install.packages("glmnet", repos = "https://cloud.r-project.org")
if (!requireNamespace("pROC", quietly = TRUE)) install.packages("pROC", repos = "https://cloud.r-project.org")
if (!requireNamespace("jsonlite", quietly = TRUE)) install.packages("jsonlite", repos = "https://cloud.r-project.org")
library(glmnet)
library(pROC)
library(jsonlite)

result <- list()

# --- 고정 데이터셋(n=30, p=2) — services/stats-engine/test_prediction.py와 동일 리터럴 ---
x1 <- c(0.0012, 0.2987, -0.2741, -0.8906, -0.4547, -0.9916, 0.0601, 1.3402, -0.4922, -0.6205, 0.4898, 0.3569, 0.1054, -0.9305, -0.0293, 0.6953, -1.3442, -0.4576, -1.9012, -1.2895, -1.8417, -0.2351, -1.2674, 0.2713, 0.1568, -0.1869, -2.5168, -0.5387, -0.0485, 0.1133)
x2 <- c(-1.5301, -0.4778, -0.9785, -0.8088, 1.0609, -0.8075, -0.0325, 0.8844, -0.5836, -0.1117, 0.1105, 0.0638, -1.2251, 0.0761, 1.3588, -1.5471, 0.8594, 0.1194, -0.6415, 2.0004, 0.7623, -1.1993, 0.0745, 0.5767, -0.1888, 0.6829, -0.0665, 0.6672, 1.4385, -0.6757)
y <- c(1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1)
X <- cbind(x1, x2)

# glmnet 고정 λ 3개 — 작은/중간/큰 정칙화. standardize=FALSE + control=list(thresh=1e-14)
# (glmnet 5.1부터 thresh를 glmnet()에 직접 넘기면 deprecated 경고 — control로 넘긴다).
lambdas <- c(0.01, 0.1, 1.0)
glmnet_coefs <- list()
for (lam in lambdas) {
  fit <- glmnet(X, y, family = "binomial", alpha = 0, lambda = lam,
                standardize = FALSE, control = list(thresh = 1e-14))
  co <- as.numeric(coef(fit))  # intercept, x1, x2
  glmnet_coefs[[as.character(lam)]] <- list(intercept = co[1], x1 = co[2], x2 = co[3])
}
result$glmnet_ridge <- glmnet_coefs

# λ→0 근사(사실상 무정칙화) — 일반 glm()과 거의 같아야 한다(대조용, 정확히
# 0은 glmnet이 허용하지 않아 아주 작은 값으로).
fit_unpenalized_glmnet <- glmnet(X, y, family = "binomial", alpha = 0, lambda = 1e-8,
                                   standardize = FALSE, control = list(thresh = 1e-14))
co_up <- as.numeric(coef(fit_unpenalized_glmnet))
result$glmnet_near_zero_lambda <- list(intercept = co_up[1], x1 = co_up[2], x2 = co_up[3])

fit_glm <- glm(y ~ x1 + x2, family = binomial())
result$glm_unpenalized <- list(
  intercept = unname(coef(fit_glm)[1]), x1 = unname(coef(fit_glm)[2]), x2 = unname(coef(fit_glm)[3])
)

# --- pROC AUC — 고정 y/p 쌍(위 데이터셋의 glm 적합확률을 그대로 사용) ---
p_fitted <- as.numeric(predict(fit_glm, type = "response"))
roc_obj <- roc(y, p_fitted, direction = "<", levels = c(0, 1), quiet = TRUE)
result$proc_auc <- list(auc = as.numeric(auc(roc_obj)), p = p_fitted)

# --- AP(average precision) 수기 계산 — R 패키지 없이 정의대로 ---
ap_manual <- function(y, p) {
  ord <- order(-p)
  y_sorted <- y[ord]
  n_pos <- sum(y == 1)
  tp <- 0
  ap <- 0
  prev_recall <- 0
  n <- length(y_sorted)
  i <- 1
  while (i <= n) {
    j <- i
    while (j < n && p[ord][j + 1] == p[ord][i]) j <- j + 1
    block_tp <- sum(y_sorted[i:j] == 1)
    tp <- tp + block_tp
    precision <- tp / j
    recall <- tp / n_pos
    ap <- ap + (recall - prev_recall) * precision
    prev_recall <- recall
    i <- j + 1
  }
  ap
}
result$average_precision <- ap_manual(y, p_fitted)

# --- calibration intercept/slope — glm offset/slope(계획서 §4단계) ---
logit_p <- log(p_fitted / (1 - p_fitted))
fit_cal_intercept <- glm(y ~ 1 + offset(logit_p), family = binomial())
result$calibration_intercept <- unname(coef(fit_cal_intercept)[1])

fit_cal_slope <- glm(y ~ logit_p, family = binomial())
result$calibration_slope <- unname(coef(fit_cal_slope)[2])
result$calibration_slope_intercept <- unname(coef(fit_cal_slope)[1])

write(toJSON(result, auto_unbox = TRUE, digits = 15), file = "r_reference_values_prediction.json")
cat("wrote r_reference_values_prediction.json\n")
cat("R version:", R.version.string, "\n")
cat("glmnet version:", as.character(packageVersion("glmnet")), "\n")
cat("pROC version:", as.character(packageVersion("pROC")), "\n")
