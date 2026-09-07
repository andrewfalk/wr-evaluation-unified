// PR0-C §2.2 — person ID는 브라우저에 노출하지 않고, 서버가 실행 범위 안에서만 유효한
// personClusterKey를 부여한다. HMAC-SHA256(key=recipeDigest, message=patientPersonId)의
// 앞 22자(hex) — 같은 recipe로 재실행하면 결정적으로 같은 키가 나오고(§3 결정성 요구),
// recipe가 다르면 다른 키가 나와 실행 범위 밖으로 person 식별자가 새지 않는다.
import { createHmac } from 'crypto';

export function derivePersonClusterKey(recipeDigest: string, patientPersonId: string): string {
  return createHmac('sha256', recipeDigest).update(patientPersonId).digest('hex').slice(0, 22);
}
