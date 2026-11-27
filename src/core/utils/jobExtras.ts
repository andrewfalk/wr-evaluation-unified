// 직력별 extras 배열의 "있으면 고치고, 없으면 만든다"(REFACTORING_ROADMAP Phase 2 C8, P2-68b).
// 무릎·어깨 JobTab의 handleExtra가 같은 골격을 각자 갖고 있던 것을 한 곳으로 모았다. 같은 골격이 core videoMapping.js에도
// 있어 나중에 쓸 수 있게 core에 둔다(모듈의 _shared에 두면 core가 import할 수 없다). 무릎·어깨 index의 preset·일괄 가져오기
// upsert와 videoMapping.js는 의미가 조금씩 달라(원본 변경·기존 값 대체·팩토리 값 덮어쓰기) 여기로 옮기지 않았다.
export interface JobExtraLike {
  sharedJobId: string;
}

/**
 * sharedJobId가 같은 extras가 있으면 그 자리를 `{ ...기존, ...patch }`로 바꾸고, 없으면 `{ ...factory(sharedJobId), ...patch }`를
 * 끝에 붙인 **새 배열**을 돌려준다(입력 배열은 고치지 않는다).
 */
export function upsertJobExtra<T extends JobExtraLike>(
  extras: readonly T[],
  sharedJobId: string,
  factory: (sharedJobId: string) => T,
  patch: Partial<T>,
): T[] {
  const updated = [...extras];
  const idx = updated.findIndex(e => e.sharedJobId === sharedJobId);
  if (idx >= 0) {
    updated[idx] = { ...updated[idx], ...patch };
  } else {
    updated.push({ ...factory(sharedJobId), ...patch });
  }
  return updated;
}
