// PR1이 statsDescriptiveSuppression.ts 안에 비-export 함수로 만들었던 것을
// PR3-A가 별도 파일로 추출했다(계획서 §"쌍 추출" — statsBivariateDataset.ts도
// 같은 순서 판정이 필요해 재사용해야 하는데, 원래 위치는 export가 안 돼 있었다).
// 신규 카탈로그 필드(levels 등)를 만들지 않는다 — ELBOW_BURDEN_GRADE_ORDER/
// WRIST_BURDEN_GRADE_ORDER가 이미 packages/analytics-core/modules/{elbow,wrist}
// /metadata.ts에 export돼 있어 그걸 그대로 재사용한다.
import { ELBOW_BURDEN_GRADE_ORDER } from '@wr/analytics-core/modules/elbow/index';
import { WRIST_BURDEN_GRADE_ORDER } from '@wr/analytics-core/modules/wrist/index';
// PR0-B3 Part B — diagnosis_side grain 2종(K-L Grade/Ellman Class)도 같은 재사용 패턴.
import { KNEE_KLG_ORDER } from '@wr/analytics-core/modules/knee/index';
import { SHOULDER_ELLMAN_ORDER } from '@wr/analytics-core/modules/shoulder/index';
// PR0-B3 Part C 리뷰 보완 — categorical 변수 중 "고정된 값 집합"을 가진 것(부위군 6종)의
// 선언 순서. 담당의처럼 값 집합이 조직 데이터마다 달라지는 categorical은 여기 등록하지
// 않는다 — statsBivariateRoles.ts의 resolveLevelOrder가 관측값에서 동적으로 순서를 만든다.
import { DIAGNOSIS_MODULE_GROUP_ORDER } from '@wr/analytics-core/modules/diagnosis/index';

export function getOrdinalOrder(variableKey: string): readonly string[] | null {
  if (variableKey === 'elbow.assessment.burdenGradeMax') return ELBOW_BURDEN_GRADE_ORDER;
  if (variableKey === 'wrist.assessment.burdenGradeMax') return WRIST_BURDEN_GRADE_ORDER;
  if (variableKey === 'knee.diagnosisSide.klGrade') return KNEE_KLG_ORDER;
  if (variableKey === 'shoulder.diagnosisSide.ellmanClass') return SHOULDER_ELLMAN_ORDER;
  return null;
}

/** categorical 변수 중 고정 순서가 선언된 것만 여기 등록한다(값 자체엔 의학적 순서가
 * 없지만 groupPairsByLevel()이 축 순서를 결정하려면 결정적인 순서가 필요하다 — 의미는
 * 없고 결정성만 있으면 된다). 미등록 categorical은 resolveLevelOrder가 관측값으로부터
 * 동적으로 순서를 만든다(담당의 등 값 집합이 고정돼 있지 않은 변수). */
export function getCategoricalOrder(variableKey: string): readonly string[] | null {
  if (variableKey === 'diagnosis.identity.moduleGroup') return DIAGNOSIS_MODULE_GROUP_ORDER;
  return null;
}
