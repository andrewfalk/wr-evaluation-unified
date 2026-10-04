// 분석 목적(analysisPurpose) 표시 라벨 — RecipePanel(목적 선택 메뉴)·CatalogPanel(비호환 툴팁)·
// describeStatsError(오류 문구)가 같이 쓴다. RecipePanel 안에 두면 describeStatsError가
// RecipePanel을 import하는 순환이 되므로 별도 모듈로 둔다.
export const PURPOSE_LABELS = {
  association: '연관성', prediction: '예측', formula_audit: '공식 감사',
};

export function purposeLabel(purpose) {
  return PURPOSE_LABELS[purpose] || purpose;
}

/** 변수의 allowedAnalysisPurposes를 "연관성, 예측" 형태로. */
export function describeAllowedPurposes(variable) {
  return (variable?.allowedAnalysisPurposes || []).map(purposeLabel).join(', ');
}
