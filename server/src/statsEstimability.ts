// PR0-C §C(2단계)/§F — estimability 신호 계산 + person 단위 소수 셀 억제. DB/네트워크
// 의존 없는 순수 함수(단위테스트 용이). §C 1단계(personCount<MINIMUM_COHORT 전체 게이트)는
// 이 함수를 호출하는 쪽(routes/stats.ts)의 책임이다 — 이 함수는 그 게이트를 통과한
// 뒤에만 호출된다는 전제로 동작한다.
import type { AnalyticsVariableMetadata } from '@wr/analytics-core';
import type { DatasetRow } from './statsDatasetBuilder';
import { isSmallCell } from './statsSmallCell';

export interface EventNonEventEntry {
  variableKey: string;
  events: number | null;
  nonEvents: number | null;
  suppressed: boolean;
}

export interface EstimabilityResult {
  completeCaseN: number | null;
  missingRatesByVariable: Record<string, number | null>;
  candidateParameterCount: null;
  eventNonEvent: EventNonEventEntry[];
}

function distinctPersons(rows: DatasetRow[]): number {
  return new Set(rows.map((r) => r.personClusterKey)).size;
}

export function computeEstimability(
  rows: DatasetRow[],
  variableKeys: string[],
  catalogByKey: Map<string, AnalyticsVariableMetadata>,
): EstimabilityResult {
  const caseCount = rows.length;

  // §F completeCaseN — variableKeys 전부가 missing===null인 사례(표시값은 사례 수).
  const isRowComplete = (row: DatasetRow) => variableKeys.every((key) => row.values[key]?.missing === null);
  const completeRows = rows.filter(isRowComplete);
  const incompleteRows = rows.filter((r) => !isRowComplete(r));
  const completeCaseN =
    isSmallCell(distinctPersons(completeRows)) || isSmallCell(distinctPersons(incompleteRows))
      ? null
      : completeRows.length;

  const missingRatesByVariable: Record<string, number | null> = {};
  const eventNonEvent: EventNonEventEntry[] = [];

  for (const key of variableKeys) {
    const variable = catalogByKey.get(key);
    const missingRows = rows.filter((r) => r.values[key]?.missing !== null);
    const presentRows = rows.filter((r) => r.values[key]?.missing === null);
    const missingPersonCount = distinctPersons(missingRows);
    const presentPersonCount = distinctPersons(presentRows);

    if (variable?.type === 'boolean') {
      // §C — boolean 변수는 missingRate와 eventNonEvent를 하나의 억제 단위로 묶는다.
      // 셋(missing/event/nonEvent) 중 하나라도 소수 셀이면 셋 다 함께 억제한다 — 그래야
      // "caseCount - events - nonEvents = missingCount" 같은 산수로 역산되지 않는다.
      const eventRows = presentRows.filter((r) => r.values[key]?.value === true);
      const nonEventRows = presentRows.filter((r) => r.values[key]?.value === false);
      const eventPersonCount = distinctPersons(eventRows);
      const nonEventPersonCount = distinctPersons(nonEventRows);

      const suppressed =
        isSmallCell(missingPersonCount) || isSmallCell(eventPersonCount) || isSmallCell(nonEventPersonCount);

      missingRatesByVariable[key] = suppressed || caseCount === 0 ? null : missingRows.length / caseCount;
      eventNonEvent.push({
        variableKey: key,
        events: suppressed ? null : eventRows.length,
        nonEvents: suppressed ? null : nonEventRows.length,
        suppressed,
      });
      continue;
    }

    const suppressed = isSmallCell(missingPersonCount) || isSmallCell(presentPersonCount);
    missingRatesByVariable[key] = suppressed || caseCount === 0 ? null : missingRows.length / caseCount;
  }

  return {
    completeCaseN,
    missingRatesByVariable,
    // outcome/predictor 구분이 레시피에 없어 정의 불가 — 항상 null(§F).
    candidateParameterCount: null,
    eventNonEvent,
  };
}
