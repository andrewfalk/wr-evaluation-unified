# r_reference_values_correlation_matrix.json 생성 스크립트.
# 검증된 R 버전: R 4.6.1(Docker r-base:latest) + jsonlite.
# correlation_matrix.py 계획서 §4 — cor(df, use="pairwise.complete.obs")와
# 개념이 동일한 pairwise-complete 필터링 + p.adjust(method="BH")로 다중검정
# 보정을 검증한다.
# 실행: Rscript generate_r_reference_correlation_matrix.R

if (!requireNamespace("jsonlite", quietly = TRUE)) install.packages("jsonlite", repos = "https://cloud.r-project.org")
library(jsonlite)

result <- list()

# --- 완전 관측 3변수(x,y,z) pearson + BH-FDR(m=3) ---
x <- c(1, 2, 3, 4, 5, 6, 7, 8, 9, 10)
y <- c(2, 4, 6, 8, 10, 12, 14, 16, 18, 20)
z <- c(10, 9, 8, 7, 6, 5, 4, 3, 2, 1)

pxy <- cor.test(x, y, method = "pearson")
pxz <- cor.test(x, z, method = "pearson")
pyz <- cor.test(y, z, method = "pearson")

raw_p <- c(pxy$p.value, pxz$p.value, pyz$p.value)
adj_p <- p.adjust(raw_p, method = "BH")

result$pearson_matrix <- list(
  xy = list(r = unname(pxy$estimate), p_value = pxy$p.value, adjusted_p = unname(adj_p[1])),
  xz = list(r = unname(pxz$estimate), p_value = pxz$p.value, adjusted_p = unname(adj_p[2])),
  yz = list(r = unname(pyz$estimate), p_value = pyz$p.value, adjusted_p = unname(adj_p[3]))
)

# --- pairwise-complete 필터링(NA 포함, test_pairwise_complete_filtering_excludes_either_null) ---
xa <- c(1, NA, 3, 4, NA, 6, 7)
ya <- c(2, 3, NA, 8, 5, 12, 14)
complete_idx <- which(!is.na(xa) & !is.na(ya))
pc <- cor.test(xa[complete_idx], ya[complete_idx], method = "pearson")
result$pairwise_complete <- list(
  n = length(complete_idx),
  r = unname(pc$estimate),
  p_value = pc$p.value
)

# --- spearman(같은 x,y) ---
sxy <- cor.test(x, y, method = "spearman", exact = FALSE)
result$spearman_xy <- list(rho = unname(sxy$estimate), p_value = sxy$p.value)

# --- BH-FDR 표준 예시(test_multiple_testing.py의 _P) — PR3-A 당시 "R을 직접
# 실행하지 않았다"고 문서화된 갭을 여기서 닫는다(같은 jsonlite 의존성 재사용).
p_std <- c(0.005, 0.011, 0.02, 0.04, 0.13, 0.5)
result$bh_fdr_standard_example <- list(
  raw_p = p_std,
  adjusted_p = p.adjust(p_std, method = "BH")
)

result$`_meta` <- list(r_version = R.version.string)

cat(toJSON(result, auto_unbox = TRUE, digits = 16, na = "null"))
