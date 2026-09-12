import { describe, it, expect } from 'vitest';
import { getDiagnosisModuleHint, resolveDiagnosisModule, supportsKlGrade } from '../diagnosisMapping';

describe('getDiagnosisModuleHint — 요추 정규식 빈 대안 버그 수정(PR0-B3 Part C, 2026-09-12)', () => {
  // NAME_MODULE_MAP의 요추 패턴 끝에 있던 빈 대안(|)을 제거했다 — 이전엔 어떤 모듈
  // 패턴에도 안 걸리는 임의 상병명이 전부 요추로 잘못 분류됐다(이 테스트가 그 버그를
  // characterization하고 있었음). 이제는 미매칭이면 null을 반환해야 한다.
  it('어떤 모듈 패턴에도 안 걸리는 임의 상병명은 null(더 이상 요추로 잘못 분류되지 않는다)', () => {
    const hint = getDiagnosisModuleHint({ code: '', name: '완전히 무관한 임의의 상병명 텍스트' });
    expect(hint).toBeNull();
  });

  it('무릎처럼 실제로 매치되는 이름은 정상적으로 해당 모듈로 분류된다(회귀 없음)', () => {
    expect(getDiagnosisModuleHint({ name: '무릎 관절증' })?.moduleId).toBe('knee');
  });

  it('요추 키워드는 여전히 정상적으로 매치된다(빈 대안 제거가 정상 매칭까지 지우지 않았는지 확인)', () => {
    expect(getDiagnosisModuleHint({ name: '요추간판탈출증' })?.moduleId).toBe('spine');
    expect(getDiagnosisModuleHint({ name: '허리 통증' })?.moduleId).toBe('spine');
    expect(getDiagnosisModuleHint({ name: 'lumbar strain' })?.moduleId).toBe('spine');
    expect(getDiagnosisModuleHint({ code: 'M51.2' })?.moduleId).toBe('spine');
  });
});

describe('resolveDiagnosisModule — 기존 동작 회귀 방어', () => {
  it('명시적 moduleId가 유효하면 자동 매핑보다 우선한다', () => {
    expect(resolveDiagnosisModule({ code: 'M17.1', moduleId: 'shoulder' }, [])).toEqual({
      moduleId: 'shoulder',
      label: expect.any(String),
    });
  });

  it('__none__은 자동 매핑과 fallback을 모두 막는다', () => {
    expect(resolveDiagnosisModule({ code: 'M17.1', moduleId: '__none__' }, ['knee'])).toBeNull();
  });

  it('활성 모듈이 1개뿐이면 매핑 실패 시 그 모듈로 fallback한다', () => {
    expect(resolveDiagnosisModule({ code: 'M79.3' }, ['knee'])?.moduleId).toBe('knee');
  });
});

describe('supportsKlGrade', () => {
  it('M17 하위코드는 전부 K-L Grade 대상이다(원판형 반월판 M17.5 포함)', () => {
    expect(supportsKlGrade({ code: 'M17.5' })).toBe(true);
    expect(supportsKlGrade({ code: 'M17.0' })).toBe(true);
  });

  it('무릎 관절증 표기 변형을 모두 인정한다', () => {
    expect(supportsKlGrade({ name: '무릎의 골관절증' })).toBe(true);
    expect(supportsKlGrade({ name: '슬관절염' })).toBe(true);
  });

  it('K-L Grade 대상이 아닌 상병은 false', () => {
    expect(supportsKlGrade({ code: 'M75.1', name: '회전근개 파열' })).toBe(false);
  });
});
