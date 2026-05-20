const SPINE_COMMON_FIELDS = ['verticalDistribution', 'concomitantSpondylosis'];

// 진단 배열 변경 전/후를 비교해, 삭제된 spine 진단에 남아 있던 공통 필드 값을
// 살아남은 spine 진단(우선순위: 첫 번째)에 이송한 새 배열을 반환.
// next에 이미 같은 필드의 값이 있으면 보존(override 안 함).
// prev가 없거나 spine 진단 수가 줄지 않았으면 next 그대로 반환.
export function preserveDeletedSpineCommonFields(prev, next, isSpineDiagnosis) {
  if (!Array.isArray(prev) || !Array.isArray(next)) return next;
  const prevSpineIds = new Set(
    prev.filter(d => d && isSpineDiagnosis(d)).map(d => d?.id).filter(Boolean)
  );
  if (prevSpineIds.size === 0) return next;
  const nextSpineIds = new Set(
    next.filter(d => d && isSpineDiagnosis(d)).map(d => d?.id).filter(Boolean)
  );
  // 삭제된 spine 진단 (id 기반 비교)
  const removedSpineDiags = prev.filter(d => d && isSpineDiagnosis(d) && d?.id && !nextSpineIds.has(d.id));
  if (removedSpineDiags.length === 0) return next;

  // donor 값 결정 — 삭제된 spine 진단 중 non-empty 첫 값
  const donor = {};
  for (const field of SPINE_COMMON_FIELDS) {
    const removed = removedSpineDiags.find(d => d[field]);
    if (removed) donor[field] = removed[field];
  }
  if (Object.keys(donor).length === 0) return next;

  // 살아남은 첫 spine 진단에 빈 필드만 채움 (override 안 함)
  const firstSurvivorIdx = next.findIndex(d => d && isSpineDiagnosis(d));
  if (firstSurvivorIdx < 0) return next; // spine이 모두 사라짐 — 이송 불가
  const survivor = next[firstSurvivorIdx];
  const patch = {};
  for (const field of SPINE_COMMON_FIELDS) {
    if (donor[field] && !survivor[field]) patch[field] = donor[field];
  }
  if (Object.keys(patch).length === 0) return next;
  return next.map((d, i) => (i === firstSurvivorIdx ? { ...d, ...patch } : d));
}

// 척추(spine) 진단 중 첫 번째에만 verticalDistribution/concomitantSpondylosis를 모아두는 정책.
// 변경이 실제로 없으면 입력 배열을 그대로 반환 (참조 동일성 보존) → useEffect 무한 루프 방지.
//
// 정책:
// - 첫 spine 진단에 값이 있으면 그대로 유지 (override 안 함)
// - 빈 필드는 다른 spine 진단 중 첫 non-empty 값을 끌어옴
// - 빈 필드는 굳이 만들지 않음 (donor 값도 비어있으면 키 자체를 추가 안 함)
// - 첫 spine 진단 외의 다른 spine 진단들은 두 필드 모두 제거
export function normalizeSpineAssessmentFields(diagnoses, isSpineDiagnosis) {
  if (!Array.isArray(diagnoses) || diagnoses.length === 0) return diagnoses;

  const spineIndices = [];
  for (let i = 0; i < diagnoses.length; i++) {
    if (isSpineDiagnosis(diagnoses[i])) spineIndices.push(i);
  }
  if (spineIndices.length <= 1) return diagnoses;

  const firstIdx = spineIndices[0];
  const first = diagnoses[firstIdx];
  const otherSpine = spineIndices.slice(1).map(i => diagnoses[i]);

  const firstVD = first.verticalDistribution
    || otherSpine.find(d => d.verticalDistribution)?.verticalDistribution
    || '';
  const firstCS = first.concomitantSpondylosis
    || otherSpine.find(d => d.concomitantSpondylosis)?.concomitantSpondylosis
    || '';

  let changed = false;
  const next = diagnoses.map((d, i) => {
    if (i === firstIdx) {
      const patch = {};
      if (firstVD && d.verticalDistribution !== firstVD) patch.verticalDistribution = firstVD;
      if (firstCS && d.concomitantSpondylosis !== firstCS) patch.concomitantSpondylosis = firstCS;
      if (Object.keys(patch).length === 0) return d;
      changed = true;
      return { ...d, ...patch };
    }
    if (spineIndices.includes(i)) {
      const hasV = 'verticalDistribution' in d;
      const hasC = 'concomitantSpondylosis' in d;
      if (!hasV && !hasC) return d;
      const { verticalDistribution: _v, concomitantSpondylosis: _c, ...rest } = d;
      changed = true;
      return rest;
    }
    return d;
  });
  return changed ? next : diagnoses;
}
