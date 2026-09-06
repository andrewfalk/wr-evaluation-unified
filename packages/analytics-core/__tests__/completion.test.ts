import { describe, it, expect } from 'vitest';
import { verifyAllModulesComplete, verifyModuleCompletion, COMPLETION_ENGINE_VERSION } from '../completion';

const ALL_MODULE_IDS = ['knee', 'shoulder', 'elbow', 'wrist', 'cervical', 'spine'];

describe('verifyAllModulesComplete', () => {
  it('activeModules가 비어 있으면 allComplete=false, 나머지는 전부 빈 배열', () => {
    const result = verifyAllModulesComplete({ shared: {}, modules: {}, activeModules: [] });
    expect(result).toEqual({ allComplete: false, results: [], errorModuleIds: [], failedModuleIds: [] });
  });

  // modules:{} (모듈 데이터 자체가 하나도 없음)는 6개 전부 §P1 방어에 걸려 errored=true다
  // — 등록 여부 확인용 dist-smoke 테스트는 각 모듈에 유효한 빈 객체({})를 채워서 구분한다.
  it('활성 모듈의 module 데이터가 전부 없으면(modules:{}) 6개 전부 errored=true(등록 여부와 무관하게 차단)', () => {
    const result = verifyAllModulesComplete({ shared: {}, modules: {}, activeModules: ALL_MODULE_IDS });
    expect(result.allComplete).toBe(false);
    expect(result.errorModuleIds.slice().sort()).toEqual(ALL_MODULE_IDS.slice().sort());
    expect(result.failedModuleIds).toEqual([]);
  });

  it('module 데이터가 유효한 빈 객체({})로 채워져 있으면 6개 전부 등록 확인(에러 없음)되고 완료는 아니다', () => {
    const modules = Object.fromEntries(ALL_MODULE_IDS.map((id) => [id, {}]));
    const result = verifyAllModulesComplete({ shared: {}, modules, activeModules: ALL_MODULE_IDS });
    expect(result.allComplete).toBe(false);
    expect(result.errorModuleIds).toEqual([]);
    expect(result.failedModuleIds.slice().sort()).toEqual(ALL_MODULE_IDS.slice().sort());
  });

  it('등록되지 않은 moduleId는 errored=true로 보고되고 allComplete는 false다', () => {
    const result = verifyAllModulesComplete({ shared: {}, modules: { 'not-a-real-module': {} }, activeModules: ['not-a-real-module'] });
    expect(result.allComplete).toBe(false);
    expect(result.errorModuleIds).toEqual(['not-a-real-module']);
    expect(result.failedModuleIds).toEqual([]);
  });

  // §리뷰 지적(2026-09-06, P1): 무릎의 isComplete는 module 파라미터를 전혀 읽지 않고
  // shared.diagnoses만 본다 — 이전 구현은 module 데이터가 없거나(undefined) 손상돼도
  // (null/배열/문자열) `{}`로 대체해 isComplete를 그대로 호출했기 때문에, shared 쪽에
  // 완료된 무릎 진단만 있으면 module 데이터 무결성과 무관하게 매번 true를 반환했다.
  it.each([
    ['modules 자체가 없음', {}],
    ['knee 값이 null', { knee: null }],
    ['knee 값이 배열', { knee: [] }],
    ['knee 값이 문자열', { knee: 'broken' }],
  ])('완료된 무릎 진단이 있어도 module 데이터가 %s이면 isComplete를 호출하지 않고 false를 반환한다', (_label, modules) => {
    const shared = { diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }] };
    const result = verifyAllModulesComplete({ shared, modules, activeModules: ['knee'] });
    expect(result.allComplete).toBe(false);
    expect(result.errorModuleIds).toEqual(['knee']);
  });

  it('module 데이터가 유효한 객체이고 무릎 진단도 완료 조건을 만족하면 정상적으로 true를 반환한다(회귀 방지)', () => {
    const shared = { diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }] };
    const result = verifyAllModulesComplete({ shared, modules: { knee: {} }, activeModules: ['knee'] });
    expect(result.allComplete).toBe(true);
    expect(result.errorModuleIds).toEqual([]);
  });

  it('COMPLETION_ENGINE_VERSION은 문자열 상수다', () => {
    expect(typeof COMPLETION_ENGINE_VERSION).toBe('string');
    expect(COMPLETION_ENGINE_VERSION.length).toBeGreaterThan(0);
  });
});
