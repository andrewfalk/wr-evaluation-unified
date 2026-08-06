// 종합소견 탭의 "특이 사항 메모"(저장 키: returnConsiderations) 조회 로직.
// 쓰기(AssessmentStep.jsx)는 활성 모듈 전체에 같은 값을 팬아웃 저장하므로, 정상 흐름에서는
// 모듈별 값이 갈릴 일이 없다. 값이 갈리는 건 레거시 데이터(옛 5-모듈 체인 시절) 또는
// 일괄입력으로 특정 모듈에만 값이 들어간 경우뿐이다. 탐색 순서를 결정적으로 고정한다:
// 활성 모듈(지금 화면에 보이는 값이 우선) → 레거시 고정 순서(기존 5-모듈 체인과 동일한
// 값이 나오도록) → 그 외(비활성/향후 모듈에 남은 값도 잃지 않도록 폴백).
const LEGACY_NOTE_ORDER = ['knee', 'wrist', 'shoulder', 'elbow', 'cervical'];

export function selectModuleNote(modules = {}, activeModules = []) {
  const seen = new Set();
  const order = [];
  for (const id of [...activeModules, ...LEGACY_NOTE_ORDER, ...Object.keys(modules || {})]) {
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  for (const id of order) {
    const v = modules?.[id]?.returnConsiderations;
    if (v) return v;
  }
  return '';
}
