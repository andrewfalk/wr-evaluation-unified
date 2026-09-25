import { useMemo, useState } from 'react';
import { describeStatsApiError } from './describeStatsError';
import { describeMethodReasonCode } from './describeMethodReasonCode';
import { isGrainCompatible } from '@analytics-core/common';

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
  // PR4-A1 — StatsMethodIdSchema와 동일 순서·목록에 맞춘다. METHOD_ORDER에 없는
  // id는 MethodPicker의 filter(Boolean)에서 조용히 사라진다 — 여기 추가하는 것
  // 자체가 카드 노출의 전제조건이다.
  ols_linear: '선형회귀(OLS)',
  binary_logistic: '이분 로지스틱 회귀',
  // PR4-B2 — StatsMethodIdSchema와 동일 순서·목록.
  l2_logistic: 'L2 정칙화 로지스틱 회귀(ridge)',
};
const METHOD_ORDER = Object.keys(METHOD_LABELS);

const STATUS_LABELS = { available: '실행 가능', conditional: '주의', unsupported: '불가' };

// 통계 배경이 없는 사용자를 위한 방법 카드 툴팁(hover 시 title로 노출) — 이 검정이 뭘
// 비교하는지·결과를 어떻게 읽는지를 2문장 이내로. "p-값이 작을수록…" 같은 공통 해석은
// 여기 반복하지 않고 방법 목록 위에 한 번만 둔다(MethodPicker의 METHOD_LIST_PVALUE_NOTE).
// unsupported 상태는 이미 describeMethodReasonCode()가 title을 채우므로 여기 없음.
const METHOD_TOOLTIPS = {
  welch_t: '두 그룹의 평균을 비교합니다(예: 남/여의 부담점수 평균 차이). 두 그룹의 분산이 달라도 쓸 수 있어 일반 t검정보다 안전합니다.',
  mann_whitney: '두 그룹의 값 순위(분포)를 비교합니다 — 평균 대신 중앙값 차이를 볼 때, 또는 값이 한쪽으로 치우치거나 이상치가 많을 때 Welch t검정보다 안정적입니다.',
  anova: '세 그룹 이상의 평균을 한 번에 비교합니다(예: 직업군 3개의 부담점수). 유의하면 "적어도 한 그룹은 다르다"는 뜻이며, 어느 그룹끼리 다른지는 별도 확인이 필요합니다.',
  kruskal_wallis: '세 그룹 이상을 비교하되 평균이 아니라 순위(분포)로 비교합니다 — 분산분석 조건이 안 맞을 때 대신 씁니다.',
  chi_square: '두 범주형 변수 사이에 연관이 있는지 봅니다(예: 성별과 상병 유무).',
  fisher_exact: '카이제곱검정과 같은 목적(범주형 변수 간 연관)이지만, 표본이 작거나 어느 칸의 인원이 매우 적을 때 더 정확합니다.',
  pearson_correlation: '두 연속형 변수가 함께 커지거나 작아지는 직선적 관계를 −1~+1 사이 값으로 나타냅니다. 0에 가까우면 관계가 약하고, ±1에 가까울수록 강합니다.',
  spearman_correlation: 'Pearson과 같은 목적이지만 직선 관계가 아니라 "한쪽이 커지면 다른 쪽도 대체로 커지는/작아지는" 순위 관계를 봅니다. 이상치에 덜 민감합니다.',
  ols_linear: '결과변수(연속형)를 여러 설명변수로 동시에 설명합니다 — 다른 변수를 보정한 뒤에도 특정 변수의 효과가 남는지 봅니다.',
  binary_logistic: '결과변수(있음/없음 같은 이분형)가 나타날 가능성을 여러 설명변수로 동시에 설명합니다. 계수는 오즈비(OR)로도 함께 표시됩니다.',
  // PR4-B2 — 예측 전용 방법 설명. "연관성"과 달리 예측력 자체(교차검증 성능)를
  // 목적으로 한다는 점을 첫 문장에서 명확히 한다.
  l2_logistic: '결과변수가 나타날 확률을 예측하는 모형의 교차검증 성능(AUC 등)을 봅니다 — 개별 변수의 유의성이 아니라 모형 전체의 예측력이 목적입니다. 연구용 내부검증이며 실제 판정에 쓰지 않습니다.',
};
const METHOD_LIST_PVALUE_NOTE = 'p-값이 작을수록(보통 0.05 미만) 우연이라 보기 어려운 차이·연관으로 해석합니다.';

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

