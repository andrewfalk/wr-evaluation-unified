import { WBV_FORMULA_LABEL, WBV_FORMULA_TITLE } from '../utils/formulaVersion';

const riskIcon = { danger: '⛔', warning: '⚠️', safe: '✅' };
const statusLabel = { safe: '✓ 미만', warning: '⚠ 걸침', danger: '✗ 초과' };

const fmt = (v, d = 2) => (Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '-');

// calc은 computeVibrationCalc 결과(=상위 calc.vibration 서브객체)를 받는다.
export function VibrationResultPanel({ calc }) {
  if (!calc || calc.evalMethod !== 'wbv') return null;

  // present일 때만 결과 패널 표시. unknown(미평가)·none(노출없음)은 공간 절약을 위해 미표시.
  const exposureStatus = calc.exposureStatus || 'unknown';
  if (exposureStatus !== 'present') return null;

  const { jobResults, amax8, dv, comparison, validation, risk } = calc;
  const multiJob = (jobResults || []).filter(jr => (jr.intervals || []).length > 0).length > 1;
  const amaxLabel = multiJob ? '직업별 최대 일일 Amax(8)' : '일일 Amax(8)';

  return (
    <div className="panel">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title">
            <span className="section-icon">&#x1F4CA;</span>전신진동(BK 2110) 결과
            <span className="spine-formula-badge is-v513" title={WBV_FORMULA_TITLE}>
              {WBV_FORMULA_LABEL}
            </span>
          </h2>
          <p className="section-description">진동가속도 범위(하한~상한)로 산출한 일일 Amax(8)·평생 누적용량 DV와 기준 비교를 보여줍니다.</p>
        </div>
      </div>

      <div className="result-panel">
        {validation?.hasInvalidIntervals && (
          <div className="result-risk-banner level-danger">
            <div className="result-risk-icon">{'⚠️'}</div>
            <div>
              <div className="result-risk-title level-danger">유효하지 않은 진동작업 구간</div>
              <div className="result-risk-copy">{(validation.messages || []).join(' ')}</div>
            </div>
          </div>
        )}

        <div className="result-summary-grid">
          <div className="result-summary-card">
            <div className="result-summary-label">{amaxLabel}</div>
            <div className="result-summary-value">
              {fmt(amax8?.min)} ~ {fmt(amax8?.max)} <span className="result-summary-unit">m/s²</span>
            </div>
            <div className="result-summary-sub">기준 0.63 m/s²</div>
          </div>
          <div className={`result-summary-card ${comparison?.lifetime?.status === 'danger' ? 'is-danger' : ''}`}>
            <div className="result-summary-label">평생 누적용량 DV</div>
            <div className="result-summary-value">
              {fmt(dv?.min, 0)} ~ {fmt(dv?.max, 0)} <span className="result-summary-unit">(m/s²)²</span>
            </div>
            <div className="result-summary-sub">기준 1400 (m/s²)²</div>
          </div>
        </div>

        <div className={`result-risk-banner level-${risk.level}`}>
          <div className="result-risk-icon">{riskIcon[risk.level]}</div>
          <div>
            <div className={`result-risk-title level-${risk.level}`}>{risk.text}</div>
            <div className="result-risk-copy">{risk.description}</div>
          </div>
        </div>

        <div>
          <div className="result-section-heading">
            <div className="result-section-title">기준 비교 (범위)</div>
            <div className="result-section-caption">일일 Amax(8) 0.63 / 평생 DV 1400 대비 비율</div>
          </div>
          <div className="result-detail-stack">
            {[
              { key: 'daily', name: '일일 Amax(8) 기준(0.63)', data: comparison.daily, unit: 'm/s²' },
              { key: 'lifetime', name: '평생 DV 기준(1400)', data: comparison.lifetime, unit: '(m/s²)²' },
            ].map(({ key, name, data }) => (
              <div key={key} className="result-detail-card">
                <div className="result-card-top result-card-top-tight">
                  <div>
                    <span className="result-card-title">{name}</span>
                    <span className={`result-status-badge level-${data.status}`}>{statusLabel[data.status]}</span>
                  </div>
                  <div className="result-card-meta">
                    <span className={`result-value-highlight ${data.status !== 'safe' ? `level-${data.status}` : ''}`}>
                      {fmt(data.percent.min, 0)}% ~ {fmt(data.percent.max, 0)}%
                    </span>
                  </div>
                </div>
                <div className="result-progress-track">
                  <div
                    className={`result-progress-fill level-${data.status}`}
                    style={{ width: `${Math.min(100, data.percent.max)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>

        {multiJob && (
          <div>
            <div className="result-section-heading">
              <div className="result-section-title">직업별 진동 노출 내역</div>
              <div className="result-section-caption">직력별 일일 Amax(8)·평생 DV 범위</div>
            </div>
            <div className="result-detail-stack">
              {jobResults.map((jr, i) => (
                (jr.intervals || []).length > 0 && (
                  <div key={jr.jobId} className="result-detail-card">
                    <div className="result-card-title">직력{i + 1}: {jr.jobName} ({jr.periodYears.toFixed(1)}년)</div>
                    <div className="result-metric-list result-metric-list-spaced">
                      <div className="result-metric-row"><span>일일 Amax(8)</span><strong>{fmt(jr.amax8.min)} ~ {fmt(jr.amax8.max)} m/s²</strong></div>
                      <div className="result-metric-row"><span>평생 DV</span><strong>{fmt(jr.dv.min, 0)} ~ {fmt(jr.dv.max, 0)} (m/s²)²</strong></div>
                      <div className="result-card-meta">포함 구간: {(jr.intervals || []).length}개</div>
                    </div>
                  </div>
                )
              ))}
            </div>
          </div>
        )}

        <div className="result-detail-card">
          <div className="result-section-caption">참고 (예방·규제 기준)</div>
          <div className="result-card-meta result-card-meta-bottom">
            일일 조치값 A(8) = {calc.actionValue} m/s² · z축 한계값 = {calc.limitZ} m/s²
          </div>
        </div>
      </div>
    </div>
  );
}
