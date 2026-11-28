// 예측 결과 카드(지표표 · 곡선 · 계수 · 완전사례 기준 인원) — P2-78d에서 ResultPanel.tsx의 선언을 본문 그대로 옮겼다.
import { PREDICTION_REQUIREMENTS } from '../predictionRequirements';
import { CurveChart } from '../../charts/CurveChart';
import { formatStat } from '../../charts/numberFormat';
import { METHOD_LABELS } from '../labels';
import { PREDICTION_NON_ESTIMABLE_LABELS, PREDICTION_METRIC_LABELS, PREDICTION_CAVEAT_LABELS } from './labels';
import type { PredictionMetric } from '@wr/contracts/stats';
import type { PredictionView, CatalogByKey, PredictionBodyLambda } from './types';
import { variableLabel, fmtCi } from './format';

const PREDICTION_CV_WITHHELD_LABELS: Record<string, string> = { LOW_VALID_REPEATS: '유효 반복 수 부족' };
const PREDICTION_BOOTSTRAP_WITHHELD_LABELS: Record<string, string> = {
  APPARENT_UNAVAILABLE: 'apparent 값 없음', LOW_VALID_REPLICATES: '유효 복제 수 부족',
};

function predictionCvCell(cv: PredictionMetric['cv']): string {
  if (cv.status === 'withheld') {
    return `보류: 유효 ${cv.validRepeats}/${cv.totalRepeats}${cv.withheldReason ? ` (${PREDICTION_CV_WITHHELD_LABELS[cv.withheldReason] || cv.withheldReason})` : ''}`;
  }
  return `${formatStat(cv.mean)} [${formatStat(cv.min)}–${formatStat(cv.max)}] (유효 ${cv.validRepeats}/${cv.totalRepeats})`;
}

function predictionBootstrapCell(bootstrap: PredictionMetric['bootstrap']): string {
  if (bootstrap.status === 'withheld') {
    return `보류: 유효 ${bootstrap.validReplicates}/${bootstrap.totalReplicates}${bootstrap.withheldReason ? ` (${PREDICTION_BOOTSTRAP_WITHHELD_LABELS[bootstrap.withheldReason] || bootstrap.withheldReason})` : ''}`;
  }
  const warn = bootstrap.correctedOutOfRange ? ' ⚠ 범위 밖' : '';
  return `${formatStat(bootstrap.corrected)} (유효 ${bootstrap.validReplicates}/${bootstrap.totalReplicates})${warn}`;
}

