"""OneEuro 필터 (1€ filter) — keypoint/각도 시계열 평활화 (6.0-6a).
참조: Casiez et al., "1€ Filter". jitter는 줄이고 lag은 최소화."""
import math


def _alpha(cutoff, dt):
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class OneEuroFilter:
    def __init__(self, min_cutoff=1.0, beta=0.0, d_cutoff=1.0):
        self.min_cutoff = float(min_cutoff)
        self.beta = float(beta)
        self.d_cutoff = float(d_cutoff)
        self._x_prev = None
        self._dx_prev = 0.0
        self._t_prev = None

    def __call__(self, x, t):
        if x is None or (isinstance(x, float) and math.isnan(x)):
            return x
        if self._x_prev is None:
            self._x_prev = x
            self._t_prev = t
            return x
        dt = max(1e-6, t - self._t_prev)
        dx = (x - self._x_prev) / dt
        a_d = _alpha(self.d_cutoff, dt)
        dx_hat = a_d * dx + (1 - a_d) * self._dx_prev
        cutoff = self.min_cutoff + self.beta * abs(dx_hat)
        a = _alpha(cutoff, dt)
        x_hat = a * x + (1 - a) * self._x_prev
        self._x_prev = x_hat
        self._dx_prev = dx_hat
        self._t_prev = t
        return x_hat
