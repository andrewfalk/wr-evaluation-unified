// 매니페스트 검사(validateManifest)와 레지스트리(P2-49·P2-50, Phase 2 C5).
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { MANIFEST_KEYS, REQUIRED_MANIFEST_KEYS, validateManifest, type ModuleManifest } from '../manifest';
import { createModuleRegistry } from '../registry';

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    name: '데모',
    icon: 'D',
    description: '설명',
    EvaluationComponent: () => null,
    createModuleData: () => ({}),
    computeCalc: () => ({}),
    isComplete: () => false,
    tabs: [{ id: 'main', label: '평가' }],
    ...overrides,
  };
}

describe('validateManifest', () => {
  it('필수 키만 갖춘 매니페스트는 문제가 없다', () => {
    expect(validateManifest(validManifest())).toEqual([]);
  });

  it('필수 키는 9개이고 허용 키는 필수 9 + 선택 5이다', () => {
    expect([...REQUIRED_MANIFEST_KEYS]).toEqual([
      'id', 'name', 'icon', 'description', 'EvaluationComponent', 'createModuleData', 'computeCalc', 'isComplete', 'tabs',
    ]);
    expect([...MANIFEST_KEYS].slice(9)).toEqual(['presetConfig', 'batchImportConfig', 'videoMappingConfig', 'devFixtures', 'batchExport']);
  });

  it.each(REQUIRED_MANIFEST_KEYS)('필수 키 %s가 없으면 문제로 낸다', (key) => {
    const manifest = validManifest();
    delete manifest[key];
    expect(validateManifest(manifest)).toContain(`필수 키 '${key}'가 없습니다`);
  });

  it('객체가 아니면 한 건으로 낸다', () => {
    expect(validateManifest(null)).toEqual(['매니페스트는 객체여야 합니다']);
    expect(validateManifest([])).toEqual(['매니페스트는 객체여야 합니다']);
  });

  it('모르는 최상위 키(예: 삭제된 createDiagnosis)를 낸다', () => {
    expect(validateManifest(validManifest({ createDiagnosis: () => ({}) }))).toEqual(["모르는 키 'createDiagnosis'"]);
  });

  it('키별 타입을 본다', () => {
    expect(validateManifest(validManifest({
      id: '',
      name: 3,
      icon: null,
      description: 1,
      EvaluationComponent: 'Comp',
      computeCalc: {},
      tabs: [],
    }))).toEqual([
      'id는 빈 문자열이 아닌 문자열이어야 합니다',
      'name은 빈 문자열이 아닌 문자열이어야 합니다',
      'icon은 문자열이어야 합니다',
      'description은 문자열이어야 합니다',
      'EvaluationComponent는 React 컴포넌트여야 합니다',
      'computeCalc는 함수여야 합니다',
      'tabs는 비어 있지 않은 배열이어야 합니다',
    ]);
    expect(validateManifest(validManifest({ tabs: [{ id: 'a' }] }))).toEqual(['tabs[0]는 { id, label } 문자열 객체여야 합니다']);
  });

  it('memo·lazy·forwardRef 객체 컴포넌트는 받고, JSX 요소·가짜 태그는 막는다', () => {
    for (const tag of ['react.memo', 'react.lazy', 'react.forward_ref']) {
      expect(validateManifest(validManifest({ EvaluationComponent: { $$typeof: Symbol.for(tag) } })), tag).toEqual([]);
    }
    const problem = ['EvaluationComponent는 React 컴포넌트여야 합니다'];
    expect(validateManifest(validManifest({ EvaluationComponent: createElement('div') }))).toEqual(problem);
    expect(validateManifest(validManifest({ EvaluationComponent: { $$typeof: null } }))).toEqual(problem);
    expect(validateManifest(validManifest({ EvaluationComponent: { $$typeof: 'react.memo' } }))).toEqual(problem);
  });

  it('presetConfig 하위 모양', () => {
    const ok = { label: 'L', fields: [{ key: 'k', label: 'K', type: 'number' }], extractFromModule: () => null, applyToModule: () => ({}) };
    expect(validateManifest(validManifest({ presetConfig: ok }))).toEqual([]);
    expect(validateManifest(validManifest({ presetConfig: { ...ok, fields: [{ key: 'tasks', type: 'taskList' }] } }))).toEqual([]);
    expect(validateManifest(validManifest({
      presetConfig: { label: '', fields: [{ key: 'k', label: 'K', type: 'date', extra: 1 }], extractFromModule: 1, more: true },
    }))).toEqual([
      "presetConfig에 모르는 키 'more'",
      'presetConfig.label은 빈 문자열이 아닌 문자열이어야 합니다',
      "presetConfig.fields[0]에 모르는 키 'extra'",
      'presetConfig.fields[0].type은 number·boolean·string·taskList 중 하나여야 합니다',
      'presetConfig.extractFromModule은 함수여야 합니다',
      'presetConfig.applyToModule은 함수여야 합니다',
    ]);
    // P2-50: 옛 문자열 'tasks'는 더 이상 받지 않는다(taskList 필드로 바꿈).
    expect(validateManifest(validManifest({ presetConfig: { ...ok, fields: 'tasks' } })))
      .toEqual(['presetConfig.fields는 배열이어야 합니다']);
    expect(validateManifest(validManifest({
      presetConfig: { ...ok, fields: [{ key: 'tasks', type: 'taskList', label: 3 }, { key: 'more', type: 'taskList' }] },
    }))).toEqual([
      'presetConfig.fields[0].label은 문자열이어야 합니다',
      'presetConfig.fields의 taskList 필드는 하나만 둘 수 있습니다',
    ]);
  });

  it('batchImportConfig 하위 모양', () => {
    expect(validateManifest(validManifest({ batchImportConfig: { columns: { a: ['A'] }, applyRow: () => {} } }))).toEqual([]);
    expect(validateManifest(validManifest({ batchImportConfig: { columns: { a: [], b: 'B' }, applyRow: null } }))).toEqual([
      'batchImportConfig.columns.a는 비어 있지 않은 문자열 배열이어야 합니다',
      'batchImportConfig.columns.b는 비어 있지 않은 문자열 배열이어야 합니다',
      'batchImportConfig.applyRow는 함수여야 합니다',
    ]);
  });

  it('videoMappingConfig 하위 모양(taskFallbackUnlinked 포함)', () => {
    const ok = { scope: 'task', featureKeys: ['x'], coerce: () => 1, writeField: () => ({}), taskFallbackUnlinked: true };
    expect(validateManifest(validManifest({ videoMappingConfig: ok }))).toEqual([]);
    expect(validateManifest(validManifest({
      videoMappingConfig: { scope: 'patient', featureKeys: [1], coerce: 'x', taskFallbackUnlinked: 'yes', other: 1 },
    }))).toEqual([
      "videoMappingConfig에 모르는 키 'other'",
      'videoMappingConfig.scope는 job·task·job-diagnosis 중 하나여야 합니다',
      'videoMappingConfig.featureKeys는 문자열 배열이어야 합니다',
      'videoMappingConfig.coerce는 함수여야 합니다',
      'videoMappingConfig.writeField는 함수여야 합니다',
      'videoMappingConfig.taskFallbackUnlinked는 불리언이어야 합니다',
    ]);
  });

  it('devFixtures 하위 모양(P2-53)', () => {
    expect(validateManifest(validManifest({ devFixtures: { createJobEvaluation: () => ({}), createDiagnosisEntry: () => ({}) } })))
      .toEqual([]);
    expect(validateManifest(validManifest({ devFixtures: {} }))).toEqual([]);
    expect(validateManifest(validManifest({ devFixtures: { createJobEvaluation: 1, other: () => 1 } }))).toEqual([
      "devFixtures에 모르는 키 'other'",
      'devFixtures.createJobEvaluation는 함수여야 합니다',
    ]);
    expect(validateManifest(validManifest({ devFixtures: [] }))).toEqual(['devFixtures는 객체여야 합니다']);
  });

  it('batchExport 하위 모양(P2-55a)', () => {
    const column = { header: '열', cell: () => '' };
    expect(validateManifest(validManifest({ batchExport: { order: 10, columns: [column] } }))).toEqual([]);
    expect(validateManifest(validManifest({ batchExport: { order: 10, columns: [column], rowTasks: () => [] } }))).toEqual([]);
    expect(validateManifest(validManifest({ batchExport: { columns: [] } }))).toEqual([
      'batchExport.order는 유한한 숫자여야 합니다',
      'batchExport.columns는 비어 있지 않은 배열이어야 합니다',
    ]);
    expect(validateManifest(validManifest({
      batchExport: { order: Number.POSITIVE_INFINITY, columns: [{ header: '', cell: 'x', width: 1 }], rowTasks: [], extra: 1 },
    }))).toEqual([
      "batchExport에 모르는 키 'extra'",
      'batchExport.order는 유한한 숫자여야 합니다',
      "batchExport.columns[0]에 모르는 키 'width'",
      'batchExport.columns[0].header는 빈 문자열이 아닌 문자열이어야 합니다',
      'batchExport.columns[0].cell은 함수여야 합니다',
      'batchExport.rowTasks는 함수여야 합니다',
    ]);
  });
});

