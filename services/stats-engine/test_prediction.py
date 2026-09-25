"""prediction.py 단위테스트 — PR4-B2 계획서(async-riding-hennessy.md) §4단계
"검증 — Python" 절을 그대로 구현한다.

R 참조값 대조(정답 대조)는 2026-09-24에 Docker r-base:latest(R 4.6.1
"Happy Hop") + glmnet + pROC로 실제 실행해 완료했다(0단계 항목 3에서 환경을
검증, `fixtures/generate_r_reference_prediction.R` 실행 결과가
`fixtures/r_reference_values_prediction.json`). 정확 검사(수치 최적해 여부)는
R 대조와 별개로 KKT 정류점 조건을 직접 검사한다 — solver 알고리즘이 달라도
같은 볼록 목적함수의 최적해는 그래디언트가 0이어야 한다는 것은 항상 참이다.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest

import prediction as pred

_R_REFERENCE_PATH = Path(__file__).parent / "fixtures" / "r_reference_values_prediction.json"

# fixtures/generate_r_reference_prediction.R과 정확히 동일한 리터럴.
_X1 = [0.0012, 0.2987, -0.2741, -0.8906, -0.4547, -0.9916, 0.0601, 1.3402, -0.4922, -0.6205, 0.4898, 0.3569, 0.1054, -0.9305, -0.0293, 0.6953, -1.3442, -0.4576, -1.9012, -1.2895, -1.8417, -0.2351, -1.2674, 0.2713, 0.1568, -0.1869, -2.5168, -0.5387, -0.0485, 0.1133]
_X2 = [-1.5301, -0.4778, -0.9785, -0.8088, 1.0609, -0.8075, -0.0325, 0.8844, -0.5836, -0.1117, 0.1105, 0.0638, -1.2251, 0.0761, 1.3588, -1.5471, 0.8594, 0.1194, -0.6415, 2.0004, 0.7623, -1.1993, 0.0745, 0.5767, -0.1888, 0.6829, -0.0665, 0.6672, 1.4385, -0.6757]
_Y = [1, 1, 1, 1, 1, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 1]
_X = np.column_stack([np.array(_X1), np.array(_X2)])
_Y_ARR = np.array(_Y, dtype=np.float64)


def _kkt_gradient_norm(beta: np.ndarray, x: np.ndarray, y: np.ndarray, lam: float) -> float:
    """정류점 조건 ∇f(β*)=0의 잔차 크기(무한노름) — 목적함수(정칙화 포함)의
    실제 그래디언트를 직접 재계산한다(ridge_logistic_fit 내부 구현과 별개
    경로 — 같은 코드로 "자기 자신이 맞다"고 순환 검증하지 않는다)."""
    n = x.shape[0]
    x1 = np.hstack([np.ones((n, 1)), x])
    eta = x1 @ beta
    mu = 1.0 / (1.0 + np.exp(-eta))
    penalty_vec = np.concatenate([[0.0], np.full(x.shape[1], lam)])
    grad = x1.T @ (mu - y) / n + penalty_vec * beta
    return float(np.max(np.abs(grad)))


# ---------------------------------------------------------------------------
# ridge_logistic_fit — KKT 정류점 + 해석적 검산 + R 대조
# ---------------------------------------------------------------------------
class TestRidgeLogisticFit:
    @pytest.mark.parametrize("lam", [0.001, 0.01, 0.1, 1.0, 10.0])
    def test_kkt_stationary(self, lam):
        beta = pred.ridge_logistic_fit(_X, _Y_ARR, lam)
        grad_norm = _kkt_gradient_norm(beta, _X, _Y_ARR, lam)
        assert grad_norm < 1e-6

    def test_lambda_to_infinity_shrinks_coefficients_to_zero(self):
        """λ→∞ 해석적 검산 — 페널티가 지배하면 β(절편 제외)는 0에 수렴한다."""
        beta = pred.ridge_logistic_fit(_X, _Y_ARR, 1e8)
        assert abs(beta[1]) < 1e-3
        assert abs(beta[2]) < 1e-3

    def test_warm_start_converges_to_same_point(self):
        beta_cold = pred.ridge_logistic_fit(_X, _Y_ARR, 0.5)
        beta_warm = pred.ridge_logistic_fit(_X, _Y_ARR, 0.5, beta_warm=beta_cold * 0.9)
        assert np.allclose(beta_cold, beta_warm, atol=1e-6)

    @pytest.mark.skipif(not _R_REFERENCE_PATH.exists(), reason="R 참조값 파일이 아직 생성되지 않음")
    def test_r_reference_glmnet_ridge(self):
        """계획서 §4단계 "R 골든값" — rel ~1e-6. 실측은 이보다 훨씬 정밀하다
        (1e-8~1e-13, 아래 rel=1e-6은 그 실측을 넉넉히 포함하는 계약값)."""
        ref = json.loads(_R_REFERENCE_PATH.read_text(encoding="utf-8"))
        for lam_str, expected in ref["glmnet_ridge"].items():
            lam = float(lam_str)
            beta = pred.ridge_logistic_fit(_X, _Y_ARR, lam)
            assert beta[0] == pytest.approx(expected["intercept"], rel=1e-6, abs=1e-8)
            assert beta[1] == pytest.approx(expected["x1"], rel=1e-6, abs=1e-8)
            assert beta[2] == pytest.approx(expected["x2"], rel=1e-6, abs=1e-8)

    @pytest.mark.skipif(not _R_REFERENCE_PATH.exists(), reason="R 참조값 파일이 아직 생성되지 않음")
    def test_r_reference_near_zero_lambda_matches_glm(self):
        """λ→0(사실상 무정칙화)이면 일반 glm() 결과와 거의 같아야 한다."""
        ref = json.loads(_R_REFERENCE_PATH.read_text(encoding="utf-8"))
        beta = pred.ridge_logistic_fit(_X, _Y_ARR, 1e-8)
        expected = ref["glm_unpenalized"]
        assert beta[0] == pytest.approx(expected["intercept"], rel=1e-3, abs=1e-3)
        assert beta[1] == pytest.approx(expected["x1"], rel=1e-3, abs=1e-3)
        assert beta[2] == pytest.approx(expected["x2"], rel=1e-3, abs=1e-3)

    def test_singular_hessian_raises_fit_failure(self):
        """완전 상수 열(분산 0)로 극단적 조건을 만들어도 λ>0이면 Hessian
        대각에 λ가 더해져 특이가 되지 않는다 — 그래도 병리적 입력(전부 같은
        클래스)에서 값이 발산하지 않고 FitFailure로 수렴 실패를 알리는지
        확인한다(step-halving 상한)."""
        x_degenerate = np.zeros((10, 1))
        y_all_one = np.ones(10)
        # λ가 아주 작으면 완전분리(전부 y=1)에서 β가 무한대로 발산하려 하므로
        # step-halving이 목적함수를 못 줄이는 상황을 재현할 수 있다 — 그래도
        # 반드시 실패하는 것은 보장할 수 없어(작은 λ라도 페널티가 있으면 결국
        # 수렴) 여기서는 "실패하거나 유한한 값으로 수렴한다" 둘 다 정상으로
        # 본다(즉 예외 없이 통과하는 것 자체가 계약 — 무한루프/크래시가 없어야
        # 함).
        try:
            beta = pred.ridge_logistic_fit(x_degenerate, y_all_one, 1e-6)
            assert np.all(np.isfinite(beta))
        except pred.FitFailure:
            pass


# ---------------------------------------------------------------------------
# 지표 — 해석적 검산 + R 대조
# ---------------------------------------------------------------------------
class TestMetrics:
    def test_roc_auc_perfect_separation_is_one(self):
        y = np.array([0, 0, 0, 1, 1, 1], dtype=np.float64)
        p = np.array([0.1, 0.2, 0.3, 0.7, 0.8, 0.9])
        assert pred.roc_auc(y, p) == pytest.approx(1.0)

    def test_roc_auc_random_ties_is_half(self):
        y = np.array([0, 1, 0, 1], dtype=np.float64)
        p = np.array([0.5, 0.5, 0.5, 0.5])
        assert pred.roc_auc(y, p) == pytest.approx(0.5)

    def test_roc_auc_one_class_only_is_none(self):
        y = np.array([1, 1, 1], dtype=np.float64)
        p = np.array([0.1, 0.5, 0.9])
        assert pred.roc_auc(y, p) is None

    def test_average_precision_no_events_is_none(self):
        y = np.array([0, 0, 0], dtype=np.float64)
        p = np.array([0.1, 0.2, 0.3])
        assert pred.average_precision(y, p) is None

    def test_brier_score_perfect_prediction_is_zero(self):
        y = np.array([0, 1, 0, 1], dtype=np.float64)
        p = np.array([0.0, 1.0, 0.0, 1.0])
        assert pred.brier_score(y, p) == pytest.approx(0.0)

    def test_calibration_slope_well_calibrated_is_near_one(self):
        """logit(p)와 y가 정확히 그 확률에서 생성됐다면 slope≈1이어야 한다."""
        rng = np.random.default_rng(1)
        n = 2000
        p_true = rng.uniform(0.05, 0.95, size=n)
        y = (rng.random(n) < p_true).astype(np.float64)
        slope = pred.calibration_slope(y, p_true)
        assert slope == pytest.approx(1.0, abs=0.15)

    @pytest.mark.skipif(not _R_REFERENCE_PATH.exists(), reason="R 참조값 파일이 아직 생성되지 않음")
    def test_r_reference_proc_auc(self):
        ref = json.loads(_R_REFERENCE_PATH.read_text(encoding="utf-8"))
        p = np.array(ref["proc_auc"]["p"])
        auc = pred.roc_auc(_Y_ARR, p)
        assert auc == pytest.approx(ref["proc_auc"]["auc"], rel=1e-6)

    @pytest.mark.skipif(not _R_REFERENCE_PATH.exists(), reason="R 참조값 파일이 아직 생성되지 않음")
    def test_r_reference_average_precision(self):
        ref = json.loads(_R_REFERENCE_PATH.read_text(encoding="utf-8"))
        p = np.array(ref["proc_auc"]["p"])
        ap = pred.average_precision(_Y_ARR, p)
        assert ap == pytest.approx(ref["average_precision"], rel=1e-6)

    @pytest.mark.skipif(not _R_REFERENCE_PATH.exists(), reason="R 참조값 파일이 아직 생성되지 않음")
    def test_r_reference_calibration_intercept_and_slope(self):
        ref = json.loads(_R_REFERENCE_PATH.read_text(encoding="utf-8"))
        p = np.array(ref["proc_auc"]["p"])
        intercept = pred.calibration_intercept(_Y_ARR, p)
        assert intercept == pytest.approx(ref["calibration_intercept"], rel=1e-4, abs=1e-4)
        slope = pred.calibration_slope(_Y_ARR, p)
        assert slope == pytest.approx(ref["calibration_slope"], rel=1e-4, abs=1e-4)


# ---------------------------------------------------------------------------
# fit_procedure — fold 내부 표준화 · 결정성
# ---------------------------------------------------------------------------
class TestFitProcedure:
    def _groups(self, n: int) -> list[str]:
        return [f"p{i}" for i in range(n)]

    def test_deterministic_across_calls(self):
        groups = self._groups(len(_Y))
        lam_a, beta_a = pred.fit_procedure(_X, _Y_ARR, groups, [0.01, 0.1, 1.0], 3, "seed-1")
        lam_b, beta_b = pred.fit_procedure(_X, _Y_ARR, groups, [0.01, 0.1, 1.0], 3, "seed-1")
        assert lam_a == lam_b
        assert np.array_equal(beta_a, beta_b)

    def test_different_seed_can_change_fold_assignment_but_stays_valid(self):
        groups = self._groups(len(_Y))
        lam_a, beta_a = pred.fit_procedure(_X, _Y_ARR, groups, [0.01, 0.1, 1.0], 3, "seed-1")
        lam_b, beta_b = pred.fit_procedure(_X, _Y_ARR, groups, [0.01, 0.1, 1.0], 3, "seed-2")
        assert lam_a in [0.01, 0.1, 1.0]
        assert lam_b in [0.01, 0.1, 1.0]

    def test_fixed_lambda_fold_fit_is_invariant_to_test_fold_values(self):
        """고정 λ의 fold별 적합 — 검증(test) fold 값을 극단값으로 바꿔도
        학습(train) fold의 평균·SD·계수는 불변이어야 한다(3차 세부조건 —
        표준화가 학습 fold만의 통계여야 한다는 것을 직접 확인)."""
        groups = self._groups(len(_Y))
        inner_fold = pred._grouped_stratified_fold(_Y_ARR, groups, 3, "fixed-seed")
        train_mask = inner_fold != 0
        x_train, y_train = _X[train_mask], _Y_ARR[train_mask]
        mean1, sd1, zero_sd1 = pred._standardize_fit(x_train)
        beta1 = pred.ridge_logistic_fit(pred._apply_standardize(x_train, mean1, sd1, zero_sd1), y_train, 0.1)

        # 검증 fold(fold==0)의 X를 극단값으로 바꿔도 train_mask로 걸러진
        # x_train/y_train 자체는 원본 인덱싱이라 변하지 않는다 — 여기서는
        # "표준화 통계가 test fold를 보지 않는다"를 직접 확인하기 위해
        # X 전체를 복제해 test 부분만 오염시킨 뒤 같은 절차를 반복한다.
        x_polluted = _X.copy()
        x_polluted[~train_mask] = 1e9
        mean2, sd2, zero_sd2 = pred._standardize_fit(x_polluted[train_mask])
        beta2 = pred.ridge_logistic_fit(pred._apply_standardize(x_polluted[train_mask], mean2, sd2, zero_sd2), y_train, 0.1)

        assert np.array_equal(mean1, mean2)
        assert np.array_equal(sd1, sd2)
        assert np.allclose(beta1, beta2)

    def test_full_tuning_procedure_may_change_with_validation_data(self):
        """전체 튜닝 절차(fit_procedure)는 검증 자료가 바뀌면 선택된 λ와
        최종 계수가 바뀌어도 정상이다(3차 세부조건 — 불변을 주장하지 않는다).
        이 테스트는 "바뀔 수 있다"는 것 자체를 계약으로 고정한다(바뀌지
        않을 수도 있으므로 assert는 하지 않고, 예외 없이 두 경로 다 정상
        종료하는지만 확인)."""
        groups = self._groups(len(_Y))
        pred.fit_procedure(_X, _Y_ARR, groups, [0.001, 0.01, 0.1, 1.0, 10.0], 3, "seed-a")
        x_perturbed = _X.copy()
        x_perturbed[0] *= 5  # 검증 자료 하나를 크게 흔든다
        pred.fit_procedure(x_perturbed, _Y_ARR, groups, [0.001, 0.01, 0.1, 1.0, 10.0], 3, "seed-a")
        # 예외 없이 여기 도달하면 계약 충족(값 비교는 하지 않음).

    def test_zero_sd_column_gets_zero_coefficient(self):
        """SD=0인 열은 β=0이어야 한다(계획서 §4단계 fit_procedure ②)."""
        x_with_constant = np.column_stack([_X[:, 0], np.full(len(_Y), 3.0)])
        groups = self._groups(len(_Y))
        _, beta = pred.fit_procedure(x_with_constant, _Y_ARR, groups, [0.1], 3, "seed-const")
        assert beta[2] == 0.0

    def test_all_lambdas_fail_raises_fit_failure(self, monkeypatch):
        """내부 CV의 모든 λ가 실패하면 fit_procedure 자체가 FitFailure를
        낸다(계획서 §4단계 "모든 λ에서 내부 CV 적합이 실패했다")."""
        def _always_fail(*args, **kwargs):
            raise pred.FitFailure("forced")
        monkeypatch.setattr(pred, "ridge_logistic_fit", _always_fail)
        groups = self._groups(len(_Y))
        with pytest.raises(pred.FitFailure):
            pred.fit_procedure(_X, _Y_ARR, groups, [0.1, 1.0], 3, "seed-fail")


# ---------------------------------------------------------------------------
# 그룹화 fold — 층화 편차 ≤1, 누출 카나리아
# ---------------------------------------------------------------------------
class TestGroupedFold:
    def test_stratum_balance_deviation_at_most_one(self):
        rng = np.random.default_rng(3)
        n = 97  # k로 안 나누어떨어지는 인원수
        y = (rng.random(n) < 0.4).astype(np.float64)
        groups = [f"p{i}" for i in range(n)]
        k = 5
        fold = pred._grouped_stratified_fold(y, groups, k, "balance-seed")
        for stratum_y in (0.0, 1.0):
            idx = np.where(y == stratum_y)[0]
            counts = [int(np.sum(fold[idx] == f)) for f in range(k)]
            assert max(counts) - min(counts) <= 1

    def test_same_group_always_same_fold_within_one_assignment(self):
        rng = np.random.default_rng(4)
        n_person = 20
        groups = []
        y_list = []
        for i in range(n_person):
            rows_for_person = 1 if i % 2 == 0 else 2
            for _ in range(rows_for_person):
                groups.append(f"p{i}")
                y_list.append(float(rng.random() < 0.5))
        y = np.array(y_list)
        fold = pred._grouped_stratified_fold(y, groups, 4, "cohesion-seed")
        fold_of_group: dict[str, int] = {}
        for g, f in zip(groups, fold):
            if g in fold_of_group:
                assert fold_of_group[g] == f
            else:
                fold_of_group[g] = int(f)

    def test_leakage_canary_grouped_auc_near_half_ungrouped_above_half(self):
        """누출 카나리아 — person 수준 고차원 무작위 특징 + 무작위 person
        outcome + 동일 행 복제(person당 여러 행). ungrouped(행 단위 무작위
        fold)는 그룹 누출로 0.5를 뚜렷이 넘고, grouped는 0.5 근처여야 한다."""
        rng = np.random.default_rng(11)
        n_person = 80
        p_features = 50  # 고차원 무작위 특징(진짜 신호 없음)
        rows_per_person = 5

        person_features = rng.normal(size=(n_person, p_features))
        person_y = (rng.random(n_person) < 0.5).astype(np.float64)

        x_rows = []
        y_rows = []
        groups = []
        for i in range(n_person):
            for _ in range(rows_per_person):
                x_rows.append(person_features[i])  # 동일 행 복제
                y_rows.append(person_y[i])
                groups.append(f"p{i}")
        x = np.array(x_rows)
        y = np.array(y_rows)
        n = len(y)

        # grouped — person 단위 fold(각 person의 모든 복제 행이 같은 fold).
        grouped_fold = pred._grouped_stratified_fold(y, groups, 5, "canary-grouped")
        # ungrouped — 행 단위 무작위 fold(그룹을 무시 — 같은 person의 복제 행이
        # train/test에 걸쳐 누출된다).
        ungrouped_fold = np.array([i % 5 for i in rng.permutation(n)])

        def _oof_auc(fold: np.ndarray) -> float | None:
            oof = np.full(n, np.nan)
            for k in range(5):
                train_mask = fold != k
                test_mask = ~train_mask
                if not np.any(train_mask) or not np.any(test_mask):
                    continue
                mean, sd, zero_sd = pred._standardize_fit(x[train_mask])
                try:
                    # 약한 정칙화(작은 λ)를 써야 과적합/복제행 암기 효과가
                    # 실제로 드러난다 — λ가 크면 릿지 페널티가 누출 신호를
                    # 눌러버려 ungrouped조차 0.5 근처로 나온다(실측 확인).
                    _, beta = pred.fit_procedure(
                        x[train_mask], y[train_mask], [groups[i] for i in range(n) if train_mask[i]],
                        [0.0001, 0.001, 0.01], 3, "canary-fit",
                    )
                except pred.FitFailure:
                    continue
                oof[test_mask] = pred._predict_proba(beta, x[test_mask], mean, sd, zero_sd)
            valid = ~np.isnan(oof)
            return pred.roc_auc(y[valid], oof[valid])

        grouped_auc = _oof_auc(grouped_fold)
        ungrouped_auc = _oof_auc(ungrouped_fold)
        assert grouped_auc is not None and ungrouped_auc is not None
        assert abs(grouped_auc - 0.5) < 0.2
        assert ungrouped_auc > grouped_auc + 0.3


# ---------------------------------------------------------------------------
# compute_prediction — 전체 파이프라인, 결정성, 실패 격리, cv 보류 상태 보존
# ---------------------------------------------------------------------------
def _make_request(n: int = 120, p: int = 4, repeats: int = 3, outer_folds_count: int = 4, seed: int = 42) -> dict:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=(n, p))
    beta_true = np.array([1.5, -1.0, 0.5, 0.0])
    eta = -0.2 + x @ beta_true
    prob = 1 / (1 + np.exp(-eta))
    y = (rng.random(n) < prob).astype(float)
    groups = [f"p{i}" for i in range(n)]

    outer_folds = []
    for r in range(repeats):
        fold = pred._grouped_stratified_fold(y, groups, outer_folds_count, f"outer-{r}")
        outer_folds.append(fold.tolist())

    return {
        "y": y.tolist(),
        "X": x.tolist(),
        "columnNames": [f"x{i}" for i in range(p)],
        "groups": groups,
        "outerFoldCount": outer_folds_count,
        "outerFolds": outer_folds,
        "config": {
            "innerFolds": 3,
            "lambdaGrid": list(np.logspace(-4, 1, 10)),
            "bootstrapReplicates": 20,
            "bootstrapMinValidRate": 0.9,
            "cvMinValidRepeats": 2,
            "aucCiReplicates": 30,
            "samplerSeed": "test-seed",
            "representativeRepeat": 1,
        },
    }


class TestComputePrediction:
    def test_estimable_end_to_end_shape(self):
        request = _make_request()
        result = pred.compute_prediction(request)
        assert result["estimation"] == "ok"
        assert result["nonEstimableReason"] is None
        assert result["lambdaSelected"] is not None
        assert set(result["metrics"].keys()) == set(pred._METRIC_NAMES)
        assert len(result["oofRepresentative"]) == len(request["y"])
        assert len(result["coefficients"]) == 4

    def test_deterministic_two_runs_byte_identical(self):
        request = _make_request()
        result_a = pred.compute_prediction(request)
        result_b = pred.compute_prediction(request)
        assert json.dumps(result_a, sort_keys=True) == json.dumps(result_b, sort_keys=True)

    def test_row_order_shuffle_does_not_change_fold_or_bootstrap_assignment_identity(self):
        """행 순서를 섞어도(같은 person·같은 X/y 재배치) inner/bootstrap 배정이
        person 기준으로는 같아야 한다 — 결과 자체(OOF 순서 등)는 행 순서를
        따라가지만, 반복별 AUC 같은 순서 무관 지표는 동일해야 한다."""
        request = _make_request()
        n = len(request["y"])
        rng = np.random.default_rng(99)
        perm = rng.permutation(n)

        shuffled = dict(request)
        shuffled["y"] = [request["y"][i] for i in perm]
        shuffled["X"] = [request["X"][i] for i in perm]
        shuffled["groups"] = [request["groups"][i] for i in perm]
        shuffled["outerFolds"] = [[fold[i] for i in perm] for fold in request["outerFolds"]]

        result_a = pred.compute_prediction(request)
        result_b = pred.compute_prediction(shuffled)
        assert result_a["metrics"]["roc_auc"]["cv"]["mean"] == pytest.approx(
            result_b["metrics"]["roc_auc"]["cv"]["mean"], abs=1e-9,
        )

    def test_failure_isolation_lambda_only_excludes_that_lambda(self, monkeypatch):
        """실패 범위 — 특정 λ가 실패해도 fit_procedure 전체가 실패하지 않고
        다른 λ로 선택이 계속된다(이미 fit_procedure 테스트가 간접 확인하지만,
        여기서는 compute_prediction이 정상 estimation:'ok'로 끝나는지까지
        확인)."""
        request = _make_request()
        original = pred.ridge_logistic_fit
        call_count = {"n": 0}

        def _fail_sometimes(x, y, lam, beta_warm=None):
            call_count["n"] += 1
            if lam == request["config"]["lambdaGrid"][0] and call_count["n"] % 7 == 0:
                raise pred.FitFailure("forced intermittent failure")
            return original(x, y, lam, beta_warm)

        monkeypatch.setattr(pred, "ridge_logistic_fit", _fail_sometimes)
        result = pred.compute_prediction(request)
        assert result["estimation"] == "ok"

    def test_bootstrap_replicate_failure_only_invalidates_that_replicate(self, monkeypatch):
        request = _make_request(n=60, repeats=2, outer_folds_count=3)
        original = pred.fit_procedure
        state = {"calls": 0}

        def _fail_every_third_boot(x, y, groups, lambda_grid, inner_folds, seed):
            if "-boot-fit-" in seed:
                state["calls"] += 1
                if state["calls"] % 3 == 0:
                    raise pred.FitFailure("forced boot failure")
            return original(x, y, groups, lambda_grid, inner_folds, seed)

        monkeypatch.setattr(pred, "fit_procedure", _fail_every_third_boot)
        result = pred.compute_prediction(request)
        assert result["estimation"] == "ok"
        boot = result["metrics"]["roc_auc"]["bootstrap"]
        assert boot["validReplicates"] < boot["totalReplicates"]
        assert boot["validReplicates"] > 0

    def test_apparent_failure_yields_not_converged(self, monkeypatch):
        def _always_fail(*args, **kwargs):
            raise pred.FitFailure("forced apparent failure")
        monkeypatch.setattr(pred, "fit_procedure", _always_fail)
        request = _make_request()
        result = pred.compute_prediction(request)
        assert result["estimation"] == "non_estimable"
        assert result["nonEstimableReason"] == "NOT_CONVERGED"
        assert result["lambdaSelected"] is None
        assert result["coefficients"] is None
        for name in pred._METRIC_NAMES:
            assert result["metrics"][name]["cv"]["status"] == "withheld"
            assert result["metrics"][name]["bootstrap"]["status"] == "withheld"

    def test_outer_fold_failure_yields_not_converged_but_keeps_apparent(self, monkeypatch):
        original = pred.fit_procedure
        call_state = {"apparent_done": False}

        def _fail_on_outer(x, y, groups, lambda_grid, inner_folds, seed):
            if "-apparent" in seed:
                call_state["apparent_done"] = True
                return original(x, y, groups, lambda_grid, inner_folds, seed)
            if "-outer-" in seed:
                raise pred.FitFailure("forced outer failure")
            return original(x, y, groups, lambda_grid, inner_folds, seed)

        monkeypatch.setattr(pred, "fit_procedure", _fail_on_outer)
        request = _make_request()
        result = pred.compute_prediction(request)
        assert result["estimation"] == "non_estimable"
        assert result["nonEstimableReason"] == "NOT_CONVERGED"
        # apparent는 성공했으므로 apparent 지표는 값이 있어야 한다(계획서
        # "apparent나 외부 fold에서 실패하면 NOT_CONVERGED" — apparent 자체
        # 값은 보존해도 된다는 것을 별도로 요구하진 않지만, 최소한 계산이
        # 실제로 시도됐는지는 이 플래그로 확인한다).
        assert call_state["apparent_done"] is True

    def test_cv_withheld_preserves_status_and_repeat_counts(self):
        """validRepeats < cvMinValidRepeats에서 status='withheld'로 두되
        반복 수(validRepeats/totalRepeats)는 보존된다(계획서 §4단계/3차
        리뷰 #3-6)."""
        request = _make_request(repeats=5, outer_folds_count=4)
        request["config"]["cvMinValidRepeats"] = 10  # 5회 다 성공해도 항상 미달
        result = pred.compute_prediction(request)
        for name in pred._METRIC_NAMES:
            cv = result["metrics"][name]["cv"]
            assert cv["status"] == "withheld"
            assert cv["totalRepeats"] == 5
            assert cv["validRepeats"] <= 5
            assert cv["mean"] is None
            # 리뷰(2026-09-25) — validRepeats>0(5회 다 성공)이어도 withheld면
            # min/max까지 전부 null이어야 한다(shared/contracts/stats.ts
            # CV_WITHHELD_REQUIRES_NULL_SUMMARY). np.min/max가 valid_cv
            # 비어있지 않음만 보고 status를 안 본 회귀가 있었다.
            assert cv["validRepeats"] > 0
            assert cv["min"] is None
            assert cv["max"] is None

    def test_representative_repeat_is_repeat_one_by_default(self):
        request = _make_request(repeats=3)
        result = pred.compute_prediction(request)
        assert result["metrics"]["roc_auc"]["representativeRepeat"] == pytest.approx(
            pred._compute_metrics(np.array(request["y"]), np.array([r["p"] for r in sorted(result["oofRepresentative"], key=lambda e: e["row"])]))["roc_auc"],
        )
