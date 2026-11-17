// 작업 공간 Context 값의 이름 충돌 검사(REFACTORING_ROADMAP Phase 2 C3-C P2-45a). App은 컨트롤러 1~7의 반환을 펼쳐 한 객체로
// 합친다(`{ settings, handleSaveSettings, switchToLocalMode, ...shell, …, ...commands }`) — 같은 이름이 두 컨트롤러에 있으면 뒤의 것이
// 앞의 것을 조용히 가린다(타입 검사도 못 잡는다). 각 컨트롤러의 `return { … }` 객체 리터럴에서 이름을 읽어 겹치지 않음을 확인한다.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ROOT, findFunctionBody } from './app-hook-order.mjs';

const CONTROLLERS = [
  ['useShellController', 'src/app/workspace/useShellController.ts'],
  ['useEnvController', 'src/app/workspace/useEnvController.ts'],
  ['useEditingController', 'src/app/workspace/useEditingController.ts'],
  ['useNavController', 'src/app/workspace/useNavController.ts'],
  ['useSyncController', 'src/app/workspace/useSyncController.ts'],
  ['useDataController', 'src/app/workspace/useDataController.ts'],
  ['useCommandsController', 'src/app/workspace/useCommandsController.ts'],
];
const APP_PROPS = ['settings', 'handleSaveSettings', 'switchToLocalMode'];

function returnedNames(name, rel) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = findFunctionBody(sf, name);
  const ret = body.statements.filter(ts.isReturnStatement).at(-1);
  if (!ret || !ret.expression || !ts.isObjectLiteralExpression(ret.expression)) throw new Error(`${name}: 마지막 return이 객체 리터럴이 아님`);
  return ret.expression.properties.map((p) => {
    if (ts.isShorthandPropertyAssignment(p) || ts.isPropertyAssignment(p)) return p.name.getText(sf);
    throw new Error(`${name}: 펼침(...)·메서드는 쓰지 않는다 — 이름을 검사할 수 없다`);
  });
}

describe('작업 공간 Context 값 이름(P2-45a)', () => {
  it('컨트롤러 1~7 반환과 App 설정 props의 이름이 서로 겹치지 않는다', () => {
    const owner = new Map(APP_PROPS.map((n) => [n, 'App props']));
    const dupes = [];
    for (const [name, rel] of CONTROLLERS) {
      for (const key of returnedNames(name, rel)) {
        if (owner.has(key)) dupes.push(`${key}: ${owner.get(key)} · ${name}`);
        else owner.set(key, name);
      }
    }
    expect(dupes).toEqual([]);
    expect(owner.size).toBeGreaterThan(100);
  });
});
