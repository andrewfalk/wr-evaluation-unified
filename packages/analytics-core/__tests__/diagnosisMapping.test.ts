import { describe, it, expect } from 'vitest';
import { getDiagnosisModuleHint, resolveDiagnosisModule, supportsKlGrade } from '../diagnosisMapping';

describe('getDiagnosisModuleHint — KNOWN BUG characterization (do not fix in this PR)', () => {
  // diagnosisMapping.ts의 NAME_MODULE_MAP 요추 패턴이 끝에 빈 대안(|)을 가진 채로
  // 이동됐다(원본 src/core/utils/diagnosisMapping.js와 동일 — 계획서 §2 "known issue").
  // 이 테스트는 그 동작(버그 포함)이 이동 전후 동일함을 고정한다 — "옳다"가 아니라
  // "지금 이렇다"를 검증하는 characterization test다. 별도 이슈로 분리해 수정할 것.
  it('KNOWN BUG(별도 이슈 필요, 수정 금지): 어떤 모듈 패턴에도 안 걸리는 임의 상병명이 요추로 잘못 분류된다', () => {
    const hint = getDiagnosisModuleHint({ code: '', name: '완전히 무관한 임의의 상병명 텍스트' });
    expect(hint).toEqual({ moduleId: 'spine', label: '요추(허리)' });
  });

  it('무릎처럼 실제로 매치되는 이름은 정상적으로 해당 모듈로 분류된다(버그의 영향을 안 받음)', () => {
    expect(getDiagnosisModuleHint({ name: '무릎 관절증' })?.moduleId).toBe('knee');
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
