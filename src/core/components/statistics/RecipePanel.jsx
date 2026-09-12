import { useMemo, useState } from 'react';
import { describeStatsApiError } from './describeStatsError';
import { describeMethodReasonCode } from './describeMethodReasonCode';

// PR3-A — StatsMethodIdSchema(shared/contracts/stats.ts)와 동일 순서·목록. 실행
// 가능 8종 + 예약된 unsupported 2종(대응검정, 계획서 §"실행 가능한 방법은 8종").
const METHOD_LABELS = {
  welch_t: 'Welch t 검정',
  mann_whitney: 'Mann-Whitney U 검정',
  anova: '일원분산분석(Welch)',
  kruskal_wallis: 'Kruskal-Wallis 검정',
  chi_square: '카이제곱 검정',
  fisher_exact: 'Fisher 정확검정',
  pearson_correlation: 'Pearson 상관',
  spearman_correlation: 'Spearman 상관',
  paired_t: '대응 t 검정',
  wilcoxon_signed_rank: 'Wilcoxon 부호순위검정',
};
const METHOD_ORDER = Object.keys(METHOD_LABELS);

const STATUS_LABELS = { available: '실행 가능', conditional: '주의', unsupported: '불가' };

// server/src/statsRecipeValidation.ts의 TYPE_ALLOWED_OPERATORS와 동일 — 서버가 최종 판정하므로
// 여기서 어긋나도 안전하지만(400으로 드러남), UI가 애초에 무효한 조합을 안 보여주기 위해 미러링.
const TYPE_ALLOWED_OPERATORS = {
  continuous: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_missing', 'not_missing'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_missing', 'not_missing'],
  categorical: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  ordinal: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  high_cardinality: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  boolean: ['eq', 'neq', 'is_missing', 'not_missing'],
};

const OPERATOR_LABELS = {
  eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
  between: '범위', in: '포함', is_missing: '결측', not_missing: '결측 아님',
};

const PURPOSE_LABELS = {
  association: '연관성', prediction: '예측', formula_audit: '공식 감사',
};

// PR0-B3 Part A — grain 선택 UI. §2 grain표(마스터 계획서)의 한국어 표기.
const GRAIN_LABELS = {
  person: '사람(person)',
  case: '사례(case)',
  diagnosis_side: '진단측',
  job: '직업력',
  job_diagnosis: '직업력×진단',
  task: '작업',
  vibration_interval: '진동구간',
};

function needsValue(operator) {
  return operator !== 'is_missing' && operator !== 'not_missing';
}