// grain 선택 UI. §2 grain표(마스터 계획서)의 한국어 표기 — grain 단순화(PR0-B4 개정) 후속으로
// person을 다시 삭제해 case(사례)/job(직업)/disease(상병) 3개만 남는다. 라벨은 전부
// "한글(영문)" 패턴으로 통일한다(job이 "직업"으로만 표기돼 있던 게 이전 리뷰에서
// 지적된 불일치). disease는 이름만 바뀐 게 아니라 행 단위 자체가 "상병 건수"가 아니라
// "상병×측"이다(양측 상병=2행, enumerateDiseaseEntities/grainEntities.ts 참고) — 그
// 설명은 라벨이 아니라 아래 disease 전용 안내 문구(관측 행 기준 note)에서 다룬다.
const GRAIN_LABELS = {
  case: '사례(case)',
  job: '직업(job)',
  disease: '상병(disease)',
};

// server/src/statsSnapshotColumnVariables.ts의 REGISTERED_AT_KEY와 동일 리터럴.
const PREDICTION_REGISTERED_AT_KEY = 'case.meta.registeredAt';

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

// PR4-A2 §5 "RecipePanel.jsx" — 회귀 고급 옵션(표준화·interaction·spline·
// eventLevel). <details>/<summary>로 접어둔다(새 CSS/JS 의존성 없이 접근성
// 기본값 유지). eventLevel은 자유 입력이다 — CatalogVariableSchema에 선언 레벨
// 필드가 없어(A1의 referenceLevels와 같은 제약) 관측 레벨을 드롭다운으로 못
// 보여준다. 비워두면 서버가 결정적으로 자동 선택한다(§2 "categorical 2레벨
// outcome" — predictor 기준 레벨 해석과 동일 함수 재사용).
function RegressionAdvancedOptions({
  catalogByKey, outcomeKey, predictorKeys,
  standardizePredictors, onStandardizePredictorsChange,
  interactionTerms, onInteractionTermsChange,
  splineKeys, onSplineKeysChange,
  eventLevel, onEventLevelChange,
}) {
  const [pendingPairA, setPendingPairA] = useState('');
  const [pendingPairB, setPendingPairB] = useState('');

  // spline predictor는 interaction에 전면 금지(v1, 계약 §1) — 선택 UI 단계에서
  // 이미 막아 서버 400(SPLINE_INTERACTION_NOT_SUPPORTED)까지 갈 필요가 없게 한다.
  const splineKeySet = new Set(splineKeys);
  const interactionCandidates = predictorKeys.filter((k) => !splineKeySet.has(k));
  // 이미 interaction에 쓰인 predictor도 spline 후보에서 뺀다(같은 배타 규칙의 반대 방향).
  const predictorsInInteractions = new Set(interactionTerms.flat());
  const splineCandidates = predictorKeys.filter(
    (k) => catalogByKey.get(k)?.type === 'continuous' && !predictorsInInteractions.has(k),
  );

  const outcomeType = outcomeKey ? catalogByKey.get(outcomeKey)?.type : undefined;

  function addInteractionPair() {
    if (!pendingPairA || !pendingPairB || pendingPairA === pendingPairB) return;
    const normalized = [pendingPairA, pendingPairB].sort().join('\u0000');
    const exists = interactionTerms.some(([a, b]) => [a, b].sort().join('\u0000') === normalized);
    if (exists) return;
    onInteractionTermsChange([...interactionTerms, [pendingPairA, pendingPairB]]);
    setPendingPairA('');
    setPendingPairB('');
  }

  return (
    <details className="swb-advanced-options">
      <summary>고급 옵션(표준화·interaction·spline)</summary>

      <label className="swb-checkbox-row">
        <input
          type="checkbox"
          checked={standardizePredictors}
          onChange={(e) => onStandardizePredictorsChange(e.target.checked)}
        />
        연속형 설명변수 표준화(z-score) — spline 대상 변수는 제외됩니다
      </label>

      {outcomeType === 'categorical' && (
        <div className="swb-section-label">
          사건 레벨(eventLevel, 선택)
          <input
            type="text"
            className="swb-search"
            aria-label="사건 레벨"
            placeholder="비워두면 자동 선택"
            value={eventLevel}
            onChange={(e) => onEventLevelChange(e.target.value)}
          />
        </div>
      )}

      <div className="swb-section-label">Spline 대상(연속형만, {splineKeys.length}개)</div>
      <div>
        {splineCandidates.length === 0 && (
          <p className="swb-suppressed-note">spline을 적용할 수 있는 연속형 설명변수가 없습니다.</p>
        )}
        {splineCandidates.map((k) => (
          <label key={k} className="swb-checkbox-row">
            <input
              type="checkbox"
              checked={splineKeys.includes(k)}
              onChange={(e) => {
                if (e.target.checked) onSplineKeysChange([...splineKeys, k]);
                else onSplineKeysChange(splineKeys.filter((x) => x !== k));
              }}
            />
            {catalogByKey.get(k)?.label || k}
          </label>
        ))}
      </div>

      <div className="swb-section-label">Interaction 항({interactionTerms.length}개)</div>
      <div>
        {interactionTerms.map(([a, b], i) => (
          <span key={`${a}-${b}`} className="swb-recipe-chip">
            {(catalogByKey.get(a)?.label || a)} × {(catalogByKey.get(b)?.label || b)}
            <button
              type="button"
              onClick={() => onInteractionTermsChange(interactionTerms.filter((_, idx) => idx !== i))}
              aria-label="interaction 제거"
            >×</button>
          </span>
        ))}
        {interactionCandidates.length >= 2 && (
          <div className="swb-filter-row">
            <select className="swb-search" aria-label="interaction 변수 A" value={pendingPairA} onChange={(e) => setPendingPairA(e.target.value)}>
              <option value="">변수 A</option>
              {interactionCandidates.map((k) => (
                <option key={k} value={k}>{catalogByKey.get(k)?.label || k}</option>
              ))}
            </select>
            <select className="swb-search" aria-label="interaction 변수 B" value={pendingPairB} onChange={(e) => setPendingPairB(e.target.value)}>
              <option value="">변수 B</option>
              {interactionCandidates.map((k) => (
                <option key={k} value={k}>{catalogByKey.get(k)?.label || k}</option>
              ))}
            </select>
            <button type="button" onClick={addInteractionPair}>Interaction 추가</button>
          </div>
        )}
      </div>
    </details>
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
  outcomeKey, onOutcomeKeyChange,
  standardizePredictors = false, onStandardizePredictorsChange = () => {},
  interactionTerms = [], onInteractionTermsChange = () => {},
  splineKeys = [], onSplineKeysChange = () => {},
  eventLevel = '', onEventLevelChange = () => {},
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

  // 필터 후보 = 현재 grain과 호환되는 전체(analysisRole 계약은 별개 — filter_only도
  // 여기선 그대로 둔다). 분석 변수 선택은 CatalogPanel이 이미 grain 호환성으로 거르므로
  // 여기서는 필터 후보만 별도로 좁힌다. grain 단순화(PR0-B4 개정) — 서버와 동일한
  // isGrainCompatible로 case 브로드캐스트 안전 변수도 포함시킨다.
  const grainCatalogByKey = useMemo(
    () => new Map(Array.from(catalogByKey.entries()).filter(([, v]) => isGrainCompatible(v, grain))),
    [catalogByKey, grain],
  );

  // PR4-B2 — 예측 필터는 predictor 역할이거나 등록일(REGISTERED_AT_KEY)만 허용된다
  // (server/src/statsRecipeValidation.ts PREDICTION_FILTER_LEAKAGE — outcome이나
  // outcome과 얽힌 변수를 필터로 쓰면 결과를 미리 알고 거른 셈이 되는 정보누출을
  // 막는다, 계획서 §0단계 "필터"). 그 외 필터는 여기서 아예 후보에서 뺀다 —
  // "필터를 비활성화할 때 사유를 표시한다"(계획서 §6단계).
  const filterCatalogByKey = useMemo(() => {
    if (analysisMode !== 'prediction') return grainCatalogByKey;
    return new Map(Array.from(grainCatalogByKey.entries()).filter(
      ([k, v]) => v.predictionRole === 'predictor' || k === PREDICTION_REGISTERED_AT_KEY,
    ));
  }, [analysisMode, grainCatalogByKey]);

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
  // PR4-B2 — 계획서 §6단계 "outcome과 predictor를 역할별로 필터링한다". CatalogPanel은
  // predictionRole과 무관하게 체크를 허용하므로(회귀와 동일한 원칙 — 역할 제약이 없는
  // 모드도 있다), 여기서 selectedKeys를 역할로 다시 나눈다. StatisticsWorkbench.jsx의
  // predictionEffectiveVariableKeys/isRecipeComplete와 같은 필터 로직이다 — 실제로
  // recipe에 담기는 집합과 화면에 보이는 집합이 어긋나면 안 된다.
  const predictionOutcomeCandidates = useMemo(
    () => selectedKeys.filter((k) => catalogByKey.get(k)?.predictionRole === 'outcome'),
    [selectedKeys, catalogByKey],
  );
  const predictionPredictorKeys = useMemo(
    () => selectedKeys.filter((k) => k !== outcomeKey && catalogByKey.get(k)?.predictionRole === 'predictor'),
    [selectedKeys, outcomeKey, catalogByKey],
  );
  const predictionIgnoredKeys = useMemo(
    () => selectedKeys.filter((k) => k !== outcomeKey && catalogByKey.get(k)?.predictionRole !== 'predictor'),
    [selectedKeys, outcomeKey, catalogByKey],
  );
  // DTO 필드(routes/stats.ts toCatalogVariableDto) — 자유입력이 아니라 이 목록에서만
  // 고른다(계획서 §6단계 "eventLevel select는 DTO의 predictionEventLevels에서 만든다").
  const predictionEventLevels = outcomeKey ? (catalogByKey.get(outcomeKey)?.predictionEventLevels ?? []) : [];
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
        {/* grain 단순화 개정(PR0-B4) — job/disease 기술통계는 case 단위가 아니라 관측 행
            단위다. 브로드캐스트된 인적사항(성별 등)도 그 행 수만큼 반복 집계되므로 사람이
            job을 여러 개 가지면 고유 인원 분포처럼 보이지 않는다 — 계획서 "행 단위 가중
            한계" 절, 오해 방지를 위해 grain 선택 즉시 명시한다. */}
        {(grain === 'job' || grain === 'disease') && (
          <p className="swb-suppressed-note">
            {GRAIN_LABELS[grain]} 기술통계는 <strong>관측 행 기준</strong>입니다 — 브로드캐스트된 인적사항(성별 등)도 그 행 수만큼 반영됩니다(고유 인원 분포가 아닙니다).{' '}
            {grain === 'job'
              ? '예: 한 사람이 직업을 3개 가지면 그 사람의 값이 3행에 그대로 반복됩니다.'
              : '예: 양측 상병 하나는 좌·우 2행으로 나뉘고, 그 사람의 값이 2행에 그대로 반복됩니다.'}
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
          {/* PR4-A1 — 연관성 회귀(계획서 §5). 결과변수 1개 + 설명변수 1개 이상. */}
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'regression' ? ' swb-seg-opt--active' : ''}`}
            onClick={() => onAnalysisModeChange('regression')}
          >회귀</button>
          {/* PR4-B2 — 예측(계획서 §6단계). outcome/predictor는 predictionRole로
              정해진 역할제 선택이라 회귀와 다른 UI를 쓴다(아래). */}
          <button
            type="button"
            className={`swb-seg-opt${analysisMode === 'prediction' ? ' swb-seg-opt--active' : ''}`}
            disabled={!predictionSupported}
            onClick={() => onAnalysisModeChange('prediction')}
            title={!predictionSupported ? '현재 지원 변수 없음' : undefined}
          >예측</button>
        </div>
        {modeChangeBlockedNotice && analysisMode !== 'bivariate' && (
          <p className="swb-status-warn">이변량 모드는 변수를 2개까지만 지원합니다 — 먼저 2개로 줄여주세요.</p>
        )}

        <div className="swb-section-label">분석 목적</div>
        {/* PR4-B2 — analysisMode==='prediction' ⇔ analysisPurpose==='prediction'
            (서버 PURPOSE_MODE_MISMATCH). 예측 모드에서는 부모가 목적을 이미
            'prediction'으로 강제·고정했으므로(handleAnalysisModeChange) 여기서
            다시 고를 필요가 없다 — 목적 선택지에서 'prediction'을 아예 제거하고
            고정 문구로 대신한다(계획서 §6단계 "purpose prediction 옵션을 제거").*/}
        {analysisMode === 'prediction' ? (
          <p className="swb-suppressed-note">예측 모드에서는 분석 목적이 "예측"으로 자동 고정됩니다.</p>
        ) : (
          <div className="swb-seg">
            {['association', 'formula_audit'].map((p) => (
              <button
                key={p}
                type="button"
                className={`swb-seg-opt${analysisPurpose === p ? ' swb-seg-opt--active' : ''}`}
                onClick={() => onAnalysisPurposeChange(p)}
              >{PURPOSE_LABELS[p]}</button>
            ))}
          </div>
        )}
        {analysisMode === 'descriptive' && (
          <p className="swb-suppressed-note">목적을 골라도 지금 제공하는 분석은 기술통계뿐입니다.</p>
        )}

        {(analysisMode === 'bivariate' || analysisMode === 'correlation_matrix' || analysisMode === 'regression' || analysisMode === 'prediction') && (
          <MethodPicker
            previewState={previewState}
            isPreviewCurrent={isPreviewCurrent}
            requestedMethod={requestedMethod}
            onRequestedMethodChange={onRequestedMethodChange}
            onApplyRemedy={(patch) => { if (patch?.requestedMethod) onRequestedMethodChange(patch.requestedMethod); }}
            notReadyMessage={analysisMode === 'correlation_matrix'
              ? '연속형 변수를 3개 이상 선택하면 사용 가능한 방법이 표시됩니다.'
              : analysisMode === 'regression' || analysisMode === 'prediction'
                ? '결과변수 1개와 설명변수 1개 이상을 선택하면 사용 가능한 방법이 표시됩니다.'
                : '변수를 2개 선택하면 사용 가능한 방법이 표시됩니다.'}
          />
        )}

        {/* PR4-A1 §5 — 회귀는 기존 "선택 변수" 칩 목록과 다른 UI를 쓴다: 결과변수
            (outcome)는 <select>로 역할을 지정하고, 나머지가 설명변수(predictor)로
            파생된다. CatalogPanel의 체크박스 선택은 그대로 재사용 — 여기서는
            "이미 고른 변수들 중 무엇이 outcome인지"만 정한다(새로 고르지 않음). */}
        {analysisMode === 'regression' ? (
          <>
            <div className="swb-section-label">결과변수(outcome, 1개)</div>
            {selectedKeys.length === 0 && (
              <p className="swb-suppressed-note">좌측 카탈로그에서 변수를 2개 이상 선택하세요.</p>
            )}
            {selectedKeys.length > 0 && (
              <select
                className="swb-search"
                aria-label="결과변수"
                value={outcomeKey || ''}
                onChange={(e) => onOutcomeKeyChange(e.target.value || null)}
              >
                <option value="">선택 필요</option>
                {selectedKeys.map((k) => (
                  <option key={k} value={k}>{catalogByKey.get(k)?.label || k}</option>
                ))}
              </select>
            )}
            <div className="swb-section-label">
              설명변수(predictor, {Math.max(selectedKeys.length - (outcomeKey ? 1 : 0), 0)}개)
            </div>
            <div>
              {selectedKeys.filter((k) => k !== outcomeKey).length === 0 && (
                <p className="swb-suppressed-note">결과변수 외에 설명변수를 1개 이상 선택하세요.</p>
              )}
              {selectedKeys.filter((k) => k !== outcomeKey).map((k) => (
                <span key={k} className="swb-recipe-chip">
                  {catalogByKey.get(k)?.label || k}
                  <button type="button" onClick={() => onRemoveVariable(k)} aria-label={`${k} 제거`}>×</button>
                </span>
              ))}
            </div>

            <RegressionAdvancedOptions
              catalogByKey={catalogByKey}
              outcomeKey={outcomeKey}
              predictorKeys={selectedKeys.filter((k) => k !== outcomeKey)}
              standardizePredictors={standardizePredictors}
              onStandardizePredictorsChange={onStandardizePredictorsChange}
              interactionTerms={interactionTerms}
              onInteractionTermsChange={onInteractionTermsChange}
              splineKeys={splineKeys}
              onSplineKeysChange={onSplineKeysChange}
              eventLevel={eventLevel}
              onEventLevelChange={onEventLevelChange}
            />
          </>
        ) : analysisMode === 'prediction' ? (
          <>
            <div className="swb-section-label">결과변수(outcome, 1개)</div>
            {predictionOutcomeCandidates.length === 0 && (
              <p className="swb-suppressed-note">좌측 카탈로그에서 예측 결과변수로 쓸 수 있는 변수를 선택하세요.</p>
            )}
            {predictionOutcomeCandidates.length > 0 && (
              <select
                className="swb-search"
                aria-label="결과변수"
                value={outcomeKey || ''}
                onChange={(e) => onOutcomeKeyChange(e.target.value || null)}
              >
                <option value="">선택 필요</option>
                {predictionOutcomeCandidates.map((k) => (
                  <option key={k} value={k}>{catalogByKey.get(k)?.label || k}</option>
                ))}
              </select>
            )}

            {outcomeKey && (
              <div className="swb-section-label">
                사건 레벨(eventLevel)
                <select
                  className="swb-search"
                  aria-label="사건 레벨"
                  value={eventLevel}
                  onChange={(e) => onEventLevelChange(e.target.value)}
                >
                  <option value="">선택 필요</option>
                  {predictionEventLevels.map((lvl) => <option key={lvl} value={lvl}>{lvl}</option>)}
                </select>
              </div>
            )}

            <div className="swb-section-label">설명변수(predictor, {predictionPredictorKeys.length}개)</div>
            <div>
              {predictionPredictorKeys.length === 0 && (
                <p className="swb-suppressed-note">결과변수 외에 예측 설명변수를 1개 이상 선택하세요.</p>
              )}
              {predictionPredictorKeys.map((k) => (
                <span key={k} className="swb-recipe-chip">
                  {catalogByKey.get(k)?.label || k}
                  <button type="button" onClick={() => onRemoveVariable(k)} aria-label={`${k} 제거`}>×</button>
                </span>
              ))}
            </div>
            {predictionIgnoredKeys.length > 0 && (
              <p className="swb-suppressed-note">
                선택했지만 예측에는 쓸 수 없는 변수 {predictionIgnoredKeys.length}개는 제외됩니다:{' '}
                {predictionIgnoredKeys.map((k) => catalogByKey.get(k)?.label || k).join(', ')}
              </p>
            )}
          </>
        ) : (
          <>
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
          </>
        )}

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
        {analysisMode === 'prediction' && (
          <p className="swb-suppressed-note">
            예측 모드에서는 결과와 무관한 필터만 쓸 수 있습니다 — 설명변수이거나 등록일 하나만 허용됩니다(결과를 미리 알고 거르는 정보누출 방지).
          </p>
        )}
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
            key={`${grain}-${analysisMode === 'prediction' ? 'prediction' : 'other'}`}
            catalogByKey={filterCatalogByKey}
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

        {missingFormulaPolicy && (
          <p className="swb-status-warn">위 "공식 정책"에서 선택을 완료해야 분석을 실행할 수 있습니다.</p>
        )}
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
          <p className="swb-suppressed-note" style={{ margin: '0 0 4px' }}>{METHOD_LIST_PVALUE_NOTE}</p>
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
                  title={m.status === 'unsupported' ? describeMethodReasonCode(m.reasonCode) : METHOD_TOOLTIPS[m.id]}
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
