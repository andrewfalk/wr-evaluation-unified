import { describe, it, expect, beforeEach } from 'vitest';
import { registerAnalyticsModule, getRegisteredVariableKeys, __resetAnalyticsRegistryForTests } from '../analyticsRegistry';

describe('registerAnalyticsModule', () => {
  beforeEach(() => {
    __resetAnalyticsRegistryForTests();
  });

  it('registers a module whose metadata and extractors match 1:1', () => {
    registerAnalyticsModule({
      moduleId: 'fixture',
      metadata: [{ key: 'fixture.a' }, { key: 'fixture.b' }],
      extractors: { 'fixture.a': () => null, 'fixture.b': () => null },
    });
    expect(getRegisteredVariableKeys().sort()).toEqual(['fixture.a', 'fixture.b']);
  });

  it('throws on duplicate variable key within the same metadata array (in-call duplicate, not yet in the global registry)', () => {
    // 리뷰로 발견된 회귀: 사전 검사 루프가 전역 registeredKeys만 보고, 이번 호출의
    // metadata 배열 자체에 중복 key가 있는 건(둘 다 아직 전역에 없으므로) 놓쳤었다.
    expect(() =>
      registerAnalyticsModule({
        moduleId: 'fixture',
        metadata: [{ key: 'fixture.dup' }, { key: 'fixture.dup' }],
        extractors: { 'fixture.dup': () => null },
      }),
    ).toThrow(/duplicate variable key/);
    expect(getRegisteredVariableKeys()).toEqual([]); // 실패한 등록은 아무것도 안 남긴다
  });

  it('throws on duplicate variable key across modules', () => {
    registerAnalyticsModule({
      moduleId: 'fixture-1',
      metadata: [{ key: 'shared.key' }],
      extractors: { 'shared.key': () => null },
    });
    expect(() =>
      registerAnalyticsModule({
        moduleId: 'fixture-2',
        metadata: [{ key: 'shared.key' }],
        extractors: { 'shared.key': () => null },
      }),
    ).toThrow(/duplicate variable key/);
  });

  it('throws when a metadata entry has no matching extractor', () => {
    expect(() =>
      registerAnalyticsModule({
        moduleId: 'fixture',
        metadata: [{ key: 'fixture.orphanMetadata' }],
        extractors: {},
      }),
    ).toThrow(/has no matching extractor/);
  });

  it('throws when an extractor has no matching metadata entry', () => {
    expect(() =>
      registerAnalyticsModule({
        moduleId: 'fixture',
        metadata: [],
        extractors: { 'fixture.orphanExtractor': () => null },
      }),
    ).toThrow(/has no matching metadata entry/);
  });

  it('a failed registration does not partially register other keys from the same call', () => {
    expect(() =>
      registerAnalyticsModule({
        moduleId: 'fixture',
        metadata: [{ key: 'fixture.ok' }, { key: 'fixture.missingExtractor' }],
        extractors: { 'fixture.ok': () => null },
      }),
    ).toThrow();
    expect(getRegisteredVariableKeys()).toEqual([]);
  });
});

describe('knee module real registration (via import side effect)', () => {
  it('registers knee.relatedness.max when packages/analytics-core/modules/knee/index is imported', async () => {
    __resetAnalyticsRegistryForTests();
    const mod = await import('../modules/knee/index');
    expect(mod).toBeTruthy();
    expect(getRegisteredVariableKeys()).toContain('knee.relatedness.max');
  });
});
