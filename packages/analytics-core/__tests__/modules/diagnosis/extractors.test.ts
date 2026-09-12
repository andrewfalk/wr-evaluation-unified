import { describe, it, expect } from 'vitest';
import { extractDiagnosisIdentityModuleGroup } from '../../../modules/diagnosis/extractors';
import { deterministicMigrate } from '../../../migration/deterministicMigrate';

const FALLBACK = '2024-01-01T00:00:00.000Z';

function migrate(payload: unknown, caseId = 'case-1') {
  return deterministicMigrate(payload, { caseId, createdAtFallbackIso: FALLBACK });
}

function diagnosesCase(diagnoses: unknown[]) {
  return { data: { shared: { diagnoses }, modules: {}, activeModules: [] } };
}

describe('extractDiagnosisIdentityModuleGroup — diagnosisMapping.ts 정규식 버그 수정 후 최초 파생(§5.5 ④)', () => {
  it('명시적 moduleId가 유효한 6개 모듈 중 하나면 그대로 사용한다', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎 관절증', moduleId: 'shoulder' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: 'shoulder', missing: null, qualityFlags: [] }]);
  });

  it('moduleId가 "__none__"이면 not_applicable(구조적으로 부위군이 없음, 결측 아님)', () => {
    const dx = { id: 'dx-1', code: 'M17.1', name: '무릎 관절증', moduleId: '__none__' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_applicable', qualityFlags: [] }]);
  });

  it('moduleId 없이 ICD 코드로 매치되면 해당 부위군을 반환한다', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: 'spine', missing: null, qualityFlags: [] }]);
  });

  it('moduleId 없이 상병명으로만 매치되면 해당 부위군을 반환한다', () => {
    const dx = { id: 'dx-1', code: '', name: '허리 통증' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: 'spine', missing: null, qualityFlags: [] }]);
  });

  // 이 회귀 테스트가 바로 diagnosisMapping.ts 버그 수정의 존재 이유다 — 수정 전에는 이
  // 값이 'spine'으로 잘못 반환됐다(정규식 끝 빈 대안이 모든 미매칭 문자열에 매치).
  it('어떤 모듈 패턴에도 안 걸리는 진단명은 not_entered + legacy_unknown(요추로 잘못 집계되지 않는다)', () => {
    const dx = { id: 'dx-1', code: 'J00', name: '감기' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([{ entityKey: ['dx-1', 'unspecified'], value: null, missing: 'not_entered', qualityFlags: ['legacy_unknown'] }]);
  });

  it('activeModules가 1개뿐이어도(UI fallback 규칙) 그 모듈로 잘못 집계되지 않는다', () => {
    const payload = {
      data: { shared: { diagnoses: [{ id: 'dx-1', code: 'J00', name: '감기' }] }, modules: {}, activeModules: ['spine'] },
    };
    const result = extractDiagnosisIdentityModuleGroup(migrate(payload));
    expect(result[0].value).toBeNull();
    expect(result[0].missing).toBe('not_entered');
  });

  it('side="both"인 진단은 양측으로 explode되지만 부위군 값은 동일하다', () => {
    const dx = { id: 'dx-1', code: 'M51.2', name: '요추간판탈출증', side: 'both' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.entityKey[1]).sort()).toEqual(['left', 'right']);
    expect(result.every((r) => r.value === 'spine')).toBe(true);
  });

  it('빈 placeholder 진단(code/name 둘 다 공백)은 엔터티 자체가 없다', () => {
    const dx = { id: 'dx-1', code: '', name: '' };
    const result = extractDiagnosisIdentityModuleGroup(migrate(diagnosesCase([dx])));
    expect(result).toEqual([]);
  });

  it('결정성 — 동일 snapshot을 두 번 추출해도 byte-identical 결과', () => {
    const payload = diagnosesCase([{ id: 'dx-1', code: 'M51.2', name: '요추간판탈출증' }]);
    expect(extractDiagnosisIdentityModuleGroup(migrate(payload))).toEqual(extractDiagnosisIdentityModuleGroup(migrate(payload)));
  });
});
