// 끊김을 따르는 fetch 래퍼(P2-81b) 자체의 단위 테스트 — 브라우저 fetch처럼 끊기면 AbortError로 거부하는지, 기록이 맞는지.
import { describe, expect, it } from 'vitest';
import { createAbortableFetch } from '../abortableFetch';

function controllable() {
  const pending: Array<{ url: string; resolve(response: Response): void; reject(error: unknown): void }> = [];
  const inner = (input: string | URL | Request) => new Promise<Response>((resolve, reject) => {
    pending.push({ url: String(input), resolve, reject });
  });
  return { inner, pending };
}

describe('createAbortableFetch', () => {
  it('signal이 없으면 안쪽 응답을 그대로 돌려준다', async () => {
    const { inner, pending } = controllable();
    const wrapped = createAbortableFetch(inner);
    const promise = wrapped.fetch('https://x.test/a', { method: 'post', body: '{"n":1}', headers: { 'X-A': '1' } });
    pending[0].resolve(new Response('{"ok":true}', { status: 200 }));
    await expect((await promise).json()).resolves.toEqual({ ok: true });
    expect(wrapped.calls).toHaveLength(1);
    expect(wrapped.calls[0]).toMatchObject({ method: 'POST', url: 'https://x.test/a', body: { n: 1 }, headers: { 'X-A': '1' }, sent: true });
    expect(wrapped.calls[0].signal).toBe('none');
  });

  it('응답 전에 끊기면 AbortError로 거부하고, 늦게 온 안쪽 응답은 버린다', async () => {
    const { inner, pending } = controllable();
    const wrapped = createAbortableFetch(inner);
    const controller = new AbortController();
    const promise = wrapped.fetch('https://x.test/slow', { signal: controller.signal });
    expect(wrapped.calls[0].signal).toBe('live');
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(wrapped.calls[0].signal).toBe('aborted'); // 읽는 시점의 상태
    pending[0].resolve(new Response('{}'));          // 늦게 와도 아무 일 없음
    expect(wrapped.calls[0].sent).toBe(true);
  });

  it('이미 끊긴 signal이면 안쪽을 부르지 않고 곧바로 거부한다', async () => {
    const { inner, pending } = controllable();
    const wrapped = createAbortableFetch(inner);
    const controller = new AbortController();
    controller.abort();
    await expect(wrapped.fetch('https://x.test/never', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(pending).toHaveLength(0);
    expect(wrapped.calls[0]).toMatchObject({ sent: false, signal: 'aborted' });
  });

  it('Request 객체로 불러도 그 signal을 따른다(init이 없을 때)', async () => {
    const { inner, pending } = controllable();
    const wrapped = createAbortableFetch(inner);
    const done = new AbortController();
    done.abort();
    await expect(wrapped.fetch(new Request('https://x.test/req', { method: 'POST', signal: done.signal })))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(pending).toHaveLength(0);
    expect(wrapped.calls[0]).toMatchObject({ method: 'POST', sent: false, signal: 'aborted' });

    const live = new AbortController();
    const promise = wrapped.fetch(new Request('https://x.test/req2', { signal: live.signal }));
    expect(wrapped.calls[1].signal).toBe('live');
    live.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(wrapped.calls[1].signal).toBe('aborted');
  });

  it('응답이 온 뒤의 끊김은 무시하고, 안쪽 실패는 그대로 전한다', async () => {
    const { inner, pending } = controllable();
    const wrapped = createAbortableFetch(inner);
    const controller = new AbortController();
    const ok = wrapped.fetch('https://x.test/ok', { signal: controller.signal });
    pending[0].resolve(new Response('{"v":2}'));
    const response = await ok;
    controller.abort();
    await expect(response.json()).resolves.toEqual({ v: 2 });

    const failing = wrapped.fetch('https://x.test/fail', { signal: new AbortController().signal });
    pending[1].reject(new TypeError('network down'));
    await expect(failing).rejects.toThrow('network down');
  });
});
