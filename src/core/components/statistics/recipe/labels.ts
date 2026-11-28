// 레시피 패널(RecipePanel)만 쓰는 라벨·표 — P2-78b에서 본체 머리의 표를 그대로 옮겼다.
// 결과 패널과 문구까지 같던 METHOD_LABELS는 ../labels.ts(METHOD_ORDER는 그 키 순서를 따른다).
import type { StatsFilterOperator } from '@wr/contracts/stats';
import { METHOD_LABELS } from '../labels';

export const METHOD_ORDER = Object.keys(METHOD_LABELS);

export const STATUS_LABELS: Record<string, string> = { available: '실행 가능', conditional: '주의', unsupported: '불가' };

// 통계 배경이 없는 사용자를 위한 방법 카드 툴팁(hover 시 title로 노출) — 이 검정이 뭘
// 비교하는지·결과를 어떻게 읽는지를 2문장 이내로. "p-값이 작을수록…" 같은 공통 해석은
// 여기 반복하지 않고 방법 목록 위에 한 번만 둔다(MethodPicker의 METHOD_LIST_PVALUE_NOTE).
// unsupported 상태는 이미 describeMethodReasonCode()가 title을 채우므로 여기 없음.
export const METHOD_TOOLTIPS: Record<string, string> = {
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
export const METHOD_LIST_PVALUE_NOTE = 'p-값이 작을수록(보통 0.05 미만) 우연이라 보기 어려운 차이·연관으로 해석합니다.';

// server/src/stats/recipe/validate/filters.ts의 TYPE_ALLOWED_OPERATORS와 동일 — 서버가 최종 판정하므로
// 여기서 어긋나도 안전하지만(400으로 드러남), UI가 애초에 무효한 조합을 안 보여주기 위해 미러링.
export const TYPE_ALLOWED_OPERATORS: Record<string, StatsFilterOperator[]> = {
  continuous: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_missing', 'not_missing'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'is_missing', 'not_missing'],
  categorical: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  ordinal: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  high_cardinality: ['eq', 'neq', 'in', 'is_missing', 'not_missing'],
  boolean: ['eq', 'neq', 'is_missing', 'not_missing'],
};

export const OPERATOR_LABELS: Record<string, string> = {
  eq: '=', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
  between: '범위', in: '포함', is_missing: '결측', not_missing: '결측 아님',
};

// grain 선택 UI. §2 grain표(마스터 계획서)의 한국어 표기 — grain 단순화(PR0-B4 개정) 후속으로
// person을 다시 삭제해 case(사례)/job(직업)/disease(상병) 3개만 남는다. 라벨은 전부
// "한글(영문)" 패턴으로 통일한다(job이 "직업"으로만 표기돼 있던 게 이전 리뷰에서
// 지적된 불일치). disease는 이름만 바뀐 게 아니라 행 단위 자체가 "상병 건수"가 아니라
// "상병×측"이다(양측 상병=2행, enumerateDiseaseEntities/grainEntities.ts 참고) — 그
// 설명은 라벨이 아니라 아래 disease 전용 안내 문구(관측 행 기준 note)에서 다룬다.
export const GRAIN_LABELS: Record<string, string> = {
  case: '사례(case)',
  job: '직업(job)',
  disease: '상병(disease)',
};

// 사용자 요청 — 표시 순서를 사례·상병·직업으로. 서버가 주는 supportedGrains 원본 순서
// (Array.from(SUPPORTED_GRAINS) — server/src/stats/recipe/grains.ts, 계약상 'case','job','disease')는 그대로 두고
// 화면에서만 재배열한다(서버 순서에 의존하는 테스트·계약을 건드리지 않기 위함).
export const GRAIN_DISPLAY_ORDER = ['case', 'disease', 'job'];
