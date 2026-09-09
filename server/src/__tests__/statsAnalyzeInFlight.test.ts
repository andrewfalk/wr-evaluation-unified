// PR1 계획서 §4.3/§9-item6 — 생성자/합류자 판정 경쟁 제거 + orphan promise.finally()가
// 만들던 unhandled rejection 제거를 실측 검증한다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getOrCompute, __getInFlightSizeForTests, __resetInFlightForTests } from '../statsAnalyzeInFlight';

describe('statsAnalyzeInFlight.getOrCompute', () => {
  beforeEach(() => {
    __resetInFlightForTests();
  });

  it('두 번째 동시 호출은 합류자(joined=true)이고 compute()는 1회만 호출된다', async () => {
    let resolveCompute!: (v: string) => void;
    const compute = vi.fn(() => new Promise<string>((resolve) => { resolveCompute = resolve; }));

    const a = getOrCompute('digest-1', compute);
    const b = getOrCompute('digest-1', compute);

    expect(a.joined).toBe(false);
    expect(b.joined).toBe(true);
    expect(a.promise).toBe(b.promise);

    // compute는 Promise.resolve().then(compute)로 스케줄되므로(§4.3의 orphan-promise
    // 수정안 그대로) 마이크로태스크 한 틱 뒤에야 실제로 실행된다 — map 등록 자체는 이미
    // 동기로 끝나 있으므로(위 joined/promise 동일성 검증) 경쟁 안전성과는 무관하다.
    await Promise.resolve();
    expect(compute).toHaveBeenCalledTimes(1);

    resolveCompute('result');
    await expect(a.promise).resolves.toBe('result');
    await expect(b.promise).resolves.toBe('result');
  });

  it('DB 조회 지연을 흉내낸 경쟁구간에서도 compute는 정확히 1회만 호출된다', async () => {
    const compute = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20)); // 인위적 지연 — 첫 await 이전에 map 등록이 끝나야 함
      return 'ok';
    });

    // 동시에 여러 요청이 같은 digest로 들어오는 상황을 흉내낸다.
    const results = await Promise.all([
      getOrCompute('digest-2', compute).promise,
      getOrCompute('digest-2', compute).promise,
      getOrCompute('digest-2', compute).promise,
    ]);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(results).toEqual(['ok', 'ok', 'ok']);
  });

  it('완료 후 in-flight map에서 정리된다', async () => {
    const { promise } = getOrCompute('digest-3', async () => 'done');
    await promise;
    expect(__getInFlightSizeForTests()).toBe(0);
  });

  it('실패해도 map에서 정리되고 unhandledRejection이 발생하지 않는다', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const a = getOrCompute('digest-4', async () => { throw new Error('boom'); });
      const b = getOrCompute('digest-4', async () => 'unused');

      await expect(a.promise).rejects.toThrow('boom');
      await expect(b.promise).rejects.toThrow('boom');

      // orphan .finally() Promise가 있었다면 여기서 마이크로태스크 큐에 unhandledRejection이
      // 남아있을 수 있으므로, 이벤트 루프에 한 틱 양보한 뒤 확인한다.
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(__getInFlightSizeForTests()).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('먼저 등록된 요청이 끝난 뒤에는 새 digest 호출로 처리된다(재사용 아님)', async () => {
    const compute = vi.fn(async () => 'first');
    const { promise: p1 } = getOrCompute('digest-5', compute);
    await p1;
    expect(__getInFlightSizeForTests()).toBe(0);

    const compute2 = vi.fn(async () => 'second');
    const { promise: p2, joined } = getOrCompute('digest-5', compute2);
    expect(joined).toBe(false);
    await expect(p2).resolves.toBe('second');
    expect(compute2).toHaveBeenCalledTimes(1);
  });
});
