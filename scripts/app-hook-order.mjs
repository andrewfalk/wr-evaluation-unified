#!/usr/bin/env node
/**
 * scripts/app-hook-order.mjs — App 훅 호출 순서 추출(REFACTORING_ROADMAP Phase 2 P2-44a, C3-C).
 *
 * App 한 fiber의 passive·layout effect는 **등록 순서대로** 돈다. C3-C는 App 본문을 컨트롤러 훅(src/app/workspace/*)으로
 * 꺼내지만 effect 등록 순서는 바꾸지 않는다 — 이 스크립트가 그 순서를 목록으로 뽑고, scripts/appHookOrder.test.mjs가
 * 골든(scripts/__goldens__/appHookOrder.json)과 비교한다.
 *
 * 규칙:
 *   - App 함수 본문을 소스 순서로 훑어 `useXxx(` 호출을 모은다. 함수 안(콜백·effect 본문)으로는 내려가지 않는다.
 *   - src/app/workspace/*.ts(x)에 선언된 훅(컨트롤러)은 그 본문을 같은 규칙으로 **펼친다**(컨트롤러 자체는 기록하지 않는다
 *     — 펼친 결과가 옛 App 본문과 같아야 한다).
 *   - 자체 `useEffect`·`useLayoutEffect`·`useInsertionEffect`는 deps 배열의 글자(공백 정규화)와 함께 기록한다.
 *   - effect가 없는 React 내장 훅(useState·useRef·useMemo·useCallback 등)과 EFFECT_FREE_HOOKS의 커스텀 훅은 기록하지
 *     않는다(위치를 옮겨도 effect 순서가 바뀌지 않는다). 허용 목록 훅에 effect가 없다는 것은 테스트가 확인한다.
 *   - 그 밖의 커스텀 훅은 이름을 기록한다(안에 effect가 있다 — 순서 고정 대상).
 *
 * Usage: node scripts/app-hook-order.mjs   # 순서를 출력
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** App 셸 파일 — P2-46a에서 src/App.jsx → src/app/App.tsx로 옮긴다(앞의 것이 있으면 그것). */
export const APP_SHELL_CANDIDATES = ['src/app/App.tsx', 'src/App.jsx'];
export const CONTROLLER_DIR = 'src/app/workspace';

const REACT_NON_EFFECT = new Set([
  'useState', 'useRef', 'useMemo', 'useCallback', 'useReducer', 'useContext', 'useId',
  'useTransition', 'useDeferredValue', 'useSyncExternalStore', 'useDebugValue',
]);
const REACT_EFFECT = new Set(['useEffect', 'useLayoutEffect', 'useInsertionEffect']);

/** effect가 없는 커스텀 훅(이름 → 선언 파일). 본문에 effect·커스텀 훅 호출이 없다는 것을 테스트가 확인한다. */
export const EFFECT_FREE_HOOKS = {
  useAuth: 'src/core/auth/AuthContext.jsx',
  usePatientsContainer: 'src/core/state/patientStore/usePatientsContainer.ts',
  useModalState: 'src/app/useModalState.ts',
  useScreenRouter: 'src/app/useScreenRouter.ts',
  useAIAvailable: 'src/core/hooks/useAIAvailable.js',
  useStepNavigation: 'src/core/hooks/useStepNavigation.js',
  useSyncStatusSummary: 'src/core/hooks/useSyncStatusSummary.js',
  usePatientList: 'src/core/hooks/usePatientList.js',
};

const HOOK_NAME = /^use[A-Z0-9]/;

function scriptKind(file) {
  const ext = path.extname(file);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.ts') return ts.ScriptKind.TS;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function parse(rel) {
  const text = readFileSync(path.join(ROOT, rel), 'utf8');
  return ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
}

/** 파일에서 이름이 `name`인 함수(function 선언 또는 const = 화살표/함수 식)의 본문. */
export function findFunctionBody(sourceFile, name) {
  let found = null;
  const visit = (node) => {
    if (found) return;
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) { found = node.body; return; }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      found = node.initializer.body;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

const isFunctionLike = (node) => ts.isArrowFunction(node) || ts.isFunctionExpression(node)
  || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node);

