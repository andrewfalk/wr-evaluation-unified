// PR0-C §2.2 — person ID는 브라우저에 노출하지 않고, 서버가 실행 범위 안에서만 유효한
// personClusterKey를 부여한다. HMAC-SHA256(key=recipeDigest, message=patientPersonId)의
// 앞 22자(hex) — 같은 recipe로 재실행하면 결정적으로 같은 키가 나오고(§3 결정성 요구),
// recipe가 다르면 다른 키가 나와 실행 범위 밖으로 person 식별자가 새지 않는다.
import { createHmac } from 'crypto';

export function derivePersonClusterKey(recipeDigest: string, patientPersonId: string): string {
  return createHmac('sha256', recipeDigest).update(patientPersonId).digest('hex').slice(0, 22);
}

// PR4-B2 — 예측 전용 person 키(계획서 §3-1단계). personClusterKey와 같은 HMAC 구조지만
// recipeDigest가 아니라 cohortDigest(예측변수와 무관 — statsPredictionCohort.ts)로
// 키를 유도한다. personClusterKey를 재사용하지 않는 이유: recipe(=변수 선택)가 바뀌면
// personClusterKey도 바뀌어, predictor를 하나 추가/제거할 때마다 fold 배정이 흔들리는
// 문제가 재발한다(3차 리뷰 #3-1).
export function derivePredictionCohortPersonKey(cohortDigest: string, patientPersonId: string): string {
  return createHmac('sha256', cohortDigest).update(patientPersonId).digest('hex').slice(0, 22);
}