describe('createModuleRegistry (P2-50: throw)', () => {
  it('검사에 걸리면 모듈 id·문제 목록과 함께 throw하고 등록하지 않는다', () => {
    const registry = createModuleRegistry();
    const manifest = validManifest({ tabs: undefined }) as unknown as ModuleManifest;
    expect(() => registry.register(manifest))
      .toThrow("[moduleRegistry] 모듈 'demo' 매니페스트 문제 1건: 필수 키 'tabs'가 없습니다");
    expect(registry.get('demo')).toBeUndefined();
    expect(() => registry.register(null as unknown as ModuleManifest))
      .toThrow("[moduleRegistry] 모듈 '(id 없음)' 매니페스트 문제 1건: 매니페스트는 객체여야 합니다");
  });

  it('같은 id 재등록은 기본으로 throw하고 처음 것을 유지한다', () => {
    const registry = createModuleRegistry();
    const a = validManifest({ id: 'a' }) as unknown as ModuleManifest;
    registry.register(a);
    expect(() => registry.register(validManifest({ id: 'a', name: '다시' }) as unknown as ModuleManifest))
      .toThrow("[moduleRegistry] 모듈 id 'a'가 이미 등록돼 있습니다");
    expect(registry.all()).toEqual([a]);
  });

  it('allowReplace면 자리는 그대로, 내용만 바뀐다(옛 Map 동작 — 개발 모드 HMR)', () => {
    const registry = createModuleRegistry({ allowReplace: true });
    const a = validManifest({ id: 'a' }) as unknown as ModuleManifest;
    const b = validManifest({ id: 'b' }) as unknown as ModuleManifest;
    const a2 = validManifest({ id: 'a', name: '다시' }) as unknown as ModuleManifest;
    registry.register(a);
    registry.register(b);
    registry.register(a2);
    expect(registry.all()).toEqual([a2, b]);
  });

  it('기본 인스턴스는 import.meta.env.DEV일 때 교체를 허용한다(vitest는 DEV)', async () => {
    expect(import.meta.env.DEV).toBe(true);
    const { registerModule, getAllModules, getModule } = await import('../registry');
    const first = validManifest({ id: 'dev-replace' }) as unknown as ModuleManifest;
    const second = validManifest({ id: 'dev-replace', name: '교체' }) as unknown as ModuleManifest;
    registerModule(first);
    registerModule(second);
    expect(getModule('dev-replace')).toBe(second);
    expect(getAllModules().filter(mod => mod.id === 'dev-replace')).toHaveLength(1);
  });
});
