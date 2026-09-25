"""L2 정칙화 로지스틱(예측) — PR4-B2 계획서(async-riding-hennessy.md) §4단계 구현.

Node가 완전사례(S2, 결측 없음) 설계행렬(y, X — full one-hot, 절편 미포함,
columnNames)과 person 그룹 라벨(groups=cohortPersonKey), 외부 fold 배정
(outerFolds, R×N)을 만들어 보내고, 이 모듈은 순수 수치 계산만 한다 — 정책값
(람다 격자·반복 수·bootstrap 복제 수 등)을 전혀 모른다(계획서 "Python은 정책을
모르는 순수 함수다"). person 신원도 소수셀 판정도 이 모듈의 책임이 아니다
(regression.py와 같은 프로젝트 전역 원칙).

수렴 실패 범위(계획 §4단계):
  - 내부 CV에서 특정 λ가 실패하면 그 λ만 ∞로 둔다(다른 λ로 계속 진행).
  - bootstrap 복제에서 실패하면 그 복제만 무효로 센다.
  - apparent나 외부 fold(반복×outerFolds) 적합이 실패하면 전체가 NOT_CONVERGED다.

표준화는 각 내부 CV 학습 fold 자체의 평균·모표준편차(ddof=0)로만 한다(데이터
유출 방지) — 표준화된 계수를 원 스케일로 되돌리지 않는다(연구용 성능평가라
계수 자체를 최종 산출물로 보고하지 않는다, coefficients는 표준화 스케일 그대로).
"""
from __future__ import annotations

import hashlib
import math
from typing import Any

import numpy as np

_NEWTON_MAXITER = 100
_GRAD_TOL = 1e-8
_STEP_HALVING_MAX = 30
_PROB_CLIP = 1e-12
_METRIC_NAMES = ("roc_auc", "average_precision", "brier", "calibration_intercept", "calibration_slope")


class FitFailure(Exception):
    """ridge_logistic_fit/fit_procedure가 수렴하지 못했을 때."""


def _expit(z: np.ndarray) -> np.ndarray:
    out = np.empty_like(z, dtype=np.float64)
    pos = z >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-z[pos]))
    ez = np.exp(z[~pos])
    out[~pos] = ez / (1.0 + ez)
    return out


def _logaddexp0(z: np.ndarray) -> np.ndarray:
    return np.logaddexp(0.0, z)


def _penalized_neg_loglik(beta: np.ndarray, x1: np.ndarray, y: np.ndarray, lam: float) -> float:
    eta = x1 @ beta
    nll = float(np.mean(_logaddexp0(eta) - y * eta))
    penalty = 0.5 * lam * float(np.sum(beta[1:] ** 2))
    return nll + penalty


