// PR1이 statsDescriptiveSuppression.ts 안에 비-export 함수로 만들었던 것을
// PR3-A가 별도 파일로 추출했다(계획서 §"쌍 추출" — statsBivariateDataset.ts도
// 같은 순서 판정이 필요해 재사용해야 하는데, 원래 위치는 export가 안 돼 있었다).
// 신규 카탈로그 필드(levels 등)를 만들지 않는다 — ELBOW_BURDEN_GRADE_ORDER/
// WRIST_BURDEN_GRADE_ORDER가 이미 packages/analytics-core/modules/{elbow,wrist}
// /metadata.ts에 export돼 있어 그걸 그대로 재사용한다.
import { ELBOW_BURDEN_GRADE_ORDER } from '@wr/analytics-core/modules/elbow/index';
import { WRIST_BURDEN_GRADE_ORDER } from '@wr/analytics-core/modules/wrist/index';

export function getOrdinalOrder(variableKey: string): readonly string[] | null {
  if (variableKey === 'elbow.assessment.burdenGradeMax') return ELBOW_BURDEN_GRADE_ORDER;
  if (variableKey === 'wrist.assessment.burdenGradeMax') return WRIST_BURDEN_GRADE_ORDER;
  return null;
}
