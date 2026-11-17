// App 훅(effect) 호출 순서 골든 — REFACTORING_ROADMAP Phase 2 P2-44a(C3-C). 규칙은 scripts/app-hook-order.mjs 머리 주석.
// C3-C는 App 본문을 컨트롤러 훅으로 꺼내되 effect 등록 순서는 바꾸지 않는다 — 이 골든이 실패하면 순서가 바뀐 것이니
// 코드를 고친다(골든을 갱신하지 않는다).
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { collectHookOrder, effectFreeViolations, findFunctionBody, hookCallsIn } from './app-hook-order.mjs';

const parseTs = (text) => ts.createSourceFile('x.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

describe('App 훅 호출 순서(P2-44a)', () => {
  it('effect를 가진 훅과 자체 effect(deps 글자 포함)의 순서가 골든과 같다', async () => {
    await expect(`${JSON.stringify(collectHookOrder(), null, 2)}\n`).toMatchFileSnapshot('./__goldens__/appHookOrder.json');
  });

  it('순서에서 빼는 커스텀 훅(허용 목록)에는 effect가 없다', () => {
    expect(effectFreeViolations()).toEqual([]);
  });

  it('추출 규칙: 호출 지점 캐스트를 풀고, 콜백 안으로는 내려가지 않는다', () => {
    const sf = parseTs(`
      function App() {
        const a = useA();
        const b = (useB as unknown as (x: object) => number)({});
        const c = (useC!)();
        useEffect(() => { useNotAHookCall(); }, [a]);
        const cb = useCallback(() => useInsideCallback(), []);
        return null;
      }
    `);
    expect(hookCallsIn(findFunctionBody(sf, 'App')).map((c) => c.name))
      .toEqual(['useA', 'useB', 'useC', 'useEffect', 'useCallback']);
  });
});
