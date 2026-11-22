// 매니페스트 검사(validateManifest)와 레지스트리(P2-49, Phase 2 C5).
import { describe, expect, it, vi } from 'vitest';
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

  it('필수 키는 9개이고 허용 키는 필수 9 + 선택 3이다', () => {
    expect([...REQUIRED_MANIFEST_KEYS]).toEqual([
      'id', 'name', 'icon', 'description', 'EvaluationComponent', 'createModuleData', 'computeCalc', 'isComplete', 'tabs',
    ]);
    expect([...MANIFEST_KEYS].slice(9)).toEqual(['presetConfig', 'batchImportConfig', 'videoMappingConfig']);
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

  it('memo·lazy 같은 객체 컴포넌트도 컴포넌트로 본다', () => {
    expect(validateManifest(validManifest({ EvaluationComponent: { $$typeof: Symbol.for('react.memo') } }))).toEqual([]);
  });

  it('presetConfig 하위 모양', () => {
    const ok = { label: 'L', fields: [{ key: 'k', label: 'K', type: 'number' }], extractFromModule: () => null, applyToModule: () => ({}) };
    expect(validateManifest(validManifest({ presetConfig: ok }))).toEqual([]);
    expect(validateManifest(validManifest({ presetConfig: { ...ok, fields: 'tasks' } }))).toEqual([]);
    expect(validateManifest(validManifest({
      presetConfig: { label: '', fields: [{ key: 'k', label: 'K', type: 'date', extra: 1 }], extractFromModule: 1, more: true },
    }))).toEqual([
      "presetConfig에 모르는 키 'more'",
      'presetConfig.label은 빈 문자열이 아닌 문자열이어야 합니다',
      "presetConfig.fields[0]에 모르는 키 'extra'",
      'presetConfig.fields[0].type은 number·boolean·string 중 하나여야 합니다',
      'presetConfig.extractFromModule은 함수여야 합니다',
      'presetConfig.applyToModule은 함수여야 합니다',
    ]);
    expect(validateManifest(validManifest({ presetConfig: { ...ok, fields: 'items' } })))
      .toEqual(["presetConfig.fields는 배열이거나 'tasks'여야 합니다"]);
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
});

describe('createModuleRegistry (P2-49: 경고만)', () => {
  it('문제가 있어도 등록하고, 경고는 모듈 id와 함께 한 번 낸다', () => {
    const warn = vi.fn();
    const registry = createModuleRegistry({ warn });
    const manifest = validManifest({ tabs: undefined }) as unknown as ModuleManifest;
    registry.register(manifest);
    expect(registry.get('demo')).toBe(manifest);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[moduleRegistry] 모듈 'demo' 매니페스트 문제 1건: 필수 키 'tabs'가 없습니다");
  });

  it('같은 id를 다시 등록하면 자리는 그대로, 내용만 바뀐다(옛 Map 동작)', () => {
    const registry = createModuleRegistry({ warn: () => {} });
    const a = validManifest({ id: 'a' }) as unknown as ModuleManifest;
    const b = validManifest({ id: 'b' }) as unknown as ModuleManifest;
    const a2 = validManifest({ id: 'a', name: '다시' }) as unknown as ModuleManifest;
    registry.register(a);
    registry.register(b);
    registry.register(a2);
    expect(registry.all()).toEqual([a2, b]);
  });
});
