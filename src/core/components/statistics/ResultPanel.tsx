import { useState } from 'react';
import { describeStatsApiError } from './describeStatsError';
import type { AnalyzeResponse, CatalogVariable } from '@wr/contracts/stats';
import type { ResultRecipeView } from './result/types';
import { LimitedDisclosureBanner } from './result/LimitedDisclosureBanner';
import { Table1Grid } from './result/Table1Grid';
import { ContinuousCard, DiscreteCard, ContinuousDistributionCard, DiscreteDistributionCard } from './result/DescriptiveCards';
import { BivariateResultCard } from './result/BivariateCards';
import { CorrelationMatrixResultCard } from './result/CorrelationMatrixResultCard';
import { RegressionResultCard } from './result/RegressionResultCard';
import { PredictionResultCard } from './result/PredictionResultCard';

export interface ResultExportState {
  status: string;
  error?: unknown;
}

export interface ResultPanelProps {
  catalog: { variables?: CatalogVariable[] } | null | undefined;
  committedRecipe: ResultRecipeView | null;
  committedResult: AnalyzeResponse | null;
  recipeChanged: boolean;
  onExport: () => void;
  exportState: ResultExportState;
  actionsLocked: boolean;
  exportUnsupported: boolean;
}

const TABS = [
  { id: 'summary', label: '요약', enabled: true },
  { id: 'distribution', label: '분포', enabled: true },
  { id: 'association', label: '연관성', enabled: true },
  { id: 'regression', label: '회귀', enabled: true }, // PR4-A1
  { id: 'prediction', label: '예측', enabled: true }, // PR4-B2
];

