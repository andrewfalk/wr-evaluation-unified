// PR0-B2 §5.3: Coverage inventory — "6개 모듈에서 변수가 하나 이상 노출됨"만으로는
// 부족하다는 계획서 지적에 대한 응답. 저장되는 모든 필드가 다음 둘 중 하나로 분류돼야
// 한다:
//   - included: 이 필드가 실제로 카탈로그 변수의 dependsOn에 나열돼 분석에 쓰인다.
//   - excluded_with_reason: 아직 카탈로그에 없거나 앞으로도 없을 필드 — 왜 없는지 사유를
//     남긴다(자유서술 · 기술 ID · UI 전용 상태 · PR0-B3 카탈로그 확장 대기 등).
//
// path 표기법은 metadata.ts의 dependsOn과 동일하다: 'shared.name'(단일 필드),
// 'shared.jobs[].startDate'(배열 원소 필드), 'modules.elbow.jobEvaluations[].
// diagnosisEntries[].bk2101_cycle_seconds'(중첩 배열). 이 표기를 그대로 재사용해서
// dependsOn과 기계적으로 대조할 수 있게 한다(coverage.test.ts).

export type CoverageEntry =
  | { included: true }
  | { included: false; reason: string };

export type CoverageInventory = Record<string, CoverageEntry>;

/** 여러 섹션(shared, 모듈별)의 인벤토리를 충돌 검사와 함께 합친다. */
export function mergeInventories(...sections: CoverageInventory[]): CoverageInventory {
  const merged: CoverageInventory = {};
  for (const section of sections) {
    for (const [path, entry] of Object.entries(section)) {
      if (path in merged) {
        throw new Error(`coverage inventory: duplicate path "${path}" across sections`);
      }
      merged[path] = entry;
    }
  }
  return merged;
}
