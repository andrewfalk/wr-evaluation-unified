// Retry of a whole transaction on PostgreSQL deadlock_detected (40P01). Moved from routes/patients.ts
// (P1-27) so routes/workspaces.ts no longer imports from another route module; bodies unchanged.

interface PgErrorLike {
  code?: string;
}

// PostgreSQL deadlock_detected. 두 환자가 서로 등록번호를 맞바꾸면
// 〈T1: 새 person B 보유 → 옛 person A 대기〉 vs 〈T2: B 보유 → A 대기〉로 순환 대기가
// 생길 수 있다(새 person은 resolve 시점에 INSERT될 수도 있어 UUID 정렬 선점이 불가능).
// PostgreSQL이 한쪽을 희생시켜 중단하므로, 희생된 쪽만 다시 돌리면 성공한다.
export function isDeadlock(err: unknown): boolean {
  return (err as PgErrorLike | null)?.code === '40P01';
}

const DEADLOCK_MAX_ATTEMPTS = 3;

// 핸들러가 deadlock으로 던지면 제한 횟수만큼 다시 실행한다.
// deadlock은 트랜잭션 내부 query에서 발생하고 그 시점엔 응답을 쓰기 전이므로 재실행이 안전하다.
// 상한을 넘으면 마지막 오류를 그대로 올려 라우트의 500 핸들러가 받는다.
export async function withDeadlockRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (err) {
      if (!isDeadlock(err) || attempt >= DEADLOCK_MAX_ATTEMPTS) throw err;
    }
  }
}