// 1차 리뷰가 잡은 결함 — 연속형만 Number(value), 나머지는 무조건 문자열로 보내던 기존 코드는
// between(배열 아님)·in(배열 아님)·boolean(문자열 "true"/"false")에서 전부 서버 400을 냈고,
// 빈 숫자는 Number('')===0으로 조용히 통과했다. 연산자·타입별로 원시 UI 입력을 서버 계약이
// 요구하는 정확한 형태로 변환하고, 빈/잘못된 입력은 여기서 막는다(server/src/statsRecipeValidation.ts
// 의 isValueOfType·between·in 검증과 대응).
function buildFilterValue(variable, operator, raw) {
  if (!needsValue(operator)) return { ok: true, value: undefined };

  if (variable.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') return { ok: false, error: '값을 선택하세요.' };
    return { ok: true, value: raw === 'true' };
  }

  if (operator === 'between') {
    const [lowerRaw, upperRaw] = Array.isArray(raw) ? raw : ['', ''];
    if (lowerRaw === '' || upperRaw === '') return { ok: false, error: '하한·상한을 모두 입력하세요.' };
    if (variable.type === 'continuous') {
      const lower = Number(lowerRaw);
      const upper = Number(upperRaw);
      if (!Number.isFinite(lower) || !Number.isFinite(upper)) return { ok: false, error: '숫자를 입력하세요.' };
      if (lower > upper) return { ok: false, error: '하한이 상한보다 클 수 없습니다.' };
      return { ok: true, value: [lower, upper] };
    }
    return { ok: true, value: [lowerRaw, upperRaw] }; // date 등 문자열 타입(현재 카탈로그엔 없음)
  }

  if (operator === 'in') {
    const items = String(raw ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (items.length === 0) return { ok: false, error: '값을 하나 이상 입력하세요(쉼표로 구분).' };
    return { ok: true, value: items };
  }

  // eq/neq/gt/gte/lt/lte
  if (variable.type === 'continuous') {
    if (raw === '' || raw === undefined) return { ok: false, error: '값을 입력하세요.' };
    const num = Number(raw);
    if (!Number.isFinite(num)) return { ok: false, error: '숫자를 입력하세요.' };
    return { ok: true, value: num };
  }
  if (!raw) return { ok: false, error: '값을 입력하세요.' };
  return { ok: true, value: raw };
}

// 3차 리뷰가 잡은 결함 — 배열 길이만 보고 판단하면 in:['low','high'](값 2개, 목록)도
// between처럼 "low ~ high"(범위)로 표시돼 포함 조건을 구간 조건으로 오해하게 만든다.
// 연산자를 함께 받아 between만 범위로, in은 항상 쉼표 목록으로 표시한다.
function formatFilterValue(operator, value) {
  if (value === undefined) return '';
  if (operator === 'between' && Array.isArray(value)) return `${value[0]} ~ ${value[1]}`;
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

function emptyRawValueFor(operator) {
  return operator === 'between' ? ['', ''] : '';
}

// 등록일처럼 date 타입 필터는 자유 텍스트로 두면 "2024/01/15"·"2024-01-15T00:00:00Z" 같은
// 형식이 섞여 들어온다 — 서버(statsRecipeValidation.ts)는 YYYY-MM-DD만 엄격히 허용하므로
// (실제 값 비교도 그 형식 기준), 브라우저 네이티브 <input type="date">로 입력 자체를 그
// 형식으로 고정한다(네이티브 date input의 value는 항상 YYYY-MM-DD).
function inputTypeFor(variableType) {
  if (variableType === 'continuous') return 'number';
  if (variableType === 'date') return 'date';
  return 'text';
}

function FilterValueInput({ variable, operator, raw, onChange }) {
  if (!needsValue(operator)) return null;

  if (variable.type === 'boolean') {
    return (
      <select className="swb-search" value={raw || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">값 선택</option>
        <option value="true">참</option>
        <option value="false">거짓</option>
      </select>
    );
  }

  if (operator === 'between') {
    const [lower, upper] = Array.isArray(raw) ? raw : ['', ''];
    return (
      <span style={{ display: 'inline-flex', gap: 4, width: '100%' }}>
        <input
          className="swb-search"
          type={inputTypeFor(variable.type)}
          placeholder="하한"
          value={lower}
          onChange={(e) => onChange([e.target.value, upper])}
        />
        <input
          className="swb-search"
          type={inputTypeFor(variable.type)}
          placeholder="상한"
          value={upper}
          onChange={(e) => onChange([lower, e.target.value])}
        />
      </span>
    );
  }

  if (operator === 'in') {
    return (
      <input
        className="swb-search"
        type="text"
        placeholder="값1, 값2, ... (쉼표로 구분)"
        value={raw || ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <input
      className="swb-search"
      type={inputTypeFor(variable.type)}
      placeholder="값"
      value={raw ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function FilterEditor({ catalogByKey, onAdd }) {
  const keys = Array.from(catalogByKey.keys());
  const [key, setKey] = useState(keys[0] || '');
  const [operator, setOperator] = useState('eq');
  const [raw, setRaw] = useState('');
  const [error, setError] = useState(null);
  const variable = catalogByKey.get(key);
  const allowedOps = variable ? (TYPE_ALLOWED_OPERATORS[variable.type] || []) : [];

  if (keys.length === 0) return null;

  return (
    <div className="swb-card swb-card--muted">
      <select
        className="swb-search"
        value={key}
        onChange={(e) => { setKey(e.target.value); setOperator('eq'); setRaw(''); setError(null); }}
      >
        {keys.map((k) => <option key={k} value={k}>{catalogByKey.get(k).label}</option>)}
      </select>
      <select
        className="swb-search"
        value={operator}
        onChange={(e) => { setOperator(e.target.value); setRaw(emptyRawValueFor(e.target.value)); setError(null); }}
      >
        {allowedOps.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op] || op}</option>)}
      </select>
      <FilterValueInput variable={variable} operator={operator} raw={raw} onChange={(v) => { setRaw(v); setError(null); }} />
      {error && <p className="swb-status-danger" style={{ margin: '4px 0' }}>{error}</p>}
      <button
        type="button"
        className="swb-btn swb-btn--sm"
        onClick={() => {
          if (!key || !operator || !variable) return;
          const result = buildFilterValue(variable, operator, raw);
          if (!result.ok) { setError(result.error); return; }
          onAdd({ key, operator, ...(result.value !== undefined ? { value: result.value } : {}) });
          setRaw(emptyRawValueFor(operator));
          setError(null);
        }}
      >필터 추가</button>
    </div>
  );
}

// PR2 §5/§6 — 레시피 패널: 그레인(case 고정)·변수 칩·분석 목적·공식 정책·필터(적용 버튼으로
// 커밋)·미리보기 카드·실행 버튼. isPreviewCurrent/canExecute는 부모(StatisticsWorkbench)가
// 계산해 내려준다 — 이 컴포넌트는 그 값을 그대로 표시만 한다(계획서 §6 render 시점 판정 원칙).
export function RecipePanel({
  catalog,
  grain = 'case', supportedGrains = ['case'], unsupportedGrains = [], onGrainChange = () => {},
  selectedKeys, onRemoveVariable,
  analysisMode, onAnalysisModeChange, modeChangeBlockedNotice,
  requestedMethod, onRequestedMethodChange,
  analysisPurpose, onAnalysisPurposeChange,
  formulaPolicies, onFormulaPolicyChange,
  filterDraft, onFilterDraftChange, appliedFilters, onApplyFilters,
  previewState, isPreviewCurrent,
  canExecute, isAnalyzing, onRunAnalyze,
  collapsed, onToggleCollapse,
}) {
  const catalogByKey = useMemo(
    () => new Map((catalog?.variables ?? []).map((v) => [v.key, v])),
    [catalog],
  );

  // PR0-B3 Part A — 필터 후보 = 현재 grain 전체(analysisRole 계약은 Part C). 분석 변수
  // 선택은 CatalogPanel이 이미 grain으로 거르므로 여기서는 필터 후보만 별도로 좁힌다.
  const grainCatalogByKey = useMemo(
    () => new Map(Array.from(catalogByKey.entries()).filter(([, v]) => v.grain === grain)),
    [catalogByKey, grain],
  );

  const neededKeys = useMemo(
    () => Array.from(new Set([...selectedKeys, ...filterDraft.map((f) => f.key)])),
    [selectedKeys, filterDraft],
  );

  const formulaFamiliesNeedingChoice = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const key of neededKeys) {
      const v = catalogByKey.get(key);
      if (!v || seen.has(v.formulaFamily)) continue;
      seen.add(v.formulaFamily);
      if (v.supportedFormulaPolicies.length > 1) out.push(v);
    }
    return out;
  }, [neededKeys, catalogByKey]);

  const predictionSupported = (catalog?.variables ?? []).some((v) => v.allowedAnalysisPurposes.includes('prediction'));
  const filtersDirty = JSON.stringify(filterDraft) !== JSON.stringify(appliedFilters);
  const missingFormulaPolicy = formulaFamiliesNeedingChoice.some((v) => !formulaPolicies[v.formulaFamily]);

  if (collapsed) {
    return (
      <aside className="swb-panel swb-panel--collapsed" aria-label="분석 레시피(접힘)">
        <div className="swb-panel-header">
          <button type="button" className="swb-collapse-btn" onClick={onToggleCollapse} aria-expanded={false} title="레시피 펼치기">›</button>
        </div>
        <div className="swb-panel-rail">분석 레시피</div>
      </aside>
    );
  }

  return (
    <aside className="swb-panel swb-panel--recipe" aria-label="분석 레시피">
      <div className="swb-panel-header">
        <span>분석 레시피</span>
        <button type="button" className="swb-collapse-btn" onClick={onToggleCollapse} aria-expanded title="레시피 접기">‹</button>
      </div>
      <div className="swb-panel-body">
        <div className="swb-section-label">그레인</div>
        <div className="swb-seg">
          {supportedGrains.map((g) => (
            <button
              key={g}
              type="button"
              className={`swb-seg-opt${grain === g ? ' swb-seg-opt--active' : ''}`}
              onClick={() => onGrainChange(g)}
            >{GRAIN_LABELS[g] || g}</button>
          ))}
        </div>
        {unsupportedGrains?.length > 0 && (
          <p className="swb-suppressed-note">
            나머지 {unsupportedGrains.length}종은 아직 지원하지 않습니다: {unsupportedGrains.map((u) => GRAIN_LABELS[u.grain] || u.grain).join(', ')}
          </p>
        )}

        {/* PR3-A — 분석 모드. 전환은 부모(StatisticsWorkbench.handleAnalysisModeChange)가
            3개 이상 선택 시 막는다(암묵적 선택 손실 방지, 계획서 §클라이언트배선). */}
        <div className="swb-section-label">분석 모드</div>
        <div className="swb-seg">
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'descriptive' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => onAnalysisModeChange('descriptive')}
          >기술통계</button>
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'bivariate' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => onAnalysisModeChange('bivariate')}
          >이변량</button>
          {/* PR3-B — 상관행렬(계획서 §4). 3개 이상의 연속형 변수를 골라 모든 쌍의
              상관계수를 계산한다. */}
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'correlation_matrix' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => onAnalysisModeChange('correlation_matrix')}
          >상관행렬</button>
        </div>
        {modeChangeBlockedNotice && analysisMode !== 'bivariate' && (
          <p className="swb-status-warn">이변량 모드는 변수를 2개까지만 지원합니다 — 먼저 2개로 줄여주세요.</p>
        )}

        <div className="swb-section-label">분석 목적</div>
        <div className="swb-seg">
          {['association', 'formula_audit', 'prediction'].map((p) => (
            <button
              key={p}
              type="button"
              className={`swb-seg-opt${analysisPurpose === p ? ' swb-seg-opt--active' : ''}`}
              disabled={p === 'prediction' && !predictionSupported}
              onClick={() => onAnalysisPurposeChange(p)}
              title={p === 'prediction' && !predictionSupported ? '현재 지원 변수 없음' : undefined}
            >{PURPOSE_LABELS[p]}</button>
          ))}
        </div>
        {analysisMode === 'descriptive' && (
          <p className="swb-suppressed-note">목적을 골라도 지금 제공하는 분석은 기술통계뿐입니다.</p>
        )}

        {(analysisMode === 'bivariate' || analysisMode === 'correlation_matrix') && (
          <MethodPicker
            previewState={previewState}
            isPreviewCurrent={isPreviewCurrent}
            requestedMethod={requestedMethod}
            onRequestedMethodChange={onRequestedMethodChange}
            onApplyRemedy={(patch) => { if (patch?.requestedMethod) onRequestedMethodChange(patch.requestedMethod); }}
            notReadyMessage={analysisMode === 'correlation_matrix'
              ? '연속형 변수를 3개 이상 선택하면 사용 가능한 방법이 표시됩니다.'
              : '변수를 2개 선택하면 사용 가능한 방법이 표시됩니다.'}
          />
        )}

        <div className="swb-section-label">
          선택 변수 ({selectedKeys.length}
          {analysisMode === 'bivariate' ? '/2' : analysisMode === 'correlation_matrix' ? ', 3개 이상' : ''})
        </div>
        <div>
          {selectedKeys.length === 0 && (
            <p className="swb-suppressed-note">
              좌측 카탈로그에서 변수를 선택하세요.
              {analysisMode === 'correlation_matrix' && ' (연속형 변수만 3개 이상)'}
            </p>
          )}
          {selectedKeys.map((k, i) => (
            <span key={k} className="swb-recipe-chip">
              {analysisMode === 'bivariate' && <strong style={{ marginRight: 4 }}>{i === 0 ? 'x' : 'y'}</strong>}
              {catalogByKey.get(k)?.label || k}
              <button type="button" onClick={() => onRemoveVariable(k)} aria-label={`${k} 제거`}>×</button>
            </span>
          ))}
        </div>

        {formulaFamiliesNeedingChoice.length > 0 && (
          <>
            <div className="swb-section-label">공식 정책</div>
            {formulaFamiliesNeedingChoice.map((v) => (
              <div key={v.formulaFamily} style={{ marginBottom: 6 }}>
                <label style={{ fontSize: 11, color: 'var(--swb-ink-muted)' }}>{v.formulaFamily}</label>
                <select
                  className="swb-search"
                  value={formulaPolicies[v.formulaFamily] || ''}
                  onChange={(e) => onFormulaPolicyChange(v.formulaFamily, e.target.value)}
                >
                  <option value="">선택 필요</option>
                  {v.supportedFormulaPolicies.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            ))}
          </>
        )}

        <div className="swb-section-label">필터 ({appliedFilters.length}개 적용됨)</div>
        {filterDraft.map((f, i) => (
          <span key={`${f.key}-${i}`} className="swb-recipe-chip">
            {catalogByKey.get(f.key)?.label || f.key} {OPERATOR_LABELS[f.operator] || f.operator} {formatFilterValue(f.operator, f.value)}
            <button
              type="button"
              onClick={() => onFilterDraftChange(filterDraft.filter((_, idx) => idx !== i))}
              aria-label="필터 제거"
            >×</button>
          </span>
        ))}
        {filterDraft.length < 10 && (
          // key={grain} — FilterEditor는 key/operator/raw/error를 내부 useState로 갖고
          // 있어 catalogByKey prop만 바뀌는 것으로는 초기화되지 않는다(grain 전환 후
          // 이전 grain의 key가 남아 variable이 undefined가 되고 필터 추가가 조용히
          // 무동작이 될 수 있음) — grain이 바뀌면 컴포넌트를 통째로 재마운트한다.
          <FilterEditor
            key={grain}
            catalogByKey={grainCatalogByKey}
            onAdd={(f) => onFilterDraftChange([...filterDraft, f])}
          />
        )}
        {filtersDirty && (
          <button type="button" className="swb-btn swb-btn--sm" style={{ marginTop: 6 }} onClick={onApplyFilters}>
            필터 적용
          </button>
        )}

        <div className="swb-section-label">분석 범위 미리보기</div>
        <PreviewSummary previewState={previewState} isPreviewCurrent={isPreviewCurrent} catalogByKey={catalogByKey} />

        <button
          type="button"
          className="swb-btn swb-btn--primary"
          style={{ width: '100%', marginTop: 12 }}
          disabled={!canExecute || missingFormulaPolicy}
          onClick={onRunAnalyze}
        >
          {isAnalyzing ? '분석 중…' : '분석 실행'}
        </button>
      </div>
    </aside>
  );
}

