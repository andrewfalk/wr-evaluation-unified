// PR0-B2 §1-2: 소스가 아니라 실제 빌드 산출물(dist/completion.js)을 직접 import한다.
// 이 파일의 다른 테스트(completion.test.ts)는 vitest alias(@analytics-core → 소스)로
// 돌아 tsup 번들링·entry 누락 문제를 못 잡는다(shoulder shim 사건 — vitest 1472개가
// 전부 통과한 채 dist에서만 export가 죽어 있던 전례). 여기서는 6개 모듈이 실제로
// dist/completion.js 안에 전부 등록됐는지(errorModuleIds가 비어 있는지)와, 빈 데이터로는
// 전부 미완료 판정되는지(failedModuleIds에 6개 전부)를 dist 자체로 검증한다.
//
// 이 테스트를 돌리기 전 `npm --prefix packages/analytics-core run build`(또는 루트
// `npm run build:web`/`npm test`의 prebuild 훅)로 dist가 최신이어야 한다.
import { describe, it, expect } from 'vitest';
import { verifyAllModulesComplete } from '../dist/completion.js';

const ALL_MODULE_IDS = ['knee', 'shoulder', 'elbow', 'wrist', 'cervical', 'spine'];

describe('dist/completion.js — 빌드 산출물 smoke', () => {
  // modules는 각 모듈에 유효한 빈 객체({})를 채운다 — modules:{}(데이터 자체가 없음)를
  // 쓰면 §P1 방어(구조적으로 유효하지 않은 module 데이터 차단)에 걸려 6개 전부
  // errorModuleIds로 보고되므로, "등록 확인"이라는 이 테스트의 원래 목적과 섞인다.
  const emptyModules = Object.fromEntries(ALL_MODULE_IDS.map((id) => [id, {}]));

  it('6개 모듈 전부 등록되어 있다(errorModuleIds가 비어 있음)', () => {
    const result = verifyAllModulesComplete({ shared: {}, modules: emptyModules, activeModules: ALL_MODULE_IDS });
    expect(result.errorModuleIds).toEqual([]);
  });

  it('빈 데이터로는 6개 모듈 전부 완료판정에 실패한다(failedModuleIds에 6개 전부)', () => {
    const result = verifyAllModulesComplete({ shared: {}, modules: emptyModules, activeModules: ALL_MODULE_IDS });
    expect(result.failedModuleIds.slice().sort()).toEqual(ALL_MODULE_IDS.slice().sort());
    expect(result.allComplete).toBe(false);
  });

  // §리뷰 지적(P1) 회귀 방지: module 데이터 자체가 없거나(undefined) 손상되면(null 등)
  // isComplete 호출 전에 차단돼야 한다 — dist 빌드에서도 동일하게 동작하는지 확인.
  it('module 데이터가 없으면(modules:{}) 실제 완료 조건을 만족하는 shared가 있어도 완료로 오판하지 않는다', () => {
    const shared = { diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }] };
    const result = verifyAllModulesComplete({ shared, modules: {}, activeModules: ['knee'] });
    expect(result.allComplete).toBe(false);
  });
});
