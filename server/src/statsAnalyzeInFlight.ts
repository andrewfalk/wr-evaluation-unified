// PR1 §4.3 — 동시 요청 합류. "생성자/합류자" 판정은 호출 시점(첫 await 이전, 동기)에
// 확정한다 — map 확인부터 등록까지 Node 단일 스레드 안에서 한 틱에 끝나므로 다른 요청이
// 끼어들 수 없다. cleanup까지 포함한 하나의 Promise 체인을 map에 저장하고 그대로
// 반환한다(저장/반환 Promise가 항상 동일 객체) — orphan `.finally()` Promise가 만드는
// unhandled rejection을 피하기 위함(과거 판이 겪은 결함, 계획서 §4.3 참고).
const inFlight = new Map<string, Promise<unknown>>();

export interface GetOrComputeResult<T> {
  promise: Promise<T>;
  /** true면 이 호출은 이미 진행 중인 계산에 올라탄 합류자 — compute()를 부르지 않았다. */
  joined: boolean;
}

export function getOrCompute<T>(digest: string, compute: () => Promise<T>): GetOrComputeResult<T> {
  const existing = inFlight.get(digest);
  if (existing) {
    return { promise: existing as Promise<T>, joined: true };
  }

  const promise: Promise<T> = Promise.resolve()
    .then(compute)
    .finally(() => {
      if (inFlight.get(digest) === promise) inFlight.delete(digest);
    });
  inFlight.set(digest, promise);
  return { promise, joined: false };
}

/** 테스트 전용 — map 크기를 확인하거나 강제로 비운다. */
export function __getInFlightSizeForTests(): number {
  return inFlight.size;
}
export function __resetInFlightForTests(): void {
  inFlight.clear();
}