def ridge_logistic_fit(x: np.ndarray, y: np.ndarray, lam: float, beta_warm: np.ndarray | None = None) -> np.ndarray:
    """목적함수 (1/n)Σ[logaddexp(0,η) − yη] + (λ/2)‖β₋₀‖² — 절편(β₀)은 벌점에서
    뺀다. Newton + step-halving, warm start 지원. 수렴 기준: ‖∇‖∞ ≤
    1e-8·max(1,‖∇₀‖∞) AND 상대 목적함수 변화 < 1e-12."""
    n, p = x.shape
    x1 = np.hstack([np.ones((n, 1)), x])
    beta = np.zeros(p + 1) if beta_warm is None else beta_warm.copy()
    penalty_vec = np.concatenate([[0.0], np.full(p, lam)])

    grad0_norm: float | None = None
    for _ in range(_NEWTON_MAXITER):
        eta = x1 @ beta
        mu = _expit(eta)
        grad = x1.T @ (mu - y) / n + penalty_vec * beta
        if grad0_norm is None:
            grad0_norm = float(np.max(np.abs(grad)))
            if grad0_norm == 0:
                grad0_norm = 1.0

        w = np.clip(mu * (1 - mu), 1e-10, None)
        wx1 = x1 * w[:, None]
        h = (x1.T @ wx1) / n + np.diag(penalty_vec)
        try:
            step = np.linalg.solve(h, grad)
        except np.linalg.LinAlgError as exc:
            raise FitFailure("Hessian이 특이(singular)해 뉴턴 스텝을 풀 수 없다") from exc
        if not np.all(np.isfinite(step)):
            raise FitFailure("뉴턴 스텝에 비유한값이 나왔다")

        obj = _penalized_neg_loglik(beta, x1, y, lam)
        alpha = 1.0
        new_beta = beta - alpha * step
        new_obj = _penalized_neg_loglik(new_beta, x1, y, lam)
        halvings = 0
        while (not math.isfinite(new_obj) or new_obj > obj) and halvings < _STEP_HALVING_MAX:
            alpha *= 0.5
            new_beta = beta - alpha * step
            new_obj = _penalized_neg_loglik(new_beta, x1, y, lam)
            halvings += 1
        if not math.isfinite(new_obj) or new_obj > obj:
            raise FitFailure(f"step-halving {_STEP_HALVING_MAX}회로도 목적함수를 줄이지 못했다")
        beta = new_beta

        grad_new = x1.T @ (_expit(x1 @ beta) - y) / n + penalty_vec * beta
        grad_inf = float(np.max(np.abs(grad_new)))
        rel_change = abs(obj - new_obj) / max(1.0, abs(obj))
        if grad_inf <= _GRAD_TOL * max(1.0, grad0_norm) and rel_change < 1e-12:
            return beta

    raise FitFailure(f"maxiter({_NEWTON_MAXITER})까지 수렴하지 못했다")


# ---------------------------------------------------------------------------
# 결정적 샘플러 — numpy RNG 버전차(로컬 2.5 vs 운영 1.26.4)에 의존하지 않는다
# (계획서 "numpy RNG에 결정성을 의존할 수 없다"). hashlib 기반 정렬/카운터만 쓴다.
# ---------------------------------------------------------------------------
def _sha256_sort_key(seed: str, item: str) -> int:
    digest = hashlib.sha256(f"{seed}\x00{item}".encode("utf-8")).hexdigest()
    return int(digest[:16], 16)


def _grouped_stratified_fold(y: np.ndarray, groups: list[str], k: int, seed: str) -> np.ndarray:
    """person(=groups) 단위 층화(그 person이 y=1 행을 하나라도 가지면 층 1) →
    층별 seed 기반 정렬 → round-robin. 반환은 행 단위 fold 배열(길이 N)."""
    unique_groups = sorted(set(groups))
    group_to_stratum: dict[str, int] = {g: 0 for g in unique_groups}
    for i, g in enumerate(groups):
        if y[i] == 1:
            group_to_stratum[g] = 1

    fold_of_group: dict[str, int] = {}
    for stratum in (0, 1):
        members = sorted(
            (g for g in unique_groups if group_to_stratum[g] == stratum),
            key=lambda g: _sha256_sort_key(seed, g),
        )
        for i, g in enumerate(members):
            fold_of_group[g] = i % k
    return np.array([fold_of_group[g] for g in groups])