// PR4-B2 §6단계 "ResultPanel.jsx — PredictionResultCard": 1)억제·추정불가 2)지표표
// 3)곡선/calibration 4)계수 5)주의문 순서. "층화 기준과 결과 카운트는 다를 수
// 있음" 도움말은 personCount(S2, 완전사례 기준 최종 분석자료)와 cohortDigest가
// 만드는 층화 기준(기준 코호트, 예측변수와 무관) 사이의 잠재적 차이를 설명한다.
// 제한데이터 권한자 해제본 전용 — 추정 불가일 때 "완전사례 기준" 인원을 필요 기준과 함께 보여 준다. 미리보기의 사건/비사건 수는
// 결과변수만 관측된 인원이라 예측이 실제로 쓰는 자료(예측변수 값이 모두 있는 사람)와 크게 다를 수 있어, 결측이 많은 변수를 고르면
// "미리보기엔 138명인데 왜 부족하지?"처럼 혼동하기 쉽다.
function PredictionCompleteCaseCounts({ prediction }: { prediction: PredictionView }) {
  const rows = [
    { label: '전체', count: prediction.personCount as number, need: PREDICTION_REQUIREMENTS.minPersons },
    { label: '사건', count: prediction.eventPersonCount as number, need: PREDICTION_REQUIREMENTS.minEventPersons },
    { label: '비사건', count: prediction.nonEventPersonCount as number, need: PREDICTION_REQUIREMENTS.minNonEventPersons },
  ];
  return (
    <>
      <div className="swb-section-label">완전사례 기준 인원 (예측에 실제로 쓰이는 자료)</div>
      <div className="swb-table-scroll">
        <table className="swb-table" aria-label="완전사례 기준 인원">
          <thead><tr><th>구분</th><th>인원</th><th>필요 기준</th><th>판정</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td>{r.count}명</td>
                <td>{r.need}명 이상</td>
                <td>{r.count >= r.need ? '충족' : '부족'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="swb-suppressed-note">
        미리보기의 사건/비사건 수는 결과변수만 관측된 인원입니다. 예측은 선택한 예측변수 값이 모두 있는 사람만 쓰므로, 결측이 많은
        변수를 고르면 이 인원이 훨씬 줄어듭니다(완전사례 제외 {prediction.excludedRowCount}건).
      </p>
    </>
  );
}

export function PredictionResultCard({ prediction, catalogByKey, limitedApplied = false }: { prediction: PredictionView; catalogByKey: CatalogByKey; limitedApplied?: boolean }) {
  if (prediction.suppressed) {
    return (
      <div className="swb-card">
        <strong>{METHOD_LABELS.l2_logistic}</strong>
        <p className="swb-suppressed-note">공개 정책에 따라 결과가 표시되지 않음(표본 크기 등).</p>
      </div>
    );
  }

  const outcomeLabel = variableLabel(catalogByKey, prediction.outcomeKey as string);

  if (prediction.estimation === 'non_estimable') {
    return (
      <div className="swb-card">
        <strong>{METHOD_LABELS.l2_logistic}</strong>
        <p className="swb-card-subtitle">결과변수: {outcomeLabel} (사건={prediction.eventLevel})</p>
        <p className="swb-suppressed-note">
          {PREDICTION_NON_ESTIMABLE_LABELS[prediction.nonEstimableReason as string] || '현재 데이터로 계산할 수 없습니다.'}
        </p>
        {limitedApplied && <PredictionCompleteCaseCounts prediction={prediction} />}
      </div>
    );
  }

  const rocAucMetric = (prediction.metrics as PredictionMetric[]).find((m) => m.metric === 'roc_auc');

  return (
    <div className="swb-card">
      <strong>{METHOD_LABELS.l2_logistic}</strong>
      <p className="swb-card-subtitle">
        결과변수: {outcomeLabel} (사건={prediction.eventLevel}) ·
        {' '}n={prediction.n} · 표본 {prediction.personCount}명(사건 {prediction.eventPersonCount} / 비사건 {prediction.nonEventPersonCount})
      </p>
      <p className="swb-suppressed-note">
        층화 기준(기준 코호트)과 위 표본 수(최종 분석자료, 완전사례)는 서로 다를 수 있습니다 — 기준 코호트는 예측변수 선택과 무관하게 결과변수·필터만으로 정해집니다.
      </p>

      <div className="swb-table-scroll">
        <table className="swb-table" aria-label="예측 성능 지표표">
          <thead>
            <tr><th>지표</th><th>apparent</th><th>CV 평균[최소–최대] (유효 n/R)</th><th>bootstrap 보정 (유효 n/B)</th><th>반복 1</th></tr>
          </thead>
          <tbody>
            {(prediction.metrics as PredictionMetric[]).map((m) => (
              <tr key={m.metric}>
                <td>{PREDICTION_METRIC_LABELS[m.metric] || m.metric}</td>
                <td>{formatStat(m.apparent)}</td>
                <td>
                  {predictionCvCell(m.cv)}
                  {m.metric === 'roc_auc' && prediction.aucCi && (
                    <> · 95% CI {fmtCi([prediction.aucCi.lower, prediction.aucCi.upper])}</>
                  )}
                </td>
                <td>{predictionBootstrapCell(m.bootstrap)}</td>
                <td>{formatStat(m.representativeRepeat)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!prediction.aucCi && rocAucMetric?.cv.status === 'ok' && (
        <p className="swb-suppressed-note">AUC의 95% 신뢰구간은 계산되지 않았습니다.</p>
      )}

      <div className="swb-section-label">ROC 곡선</div>
      <CurveChart curves={prediction.curves} kind="roc" />
      <div className="swb-section-label">PR 곡선</div>
      <CurveChart curves={prediction.curves} kind="pr" />
      <div className="swb-section-label">Calibration 곡선</div>
      <CurveChart curves={prediction.curves} kind="calibration" />
      {prediction.curves?.bins && (
        <p className="swb-suppressed-note">
          곡선과 &apos;반복 1&apos; 지표는 같은 OOF 예측에서 계산했습니다. 곡선은 공개통제로 구간화되어, 면적은 반복 1 AUC와도 다를 수 있습니다. 표의 주 지표는 반복 평균이고 95% CI는 반복 평균 AUC에 대한 것입니다.
        </p>
      )}

      <div className="swb-section-label">계수(표준화, λ={formatStat((prediction.lambda as PredictionBodyLambda).selected)})</div>
      <div className="swb-table-scroll">
        <table className="swb-table" aria-label="예측 계수표">
          <thead><tr><th>변수</th><th>수준</th><th>표준화 계수</th></tr></thead>
          <tbody>
            <tr><td>(절편)</td><td>—</td><td>{formatStat(prediction.coefficients?.intercept)}</td></tr>
            {(prediction.coefficients?.terms || []).map((t) => (
              <tr key={t.term}>
                <td>{variableLabel(catalogByKey, t.variableKey)}</td>
                <td>{t.level ?? '—'}</td>
                <td>{formatStat(t.standardizedBeta)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="swb-suppressed-note">
        ridge(L2 정칙화) 표준화 계수는 개별 변수의 유의성 검정 목적이 아니라 예측 모형 내 상대적 기여도 참고용입니다 — p값·신뢰구간을 제공하지 않습니다.
      </p>

      {(prediction.droppedColumnFoldCount as number) > 0 && (
        <p className="swb-status-warn">
          일부 교차검증 분할에서 값이 상수인 설명변수 열 {prediction.droppedColumnFoldCount}개가 제외됐습니다.
        </p>
      )}
      <p className="swb-suppressed-note">완전사례 제외 {prediction.excludedRowCount}건</p>

      <div className="swb-section-label">주의사항</div>
      <ul>
        {(prediction.caveats as string[]).map((c) => (
          <li key={c} className="swb-suppressed-note">{PREDICTION_CAVEAT_LABELS[c] || c}</li>
        ))}
      </ul>
    </div>
  );
}
