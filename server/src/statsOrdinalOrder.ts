// PR1이 statsDescriptiveSuppression.ts 안에 비-export 함수로 만들었던 것을
// PR3-A가 별도 파일로 추출했다(계획서 §"쌍 추출" — statsBivariateDataset.ts도
// 같은 순서 판정이 필요해 재사용해야 하는데, 원래 위치는 export가 안 돼 있었다).
// 신규 카탈로그 필드(levels 등)를 만들지 않는다 — ELBOW_BURDEN_GRADE_ORDER/
// WRIST_BURDEN_GRADE_ORDER가 이미 packages/analytics-core/modules/{elbow,wrist}
// /metadata.ts에 export돼 있어 그걸 그대로 재사용한다.
import {
  ELBOW_BURDEN_GRADE_ORDER,
  ELBOW_FREQUENCY_LEVEL_ORDER,
  ELBOW_FORCE_LEVEL_ORDER,
  ELBOW_REST_DISTRIBUTION_ORDER,
  ELBOW_FREQUENCY_WITH_NONE_ORDER,
} from '@wr/analytics-core/modules/elbow/index';
import {
  WRIST_BURDEN_GRADE_ORDER,
  WRIST_FREQUENCY_LEVEL_ORDER,
  WRIST_FORCE_LEVEL_ORDER,
  WRIST_REST_DISTRIBUTION_ORDER,
  WRIST_FREQUENCY_WITH_NONE_ORDER,
} from '@wr/analytics-core/modules/wrist/index';
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
  // PR0-B4 Slice 8b — job_diagnosis ordinal 변수 8개(9차 검토 P1 재현: 이 등록이 없으면
  // repetitionLevel/forceLevel/awkwardPostureLevel/restDistribution을 쓰는 그룹비교·
  // 분할표가 전부 METHOD_TYPE_MISMATCH로 거부된다).
  if (variableKey === 'elbow.jobDiagnosis.repetitionLevel' || variableKey === 'elbow.jobDiagnosis.awkwardPostureLevel') {
    return ELBOW_FREQUENCY_LEVEL_ORDER;
  }
  if (variableKey === 'elbow.jobDiagnosis.forceLevel') return ELBOW_FORCE_LEVEL_ORDER;
  if (variableKey === 'elbow.jobDiagnosis.restDistribution') return ELBOW_REST_DISTRIBUTION_ORDER;
  if (variableKey === 'wrist.jobDiagnosis.repetitionLevel' || variableKey === 'wrist.jobDiagnosis.awkwardPostureLevel') {
    return WRIST_FREQUENCY_LEVEL_ORDER;
  }
  if (variableKey === 'wrist.jobDiagnosis.forceLevel') return WRIST_FORCE_LEVEL_ORDER;
  if (variableKey === 'wrist.jobDiagnosis.restDistribution') return WRIST_REST_DISTRIBUTION_ORDER;
  // PR0-B4 Slice 8c — BK 분기 ordinal 변수 4개(staticHoldingLevel/directPressureLevel ×
  // elbow/wrist). 9~13차 검토에서 확립된 원칙대로 신규 ordinal은 등록과 동시에 여기 추가한다.
  if (variableKey === 'elbow.jobDiagnosis.staticHoldingLevel' || variableKey === 'elbow.jobDiagnosis.directPressureLevel') {
    return ELBOW_FREQUENCY_WITH_NONE_ORDER;
  }
  if (variableKey === 'wrist.jobDiagnosis.staticHoldingLevel' || variableKey === 'wrist.jobDiagnosis.directPressureLevel') {
    return WRIST_FREQUENCY_WITH_NONE_ORDER;
  }
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