/**
 * 호출 대상의 식별자 — JS 훅을 TS에서 부를 때의 호출 지점 캐스트 `(useX as unknown as T)(…)`(선례 WorkspaceBoundary.tsx)를
 * 풀어 `useX`로 본다. 식별자가 아니면 null.
 */
export function calleeName(expression) {
  let e = expression;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)
    || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return ts.isIdentifier(e) ? e.text : null;
}

/** 본문을 소스 순서로 훑어 훅 호출 `{ name, node }`를 모은다(함수 안으로는 내려가지 않는다). */
export function hookCallsIn(body) {
  const calls = [];
  const visit = (node) => {
    if (node !== body && isFunctionLike(node)) return;
    const name = ts.isCallExpression(node) ? calleeName(node.expression) : null;
    if (name && HOOK_NAME.test(name)) {
      calls.push({ name, node });
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return calls;
}

function controllerBodies() {
  const map = new Map();
  const dir = path.join(ROOT, CONTROLLER_DIR);
  if (!existsSync(dir)) return map;
  for (const entry of readdirSync(dir)) {
    if (!/\.(ts|tsx)$/.test(entry) || entry.endsWith('.d.ts')) continue;
    const rel = `${CONTROLLER_DIR}/${entry}`;
    const sf = parse(rel);
    const visit = (node) => {
      if (ts.isFunctionDeclaration(node) && node.name && HOOK_NAME.test(node.name.text) && node.body) {
        map.set(node.name.text, node.body);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return map;
}

export function appShellPath() {
  const found = APP_SHELL_CANDIDATES.find((rel) => existsSync(path.join(ROOT, rel)));
  if (!found) throw new Error(`App 셸 파일이 없다: ${APP_SHELL_CANDIDATES.join(', ')}`);
  return found;
}

const squash = (text) => text.replace(/\s+/g, ' ').trim();

/** App(+ 펼친 컨트롤러)의 effect 순서 목록. */
export function collectHookOrder() {
  const rel = appShellPath();
  const appBody = findFunctionBody(parse(rel), 'App');
  if (!appBody) throw new Error(`${rel}에서 function App을 찾지 못했다`);
  const controllers = controllerBodies();
  const out = [];
  const expand = (body, stack) => {
    for (const { name, node } of hookCallsIn(body)) {
      if (REACT_NON_EFFECT.has(name) || Object.hasOwn(EFFECT_FREE_HOOKS, name)) continue;
      if (REACT_EFFECT.has(name)) {
        const deps = node.arguments[1];
        out.push(`${name} ${deps ? squash(deps.getText()) : '(deps 없음)'}`);
        continue;
      }
      if (controllers.has(name)) {
        if (stack.includes(name)) throw new Error(`컨트롤러 순환: ${[...stack, name].join(' → ')}`);
        expand(controllers.get(name), [...stack, name]);
        continue;
      }
      out.push(name);
    }
  };
  expand(appBody, []);
  return out;
}

/** 허용 목록 훅 본문의 훅 호출 — React 내장 비-effect 훅만 있어야 한다. 위반 목록을 돌려준다. */
export function effectFreeViolations() {
  const violations = [];
  for (const [name, rel] of Object.entries(EFFECT_FREE_HOOKS)) {
    const body = findFunctionBody(parse(rel), name);
    if (!body) { violations.push(`${name}: ${rel}에서 선언을 찾지 못함`); continue; }
    const inner = [];
    const visit = (node) => {
      const callee = ts.isCallExpression(node) ? calleeName(node.expression) : null;
      if (callee && HOOK_NAME.test(callee)) inner.push(callee);
      ts.forEachChild(node, visit); // 허용 목록 확인은 콜백 안까지 본다
    };
    visit(body);
    const bad = inner.filter((n) => !REACT_NON_EFFECT.has(n));
    if (bad.length) violations.push(`${name}: ${bad.join(', ')}`);
  }
  return violations;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`# ${appShellPath()}`);
  for (const [i, line] of collectHookOrder().entries()) console.log(`${String(i + 1).padStart(3)} ${line}`);
  const v = effectFreeViolations();
  if (v.length) { console.error('effect 없는 훅 허용 목록 위반:\n' + v.join('\n')); process.exitCode = 1; }
}