// PR3-A §6.9.4 — "분석 목적 아코디언 안"에 방법 선택기를 둔다. availableMethods는
// /preview 응답에서 온다(§파이프라인 — preview는 method 미선택이어도 정상 응답).
// 인원수 관련 차단 사유(B)는 서버가 애초에 세분화해서 안 보낸다 — 그래서 이 UI는
// "왜 안 되는지" 대신 결과가 표본 크기에 따라 표시되지 않을 수 있다는 고정 문구만
// 상시 노출한다(데이터 의존 아님, 계획서 §"방법 가용성 판정").
function MethodPicker({ previewState, isPreviewCurrent, requestedMethod, onRequestedMethodChange, onApplyRemedy, notReadyMessage }) {
  const ready = isPreviewCurrent && previewState.status === 'ready' && !previewState.result?.counts?.suppressed;
  const methods = ready ? (previewState.result?.availableMethods ?? []) : [];
  const byId = new Map(methods.map((m) => [m.id, m]));
  const orderedMethods = METHOD_ORDER.map((id) => byId.get(id)).filter(Boolean);

  return (
    <>
      <div className="swb-section-label">분석 방법</div>
      {!ready && <p className="swb-suppressed-note">{notReadyMessage || '변수를 2개 선택하면 사용 가능한 방법이 표시됩니다.'}</p>}
      {ready && orderedMethods.length === 0 && (
        <p className="swb-suppressed-note">표본 수가 부족해 이용 가능한 방법을 표시할 수 없습니다.</p>
      )}
      {ready && orderedMethods.length > 0 && (
        <div className="swb-method-list">
          {orderedMethods.map((m) => {
            const selected = requestedMethod === m.id;
            const clickable = m.status !== 'unsupported';
            return (
              <div
                key={m.id}
                className={`swb-method-card${selected ? ' swb-method-card--selected' : ''}${clickable ? '' : ' swb-method-card--disabled'}`}
              >
                <button
                  type="button"
                  className="swb-method-card-main"
                  disabled={!clickable}
                  onClick={() => clickable && onRequestedMethodChange(m.id)}
                  title={m.status === 'unsupported' ? describeMethodReasonCode(m.reasonCode) : undefined}
                >
                  <span>{METHOD_LABELS[m.id] || m.label}</span>
                  <span
                    className={
                      m.status === 'available' ? 'swb-status-ok'
                        : m.status === 'conditional' ? 'swb-status-warn'
                          : 'swb-suppressed-note'
                    }
                  >{STATUS_LABELS[m.status] || m.status}</span>
                </button>
                {m.status === 'conditional' && (
                  <p className="swb-status-warn" style={{ margin: '2px 0 0' }}>{describeMethodReasonCode(m.reasonCode)}</p>
                )}
                {m.status === 'unsupported' && m.reasonCode && (
                  <p className="swb-suppressed-note" style={{ margin: '2px 0 0' }}>{describeMethodReasonCode(m.reasonCode)}</p>
                )}
                {m.remedy && m.remedyRecipePatch && (
                  <button type="button" className="swb-btn swb-btn--sm" style={{ marginTop: 4 }} onClick={() => onApplyRemedy(m.remedyRecipePatch)}>
                    {m.remedy}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {/* 데이터 의존 아님 — B(그룹/셀 소수셀·값상수)는 절대 세분화해서 노출하지 않는다는
          설계상, 이 문구는 항상 같은 형태로 상시 표시한다(계획서 §"방법 가용성 판정"). */}
      <p className="swb-suppressed-note">결과가 표본 크기에 따라 표시되지 않을 수 있습니다.</p>
    </>
  );
}

function PreviewSummary({ previewState, isPreviewCurrent, catalogByKey }) {
  if (!isPreviewCurrent || previewState.status === 'idle') {
    return <p className="swb-suppressed-note">변수를 선택하면 미리보기가 표시됩니다.</p>;
  }
  if (previewState.status === 'loading') {
    return <p className="swb-suppressed-note">미리보기 계산 중…</p>;
  }
  if (previewState.status === 'error') {
    return <p className="swb-status-danger" style={{ whiteSpace: 'pre-wrap' }}>미리보기 실패: {describeStatsApiError(previewState.error)}</p>;
  }
  const { counts, estimability } = previewState.result;
  if (counts.suppressed) {
    const reason = counts.reasonCode === 'DIFFERENCING_RATE_LIMIT'
      ? '짧은 시간 내 반복 조회 제한에 걸렸습니다.'
      : `최소 표본(${counts.minimumCohort}명) 미달로 표시할 수 없습니다.`;
    return <p className="swb-status-warn">{reason}</p>;
  }
  return (
    <>
      <div className="swb-metric-grid">
        <div className="swb-metric">
          <div className="swb-metric-value">{counts.personCount}</div>
          <div className="swb-metric-label">person</div>
        </div>
        <div className="swb-metric">
          <div className="swb-metric-value">{counts.caseCount}</div>
          <div className="swb-metric-label">case</div>
        </div>
        <div className="swb-metric">
          <div className="swb-metric-value">{counts.observationCount}</div>
          <div className="swb-metric-label">observation</div>
        </div>
      </div>
      {/* 5차 리뷰가 잡은 누락 — completeCaseN·변수별 결측률·event/non-event를 표시하지 않으면
          estimability 정보를 아예 확인할 방법이 없었다(§6.3). */}
      <table className="swb-table">
        <tbody>
          <tr><th>완전사례 수</th><td>{estimability.completeCaseN ?? '—'}</td></tr>
          {estimability.distinctAssignedDoctorClusters !== null && (
            <tr><th>담당의 클러스터 수</th><td>{estimability.distinctAssignedDoctorClusters}</td></tr>
          )}
          {Object.entries(estimability.missingRatesByVariable).map(([key, rate]) => (
            <tr key={key}>
              <th>결측률({catalogByKey.get(key)?.label || key})</th>
              <td>{rate === null ? '비공개' : `${(rate * 100).toFixed(1)}%`}</td>
            </tr>
          ))}
          {estimability.eventNonEvent.map((e) => (
            <tr key={e.variableKey}>
              <th>event/non-event({catalogByKey.get(e.variableKey)?.label || e.variableKey})</th>
              <td>{e.suppressed ? '비공개' : `${e.events} / ${e.nonEvents}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
