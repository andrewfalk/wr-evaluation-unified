// BK2117 어깨 누적 노출 해석 규칙 — 판정 한 곳(Phase 2 C7-a P2-61a).
// 소견서 문장(어깨 서술) · EMR b6·b8 문장 · AI 입력의 해석 키가 모두 이 판정을 쓴다. 문장은 쓰는 쪽에 있다.
// 서버 프롬프트 계약(shared/contracts/aiPrompt.ts)의 문장은 별도의 판이다(계약이라 바꾸지 않는다).

export type Bk2117InterpretationKind = 'exceeded' | 'combinedSufficient' | 'insufficient';

export interface Bk2117Interpretation {
  kind: Bk2117InterpretationKind;
  /** kind가 'exceeded'일 때 기준을 넘은 항목의 라벨(totals 순서). 그 밖에는 빈 배열. */
  exceededLabels: string[];
}

/** 판정에 쓰는 노출 합계 한 줄(computeShoulderCalc의 totals 원소 중 쓰는 것만). */
export interface Bk2117TotalLike {
  label?: string;
  ratio?: number;
  exceeded?: boolean;
}

/**
 * 판정 순서: 기준을 넘은 항목이 있으면 'exceeded' → 기준 대비 50% 이상이 3개 이상이거나 75% 이상이 2개 이상이면
 * 'combinedSufficient'(복합 노출) → 그 밖에는 'insufficient'. totals가 없으면 빈 목록으로 본다.
 */
export function classifyBk2117Interpretation(totals: readonly Bk2117TotalLike[] | null | undefined): Bk2117Interpretation {
  const list = totals || [];
  const exceeded = list.filter((t) => t.exceeded);
  if (exceeded.length > 0) {
    return { kind: 'exceeded', exceededLabels: exceeded.map((t) => t.label ?? '') };
  }
  const over75 = list.filter((t) => Number(t.ratio) >= 0.75);
  const over50 = list.filter((t) => Number(t.ratio) >= 0.5);
  if (over50.length >= 3 || over75.length >= 2) return { kind: 'combinedSufficient', exceededLabels: [] };
  return { kind: 'insufficient', exceededLabels: [] };
}