// PR2 §6/§8 — 결과 패널. committed(마지막 실행 성공 시점의 recipe/result)만 참조하고,
// draft가 그 이후 바뀌면 배너로만 알린다(실행된 결과-조건 연결은 절대 안 바뀜, §6).
// PR3-A — 탭 상태(activeTab)를 신설해 "연관성" 탭에 이변량 결과 카드를 배선한다.
export function ResultPanel({
  catalog, committedRecipe, committedResult, recipeChanged,
  onExport, exportState, actionsLocked, exportUnsupported,
}: ResultPanelProps) {
  const catalogByKey = new Map((catalog?.variables ?? []).map((v) => [v.key, v]));
  // 범주형 "기타" 병합 안내용 — 실행에 쓰인 변수 개수(서버 응답이 아니라 레시피만 본다).
  const variableCount = committedRecipe?.variableKeys?.length ?? 0;
  const [activeTab, setActiveTab] = useState('summary');
  const isBivariateRun = committedRecipe?.analysisMode === 'bivariate';
  // PR3-B — 상관행렬도 descriptive의 continuous/discrete 표를 안 쓰므로 이변량과
  // 같은 분기 처리가 필요하다(요약 탭 메시지, export 잠금 등).
  const isCorrelationMatrixRun = committedRecipe?.analysisMode === 'correlation_matrix';
  // PR4-A1 — 회귀도 동일 원칙. isDescriptiveRun에서 빠뜨리면 회귀 실행이
  // descriptive로 오인돼 요약/분포 탭이 빈 continuous/discrete를 읽다 깨진다
  // (계획서 §5 — 실제 버그 위험 지점으로 명시됐던 곳).
  const isRegressionRun = committedRecipe?.analysisMode === 'regression';
  // PR4-B2 — 동일 원칙(위 PR4-A1 주석 참고). 빠뜨리면 예측 실행이 descriptive로
  // 오인돼 요약/분포 탭이 빈 continuous/discrete를 읽다 깨진다.
  const isPredictionRun = committedRecipe?.analysisMode === 'prediction';
  const isDescriptiveRun = !isBivariateRun && !isCorrelationMatrixRun && !isRegressionRun && !isPredictionRun;
  // Table1 — descriptiveStratified가 있으면 최상위 continuous/discrete는 항상 빈
  // 배열이다(shared/contracts/stats.ts, 진실 공급원 하나만 유지) — 이 값으로
  // 분기해서 일반 카드 스택 대신 Table1Grid를 그린다.
  const descriptiveStratified = isDescriptiveRun ? committedResult?.result?.descriptiveStratified : null;

  return (
    <section className="swb-result" aria-label="결과">
      <div className="swb-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`swb-tab${t.id === activeTab ? ' swb-tab--active' : ''}`}
            disabled={!t.enabled}
            title={t.enabled ? undefined : '현재 제공하지 않음'}
            onClick={() => t.enabled && setActiveTab(t.id)}
          >{t.label}</button>
        ))}
      </div>

      <div className="swb-result-body">
        {recipeChanged && committedResult && (
          <div className="swb-banner" style={{ marginBottom: 12 }}>조건이 변경됨 — 다시 실행 필요</div>
        )}

        {/* 서버가 소수 셀 해제를 지원하는 모드에서만 배너를 보인다 — 기술통계·회귀·이변량·상관행렬·예측 — 전 모드. */}
        {committedResult && (isDescriptiveRun || isRegressionRun || isBivariateRun || isCorrelationMatrixRun || isPredictionRun) && (
          <LimitedDisclosureBanner status={committedResult.result?.limitedDisclosure} />
        )}

        {!committedResult && <div className="swb-empty">좌측에서 변수를 선택하고 &quot;분석 실행&quot;을 눌러주세요.</div>}

        {committedResult && activeTab === 'summary' && (
          descriptiveStratified ? (
            <Table1Grid
              stratified={descriptiveStratified}
              catalogByKey={catalogByKey}
              limitedApplied={committedResult.result?.limitedDisclosure === 'applied'}
            />
          ) : isDescriptiveRun ? (
            <>
              <div className="swb-section-label">연속형</div>
              {committedResult.result.continuous.length === 0 && <p className="swb-suppressed-note">선택된 연속형 변수 없음</p>}
              {committedResult.result.continuous.map((row) => (
                <ContinuousCard key={row.variableKey} catalogByKey={catalogByKey} row={row} />
              ))}

              <div className="swb-section-label">이산형</div>
              {committedResult.result.discrete.length === 0 && <p className="swb-suppressed-note">선택된 이산형 변수 없음</p>}
              {committedResult.result.discrete.map((row) => (
                <DiscreteCard key={row.variableKey} catalogByKey={catalogByKey} row={row} variableCount={variableCount} />
              ))}
            </>
          ) : isRegressionRun ? (
            <p className="swb-suppressed-note">회귀 분석 결과는 &quot;회귀&quot; 탭에서 확인하세요.</p>
          ) : isPredictionRun ? (
            <p className="swb-suppressed-note">예측 분석 결과는 &quot;예측&quot; 탭에서 확인하세요.</p>
          ) : (
            <p className="swb-suppressed-note">
              {isBivariateRun ? '이변량' : '상관행렬'} 분석 결과는 &quot;연관성&quot; 탭에서 확인하세요.
            </p>
          )
        )}

        {committedResult && activeTab === 'distribution' && (
          descriptiveStratified ? (
            <p className="swb-suppressed-note">
              그룹별 비교(Table 1)는 요약 통계만 제공합니다 — 히스토그램/박스플롯 같은
              분포 그래프는 그룹별 보기에서 지원하지 않습니다. 분포가 필요하면 &quot;그룹별
              비교&quot;를 &quot;사용 안 함&quot;으로 바꾼 뒤 다시 실행하세요.
            </p>
          ) : isDescriptiveRun ? (
            <>
              <div className="swb-section-label">연속형 분포</div>
              {committedResult.result.continuous.length === 0 && <p className="swb-suppressed-note">선택된 연속형 변수 없음</p>}
              {committedResult.result.continuous.map((row) => (
                <ContinuousDistributionCard key={row.variableKey} catalogByKey={catalogByKey} row={row} />
              ))}

              <div className="swb-section-label">이산형 분포</div>
              {committedResult.result.discrete.length === 0 && <p className="swb-suppressed-note">선택된 이산형 변수 없음</p>}
              {committedResult.result.discrete.map((row) => (
                <DiscreteDistributionCard key={row.variableKey} catalogByKey={catalogByKey} row={row} variableCount={variableCount} />
              ))}
            </>
          ) : (
            <p className="swb-suppressed-note">기술통계(단변량) 모드로 분석을 실행하면 여기에 분포가 표시됩니다.</p>
          )
        )}

        {committedResult && activeTab === 'association' && (
          isBivariateRun && committedResult.result.bivariate ? (
            <BivariateResultCard
              bivariate={committedResult.result.bivariate}
              catalogByKey={catalogByKey}
              committedRecipe={committedRecipe}
            />
          ) : isCorrelationMatrixRun && committedResult.result.correlationMatrix ? (
            <CorrelationMatrixResultCard
              correlationMatrix={committedResult.result.correlationMatrix}
              catalogByKey={catalogByKey}
            />
          ) : (
            <p className="swb-suppressed-note">이변량 또는 상관행렬 모드로 분석을 실행하면 여기에 결과가 표시됩니다.</p>
          )
        )}

        {committedResult && activeTab === 'regression' && (
          isRegressionRun && committedResult.result.regression ? (
            <RegressionResultCard
              regression={committedResult.result.regression}
              catalogByKey={catalogByKey}
            />
          ) : (
            <p className="swb-suppressed-note">회귀 모드로 분석을 실행하면 여기에 결과가 표시됩니다.</p>
          )
        )}

        {committedResult && activeTab === 'prediction' && (
          isPredictionRun && committedResult.result.prediction ? (
            <PredictionResultCard
              prediction={committedResult.result.prediction}
              catalogByKey={catalogByKey}
              limitedApplied={committedResult.result.limitedDisclosure === 'applied'}
            />
          ) : (
            <p className="swb-suppressed-note">예측 모드로 분석을 실행하면 여기에 결과가 표시됩니다.</p>
          )
        )}

        {/* PR4-A2 — 회귀도 집계 CSV export 지원(exportUnsupported prop이 bivariate/
            correlation_matrix만 막는다 — StatisticsWorkbench.jsx 기준과 동일).
            PR4-B2 — 예측도 집계 CSV export 지원(계수는 서버가 애초에 CSV에 넣지
            않는다 — server/src/stats/export/exportHandler.ts buildPredictionCsv 주석 참고). */}
        {committedResult && (isDescriptiveRun || isRegressionRun || isPredictionRun) && (
          <button
            type="button"
            className="swb-btn"
            style={{ marginTop: 12 }}
            disabled={exportState.status === 'exporting' || actionsLocked || exportUnsupported}
            title={actionsLocked ? '기능을 사용할 수 없는 동안은 내보낼 수 없습니다.' : undefined}
            onClick={onExport}
          >
            {exportState.status === 'exporting' ? '내보내는 중…' : '집계 결과 내보내기 (CSV)'}
          </button>
        )}
        {committedResult && !isDescriptiveRun && !isRegressionRun && !isPredictionRun && (
          <p className="swb-suppressed-note" style={{ marginTop: 12 }}>
            {isBivariateRun ? '이변량' : '상관행렬'} 결과는 아직 CSV 내보내기를 지원하지 않습니다.
          </p>
        )}
        {exportState.status === 'error' && (
          <p className="swb-status-danger" style={{ whiteSpace: 'pre-wrap' }}>내보내기 실패: {describeStatsApiError(exportState.error)}</p>
        )}
      </div>

      {committedResult && (
        <div className="swb-provenance">
          run {committedResult.runManifest.analysisRunId} · snapshot {committedResult.runManifest.snapshotAsOf} ·
          catalog {committedResult.runManifest.catalogVersion} · engine {committedResult.runManifest.engineVersion}
          <br />원본 DB 변경 후 exact rerun은 보장되지 않음 — provenance/무결성 검증용.
        </div>
      )}
    </section>
  );
}
