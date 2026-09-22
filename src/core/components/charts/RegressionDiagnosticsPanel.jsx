import { ScatterPlot } from './ScatterPlot';
import { SuppressionNotice } from './SuppressionNotice';
import { formatNumber } from './numberFormat';

// PR4-A2 §5 "RegressionDiagnosticsPanel.jsx" — VIF/condition number(집계,
// 권한 무관 표시) + 진단 4패널(limited_row, pointDiagnosticsStatus에 따라
// 5단계로 분기). 4번째 패널(leverage vs 표준화잔차)은 Cook's D를 점 반지름으로
// 인코딩한다 — 색이 아니라 크기를 쓰는 이유는 유의성을 색으로 표시하지 않는
// palette.js §6.8.3 원칙과 같다(상태색은 예약, 계열색 재사용 금지).
const STATUS_MESSAGES = {
  not_requested: '아직 진단을 요청하지 않았습니다.',
  unavailable_no_access: '행 단위 진단(잔차·leverage·Cook\'s D)을 보려면 권한이 필요합니다.',
  unavailable_model: '이 모형은 leverage 계열 진단을 계산할 수 없습니다.',
  unavailable_computation_failed: '일시적으로 진단 계산에 실패했습니다 — 계수·적합도 결과는 정상입니다.',
};

const UNSUPPORTED_REASON_LABELS = {
  QR_DECOMPOSITION_FAILED: '설계행렬 분해에 실패했습니다.',
  NEAR_SINGULAR_LEVERAGE: '일부 관측치의 leverage가 1에 가까워 계산할 수 없습니다.',
  INVALID_DIAGNOSTIC_SCALE: '잔차 척도가 퇴화해(완전적합 등) 계산할 수 없습니다.',
};

function pointsScatter(points, xOf, yOf) {
  return {
    points: points.map((p) => [xOf(p), yOf(p)]),
    displayedCount: points.length,
    totalCount: points.length,
  };
}

// Cook's D → 점 반지름. 0에 가까우면 기본 반지름(3), 크면 최대 반지름(10)까지
// 완만하게 커지도록 sqrt 스케일(면적이 Cook's D에 비례하도록 — 반지름을 선형으로
// 키우면 시각적 크기 차이가 과장된다).
function cooksRadius(cooksDistance) {
  if (!Number.isFinite(cooksDistance) || cooksDistance <= 0) return 3;
  return Math.min(10, 3 + 7 * Math.sqrt(Math.min(cooksDistance, 1)));
}

export function RegressionDiagnosticsPanel({ diagnostics, method, isPersonCluster }) {
  if (!diagnostics) return null;
  const { conditionNumber, vif, pointDiagnosticsStatus, pointDiagnosticsUnsupportedReason, pointDiagnostics, displayedPointCount, totalPointCount } = diagnostics;

  const vifTable = (vif && vif.length > 0) ? (
    <div className="swb-table-scroll">
      <table className="swb-table" aria-label="VIF">
        <thead><tr><th>변수</th><th>VIF</th></tr></thead>
        <tbody>
          {vif.map((v, i) => (
            <tr key={`${v.termName}-${i}`}>
              <td>{v.termName}</td>
              <td>{v.vif === null ? '계산 불가' : formatNumber(v.vif, 2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null;

  return (
    <div className="swb-card">
      <strong>다중공선성·회귀 진단</strong>
      <p className="swb-suppressed-note">
        Condition number: {conditionNumber === null ? '계산 불가' : formatNumber(conditionNumber, 1)}
        {' '}— 열별 설계행렬 VIF(참고용, GVIF 아님)
      </p>
      {vifTable}

      {pointDiagnosticsStatus !== 'available' && (
        <SuppressionNotice>
          {STATUS_MESSAGES[pointDiagnosticsStatus] || STATUS_MESSAGES.unavailable_computation_failed}
          {pointDiagnosticsUnsupportedReason && pointDiagnosticsStatus === 'unavailable_model'
            ? ` (${UNSUPPORTED_REASON_LABELS[pointDiagnosticsUnsupportedReason] || pointDiagnosticsUnsupportedReason})`
            : ''}
        </SuppressionNotice>
      )}

      {pointDiagnosticsStatus === 'available' && pointDiagnostics && (
        <>
          <p className="swb-suppressed-note">표시 중 {displayedPointCount} / 전체 {totalPointCount}건</p>
          {method === 'binary_logistic' && (
            <p className="swb-suppressed-note">
              로지스틱 회귀의 표준화잔차는 정상 모형에서도 정규분포를 따르지 않을 수 있습니다 — Q-Q 플롯을 OLS와 같은 정규성 기준으로 해석하지 마십시오.
            </p>
          )}
          {isPersonCluster && (
            <p className="swb-suppressed-note">
              반복행 자료의 Cook's D는 행 단위 영향도이며, 한 사람의 모든 행을 제거했을 때의 효과(person 전체 제거 영향도)가 아닙니다.
            </p>
          )}

          <p className="swb-card-subtitle">잔차 vs 적합값</p>
          <ScatterPlot scatter={pointsScatter(pointDiagnostics, (p) => p.fittedValue, (p) => p.residual)} />

          <p className="swb-card-subtitle">Normal Q-Q</p>
          <ScatterPlot scatter={pointsScatter(pointDiagnostics, (p) => p.theoreticalQuantile, (p) => p.standardizedResidual)} />

          <p className="swb-card-subtitle">Scale-Location</p>
          <ScatterPlot
            scatter={pointsScatter(pointDiagnostics, (p) => p.fittedValue, (p) => Math.sqrt(Math.abs(p.standardizedResidual)))}
          />

          <p className="swb-card-subtitle">Leverage vs 표준화잔차(점 크기 = Cook's D)</p>
          <ScatterPlot
            scatter={pointsScatter(pointDiagnostics, (p) => p.leverage, (p) => p.standardizedResidual)}
            pointRadiusAccessor={(_, i) => cooksRadius(pointDiagnostics[i].cooksDistance)}
          />
        </>
      )}
    </div>
  );
}