def _standardize_fit(x: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    mean = x.mean(axis=0)
    sd = x.std(axis=0, ddof=0)
    zero_sd = sd == 0
    sd_safe = np.where(zero_sd, 1.0, sd)
    return mean, sd_safe, zero_sd


def _apply_standardize(x: np.ndarray, mean: np.ndarray, sd: np.ndarray, zero_sd: np.ndarray) -> np.ndarray:
    x_s = (x - mean) / sd
    x_s[:, zero_sd] = 0.0
    return x_s


def fit_procedure(
    x: np.ndarray, y: np.ndarray, groups: list[str], lambda_grid: list[float], inner_folds: int, seed: str,
) -> tuple[float, np.ndarray]:
    """1) 내부 grouped stratified K-fold. 2) 각 학습 fold 자체 통계로 표준화
    (SD=0 열은 β=0). 3) 행 가중 pooled deviance 최소 λ 선택(동률이면 큰 λ).
    4) 선택 λ로 전체 학습셋 재적합. 반환: (selected_lambda, beta) — beta는
    표준화된 X(전체 재적합의 mean/sd 기준) 위의 계수, 길이 p+1(절편 포함)."""
    inner_fold = _grouped_stratified_fold(y, groups, inner_folds, seed)

    best_lambda: float | None = None
    best_dev: float | None = None
    for lam in lambda_grid:
        total_dev = 0.0
        total_rows = 0
        failed = False
        for k in range(inner_folds):
            train_mask = inner_fold != k
            test_mask = ~train_mask
            if not np.any(train_mask) or not np.any(test_mask):
                continue
            x_train, y_train = x[train_mask], y[train_mask]
            x_test, y_test = x[test_mask], y[test_mask]
            mean, sd, zero_sd = _standardize_fit(x_train)
            x_train_s = _apply_standardize(x_train, mean, sd, zero_sd)
            try:
                beta = ridge_logistic_fit(x_train_s, y_train, lam)
            except FitFailure:
                failed = True
                break
            beta[1:][zero_sd] = 0.0
            x_test_s = _apply_standardize(x_test, mean, sd, zero_sd)
            eta = beta[0] + x_test_s @ beta[1:]
            dev = 2.0 * float(np.sum(_logaddexp0(eta) - y_test * eta))
            total_dev += dev
            total_rows += int(len(y_test))
        if failed or total_rows == 0:
            continue  # 이 λ는 ∞로 둔다(선택 대상에서 제외) — 다른 λ로 계속 진행.
        pooled = total_dev / total_rows
        if best_dev is None or pooled < best_dev or (pooled == best_dev and lam > best_lambda):
            best_dev = pooled
            best_lambda = lam

    if best_lambda is None:
        raise FitFailure("모든 λ에서 내부 CV 적합이 실패했다")

    mean, sd, zero_sd = _standardize_fit(x)
    x_s = _apply_standardize(x, mean, sd, zero_sd)
    beta = ridge_logistic_fit(x_s, y, best_lambda)  # 실패하면 그대로 전파 → 호출부가 NOT_CONVERGED로 승격
    beta[1:][zero_sd] = 0.0
    return best_lambda, beta


def _predict_proba(beta: np.ndarray, x: np.ndarray, mean: np.ndarray, sd: np.ndarray, zero_sd: np.ndarray) -> np.ndarray:
    x_s = _apply_standardize(x, mean, sd, zero_sd)
    eta = beta[0] + x_s @ beta[1:]
    return _expit(eta)


# ---------------------------------------------------------------------------
# 지표(행 단위) — p는 [1e-12, 1-1e-12]로 clip한다. Hosmer–Lemeshow는 쓰지 않는다.
# ---------------------------------------------------------------------------
def _clip_p(p: np.ndarray) -> np.ndarray:
    return np.clip(p, _PROB_CLIP, 1.0 - _PROB_CLIP)


def roc_auc(y: np.ndarray, p: np.ndarray) -> float | None:
    """Mann–Whitney U 기반 AUC, 동점 0.5. 한쪽 클래스가 없으면 정의 불가(None)."""
    pos = p[y == 1]
    neg = p[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return None
    combined = np.concatenate([pos, neg])
    order = np.argsort(combined, kind="mergesort")
    ranks = np.empty(len(combined), dtype=np.float64)
    sorted_vals = combined[order]
    i = 0
    while i < len(sorted_vals):
        j = i
        while j + 1 < len(sorted_vals) and sorted_vals[j + 1] == sorted_vals[i]:
            j += 1
        avg_rank = (i + j) / 2.0 + 1.0
        ranks[order[i : j + 1]] = avg_rank
        i = j + 1
    rank_sum_pos = float(np.sum(ranks[: len(pos)]))
    n_pos, n_neg = len(pos), len(neg)
    u = rank_sum_pos - n_pos * (n_pos + 1) / 2.0
    return u / (n_pos * n_neg)


def average_precision(y: np.ndarray, p: np.ndarray) -> float | None:
    """AP = Σ(Rₙ−Rₙ₋₁)Pₙ, 예측확률 내림차순으로 임계값을 훑는다. 동점은 한
    임계값(같은 확률 값은 한 스텝). 사건이 없으면 정의 불가(None)."""
    n_pos = int(np.sum(y == 1))
    if n_pos == 0:
        return None
    order = np.argsort(-p, kind="mergesort")
    y_sorted = y[order]
    p_sorted = p[order]

    ap = 0.0
    prev_recall = 0.0
    i = 0
    n = len(y_sorted)
    tp = 0
    seen = 0
    while i < n:
        j = i
        while j + 1 < n and p_sorted[j + 1] == p_sorted[i]:
            j += 1
        block_tp = int(np.sum(y_sorted[i : j + 1] == 1))
        seen += (j - i + 1)
        tp += block_tp
        precision = tp / seen
        recall = tp / n_pos
        ap += (recall - prev_recall) * precision
        prev_recall = recall
        i = j + 1
    return ap


def brier_score(y: np.ndarray, p: np.ndarray) -> float:
    return float(np.mean((p - y) ** 2))


def calibration_intercept(y: np.ndarray, p: np.ndarray) -> float | None:
    """logit(p)를 offset으로 둔 절편 단독 로지스틱: y ~ 1, offset=logit(p).
    뉴턴 1차원으로 직접 푼다(ridge_logistic_fit과 별개 — offset이 있는 모형은
    페널티가 없는 별개 목적함수라 재사용하지 않는다)."""
    p_clipped = _clip_p(p)
    offset = np.log(p_clipped / (1 - p_clipped))
    a = 0.0
    for _ in range(_NEWTON_MAXITER):
        eta = a + offset
        mu = _expit(eta)
        grad = float(np.sum(mu - y))
        w = np.clip(mu * (1 - mu), 1e-10, None)
        hess = float(np.sum(w))
        if hess <= 0 or not math.isfinite(hess):
            return None
        step = grad / hess
        if not math.isfinite(step):
            return None
        a_new = a - step
        if abs(a_new - a) < 1e-10:
            return float(a_new)
        a = a_new
    return None  # 수렴 실패


def calibration_slope(y: np.ndarray, p: np.ndarray) -> float | None:
    """y ~ a + b·logit(p) — 2차원 뉴턴. 비수렴·분리면 None(호출부가 flag를 단다)."""
    p_clipped = _clip_p(p)
    logit_p = np.log(p_clipped / (1 - p_clipped))
    x1 = np.column_stack([np.ones_like(logit_p), logit_p])
    beta = np.array([0.0, 1.0])  # b=1(항등 보정) warm start
    for _ in range(_NEWTON_MAXITER):
        eta = x1 @ beta
        mu = _expit(eta)
        grad = x1.T @ (mu - y)
        w = np.clip(mu * (1 - mu), 1e-10, None)
        h = x1.T @ (x1 * w[:, None])
        try:
            step = np.linalg.solve(h, grad)
        except np.linalg.LinAlgError:
            return None
        if not np.all(np.isfinite(step)):
            return None
        new_beta = beta - step
        if np.max(np.abs(new_beta - beta)) < 1e-10:
            return float(new_beta[1])
        beta = new_beta
    return None


def _compute_metrics(y: np.ndarray, p: np.ndarray) -> dict[str, float | None]:
    return {
        "roc_auc": roc_auc(y, p),
        "average_precision": average_precision(y, p),
        "brier": brier_score(y, p),
        "calibration_intercept": calibration_intercept(y, p),
        "calibration_slope": calibration_slope(y, p),
    }


def _sha256_bootstrap_sample(unique_groups: list[str], seed: str, replicate: int) -> list[str]:
    """person 복원추출 — sha256 카운터 방식(계획서 §4단계 "정렬 라벨 기반 sha256
    카운터"). i번째 뽑기는 seed‖replicate‖i의 해시를 len(unique_groups)로 모듈로
    연산해 인덱스를 정한다 — numpy RNG 버전차에 의존하지 않는다."""
    n = len(unique_groups)
    sampled = []
    for i in range(n):
        digest = hashlib.sha256(f"{seed}\x00{replicate}\x00{i}".encode("utf-8")).hexdigest()
        idx = int(digest[:16], 16) % n
        sampled.append(unique_groups[idx])
    return sampled


def _non_estimable_response(
    reason: str,
    repeats: int,
    bootstrap_replicates: int,
    apparent_metrics: dict[str, float | None] | None = None,
    dropped_column_fold_count: int | None = None,
) -> dict[str, Any]:
    apparent_metrics = apparent_metrics or {name: None for name in _METRIC_NAMES}
    return {
        "estimation": "non_estimable",
        "nonEstimableReason": reason,
        "lambdaSelected": None,
        "metrics": {
            name: {
                "apparent": apparent_metrics[name],
                "representativeRepeat": None,
                "cv": {"status": "withheld", "validRepeats": 0, "totalRepeats": repeats, "mean": None, "min": None, "max": None},
                "bootstrap": {"status": "withheld", "validReplicates": 0, "totalReplicates": bootstrap_replicates, "optimism": None, "corrected": None},
            }
            for name in _METRIC_NAMES
        },
        "aucCi": None,
        "oofRepresentative": None,
        "intercept": None,
        "coefficients": None,
        "droppedColumnFoldCount": dropped_column_fold_count,
        "flags": [],
    }


def compute_prediction(request: dict[str, Any]) -> dict[str, Any]:
    y = np.array(request["y"], dtype=np.float64)
    x = np.array(request["X"], dtype=np.float64)
    groups: list[str] = request["groups"]
    outer_fold_count = int(request["outerFoldCount"])
    outer_folds: list[list[int]] = request["outerFolds"]  # R × N
    config = request["config"]
    inner_folds = int(config["innerFolds"])
    lambda_grid = [float(v) for v in config["lambdaGrid"]]
    bootstrap_replicates = int(config["bootstrapReplicates"])
    bootstrap_min_valid_rate = float(config["bootstrapMinValidRate"])
    cv_min_valid_repeats = int(config["cvMinValidRepeats"])
    auc_ci_replicates = int(config["aucCiReplicates"])
    sampler_seed = str(config["samplerSeed"])
    representative_repeat = int(config["representativeRepeat"])

    n = len(y)
    repeats = len(outer_folds)
    flags: list[str] = []

    # apparent — 전체 자료로 fit_procedure. apparent slope는 참고용으로만 쓴다
    # (ridge에서는 >1이 정상 — calibration_slope 자체 계산에 특례를 두지 않는다).
    try:
        apparent_lambda, apparent_beta = fit_procedure(x, y, groups, lambda_grid, inner_folds, f"{sampler_seed}-apparent")
    except FitFailure:
        return _non_estimable_response("NOT_CONVERGED", repeats, bootstrap_replicates)

    apparent_mean, apparent_sd, apparent_zero_sd = _standardize_fit(x)
    apparent_p = _predict_proba(apparent_beta, x, apparent_mean, apparent_sd, apparent_zero_sd)
    apparent_metrics = _compute_metrics(y, apparent_p)

    # 외부 grouped CV — Node가 준 배정으로 반복별 OOF를 전부 보존한다(AUC CI가
    # 반복별 per-row 확률을 다시 필요로 한다).
    per_repeat_metrics: dict[str, list[float | None]] = {name: [None] * repeats for name in _METRIC_NAMES}
    oof_by_repeat: list[np.ndarray | None] = [None] * repeats
    oof_representative: list[dict[str, float]] | None = None
    dropped_column_fold_count = 0

    for r in range(repeats):
        fold_of_row = np.array(outer_folds[r], dtype=np.int64)
        oof_p = np.full(n, np.nan)
        outer_failed = False
        for k in range(outer_fold_count):
            train_mask = fold_of_row != k
            test_mask = ~train_mask
            if not np.any(test_mask):
                continue
            x_train, y_train = x[train_mask], y[train_mask]
            g_train = [groups[i] for i in range(n) if train_mask[i]]
            train_sd = x_train.std(axis=0, ddof=0)
            dropped_column_fold_count += int(np.sum(train_sd == 0))
            try:
                _, beta = fit_procedure(x_train, y_train, g_train, lambda_grid, inner_folds, f"{sampler_seed}-outer-{r}-{k}")
            except FitFailure:
                outer_failed = True
                break
            mean, sd, zero_sd = _standardize_fit(x_train)
            oof_p[test_mask] = _predict_proba(beta, x[test_mask], mean, sd, zero_sd)
        if outer_failed:
            return _non_estimable_response("NOT_CONVERGED", repeats, bootstrap_replicates, apparent_metrics, dropped_column_fold_count)

        oof_by_repeat[r] = oof_p
        metrics_r = _compute_metrics(y, oof_p)
        for name in _METRIC_NAMES:
            per_repeat_metrics[name][r] = metrics_r[name]
        if r + 1 == representative_repeat:
            oof_representative = [{"row": int(i), "p": float(oof_p[i])} for i in range(n)]

    # bootstrap optimism — person(그룹) 단위 sha256 카운터 기반 복원추출. 내부
    # CV는 원래 라벨로 grouping한다(재표본 내에서도 fit_procedure가 자체적으로
    # grouped stratified K-fold를 다시 만든다 — g_b가 곧 그 라벨).
    unique_groups = sorted(set(groups))
    bootstrap_deltas: dict[str, list[float]] = {name: [] for name in _METRIC_NAMES}
    for b in range(bootstrap_replicates):
        sampled_groups = _sha256_bootstrap_sample(unique_groups, f"{sampler_seed}-boot", b)
        idx = [i for g in sampled_groups for i, gg in enumerate(groups) if gg == g]
        if not idx:
            continue
        idx_arr = np.array(idx)
        x_b, y_b = x[idx_arr], y[idx_arr]
        g_b = [groups[i] for i in idx]
        try:
            _, beta_b = fit_procedure(x_b, y_b, g_b, lambda_grid, inner_folds, f"{sampler_seed}-boot-fit-{b}")
        except FitFailure:
            continue
        mean_b, sd_b, zero_sd_b = _standardize_fit(x_b)
        p_boot_on_boot = _predict_proba(beta_b, x_b, mean_b, sd_b, zero_sd_b)
        p_boot_on_orig = _predict_proba(beta_b, x, mean_b, sd_b, zero_sd_b)
        metrics_boot = _compute_metrics(y_b, p_boot_on_boot)
        metrics_orig = _compute_metrics(y, p_boot_on_orig)
        for name in _METRIC_NAMES:
            mb, mo = metrics_boot[name], metrics_orig[name]
            if mb is None or mo is None:
                continue
            bootstrap_deltas[name].append(mb - mo)

    metrics_out: dict[str, Any] = {}
    for name in _METRIC_NAMES:
        cv_values = per_repeat_metrics[name]
        valid_cv = [v for v in cv_values if v is not None]
        cv_status = "ok" if len(valid_cv) >= cv_min_valid_repeats else "withheld"
        cv_mean = float(np.mean(valid_cv)) if cv_status == "ok" else None

        deltas = bootstrap_deltas[name]
        valid_replicates = len(deltas)
        apparent_value = apparent_metrics[name]
        if apparent_value is None:
            boot_status = "withheld"
            optimism = None
            corrected = None
        elif valid_replicates < bootstrap_min_valid_rate * bootstrap_replicates:
            boot_status = "withheld"
            optimism = None
            corrected = None
        else:
            boot_status = "ok"
            optimism = float(np.mean(deltas))
            corrected = apparent_value - optimism

        metrics_out[name] = {
            "apparent": apparent_value,
            "representativeRepeat": cv_values[representative_repeat - 1] if 0 < representative_repeat <= len(cv_values) else None,
            "cv": {
                "status": cv_status,
                "validRepeats": len(valid_cv),
                "totalRepeats": repeats,
                "mean": cv_mean,
                "min": float(np.min(valid_cv)) if cv_status == "ok" else None,
                "max": float(np.max(valid_cv)) if cv_status == "ok" else None,
            },
            "bootstrap": {
                "status": boot_status,
                "validReplicates": valid_replicates,
                "totalReplicates": bootstrap_replicates,
                "optimism": optimism,
                "corrected": corrected,
            },
        }

    auc_ci = None
    if metrics_out["roc_auc"]["cv"]["status"] == "ok":
        auc_ci = _bootstrap_auc_ci(y, groups, oof_by_repeat, auc_ci_replicates, f"{sampler_seed}-aucci")

    return {
        "estimation": "ok",
        "nonEstimableReason": None,
        "lambdaSelected": apparent_lambda,
        "metrics": metrics_out,
        "aucCi": auc_ci,
        "oofRepresentative": oof_representative,
        "intercept": float(apparent_beta[0]),
        "coefficients": [float(v) for v in apparent_beta[1:]],
        "droppedColumnFoldCount": dropped_column_fold_count,
        "flags": flags,
    }


_AUC_CI_MIN_VALID_RATE = 0.9


def _bootstrap_auc_ci(
    y: np.ndarray,
    groups: list[str],
    oof_by_repeat: list[np.ndarray | None],
    replicates: int,
    seed: str,
) -> dict[str, Any] | None:
    """반복 평균 AUC(roc_auc.cv.mean)에 대한 person bootstrap percentile CI
    (계획서 §4단계 "AUC 95% CI"). 모형 재적합 없음 — 이미 계산된 반복별 OOF
    확률(oof_by_repeat)을 person 단위로 리샘플링해 반복별 AUC를 다시 낸 뒤
    그 평균을 draw 값으로 삼는다. 조건부 CI다(모형 재적합을 포함하지 않는다)."""
    unique_groups = sorted(set(groups))
    # person → 그 person의 행 인덱스 목록(person이 여러 행을 가질 수 있다 —
    # disease grain broadcast 등).
    rows_by_group: dict[str, list[int]] = {g: [] for g in unique_groups}
    for i, g in enumerate(groups):
        rows_by_group[g].append(i)

    draw_values: list[float] = []
    for b in range(replicates):
        sampled_groups = _sha256_bootstrap_sample(unique_groups, seed, b)
        idx = [i for g in sampled_groups for i in rows_by_group[g]]
        if not idx:
            continue
        idx_arr = np.array(idx)
        y_sample = y[idx_arr]
        repeat_aucs: list[float] = []
        for oof in oof_by_repeat:
            if oof is None:
                continue
            p_sample = oof[idx_arr]
            auc = roc_auc(y_sample, p_sample)
            if auc is not None:
                repeat_aucs.append(auc)
        if repeat_aucs:
            draw_values.append(float(np.mean(repeat_aucs)))

    if len(draw_values) < _AUC_CI_MIN_VALID_RATE * replicates:
        return None

    sorted_draws = sorted(draw_values)
    lower = float(np.percentile(sorted_draws, 2.5))
    upper = float(np.percentile(sorted_draws, 97.5))
    return {
        "target": "roc_auc_cv_mean",
        "lower": lower,
        "upper": upper,
        "method": "person_bootstrap_oof_conditional",
        "replicates": len(draw_values),
    }
